/**
 * The dock's controller: the one place where edits are made, recorded, previewed and sent.
 *
 * The UI and the test handle (`window.__reglet_test`) call the same methods here, so a scripted
 * test exercises the code a person's click does.
 *
 * Rules it keeps:
 *   - an edit of the same element, property and condition updates the draft that exists and
 *     keeps its ORIGINAL before values; an edit that restores the original deletes the draft
 *     (the merge rules are the engine's, packages/engine/src/items.ts);
 *   - every creation, update and deletion of a draft goes to the server and can be undone;
 *   - the server's `session:state` is the truth for every status after `draft`;
 *   - one action at a time: actions queue behind each other, because measuring side effects
 *     waits for a frame.
 */

import { batch, effect } from '@preact/signals'
import { deriveExpectations } from '@reglet/engine/expect'
import { editKey, emptyHistory, historyReducer, upsertEdit } from '@reglet/engine/items'
import type { ChangeItem, Condition, SideEffect, SourceLoc, StructuralChange, StyleChange } from '@reglet/protocol/change'
import type { ServerMessage, SessionInfo } from '@reglet/protocol/messages'
import { collectEvidence } from '@reglet/source/browser/index'
import type { RegletBus } from '../bus.ts'
import { describeBystander, findBystanders, valuesOf } from '../probe/bystanders.ts'
import { measureEffects, type EffectsResult } from '../probe/effects.ts'
import { measure, type MeasureRequest, type Measurement } from '../probe/measure.ts'
import { createPreview, type Preview, type PreviewSpec } from '../probe/preview.ts'
import { computedLonghands, computedValue, isCustomProperty, isSupportedProperty, isValidValue } from '../probe/properties.ts'
import { buildRef, labelOf, locate, setUidPrefix, uidOf } from '../probe/ref.ts'
import { createPicker, neighbour, type Picker } from '../probe/select.ts'
import { originOf, readStyles } from '../probe/styles.ts'
import { createStore, type Crumb, type Selection, type ShiftState, type Store } from './store.ts'
import { bySeq, diffLists, reconcile, withServerTruth } from './sync.ts'

export type EditResult = { ok: true; item: ChangeItem | null } | { ok: false; error: string }

export type EffectsCost = Pick<EffectsResult, 'ms' | 'parts' | 'elements' | 'partial'>

export interface StyleEditOptions {
  /** `@media` query to scope the edit to; null: none. Default: the dock's current media control. */
  media?: string | null
  scope?: 'instance' | 'all-instances'
}

export interface ControllerOptions {
  bus: RegletBus
  /** Puts text on the clipboard; resolves false when that was refused. */
  copy?: (text: string) => Promise<boolean>
}

export interface Controller {
  store: Store
  preview: Preview
  picker: Picker
  select(element: Element | null): void
  /** Moves the selection with an arrow key (parent, first child, siblings). */
  navigate(key: string): void
  setPickMode(on: boolean): void
  setStyle(property: string, value: string, options?: StyleEditOptions): Promise<EditResult>
  structural(op: 'hide' | 'remove'): Promise<EditResult>
  deleteItem(id: string): void
  setVerdict(id: string, effectIndex: number, verdict: SideEffect['verdict']): void
  setNote(id: string, note: string): void
  undo(): void
  redo(): void
  /** Sends every draft; resolves with the prompt (empty when there was nothing to send). */
  send(): Promise<string>
  /** Sends the layout-shift recording now and resolves with the report that comes back. */
  requestShifts(): Promise<ShiftState>
  measure(items: MeasureRequest): Measurement
  reverify(ids: string[]): void
  /** Resolves once the first `session:state` has arrived. */
  ready(): Promise<void>
  /** Resolves when every queued action has finished. */
  idle(): Promise<void>
  /** Re-reads the styles of the selected element (after the viewport or the page changed). */
  refresh(): void
  /** Replaces the clipboard function once the UI knows the best document to copy from. */
  setCopy(copy: (text: string) => Promise<boolean>): void
  /** Puts text on the clipboard; false when the browser refused. */
  copy(text: string): Promise<boolean>
  /** Cost of the last side-effect measurement, for the budget check. */
  lastEffects(): EffectsCost | null
}

/**
 * Drafts are also kept in the tab's sessionStorage. A dev server's own client (Vite's, for one)
 * reloads the page when its connection through the proxy comes back, so after reglet was
 * restarted the page that held the drafts is gone and the new session is empty: without this
 * copy the drafts would be lost with nobody having deleted them.
 */
const DRAFTS_KEY = 'reglet:drafts'
const MAX_STORED_DRAFTS = 200
/** How long Send waits for source positions that are still being resolved. */
const SEND_WAITS_FOR_SOURCES_MS = 3000
const SHIFT_QUIET_MS = 3000
const SHIFT_DEBOUNCE_MS = 1500
const RESOLVE_TIMEOUT_MS = 15000
const SEND_TIMEOUT_MS = 15000
const RESTORE_DELAY_MS = 250

/** Drafts are only taken back into the project they were made in: another project can come up on the same port. */
const projectKey = (info: SessionInfo): string => `${info.projectName}|${info.target}`

function loadDrafts(project: string): ChangeItem[] {
  try {
    const raw = sessionStorage.getItem(DRAFTS_KEY)
    const stored = raw === null ? null : (JSON.parse(raw) as { project?: unknown; drafts?: unknown } | null)
    if (stored === null || stored.project !== project || !Array.isArray(stored.drafts)) return []
    return (stored.drafts as ChangeItem[]).filter((item) => typeof item === 'object' && item !== null && typeof item.id === 'string' && item.status === 'draft' && typeof item.target?.uid === 'string')
  } catch {
    return []
  }
}

function saveDrafts(project: string, drafts: readonly ChangeItem[]): void {
  try {
    if (drafts.length === 0) sessionStorage.removeItem(DRAFTS_KEY)
    else sessionStorage.setItem(DRAFTS_KEY, JSON.stringify({ project, drafts: drafts.slice(-MAX_STORED_DRAFTS) }))
  } catch {
    // Storage is blocked or full: the drafts then only live as long as the page and the server.
  }
}

/** Key of the engine's one-line summary of an edit: it belongs to one version of the item. */
export function summaryKey(item: ChangeItem): string {
  return `${item.id}|${item.kind === 'style' ? item.after.authored : item.op}`
}

export function specOf(item: ChangeItem): PreviewSpec {
  const spec: PreviewSpec = {
    itemId: item.id,
    uid: item.target.uid,
    locator: item.target.locator,
    scope: item.kind === 'style' ? item.scope : 'instance',
    declarations: item.kind === 'style' ? [{ property: item.property, value: item.after.authored }] : [{ property: 'display', value: 'none' }],
    seq: item.seq,
  }
  if (item.kind === 'style' && item.condition.media !== undefined && item.condition.media !== '') spec.media = item.condition.media
  return spec
}

export function createController(options: ControllerOptions): Controller {
  const { bus } = options
  let copy = options.copy ?? (async () => false)
  const page = location.pathname + location.search
  const store = createStore(page)
  setUidPrefix(`${bus.doc.slice(0, 6)}-`)

  const tombstones = new Set<string>()
  const sources = new WeakMap<Element, SourceLoc | null>()
  let counter = 0
  let awaitingFirstState = true
  let readyResolve: (() => void) | undefined
  const readyPromise = new Promise<void>((resolve) => (readyResolve = resolve))

  // The tab's own copy of the drafts follows the list from the first session state on.
  effect(() => {
    const info = store.info.value
    const drafts = store.allDrafts.value
    if (info !== null) saveDrafts(projectKey(info), drafts)
  })

  const present = (): ChangeItem[] => store.history.value.present
  const newId = (prefix: string): string => `${prefix}_${bus.doc.slice(0, 6)}_${(++counter).toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const nextSeq = (): number => present().reduce((max, item) => Math.max(max, item.seq), -1) + 1

  // -------------------------------------------------------------------------
  // Previews
  // -------------------------------------------------------------------------

  const preview = createPreview({
    onDetached(itemId, detached) {
      const next = new Set(store.detached.value)
      if (detached) next.add(itemId)
      else next.delete(itemId)
      store.detached.value = next
    },
  })

  const forget = (id: string): void => {
    preview.remove(id)
    if (store.detached.value.has(id)) {
      const next = new Set(store.detached.value)
      next.delete(id)
      store.detached.value = next
    }
  }

  const syncPreview = (item: ChangeItem): void => {
    if (item.status === 'draft' && item.page === page) preview.restore(specOf(item))
    else forget(item.id)
  }

  /** The server numbers the items; a draft goes out with seq 0. */
  const upsert = (item: ChangeItem): void => bus.send({ type: 'session:upsert', item: { ...item, seq: 0 } })

  /** Brings previews and the server in line with a change of the item list the dock made itself. */
  const publish = (before: readonly ChangeItem[], after: readonly ChangeItem[]): void => {
    const diff = diffLists(before, after)
    for (const id of diff.deletes) {
      forget(id)
      const old = before.find((item) => item.id === id)
      if (old !== undefined && old.status === 'draft') {
        tombstones.add(id)
        bus.send({ type: 'session:delete', id })
      }
    }
    for (const item of diff.upserts) {
      syncPreview(item)
      if (item.status === 'draft') {
        tombstones.delete(item.id)
        upsert(item)
      }
    }
  }

  /** A user edit: undoable. A list that changes nothing is not an edit. */
  const commit = (next: ChangeItem[]): void => {
    const before = present()
    const diff = diffLists(before, next)
    if (diff.upserts.length === 0 && diff.deletes.length === 0) return
    store.history.value = historyReducer(store.history.value, { type: 'commit', items: next })
    publish(before, next)
  }

  const step = (direction: 'undo' | 'redo'): void => {
    const state = store.history.value
    const moved = historyReducer(state, { type: direction })
    if (moved === state) return
    const target = withServerTruth(moved.present, state.present)
    store.history.value = { ...moved, present: target }
    publish(state.present, target)
    store.error.value = null
    refresh()
  }

  // -------------------------------------------------------------------------
  // Actions run one after the other
  // -------------------------------------------------------------------------

  let tail: Promise<unknown> = Promise.resolve()
  let queued = 0
  const enqueue = <T>(action: () => Promise<T>): Promise<T> => {
    queued++
    store.busy.value = true
    const run = tail.then(action)
    tail = run.then(
      () => undefined,
      () => undefined,
    )
    void tail.then(() => {
      if (--queued === 0) store.busy.value = false
    })
    return run
  }

  const fail = (error: string): EditResult => {
    store.error.value = error
    return { ok: false, error }
  }

  // -------------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------------

  const crumbsOf = (element: Element): Crumb[] => {
    const crumbs: Crumb[] = []
    for (let current: Element | null = element; current !== null && crumbs.length < 5; current = current.parentElement) {
      if (current.localName === 'html' || current.localName === 'body') break
      crumbs.unshift({ label: labelOf(current).split(' "')[0] ?? current.localName, element: current })
    }
    return crumbs
  }

  const describe = (element: Element): Selection => {
    const ref = buildRef(element, sources.get(element) ?? null)
    return {
      element,
      ref,
      styles: readStyles(element),
      instances: ref.instanceCount,
      crumbs: crumbsOf(element),
      hasChild: neighbour(element, 'ArrowDown') !== null,
    }
  }

  const pendingResolves = new Map<string, (source: SourceLoc | null) => void>()
  let sourcesIdle: (() => void)[] = []
  const settleSources = (): void => {
    if (pendingResolves.size > 0) return
    for (const resolve of sourcesIdle.splice(0)) resolve()
  }
  /** Resolves when no source lookup is pending, or after `ms`. */
  const sourcesSettled = (ms: number): Promise<void> =>
    pendingResolves.size === 0
      ? Promise.resolve()
      : new Promise((resolve) => {
          sourcesIdle.push(resolve)
          window.setTimeout(resolve, ms)
        })

  /** Asks the server where `element` comes from. `answered` is false when no answer came in time. */
  const askSource = (element: Element, done: (source: SourceLoc | null, answered: boolean) => void): void => {
    if (sources.has(element)) {
      done(sources.get(element) ?? null, true)
      return
    }
    let evidence: unknown
    try {
      evidence = collectEvidence(element)
    } catch {
      done(null, false)
      return
    }
    const reqId = newId('r')
    const timer = window.setTimeout(() => {
      pendingResolves.delete(reqId)
      done(null, false)
      settleSources()
    }, RESOLVE_TIMEOUT_MS)
    pendingResolves.set(reqId, (source) => {
      window.clearTimeout(timer)
      sources.set(element, source)
      done(source, true)
    })
    bus.send({ type: 'session:resolve', reqId, evidence })
  }

  const onResolved = (message: Extract<ServerMessage, { type: 'session:resolved' }>): void => {
    const pending = pendingResolves.get(message.reqId)
    pendingResolves.delete(message.reqId)
    pending?.(message.source)
    settleSources()
  }

  const resolveSource = (element: Element): void => {
    if (!sources.has(element)) store.source.value = { state: 'resolving', loc: null }
    askSource(element, (source, answered) => {
      const selection = store.selection.value
      if (selection?.element === element) {
        store.source.value = { state: answered ? 'done' : 'failed', loc: source }
        if (selection.ref.source !== source) store.selection.value = { ...selection, ref: { ...selection.ref, source } }
      }
      if (source === null) return
      // Drafts recorded before the answer arrived learn their source now. Not an undo step.
      const uid = uidOf(element)
      const before = present()
      const after = before.map((item) => (item.status === 'draft' && item.target.uid === uid && item.target.source === null ? { ...item, target: { ...item.target, source } } : item))
      if (after.some((item, index) => item !== before[index])) {
        store.history.value = historyReducer(store.history.value, { type: 'replace', items: after })
        for (const item of diffLists(before, after).upserts) upsert(item)
      }
    })
  }

  const select = (element: Element | null): void => {
    store.error.value = null
    if (element === null) {
      batch(() => {
        store.selection.value = null
        store.source.value = null
      })
      return
    }
    const selection = describe(element)
    batch(() => {
      store.selection.value = selection
      const media = store.media.value
      if (media !== null && !selection.styles.media.some((option) => option.query === media && option.matches)) store.media.value = null
      if (selection.instances < 2) store.scope.value = 'instance'
    })
    resolveSource(element)
  }

  function refresh(): void {
    const selection = store.selection.value
    if (selection === null) return
    let element: Element | null = selection.element
    if (!element.isConnected) element = preview.elementByUid(selection.ref.uid) ?? locate(selection.ref.locator).element
    if (element === null) {
      select(null)
      return
    }
    if (element !== selection.element) {
      select(element)
      return
    }
    store.selection.value = describe(element)
  }

  // -------------------------------------------------------------------------
  // Pick mode
  // -------------------------------------------------------------------------

  const setPickMode = (on: boolean): void => {
    if (on) picker.start()
    else picker.stop()
    batch(() => {
      store.pickMode.value = on
      if (!on) store.hovered.value = null
    })
  }

  const picker = createPicker({
    onHover: (element) => (store.hovered.value = element),
    onPick(element, how) {
      select(element)
      // A click ends pick mode, as it does in a browser's inspector; the keyboard keeps exploring.
      if (how === 'pointer') setPickMode(false)
    },
    onCancel: () => setPickMode(false),
    current: () => store.selection.value?.element ?? null,
    onHistory: (direction) => step(direction),
  })

  const navigate = (key: string): void => {
    const from = store.selection.value?.element ?? store.hovered.value
    if (from === null || from === undefined) return
    const next = neighbour(from, key)
    if (next !== null) select(next)
  }

  // -------------------------------------------------------------------------
  // Edits
  // -------------------------------------------------------------------------

  const condition = (media: string | null): Condition => {
    const out: Condition = {
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
      colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    }
    if (media !== null && media !== '') out.media = media
    return out
  }

  const mediaMatches = (query: string): boolean => {
    try {
      return matchMedia(query).matches
    } catch {
      return false
    }
  }

  let lastEffects: EffectsCost | null = null
  /** The source may have been resolved while the edit was waiting for its frame. */
  const withKnownSource = (ref: ChangeItem['target'], element: Element): ChangeItem['target'] => {
    const known = sources.get(element)
    return ref.source === null && known !== undefined && known !== null ? { ...ref, source: known } : ref
  }

  const remember = (item: ChangeItem, effects: EffectsResult): void => {
    lastEffects = { ms: effects.ms, parts: effects.parts, elements: effects.elements, partial: effects.partial }
    const next = new Map(store.summaries.value)
    next.set(summaryKey(item), effects.summary)
    store.summaries.value = next
  }

  /** The selected element, found again if the page replaced it since it was selected. */
  const target = (): Selection | null => {
    refresh()
    return store.selection.value
  }

  const setStyle = (rawProperty: string, rawValue: string, edit: StyleEditOptions = {}): Promise<EditResult> =>
    enqueue(async () => {
      store.error.value = null
      const selection = target()
      if (selection === null) return fail('Select an element first.')
      const element = selection.element
      const typed = rawProperty.trim()
      const property = isCustomProperty(typed) ? typed : typed.toLowerCase()
      const value = rawValue.trim().replace(/;+$/, '').trim()
      if (!isSupportedProperty(property)) return fail(`"${typed}" is not a CSS property this browser knows.`)
      if (!isValidValue(property, value)) return fail(`"${value}" is not a valid value for ${property}.`)
      const media = edit.media === undefined ? store.media.value : edit.media
      const scope = edit.scope ?? store.scope.value
      if (media !== null && media !== '' && !mediaMatches(media)) {
        return fail(`The viewport does not match @media ${media}. Resize the window until it does to edit under it.`)
      }

      const uid = uidOf(element)
      const draft: StyleChange = {
        id: '',
        seq: nextSeq(),
        createdAt: Date.now(),
        page,
        status: 'draft',
        target: { ...selection.ref, uid },
        sideEffects: [],
        expect: [],
        kind: 'style',
        property,
        scope,
        before: { computed: '' },
        after: { authored: value, computed: '' },
        condition: condition(media),
        stylingSystem: selection.styles.system,
      }
      const key = editKey(draft)
      const existing = present().find((item): item is StyleChange => item.kind === 'style' && item.status === 'draft' && editKey(item) === key)
      draft.id = existing?.id ?? newId('c')

      // Measure "before" on the page without this edit's own earlier preview.
      preview.mute(draft.id)
      const styleBefore = getComputedStyle(element)
      draft.before = { computed: computedValue(element, property, styleBefore) }
      const longhandsBefore = computedLonghands(element, property, styleBefore)
      const where = originOf(selection.styles, property)
      if (where.authored !== undefined) draft.before.authored = where.authored
      draft.origin = where.origin
      draft.stylingSystem = where.system
      // Who else the rule behind the old value styles, and what they look like before this edit is previewed.
      const witnessed = longhandsBefore === undefined ? [property] : Object.keys(longhandsBefore)
      const others = where.origin.via === 'rule' && where.ruleSelector !== undefined ? findBystanders(where.ruleSelector, element, scope) : null
      const bystanders = (others?.elements ?? []).map((other) => ({ element: other, record: describeBystander(other, witnessed) }))

      const spec = specOf(draft)
      const effects = await measureEffects(() => {
        const elements = preview.apply(spec, element)
        preview.mute(null)
        return elements
      })

      const styleAfter = getComputedStyle(element)
      draft.after.computed = computedValue(element, property, styleAfter)
      const longhandsAfter = computedLonghands(element, property, styleAfter)
      if (longhandsBefore !== undefined && longhandsAfter !== undefined) {
        draft.longhands = {}
        for (const name of Object.keys(longhandsAfter)) draft.longhands[name] = { before: longhandsBefore[name] ?? '', after: longhandsAfter[name] ?? '' }
      }
      draft.sideEffects = effects.sideEffects
      if (effects.partial) draft.sideEffectsPartial = true
      draft.target = withKnownSource(draft.target, element)
      if (others !== null) {
        draft.origin = { ...where.origin, alsoStyles: others.count }
        if (bystanders.length > 0) {
          // The preview styles only the changed elements. A bystander value that moved with it anyway follows
          // them (a size the layout resolves, something inherited) and would move with a correct edit too: no witness.
          draft.bystanders = bystanders.map(({ element: other, record }) => {
            const now = valuesOf(other, witnessed)
            return { ...record, values: Object.fromEntries(Object.entries(record.values).filter(([name, value]) => now[name] === value)) }
          })
        }
      }
      draft.expect = deriveExpectations(draft)

      const next = upsertEdit(present(), draft)
      const stored = next.find((item) => item.id === draft.id) ?? null
      commit(next)
      if (stored === null) forget(draft.id)
      else remember(stored, effects)
      refresh()
      return { ok: true, item: stored }
    })

  const structural = (op: 'hide' | 'remove'): Promise<EditResult> =>
    enqueue(async () => {
      store.error.value = null
      const selection = target()
      if (selection === null) return fail('Select an element first.')
      const element = selection.element
      const uid = uidOf(element)
      const earlier = present().filter((item): item is StructuralChange => item.kind === 'structure' && item.status === 'draft' && item.target.uid === uid)
      const same = earlier.find((item) => item.op === op)
      if (same !== undefined) return { ok: true, item: same }
      // Hide and remove of one element replace each other.
      const replaced = earlier[0]
      if (replaced !== undefined) preview.mute(replaced.id)
      const item: StructuralChange = {
        id: newId('c'),
        seq: nextSeq(),
        createdAt: Date.now(),
        page,
        status: 'draft',
        target: { ...buildRef(element, sources.get(element) ?? null), uid },
        sideEffects: [],
        expect: [],
        kind: 'structure',
        op,
      }
      const effects = await measureEffects(() => {
        const elements = preview.apply(specOf(item), element)
        preview.mute(null)
        return elements
      })
      item.sideEffects = effects.sideEffects
      if (effects.partial) item.sideEffectsPartial = true
      item.target = withKnownSource(item.target, element)
      item.expect = deriveExpectations(item)
      commit(upsertEdit(replaced === undefined ? present() : present().filter((other) => other.id !== replaced.id), item))
      remember(item, effects)
      refresh()
      return { ok: true, item }
    })

  const update = (id: string, change: (item: ChangeItem) => ChangeItem): void => {
    const before = present()
    const next = before.map((item) => (item.id === id && item.status === 'draft' ? change(item) : item))
    if (next.some((item, index) => item !== before[index])) commit(next)
  }

  const deleteItem = (id: string): void => {
    const before = present()
    const next = before.filter((item) => !(item.id === id && item.status === 'draft'))
    if (next.length === before.length) return
    commit(next)
    refresh()
  }

  const setVerdict = (id: string, effectIndex: number, verdict: SideEffect['verdict']): void =>
    update(id, (item) => {
      if (item.sideEffects[effectIndex] === undefined || item.sideEffects[effectIndex].verdict === verdict) return item
      const sideEffects = item.sideEffects.map((effect, index) => (index === effectIndex ? { ...effect, verdict } : effect))
      const changed = { ...item, sideEffects }
      return { ...changed, expect: deriveExpectations(changed) }
    })

  const setNote = (id: string, note: string): void =>
    update(id, (item) => {
      const text = note.trim()
      if ((item.note ?? '') === text) return item
      const { note: _old, ...rest } = item
      void _old
      return (text === '' ? rest : { ...rest, note: text }) as ChangeItem
    })

  // -------------------------------------------------------------------------
  // Send
  // -------------------------------------------------------------------------

  const pendingSends = new Map<string, (message: Extract<ServerMessage, { type: 'session:sent' }>) => void>()

  const send = (): Promise<string> =>
    enqueue(async () => {
      store.error.value = null
      if (store.allDrafts.value.length === 0) return ''
      if (!bus.connected()) {
        store.error.value = 'Not connected to reglet. The changes are kept; send again once it is back.'
        throw new Error(store.error.value)
      }
      store.sending.value = true
      try {
        // An item sent without its source position stays without it: give pending lookups a moment.
        await sourcesSettled(SEND_WAITS_FOR_SOURCES_MS)
        const drafts = store.allDrafts.value
        const reqId = newId('s')
        const answer = await new Promise<Extract<ServerMessage, { type: 'session:sent' }>>((resolve, reject) => {
          const timer = window.setTimeout(() => {
            pendingSends.delete(reqId)
            reject(new Error('reglet did not answer the send request.'))
          }, SEND_TIMEOUT_MS)
          pendingSends.set(reqId, (message) => {
            window.clearTimeout(timer)
            pendingSends.delete(reqId)
            resolve(message)
          })
          bus.send({ type: 'session:send', reqId, ids: drafts.map((item) => item.id) })
        })
        const sent = new Map(answer.batch.items.map((item) => [item.id, item]))
        if (sent.size === 0) {
          store.error.value = 'Nothing was sent: the server holds none of these changes as drafts.'
          return ''
        }
        // The agent's hot reload must land on an untouched page: the sent previews go now.
        for (const id of sent.keys()) forget(id)
        const items = present()
          .map((item) => sent.get(item.id) ?? item)
          .sort(bySeq)
        // Sent items cannot be un-sent: the undo history ends here.
        store.history.value = emptyHistory(items)
        const copied = await copy(answer.batch.prompt)
        store.sent.value = { prompt: answer.batch.prompt, count: sent.size, copied }
        refresh()
        return answer.batch.prompt
      } catch (error) {
        store.error.value = error instanceof Error ? error.message : String(error)
        throw error
      } finally {
        store.sending.value = false
      }
    })

  // -------------------------------------------------------------------------
  // Server state
  // -------------------------------------------------------------------------

  const whenLoaded = (action: () => void): void => {
    const later = (): number => window.setTimeout(action, RESTORE_DELAY_MS)
    if (document.readyState === 'complete') later()
    else addEventListener('load', later, { once: true })
  }

  const onState = (message: Extract<ServerMessage, { type: 'session:state' }>): void => {
    const first = awaitingFirstState
    awaitingFirstState = false
    // On the first state of this document: the drafts this tab held before the page was reloaded.
    const kept = store.info.value === null ? loadDrafts(projectKey(message.info)).filter((item) => !present().some((other) => other.id === item.id)) : []
    const before = kept.length === 0 ? present() : [...present(), ...kept]
    const result = reconcile(before, message.items, { first, deleted: tombstones })
    batch(() => {
      store.info.value = message.info
      if (kept.length > 0 || diffLists(before, result.items).upserts.length > 0 || before.length !== result.items.length) {
        // The numbers the server gave the drafts also go into the undo history, so that stepping
        // through it does not look like a change of the items.
        const seqOf = new Map(result.items.map((item) => [item.id, item.seq]))
        const renumber = (list: ChangeItem[]): ChangeItem[] =>
          list.map((item) => {
            const seq = seqOf.get(item.id)
            return seq === undefined || seq === item.seq ? item : { ...item, seq }
          })
        const history = store.history.value
        store.history.value = { past: history.past.map(renumber), present: result.items, future: history.future.map(renumber) }
      }
      store.ready.value = true
    })
    for (const id of result.released) forget(id)
    for (const item of result.resend) upsert(item)
    // Drafts from before a reload get their previews back once the page has built itself.
    // ... and so do the drafts this tab kept over a reload.
    const keptIds = new Set(kept.map((item) => item.id))
    const mine = result.items.filter((item) => item.page === page && item.status === 'draft' && (keptIds.has(item.id) || result.adopted.includes(item)))
    if (mine.length > 0) {
      whenLoaded(() => {
        void enqueue(async () => {
          for (const item of mine) if (present().some((other) => other.id === item.id && other.status === 'draft')) syncPreview(item)
        })
      })
    }
    readyResolve?.()
  }

  // -------------------------------------------------------------------------
  // Layout shifts
  // -------------------------------------------------------------------------

  let shiftTimer: number | undefined
  let shiftsSent = 0
  const shiftWaiters = new Set<(state: ShiftState) => void>()

  const sendShifts = (): void => {
    shiftTimer = undefined
    const hook = window.__reglet
    if (hook === undefined) return
    shiftsSent++
    store.shiftsPending.value = true
    try {
      bus.send({ type: 'session:shifts', doc: bus.doc, recording: hook.recording() })
    } catch {
      store.shiftsPending.value = false
    }
  }

  const armShifts = (delay: number): void => {
    if (shiftTimer !== undefined) window.clearTimeout(shiftTimer)
    shiftTimer = window.setTimeout(sendShifts, delay)
  }

  const watchShifts = (): void => {
    const hook = window.__reglet
    if (hook === undefined) return
    const start = (): void => armShifts(SHIFT_QUIET_MS)
    if (document.readyState === 'complete') start()
    else addEventListener('load', start, { once: true })
    hook.onShift((entry) => {
      if (document.readyState !== 'complete') return
      // Before the first report every entry restarts the quiet period; afterwards only the page's own shifts matter.
      if (shiftsSent === 0) armShifts(SHIFT_QUIET_MS)
      else if (entry.selfInduced === undefined) armShifts(SHIFT_DEBOUNCE_MS)
    })
  }

  const onShiftReport = (message: Extract<ServerMessage, { type: 'session:shift-report' }>): void => {
    if (message.doc !== bus.doc) return
    const state: ShiftState = { report: message.report, culpritSources: message.culpritSources, receivedAt: performance.now() }
    batch(() => {
      store.shifts.value = state
      store.shiftsPending.value = false
    })
    for (const waiter of [...shiftWaiters]) waiter(state)
    improveCulpritSources(state)
  }

  /**
   * The server names a culprit's source from the recording alone, which for an element a
   * framework rendered is at best a guess. Where the culprit is still in the page, the
   * element itself is asked about, and a better answer replaces the server's.
   */
  const improveCulpritSources = (state: ShiftState): void => {
    const rank = (source: SourceLoc | null | undefined): number => (source === null || source === undefined || source.file === undefined ? 0 : source.level === 'exact' ? 3 : source.level === 'file' ? 2 : 1)
    for (const issue of state.report.issues.slice(0, 12)) {
      const culprit = issue.culprit
      if (culprit === undefined || rank(state.culpritSources[issue.id]) === 3) continue
      let element: Element | null = null
      try {
        element = culprit.node.selector === '' ? null : document.querySelector(culprit.node.selector)
      } catch {
        // A selector this document cannot parse: leave the server's answer.
      }
      if (element === null || element.localName !== culprit.node.tag) continue
      askSource(element, (source) => {
        const current = store.shifts.value
        if (source === null || current === null || current.report !== state.report) return
        if (rank(source) <= rank(current.culpritSources[issue.id])) return
        store.shifts.value = { ...current, culpritSources: { ...current.culpritSources, [issue.id]: source } }
      })
    }
  }

  const requestShifts = (): Promise<ShiftState> =>
    new Promise((resolve, reject) => {
      if (window.__reglet === undefined) {
        reject(new Error('the layout-shift recorder is not on this page'))
        return
      }
      const timer = window.setTimeout(() => {
        shiftWaiters.delete(waiter)
        reject(new Error('no shift report arrived'))
      }, 10000)
      const waiter = (state: ShiftState): void => {
        window.clearTimeout(timer)
        shiftWaiters.delete(waiter)
        resolve(state)
      }
      shiftWaiters.add(waiter)
      if (shiftTimer !== undefined) window.clearTimeout(shiftTimer)
      sendShifts()
    })

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  const measureNow = (items: MeasureRequest): Measurement => measure(items, preview)

  bus.on('*', (event) => {
    switch (event.type) {
      case 'bus:open':
        store.connected.value = true
        // A server that restarted may have lost the drafts: the next state message settles it.
        if (event.reconnect) awaitingFirstState = true
        break
      case 'bus:close':
        store.connected.value = false
        break
      case 'session:state':
        onState(event)
        break
      case 'session:resolved':
        onResolved(event)
        break
      case 'session:sent':
        pendingSends.get(event.reqId)?.(event)
        break
      case 'session:shift-report':
        onShiftReport(event)
        break
      case 'session:measure': {
        const result = measureNow(event.items)
        bus.send({ type: 'session:measured', reqId: event.reqId, visible: result.visible, results: result.results })
        break
      }
      case 'session:reload':
        location.reload()
        break
    }
  })
  store.connected.value = bus.connected()

  document.addEventListener('visibilitychange', () => {
    bus.send({ type: 'session:visibility', doc: bus.doc, visible: document.visibilityState === 'visible' })
  })

  let resizeTimer: number | undefined
  addEventListener('resize', () => {
    if (resizeTimer !== undefined) window.clearTimeout(resizeTimer)
    resizeTimer = window.setTimeout(refresh, 150)
  })

  watchShifts()

  return {
    store,
    preview,
    picker,
    select,
    navigate,
    setPickMode,
    setStyle,
    structural,
    deleteItem,
    setVerdict,
    setNote,
    undo: () => step('undo'),
    redo: () => step('redo'),
    send,
    requestShifts,
    measure: measureNow,
    reverify: (ids) => bus.send({ type: 'session:reverify', ids }),
    ready: () => readyPromise,
    idle: () => tail.then(() => undefined),
    refresh,
    setCopy(next) {
      copy = next
    },
    copy: (text) => copy(text),
    lastEffects: () => lastEffects,
  }
}
