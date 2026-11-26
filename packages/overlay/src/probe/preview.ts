/**
 * Live previews of recorded edits, without touching the DOM structure the framework owns.
 *
 * An edited element gets one attribute, `data-primp-id`, and every preview is a rule in ONE
 * constructable stylesheet (`document.adoptedStyleSheets`):
 *
 *   [data-primp-id="x"] { padding: 28px !important }
 *   @media (min-width: 768px) { [data-primp-id="y"] { gap: 8px !important } }
 *
 * Hide and remove are both previewed as `display: none !important`: the node stays where the
 * framework put it. `all-instances` marks every instance and lists them in the rule.
 *
 * An edit made for a state applies in the real state and in the forced one (states.ts):
 *
 *   [data-primp-id="x"]:hover, [data-primp-id="x"][data-primp-force~="hover"] { color: red !important }
 *
 * Both selectors weigh more than the resting one, and the rules for a state are written after
 * the resting rules, so a resting preview and a state preview of one property resolve as the
 * same two declarations in a stylesheet would. A resting preview is `!important` and would also
 * cover the page's own rule for a state (`.btn:hover`); where the page has one for the property,
 * the resting rule is written `[data-primp-id="x"]:not(:where(:hover, [data-primp-force~="hover"]))`
 * (`exceptIn`, no added weight), so the state keeps its own value as it will once the edit is in the source.
 *
 * Every write to the page (a mark, the stylesheet text) is announced to the layout-shift
 * recorder first with `window.__primp.markSelf()`, so the shifts it causes count as primp's own.
 *
 * A framework re-render or a hot update may replace a marked node. A MutationObserver notices,
 * finds the element again by its locator and marks the new node; when it cannot be found the
 * preview is reported as detached (and tried again on later mutations), never dropped.
 *
 * REORDER is the one preview that changes the DOM structure: a spec with `move` puts its element
 * at `move.toIndex` among the element children of the SAME parent with `parent.insertBefore`
 * (every node stays a child of its parent, which a framework that owns the list survives). Each
 * applied move remembers the node that followed the element, and the moves are kept as a stack:
 * they are put back in reverse order, so the page's own order comes back exactly. A move is put
 * back when its preview is removed (undo, delete, Send), while previews are suspended (a
 * measurement must see the page's own order), while it is muted, and on dispose. When a re-render
 * changed the children of a parent with a moved element, its moves are put back as far as the
 * remembered nodes allow (else by index) and made again; an element that is gone is found again
 * by its locator or reported as detached, as for a style preview. Nothing here throws into the
 * page. Every move is announced with `markSelf` first and noted in own-moves.ts, so the settle
 * client and this module's own observer do not take it for the page changing.
 */

import type { ElementState, Locator } from '@primp/protocol/change'
import { elementChildren, siblingPicker } from './order.ts'
import { isOwnMoveRecord, noteOwnMove } from './own-moves.ts'
import { adoptUid, elementOfUid, instancesOf, locate, MARK_ATTR, uidOf } from './ref.ts'
import { ELEMENT_STATES } from './specificity.ts'
import { FORCE_ATTR, ignoreSheet } from './styles.ts'

export interface PreviewSpec {
  itemId: string
  /** Uid of the target element; the value of its mark. */
  uid: string
  locator: Locator
  scope: 'instance' | 'all-instances'
  /** `@media` query the rule is wrapped in. */
  media?: string
  /** The rule only applies while the element is in this state, real or forced. Absent: at rest (and in every state no other rule covers). */
  state?: ElementState
  /**
   * Resting rules only: states in which the page has its own rule for the property. The preview is
   * left out of them (real or forced), as the edit, made in the resting rule of the source, would be.
   */
  exceptIn?: ElementState[]
  declarations: { property: string; value: string }[]
  /** Orders the rules, and the moves. */
  seq: number
  /** A reorder: the element is moved to this index among its parent's element children (same parent). Carries no declarations. */
  move?: { toIndex: number }
}

export interface PreviewOptions {
  /** Called when a preview loses its element (`true`) or finds it again (`false`). */
  onDetached?: (itemId: string, detached: boolean) => void
  /** Called a moment after the page's DOM changed (nodes added or removed, a `<style>` rewritten), once per burst. */
  onPageChange?: () => void
  document?: Document
}

export interface Preview {
  /** Applies (or replaces) the preview of `spec.itemId` on `element`. Returns the elements it now styles. */
  apply(spec: PreviewSpec, element: Element): Element[]
  /** Applies a preview for which only the recorded target is known. Returns the elements, or null when the target is not in the page (the preview is then kept as detached). */
  restore(spec: PreviewSpec): Element[] | null
  remove(itemId: string): void
  has(itemId: string): boolean
  /** The elements a preview styles right now; empty while detached. */
  elementsOf(itemId: string): Element[]
  /** Element with this uid as its mark, if any. */
  elementByUid(uid: string): Element | null
  isDetached(itemId: string): boolean
  /** Switches ALL previews off; calls nest. */
  suspend(reason?: string): void
  resume(reason?: string): void
  suspended(): boolean
  /** Leaves one preview, or several, out of the stylesheet (to measure the page without them); null puts them back. */
  mute(itemId: string | readonly string[] | null): void
  /** Looks for lost elements now; the MutationObserver calls this by itself. */
  check(): void
  /** The stylesheet text, for tests. */
  css(): string
  dispose(): void
}

interface Entry {
  spec: PreviewSpec
  primary: Element | null
  elements: Element[]
  detached: boolean
}

/** A move that is in effect: what it moved, and what is needed to put it back. */
interface Applied {
  entry: Entry
  node: Element
  parent: Element
  /** The node that followed `node` before it was moved (null: it was the last child). */
  next: Node | null
  /** Its index among the element children before it was moved: the way back when `next` is gone. */
  index: number
  toIndex: number
}

const CHECK_DELAY_MS = 40

const markSelf = (reason: string): void => {
  try {
    window.__primp?.markSelf(reason)
  } catch {
    // The recorder is optional.
  }
}

/**
 * Where a rule goes in the stylesheet. Resting rules first, then the states in the order an author
 * writes them (`:active` last: an active element is hovered too, and the later rule wins). Within
 * each, unscoped rules before `@media` rules: a scoped rule for the same property then wins inside its query.
 */
export function ruleOrder(a: PreviewSpec, b: PreviewSpec): number {
  const rank = (spec: PreviewSpec): number => (spec.state === undefined ? -1 : ELEMENT_STATES.indexOf(spec.state))
  return rank(a) - rank(b) || Number(a.media !== undefined) - Number(b.media !== undefined) || a.seq - b.seq
}

const quoted = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

export function ruleText(spec: PreviewSpec, uids: readonly string[]): string {
  if (uids.length === 0 || spec.declarations.length === 0) return ''
  const state = spec.state
  const except = state === undefined ? (spec.exceptIn ?? []) : []
  // Inside `:where()`, so the rule weighs what any other resting preview weighs (an @media one written later still wins).
  const outside = except.length === 0 ? '' : `:not(:where(${except.map((name) => `:${name}, [${FORCE_ATTR}~="${name}"]`).join(', ')}))`
  const selector =
    state === undefined
      ? uids.map((uid) => `[${MARK_ATTR}=${quoted(uid)}]${outside}`).join(',')
      : uids.map((uid) => `[${MARK_ATTR}=${quoted(uid)}]:${state}, [${MARK_ATTR}=${quoted(uid)}][${FORCE_ATTR}~="${state}"]`).join(', ')
  const body = spec.declarations.map((declaration) => `${declaration.property}: ${declaration.value} !important`).join('; ')
  const rule = `${selector} { ${body} }`
  return spec.media === undefined || spec.media === '' ? rule : `@media ${spec.media} { ${rule} }`
}

export function createPreview(options: PreviewOptions = {}): Preview {
  const doc = options.document ?? document
  const view = doc.defaultView ?? window
  const sheet = new view.CSSStyleSheet()
  ignoreSheet(sheet)
  const entries = new Map<string, Entry>()
  let depth = 0
  let muted: readonly string[] = []
  let text = ''
  let timer: number | undefined
  /** Moves in effect, in the order they were made. */
  let applied: Applied[] = []
  /** The element children of each parent with a moved element, as the moves left them. */
  const layouts = new Map<Element, Element[]>()

  const adopt = (): void => {
    if (!doc.adoptedStyleSheets.includes(sheet)) doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet]
  }

  const rebuild = (reason: string): void => {
    let next = ''
    if (depth === 0) {
      const ordered = [...entries.values()].sort((a, b) => ruleOrder(a.spec, b.spec))
      for (const entry of ordered) {
        if (muted.includes(entry.spec.itemId)) continue
        const rule = ruleText(
          entry.spec,
          entry.elements.map((element) => uidOf(element)),
        )
        if (rule !== '') next += `${rule}\n`
      }
    }
    if (next === text) return
    markSelf(reason)
    adopt()
    try {
      sheet.replaceSync(next)
      text = next
    } catch {
      // A value the browser refuses at this point was validated before; leave the sheet as it was.
    }
  }

  // --- moves -----------------------------------------------------------------

  const sameList = (a: readonly Element[], b: readonly Element[] | undefined): boolean => b !== undefined && a.length === b.length && a.every((element, index) => element === b[index])

  const write = (node: Element, parent: Element, ref: Node | null, reason: string): void => {
    if (node.nextSibling === ref && node.parentNode === parent) return
    markSelf(reason)
    noteOwnMove(node)
    parent.insertBefore(node, ref)
  }

  const putBack = (move: Applied): void => {
    try {
      if (move.node.parentNode !== move.parent) return
      if (move.next === null || move.next.parentNode === move.parent) {
        write(move.node, move.parent, move.next, 'preview: put a moved element back')
        return
      }
      // The node that followed it is gone: back to the index it had.
      const others = elementChildren(move.parent).filter((element) => element !== move.node)
      const ref = others[move.index] ?? (others.length === 0 ? null : others[others.length - 1]!.nextSibling)
      write(move.node, move.parent, ref, 'preview: put a moved element back')
    } catch {
      // The page rebuilt this part of the tree in the meantime: nothing to put back.
    }
  }

  const place = (entry: Entry): Applied | null => {
    const node = entry.primary
    const toIndex = entry.spec.move?.toIndex
    const parent = node?.parentElement ?? null
    if (node === null || toIndex === undefined || parent === null) return null
    try {
      const siblings = elementChildren(parent)
      const index = siblings.indexOf(node)
      if (index < 0) return null
      const move: Applied = { entry, node, parent, next: node.nextSibling, index, toIndex }
      const target = Math.max(0, Math.min(siblings.length - 1, toIndex))
      if (target !== index) {
        const others = siblings.filter((element) => element !== node)
        const ref = target < others.length ? others[target]! : others[others.length - 1]!.nextSibling
        write(node, parent, ref, 'preview: move element')
      }
      return move
    } catch {
      return null
    }
  }

  /** Brings the moves in effect in line with the entries: the ones still right stay, the rest is put back and made again. */
  const placeMoves = (): void => {
    const wanted =
      depth > 0
        ? []
        : [...entries.values()]
            .filter((entry) => entry.spec.move !== undefined && entry.primary !== null && entry.primary.isConnected && !muted.includes(entry.spec.itemId))
            .sort((a, b) => a.spec.seq - b.spec.seq)
    let keep = 0
    for (; keep < applied.length && keep < wanted.length; keep++) {
      const move = applied[keep]!
      const entry = wanted[keep]!
      const intact = move.entry === entry && move.node === entry.primary && move.toIndex === entry.spec.move?.toIndex && move.node.parentElement === move.parent
      if (!intact || !sameList(elementChildren(move.parent), layouts.get(move.parent))) break
    }
    if (keep === applied.length && keep === wanted.length) return
    for (let index = applied.length - 1; index >= keep; index--) putBack(applied[index]!)
    applied = applied.slice(0, keep)
    for (const entry of wanted.slice(keep)) {
      const move = place(entry)
      if (move !== null) applied.push(move)
    }
    layouts.clear()
    for (const move of applied) layouts.set(move.parent, elementChildren(move.parent))
  }

  const mark = (element: Element, uid: string): void => {
    if (element.getAttribute(MARK_ATTR) === uid) return
    markSelf('preview: mark element')
    element.setAttribute(MARK_ATTR, uid)
    adoptUid(element, uid)
  }

  const used = (element: Element, except?: Entry): boolean => {
    for (const entry of entries.values()) if (entry !== except && entry.elements.includes(element)) return true
    return false
  }

  const unmark = (elements: readonly Element[], except?: Entry): void => {
    for (const element of elements) {
      if (!element.hasAttribute(MARK_ATTR) || used(element, except)) continue
      markSelf('preview: unmark element')
      element.removeAttribute(MARK_ATTR)
    }
  }

  /** Marks the primary element and, for `all-instances`, each of its instances. */
  const attach = (entry: Entry, primary: Element): void => {
    const before = entry.elements
    mark(primary, entry.spec.uid)
    const elements = entry.spec.scope === 'all-instances' ? instancesOf(primary) : [primary]
    for (const element of elements) if (element !== primary) mark(element, uidOf(element))
    entry.primary = primary
    entry.elements = elements
    unmark(
      before.filter((element) => !elements.includes(element)),
      entry,
    )
    if (entry.detached) {
      entry.detached = false
      options.onDetached?.(entry.spec.itemId, false)
    }
  }

  const detach = (entry: Entry): void => {
    entry.primary = null
    entry.elements = []
    if (!entry.detached) {
      entry.detached = true
      options.onDetached?.(entry.spec.itemId, true)
    }
  }

  const findAgain = (entry: Entry): Element | null => {
    const marked = doc.querySelector(`[${MARK_ATTR}=${quoted(entry.spec.uid)}]`)
    if (marked !== null) return marked
    // Still in the page without its mark: a framework rewrote the attributes, or the mark was
    // taken off when the edit was undone and the edit is now redone.
    const known = entry.primary ?? elementOfUid(entry.spec.uid)
    if (known !== null && known.isConnected) return known
    // A moved element is not recognised by its position: the sibling now at the recorded index would win on it.
    if (entry.spec.move !== undefined) return locate(entry.spec.locator, { document: doc, picker: siblingPicker }).element
    return locate(entry.spec.locator, { document: doc, anyInstance: entry.spec.scope === 'all-instances' }).element
  }

  const check = (): void => {
    if (timer !== undefined) {
      view.clearTimeout(timer)
      timer = undefined
    }
    let changed = false
    for (const entry of entries.values()) {
      const primary = entry.primary
      const intact = primary !== null && primary.isConnected && primary.getAttribute(MARK_ATTR) === entry.spec.uid
      if (intact && entry.spec.scope === 'instance') continue
      const found = intact ? primary : findAgain(entry)
      if (found === null) {
        if (!entry.detached) changed = true
        detach(entry)
        continue
      }
      const before = entry.elements
      attach(entry, found)
      if (before.length !== entry.elements.length || before.some((element, index) => element !== entry.elements[index])) changed = true
    }
    if (changed) rebuild('preview: re-attach after the page changed')
    placeMoves()
  }

  const observer = new view.MutationObserver((records) => {
    if (timer !== undefined || (entries.size === 0 && options.onPageChange === undefined)) return
    // A move of primp's own is not the page changing.
    if (records.every(isOwnMoveRecord)) return
    // A timer, not an animation frame: frames do not run in a hidden tab.
    timer = view.setTimeout(() => {
      check()
      options.onPageChange?.()
    }, CHECK_DELAY_MS)
  })
  // Of the attributes only primp's mark is watched (a framework may rewrite it away). The marker of a
  // forced state (`data-primp-force`, states.ts) is primp's own write and deliberately not in the filter.
  observer.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: [MARK_ATTR] })

  const register = (spec: PreviewSpec): Entry => {
    let entry = entries.get(spec.itemId)
    if (entry === undefined) entries.set(spec.itemId, (entry = { spec, primary: null, elements: [], detached: false }))
    else entry.spec = spec
    return entry
  }

  return {
    apply(spec, element) {
      const entry = register(spec)
      attach(entry, element)
      rebuild('preview: apply')
      placeMoves()
      return entry.elements
    },
    restore(spec) {
      const entry = register(spec)
      const found = findAgain(entry)
      if (found === null) {
        detach(entry)
        placeMoves()
        return null
      }
      attach(entry, found)
      rebuild('preview: restore')
      placeMoves()
      return entry.elements
    },
    remove(itemId) {
      const entry = entries.get(itemId)
      if (entry === undefined) return
      entries.delete(itemId)
      if (muted.includes(itemId)) muted = muted.filter((id) => id !== itemId)
      rebuild('preview: remove')
      placeMoves()
      unmark(entry.elements)
    },
    has: (itemId) => entries.has(itemId),
    elementsOf: (itemId) => entries.get(itemId)?.elements ?? [],
    elementByUid: (uid) => doc.querySelector(`[${MARK_ATTR}=${quoted(uid)}]`),
    isDetached: (itemId) => entries.get(itemId)?.detached ?? false,
    suspend(reason = 'preview: suspend') {
      depth++
      rebuild(reason)
      placeMoves()
    },
    resume(reason = 'preview: resume') {
      if (depth > 0) depth--
      rebuild(reason)
      placeMoves()
    },
    suspended: () => depth > 0,
    mute(itemId) {
      muted = itemId === null ? [] : typeof itemId === 'string' ? [itemId] : [...itemId]
      rebuild('preview: measure without one edit')
      placeMoves()
    },
    check,
    css: () => text,
    dispose() {
      observer.disconnect()
      if (timer !== undefined) view.clearTimeout(timer)
      const all = [...entries.values()].flatMap((entry) => entry.elements)
      entries.clear()
      rebuild('preview: dispose')
      placeMoves()
      unmark(all)
      doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((other) => other !== sheet)
    },
  }
}
