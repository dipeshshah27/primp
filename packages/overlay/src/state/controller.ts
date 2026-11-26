/**
 * The dock's controller: the one place where edits are made, recorded, previewed and sent.
 *
 * The UI and the test handle (`window.__primp_test`) call the same methods here, so a scripted
 * test exercises the code a person's click does.
 *
 * Rules it keeps:
 *   - an edit of the same element, property and condition updates the draft that exists and
 *     keeps its ORIGINAL before values; an edit that restores the original deletes the draft
 *     (the merge rules are the engine's, packages/engine/src/items.ts);
 *   - every creation, update and deletion of a draft goes to the server and can be undone;
 *   - the server's `session:state` is the truth for every status after `draft`;
 *   - one action at a time: actions queue behind each other, because measuring side effects
 *     waits for a frame;
 *   - while a state is chosen (`store.state`) the selected element is held in it with
 *     `forceState` (probe/states.ts). `holdState()` is the one function that brings the page in
 *     line with the State control; it is called after everything that could put them apart;
 *   - a gesture is one undo step: `setStyles` (and `resize`, which is `setStyles` of width and
 *     height) records one item per property after ONE side-effect measurement; `setStyle` is
 *     its single-property case. While a handle is dragged only `previewSize` runs (one preview
 *     rule, nothing recorded or sent);
 *   - a reorder (`reorder`, `move`) moves the element among the element children of its parent
 *     only, with a preview that really moves the node (probe/preview.ts) and is put back for
 *     every measurement and on Send. It ignores the State control.
 */

import { batch, effect } from '@preact/signals'
import { deriveExpectations } from '@primp/engine/expect'
import { editKey, emptyHistory, historyReducer, upsertEdit } from '@primp/engine/items'
import type { ChangeItem, Condition, ElementState, NoteChange, SideEffect, SiblingAnchor, SourceLoc, StructuralChange, StyleChange } from '@primp/protocol/change'
import type { ServerMessage, SessionInfo } from '@primp/protocol/messages'
import { collectEvidence } from '@primp/source/browser/index'
import type { PrimpBus } from '../bus.ts'
import { describeBystander, findBystanders, valuesOf } from '../probe/bystanders.ts'
import { measureEffects, sameEffect, sameEffects, type EffectsResult } from '../probe/effects.ts'
import { measure, type MeasureRequest, type Measurement } from '../probe/measure.ts'
import { createPreview, type Preview, type PreviewSpec } from '../probe/preview.ts'
import { computedLonghands, computedValue, isCustomProperty, isSupportedProperty, isValidValue } from '../probe/properties.ts'
import { elementChildren, itemOf, positionOf, reorderRefusal } from '../probe/order.ts'
import { buildRef, elementOfUid, labelOf, locate, locatorOf, setUidPrefix, uidOf } from '../probe/ref.ts'
import { pauseMotion, resumeMotion, setSelectCursor } from '../probe/page-mode.ts'
import { createPicker, neighbour, type Picker } from '../probe/select.ts'
import { boxModelOf, cssSizeFor, resizeRefusal } from '../probe/size.ts'
import { forcedNow, forceState } from '../probe/states.ts'
import { originOf, readStyles, statesCovering, type ElementStyles } from '../probe/styles.ts'
import { createStore, type Crumb, type Selection, type ShiftState, type Store } from './store.ts'
import { bySeq, diffLists, reconcile, withServerTruth } from './sync.ts'

/** `items`: every item a gesture of several edits recorded (`setStyles`, `resize`); `item` is the first of them. */
export type EditResult = { ok: true; item: ChangeItem | null; items?: ChangeItem[] } | { ok: false; error: string }

export interface StyleEdit {
  property: string
  value: string
}

/** The border-box size wanted, in CSS px: what a handle drag produces. */
export interface SizeRequest {
  width?: number
  height?: number
}

export type EffectsCost = Pick<EffectsResult, 'ms' | 'parts' | 'elements' | 'partial'>

export interface StyleEditOptions {
  /** `@media` query to scope the edit to; null: none. Default: the dock's current media control. */
  media?: string | null
  scope?: 'instance' | 'all-instances'
  /** The state the edit is for (`:hover`...); null: the resting style. Default: the dock's current State control. */
  state?: ElementState | null
}

export interface ControllerOptions {
  bus: PrimpBus
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
  /**
   * Opens or closes the dock. Open: selection is on (clicks on the page select, Alt lets one
   * through), the cursor is a crosshair. Closed: the selection, the popover and a pause of the
   * page's animations end, and the page gets every event again. The recorded changes stay.
   */
  setOpen(open: boolean): void
  /** The old name of `setOpen`. */
  setPickMode(on: boolean): void
  /** Escape: closes the popover (and lets go of the selection) first, then the dock. */
  escape(): void
  /** Pauses (true) or resumes (false) the page's animations and transitions. */
  setPaused(paused: boolean): void
  /**
   * Writes the note for the selected element (`on: 'element'`) or for the whole page. One note
   * per element (or page): writing again replaces its text, an empty text deletes it. Undoable.
   */
  addNote(text: string, on?: NoteChange['on']): Promise<EditResult>
  /** The draft note of the selected element (`element`) or of this page (`page`), if any. */
  noteOf(on: NoteChange['on']): NoteChange | null
  /** The element a recorded item is about, found again if the page replaced it; null when it is not in the page. */
  elementOf(item: ChangeItem): Element | null
  /** The source position of an element, if it was already resolved (no request is made). */
  knownSource(element: Element): SourceLoc | null | undefined
  /** Renders the prompt the drafts would be sent with and puts it on the clipboard, without sending. */
  copyPrompt(): Promise<{ prompt: string; copied: boolean }>
  /**
   * Chooses the interaction state the selected element is shown in and new edits are made for;
   * null: at rest. The element looks hovered (focused, pressed) without the pointer or the focus
   * being on it, until the state is set back, another element is selected (the state moves with
   * the selection), pick mode starts, or the changes are sent.
   */
  setState(state: ElementState | null): void
  setStyle(property: string, value: string, options?: StyleEditOptions): Promise<EditResult>
  /** Several properties as one gesture: one side-effect measurement, one undo step, one item per property. */
  setStyles(edits: readonly StyleEdit[], options?: StyleEditOptions): Promise<EditResult>
  /**
   * Resizes the selected element to a border-box size (CSS px) by recording `width` and / or
   * `height` for its `box-sizing`, in whole px, as one gesture. Refuses inline elements and a
   * size that does not change the element's box.
   */
  resize(size: SizeRequest, options?: StyleEditOptions): Promise<EditResult>
  /** During a handle drag: shows a size on the page and records nothing; null takes it away. */
  previewSize(size: SizeRequest | null): void
  /** During a grip drag: shows the selected element at `toIndex` among its siblings and records nothing; null puts it back. */
  previewMove(toIndex: number | null): void
  /**
   * What the grip moves for the selection: the selection when it is an item of a list, else the
   * nearest ancestor that is one (the card around a paragraph), else the selection; with the
   * reason it cannot be moved, if any. Null without a selection. Reads signals.
   */
  moveTarget(): { element: Element; refusal: string | null } | null
  /** Moves the selected element to `toIndex` among its parent's element children (from 0). */
  reorder(toIndex: number): Promise<EditResult>
  /** Moves the selected element by `delta` positions among its siblings (-1: earlier, +1: later). */
  move(delta: number): Promise<EditResult>
  /** Why the selected element cannot be moved among its siblings; null when it can. Reads signals, so a component re-renders with it. */
  reorderRefusal(): string | null
  /** Why the selected element cannot be resized; null when it can. */
  resizeRefusal(): string | null
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
  /** Takes primp's marks off the page: the forced state, pick mode and every preview. The items are kept. */
  dispose(): void
}

/**
 * Drafts are also kept in the tab's sessionStorage. A dev server's own client (Vite's, for one)
 * reloads the page when its connection through the proxy comes back, so after primp was
 * restarted the page that held the drafts is gone and the new session is empty: without this
 * copy the drafts would be lost with nobody having deleted them.
 */
const DRAFTS_KEY = 'primp:drafts'
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
  return `${item.id}|${item.kind === 'style' ? item.after.authored : item.kind === 'note' ? item.text : item.op}`
}

export function specOf(item: ChangeItem): PreviewSpec {
  const spec: PreviewSpec = {
    itemId: item.id,
    uid: item.target.uid,
    locator: item.target.locator,
    scope: item.kind === 'style' ? item.scope : 'instance',
    declarations: item.kind === 'style' ? [{ property: item.property, value: item.after.authored }] : item.kind === 'note' || item.op === 'reorder' ? [] : [{ property: 'display', value: 'none' }],
    seq: item.seq,
  }
  // A reorder moves the node (probe/preview.ts); without `move` it is a draft that says nothing to show.
  if (item.kind === 'structure' && item.op === 'reorder' && item.move !== undefined) spec.move = { toIndex: item.move.toIndex }
  if (item.kind === 'style' && item.condition.media !== undefined && item.condition.media !== '') spec.media = item.condition.media
  if (item.kind === 'style' && item.condition.state !== undefined) spec.state = item.condition.state
  return spec
}

export function createController(options: ControllerOptions): Controller {
  const { bus } = options
  let copy = options.copy ?? (async () => false)
  const store = createStore(location.pathname + location.search)
  /** The page the tab shows now: new items are recorded for it, and only its drafts are previewed. */
  const here = (): string => store.route.peek()
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
    onPageChange() {
      followRoute()
      if (store.state.value === null) return
      if (leftRoute()) return
      // A framework may have replaced the selected node, and a dev server a stylesheet: hold the state on what is there now.
      const selection = store.selection.value
      if (selection !== null && !selection.element.isConnected) refresh()
      else holdState()
    },
  })

  /**
   * A client-side navigation to another path: new items are recorded for the new page, its drafts
   * get their previews (found as the framework renders it), and the drafts of the page left lose
   * theirs. They stay recorded and are sent with the others.
   */
  const followRoute = (): void => {
    const now = location.pathname + location.search
    if (now === store.route.peek()) return
    store.route.value = now
    void enqueue(async () => {
      for (const item of present()) if (item.status === 'draft') syncPreview(item)
      const selection = store.selection.peek()
      if (selection !== null && !selection.element.isConnected) refresh()
    })
  }

  const forget = (id: string): void => {
    preview.remove(id)
    if (store.detached.value.has(id)) {
      const next = new Set(store.detached.value)
      next.delete(id)
      store.detached.value = next
    }
  }

  /** `specOf` plus what only the page can tell: the states a resting edit's preview must stay out of. */
  const specFor = (item: ChangeItem, styles?: Pick<ElementStyles, 'rules'>): PreviewSpec => {
    const spec = specOf(item)
    if (item.kind !== 'style' || spec.state !== undefined || styles === undefined) return spec
    const except = statesCovering(styles, item.property)
    if (except.length > 0) spec.exceptIn = except
    return spec
  }

  const syncPreview = (item: ChangeItem): void => {
    // A note changes nothing on the page: it has no preview.
    if (item.status !== 'draft' || item.page !== here() || item.kind === 'note') {
      forget(item.id)
      return
    }
    if (item.kind !== 'style' || item.condition.state !== undefined) {
      preview.restore(specOf(item))
      return
    }
    // A resting edit: its element (found again by the preview if need be) says which states keep their own value.
    const known = preview.elementByUid(item.target.uid) ?? elementOfUid(item.target.uid)
    const spec = specFor(item, known === null ? undefined : readStyles(known))
    const elements = preview.restore(spec)
    const found = elements?.[0]
    if (known === null && found !== undefined) {
      const placed = specFor(item, readStyles(found))
      if (placed.exceptIn !== undefined) preview.restore(placed)
    }
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

  /** Every edit starts with a clean slate: the last refusal is not shown any more. */
  const clearErrors = (): void => {
    store.error.value = null
    store.resizeNote.value = null
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
    const position = positionOf(element)
    return {
      element,
      ref,
      styles: readStyles(element),
      instances: ref.instanceCount,
      crumbs: crumbsOf(element),
      hasChild: neighbour(element, 'ArrowDown') !== null,
      position: position === null ? null : { index: position.index, count: position.siblings.length },
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

  // -------------------------------------------------------------------------
  // The state the selection is shown in
  // -------------------------------------------------------------------------

  /** An edit in flight keeps the element in the state it is made for until it has measured. */
  let pinned = false

  /**
   * Brings the page in line with the State control: the selected element is held in the chosen
   * state, and nothing is held while there is no selection or no state. Safe to call at any time; it writes only when something
   * differs, and looks at the stylesheets again when nothing does (one may have been replaced).
   */
  const holdState = (): void => {
    if (pinned) return
    const state = store.state.value
    const element = store.selection.value?.element
    const held = forcedNow()
    if (state === null || element === undefined || !element.isConnected) {
      held?.release()
      return
    }
    if (held !== undefined && held.element === element && held.state === state) held.refresh()
    else forceState(element, state)
  }

  /** The route the State control was set on; a client-side navigation away from it puts the control back to rest. */
  let stateRoute = here()
  const route = (): string => location.pathname + location.search
  const leftRoute = (): boolean => {
    if (store.state.value === null || route() === stateRoute) return false
    store.state.value = null
    holdState()
    return true
  }

  const setState = (state: ElementState | null): void => {
    store.error.value = null
    store.state.value = state
    stateRoute = route()
    // Before the dock renders again: its computed rows read the element as it is then.
    holdState()
  }

  const select = (element: Element | null): void => {
    store.error.value = null
    if (element === null) {
      batch(() => {
        store.selection.value = null
        store.source.value = null
      })
      holdState()
      return
    }
    const selection = describe(element)
    batch(() => {
      store.selection.value = selection
      const media = store.media.value
      if (media !== null && !selection.styles.media.some((option) => option.query === media && option.matches)) store.media.value = null
      if (selection.instances < 2) store.scope.value = 'instance'
    })
    // The chosen state moves with the selection.
    holdState()
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
    holdState()
  }

  // -------------------------------------------------------------------------
  // Open, selection, Escape, pause
  // -------------------------------------------------------------------------

  const setPaused = (on: boolean): void => {
    if (on === store.paused.peek()) return
    if (on) pauseMotion()
    else resumeMotion()
    store.paused.value = on
  }

  const setOpen = (on: boolean): void => {
    if (on) picker.start()
    else picker.stop()
    setSelectCursor(on)
    batch(() => {
      store.open.value = on
      if (!on) {
        store.hovered.value = null
        store.panel.value = null
        store.outlines.value = []
      }
    })
    if (!on) {
      // Closed, primp leaves the page as the app has it: nothing selected, held or paused.
      select(null)
      setPaused(false)
    }
  }

  const escape = (): void => {
    const panel = store.panel.peek()
    if (panel !== null) {
      batch(() => {
        store.panel.value = null
        store.outlines.value = []
      })
      if (panel === 'inspector') select(null)
      return
    }
    if (store.selection.peek() !== null) {
      select(null)
      return
    }
    setOpen(false)
  }

  const picker = createPicker({
    onHover: (element) => (store.hovered.value = element),
    onPick(element) {
      select(element)
      store.panel.value = 'inspector'
    },
    onCancel: () => escape(),
    current: () => store.selection.value?.element ?? null,
    onHistory: (direction) => step(direction),
  })

  /** Where an item's element was last found; a locator lookup is not cheap enough for every frame. */
  const located = new Map<string, { element: Element | null; at: number }>()
  const elementOf = (item: ChangeItem): Element | null => {
    const known = elementOfUid(item.target.uid)
    if (known !== null && known.isConnected) return known
    const marked = preview.elementByUid(item.target.uid)
    if (marked !== null) return marked
    const cached = located.get(item.target.uid)
    if (cached !== undefined && (cached.element?.isConnected === true || performance.now() - cached.at < 1000)) return cached.element?.isConnected === true ? cached.element : null
    let element: Element | null = null
    try {
      element = locate(item.target.locator).element
    } catch {
      element = null
    }
    located.set(item.target.uid, { element, at: performance.now() })
    return element
  }

  const navigate = (key: string): void => {
    const from = store.selection.value?.element ?? store.hovered.value
    if (from === null || from === undefined) return
    const next = neighbour(from, key)
    if (next !== null) select(next)
  }

  // -------------------------------------------------------------------------
  // Edits
  // -------------------------------------------------------------------------

  const condition = (media: string | null, state: ElementState | null): Condition => {
    const out: Condition = {
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
      colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    }
    if (media !== null && media !== '') out.media = media
    if (state !== null) out.state = state
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

  /** The element's recorded hide or remove, if it has one. */
  const hiddenBy = (uid: string): 'hide' | 'remove' | undefined => {
    const item = present().find((other): other is StructuralChange => other.kind === 'structure' && other.status === 'draft' && other.target.uid === uid && other.op !== 'reorder')
    return item?.op === 'hide' || item?.op === 'remove' ? item.op : undefined
  }

  /**
   * One gesture of style edits on the selected element: several properties (a resize sets width
   * and height), ONE side-effect measurement, ONE undo step, one item per property. Every item is
   * an ordinary style change, made exactly as a single `setStyle` is (validation, the state the
   * element is held in for it, media, scope, bystanders, longhands). The side effects belong to
   * the gesture as a whole, so each of its items carries the same list.
   *
   * `make` gives the edits once the element is in the state the gesture is for (a resize reads
   * the element's padding there). With `sized`, the edits are border-box sizes from `resize`:
   * each is first tried on the page without a frame being drawn, and one that does not change
   * the box (an item a flex or grid container sizes) is not recorded but reported.
   */
  const styleGesture = async (make: (element: Element) => StyleEdit[] | string, edit: StyleEditOptions, sized?: Partial<Record<'width' | 'height', number>>): Promise<EditResult> => {
    clearErrors()
    const selection = target()
    if (selection === null) return fail('Select an element first.')
    const element = selection.element
    const media = edit.media === undefined ? store.media.value : edit.media
    const scope = edit.scope ?? store.scope.value
    const state = edit.state === undefined ? store.state.value : edit.state
    if (media !== null && media !== '' && !mediaMatches(media)) {
      return fail(`The viewport does not match @media ${media}. Resize the window until it does to edit under it.`)
    }

    // From here until everything is measured the element is in the state the edit is for (at rest
    // for a resting edit), whatever the State control is set to meanwhile: before and after
    // values, longhands and side effects are then read by the same code as for any other edit.
    pinned = true
    try {
      const held = forcedNow()
      if (state === null) held?.release()
      else if (held !== undefined && held.element === element && held.state === state) held.refresh()
      else forceState(element, state)

      const made = make(element)
      if (typeof made === 'string') return fail(made)
      const wanted = new Map<string, string>()
      for (const raw of made) {
        const typed = raw.property.trim()
        const property = isCustomProperty(typed) ? typed : typed.toLowerCase()
        const value = raw.value.trim().replace(/;+$/, '').trim()
        if (!isSupportedProperty(property)) return fail(`"${typed}" is not a CSS property this browser knows.`)
        if (!isValidValue(property, value)) return fail(`"${value}" is not a valid value for ${property}.`)
        // The same property twice in one gesture: the last value counts.
        wanted.delete(property)
        wanted.set(property, value)
      }
      if (wanted.size === 0) return fail('There is nothing to change.')

      const uid = uidOf(element)
      const existingOf = new Map<string, StyleChange>()
      let drafts: StyleChange[] = [...wanted].map(([property, value], index) => {
        const draft: StyleChange = {
          id: '',
          seq: nextSeq() + index,
          createdAt: Date.now(),
          page: here(),
          status: 'draft',
          target: { ...selection.ref, uid },
          sideEffects: [],
          expect: [],
          kind: 'style',
          property,
          scope,
          before: { computed: '' },
          after: { authored: value, computed: '' },
          condition: condition(media, state),
          stylingSystem: selection.styles.system,
        }
        const key = editKey(draft)
        const existing = present().find((item): item is StyleChange => item.kind === 'style' && item.status === 'draft' && editKey(item) === key)
        draft.id = existing?.id ?? newId('c')
        if (existing !== undefined) existingOf.set(draft.id, existing)
        return draft
      })

      if (sized !== undefined) {
        const tried = trySizes(element, drafts, sized, existingOf, selection.styles)
        if (typeof tried === 'string') return fail(tried)
        drafts = tried.kept
        if (drafts.length === 0) return { ok: true, item: null, items: [] }
        if (tried.note !== undefined) {
          store.error.value = tried.note
          store.resizeNote.value = tried.note
        }
      }

      // Measure "before" on the page without this gesture's own earlier previews. For a state whose own
      // rule sets the property, also without a resting draft of that property: its preview is
      // `!important` and would cover the page's rule for the state, which in the source it cannot.
      const origins = new Map(drafts.map((draft) => [draft.id, originOf(selection.styles, draft.property, state)]))
      const covered = drafts.flatMap((draft) =>
        state !== null && (origins.get(draft.id)?.ruleStates?.length ?? 0) > 0
          ? present().filter((item) => item.kind === 'style' && item.status === 'draft' && item.target.uid === uid && item.property === draft.property && item.condition.state === undefined).map((item) => item.id)
          : [],
      )
      preview.mute([...drafts.map((draft) => draft.id), ...covered])
      const styleBefore = getComputedStyle(element)
      const prepared = drafts.map((draft) => {
        const property = draft.property
        const where = origins.get(draft.id)!
        draft.before = { computed: computedValue(element, property, styleBefore) }
        const longhandsBefore = computedLonghands(element, property, styleBefore)
        if (where.authored !== undefined) draft.before.authored = where.authored
        draft.origin = where.origin
        draft.stylingSystem = where.system
        // Who else the rule behind the old value styles, and what they look like before this edit is previewed.
        // Not for an edit in a state: bystanders are not recorded for those.
        const witnessed = longhandsBefore === undefined ? [property] : Object.keys(longhandsBefore)
        const others = state === null && where.origin.via === 'rule' && where.ruleSelector !== undefined ? findBystanders(where.ruleSelector, element, scope) : null
        const bystanders = (others?.elements ?? []).map((other) => ({ element: other, record: describeBystander(other, witnessed) }))
        return { draft, where, longhandsBefore, witnessed, others, bystanders, spec: specFor(draft, selection.styles) }
      })

      const effects = await measureEffects(() => {
        const elements = new Set<Element>()
        for (const { spec } of prepared) for (const one of preview.apply(spec, element)) elements.add(one)
        preview.mute(null)
        return [...elements]
      })

      const styleAfter = getComputedStyle(element)
      for (const { draft, where, longhandsBefore, witnessed, others, bystanders } of prepared) {
        const property = draft.property
        draft.after.computed = computedValue(element, property, styleAfter)
        const longhandsAfter = computedLonghands(element, property, styleAfter)
        if (longhandsBefore !== undefined && longhandsAfter !== undefined) {
          draft.longhands = {}
          for (const name of Object.keys(longhandsAfter)) draft.longhands[name] = { before: longhandsBefore[name] ?? '', after: longhandsAfter[name] ?? '' }
        }
        draft.sideEffects = effects.sideEffects.map((effect) => ({ ...effect }))
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
      }

      // One commit: one undo step for the whole gesture.
      let next = present()
      for (const { draft } of prepared) next = upsertEdit(next, draft)
      const stored = prepared.map(({ draft }) => next.find((item) => item.id === draft.id) ?? null)
      commit(next)
      prepared.forEach(({ draft }, index) => {
        const item = stored[index]
        if (item === null || item === undefined) forget(draft.id)
        else remember(item, effects)
      })
      refresh()
      const items = stored.filter((item): item is ChangeItem => item !== null && item !== undefined)
      return { ok: true, item: stored[0] ?? null, items }
    } finally {
      preview.mute(null)
      pinned = false
      holdState()
    }
  }

  /**
   * Resize only: applies the gesture's previews, reads the border box and puts the previews back
   * as they were, all in one task (no frame is drawn, so nothing is seen and nothing shifts).
   * Keeps a size that takes effect, drops one the user did not change (without an earlier draft
   * of it), and drops with a reason one that changes nothing on the page.
   */
  const trySizes = (
    element: Element,
    drafts: StyleChange[],
    sized: Partial<Record<'width' | 'height', number>>,
    existingOf: ReadonlyMap<string, StyleChange>,
    styles: ElementStyles,
  ): { kept: StyleChange[]; note?: string } | string => {
    const ids = drafts.map((draft) => draft.id)
    preview.mute(ids)
    const before = element.getBoundingClientRect()
    for (const draft of drafts) preview.apply(specFor(draft, styles), element)
    preview.mute(null)
    const after = element.getBoundingClientRect()
    // Back as it was: earlier drafts show their own value again, new ones go.
    for (const draft of drafts) {
      const existing = existingOf.get(draft.id)
      if (existing === undefined) forget(draft.id)
      else syncPreview(existing)
    }
    const kept: StyleChange[] = []
    const noEffect: string[] = []
    for (const draft of drafts) {
      const axis = draft.property === 'width' || draft.property === 'height' ? draft.property : undefined
      const want = axis === undefined ? undefined : sized[axis]
      if (axis === undefined || want === undefined) {
        kept.push(draft)
        continue
      }
      const was = axis === 'width' ? before.width : before.height
      const now = axis === 'width' ? after.width : after.height
      if (Math.abs(want - was) < 0.5 && !existingOf.has(draft.id)) continue
      if (Math.abs(now - was) < 0.5 && Math.abs(now - want) > 1) noEffect.push(axis)
      else kept.push(draft)
    }
    if (noEffect.length === 0) return { kept }
    const which = noEffect.join(' and ')
    const reason = `The ${which} of this element did not change when ${noEffect.length === 1 ? 'it was' : 'they were'} set: its size is decided by its container (a flex or grid layout) or by a min or max size. Resize the container, or change how it sizes this element.`
    if (kept.length === 0) return reason
    return { kept, note: `Only the ${kept.map((draft) => draft.property).join(' and ')} was recorded. ${reason}` }
  }

  const setStyles = (edits: readonly StyleEdit[], options: StyleEditOptions = {}): Promise<EditResult> => enqueue(() => styleGesture(() => [...edits], options))

  const setStyle = (property: string, value: string, options: StyleEditOptions = {}): Promise<EditResult> => setStyles([{ property, value }], options)

  // -------------------------------------------------------------------------
  // Resize
  // -------------------------------------------------------------------------

  /** The CSS width / height that give the element the border-box size wanted, read in the state it is shown in now. */
  const sizeEdits = (element: Element, size: SizeRequest): StyleEdit[] | string => {
    const style = getComputedStyle(element)
    const edits: StyleEdit[] = []
    for (const axis of ['width', 'height'] as const) {
      const wanted = size[axis]
      if (wanted === undefined) continue
      if (typeof wanted !== 'number' || !Number.isFinite(wanted) || wanted < 0) return `The ${axis} to resize to must be a number of px, 0 or more.`
      edits.push({ property: axis, value: `${cssSizeFor(wanted, boxModelOf(style, axis))}px` })
    }
    return edits.length === 0 ? 'Give a width or a height to resize to.' : edits
  }

  /** The preview of a handle drag in progress: one rule, no item, no history, nothing sent. */
  const LIVE_SIZE = 'primp-live-size'

  const previewSize = (size: SizeRequest | null): void => {
    const selection = store.selection.peek()
    if (size === null || selection === null || !selection.element.isConnected) {
      if (preview.has(LIVE_SIZE)) forget(LIVE_SIZE)
      return
    }
    const edits = sizeEdits(selection.element, size)
    if (typeof edits === 'string') return
    const media = store.media.peek()
    const state = store.state.peek()
    const spec: PreviewSpec = {
      itemId: LIVE_SIZE,
      uid: uidOf(selection.element),
      locator: selection.ref.locator,
      scope: store.scope.peek(),
      declarations: edits,
      // After every recorded preview: the drag shows what the release will record.
      seq: Number.MAX_SAFE_INTEGER,
    }
    if (media !== null && media !== '' && mediaMatches(media)) spec.media = media
    if (state !== null) spec.state = state
    preview.apply(spec, selection.element)
  }

  const resize = (size: SizeRequest, options: StyleEditOptions = {}): Promise<EditResult> =>
    enqueue(async () => {
      // A drag's live preview goes in the same task as the measurement starts: no frame shows the old size in between.
      if (preview.has(LIVE_SIZE)) forget(LIVE_SIZE)
      clearErrors()
      const selection = target()
      if (selection === null) return fail('Select an element first.')
      const refusal = resizeRefusal(selection.element)
      if (refusal !== null) {
        store.resizeNote.value = refusal
        return fail(refusal)
      }
      const sized: Partial<Record<'width' | 'height', number>> = {}
      if (size.width !== undefined) sized.width = size.width
      if (size.height !== undefined) sized.height = size.height
      const result = await styleGesture((element) => sizeEdits(element, size), options, sized)
      // Said next to the handle and the size fields, where the resize was tried; not anywhere else.
      if (!result.ok) store.resizeNote.value = result.error
      return result
    })

  // -------------------------------------------------------------------------
  // Reorder
  // -------------------------------------------------------------------------

  const reorderRefusalOf = (element: Element): string | null => reorderRefusal(element, hiddenBy(uidOf(element)))

  const anchorOf = (element: Element | undefined): SiblingAnchor | undefined => (element === undefined ? undefined : { label: labelOf(element), locator: locatorOf(element) })
  const neighboursAt = (siblings: readonly Element[], index: number): { prev?: SiblingAnchor; next?: SiblingAnchor } => {
    const out: { prev?: SiblingAnchor; next?: SiblingAnchor } = {}
    const prev = anchorOf(siblings[index - 1])
    const next = anchorOf(siblings[index + 1])
    if (prev !== undefined) out.prev = prev
    if (next !== undefined) out.next = next
    return out
  }

  /**
   * Moves the selected element among the element children of its parent, to the index `pick`
   * returns (or refuses with the text it returns). The moved element is the primary change; its
   * siblings sliding along IS the reorder, so they are not side effects (and so never become a
   * "must not move" by default); what moves outside the parent (it grew because a taller element
   * now ends a row) is listed as for any other edit. The target is recorded again after the move:
   * its position changed on purpose, and verification looks for it at the new place.
   */
  /** The preview of a grip drag in progress: one move, no item, no history, nothing sent. */
  const LIVE_MOVE = 'primp-live-move'

  const previewMove = (toIndex: number | null): void => {
    const selection = store.selection.peek()
    if (toIndex === null || selection === null || !selection.element.isConnected) {
      if (preview.has(LIVE_MOVE)) forget(LIVE_MOVE)
      return
    }
    const spec: PreviewSpec = { itemId: LIVE_MOVE, uid: uidOf(selection.element), locator: selection.ref.locator, scope: 'instance', declarations: [], seq: Number.MAX_SAFE_INTEGER, move: { toIndex } }
    preview.apply(spec, selection.element)
  }

  const moveTarget = (): { element: Element; refusal: string | null } | null => {
    const selection = store.selection.value
    void store.items.value
    if (selection === null) return null
    const selected = selection.element
    const item = itemOf(selected)
    if (item !== null && item !== selected) {
      const refusal = reorderRefusalOf(item)
      if (refusal === null) return { element: item, refusal }
    }
    return { element: selected, refusal: reorderRefusalOf(selected) }
  }

  const reorderWith = (pick: (index: number, count: number) => number | string): Promise<EditResult> =>
    enqueue(async () => {
      // A drag's live move is put back in the same task as the measurement starts: no frame shows the old order in between.
      if (preview.has(LIVE_MOVE)) forget(LIVE_MOVE)
      clearErrors()
      const selection = target()
      if (selection === null) return fail('Select an element first.')
      const element = selection.element
      const refusal = reorderRefusalOf(element)
      const position = positionOf(element)
      if (refusal !== null || position === null) return fail(refusal ?? 'This element cannot be moved.')
      const { parent, siblings, index } = position
      const wanted = pick(index, siblings.length)
      if (typeof wanted === 'string') return fail(wanted)
      if (!Number.isInteger(wanted) || wanted < 0 || wanted >= siblings.length) {
        return fail(`There is no position ${Number.isFinite(wanted) ? wanted + 1 : wanted} to move to: ${labelOf(parent).split(' "')[0]} has ${siblings.length} elements (positions 1 to ${siblings.length}).`)
      }
      const uid = uidOf(element)
      const existing = present().find((item): item is StructuralChange => item.kind === 'structure' && item.status === 'draft' && item.op === 'reorder' && item.target.uid === uid)
      if (wanted === index) return { ok: true, item: existing ?? null }

      const was = neighboursAt(siblings, index)
      const id = existing?.id ?? newId('c')
      const seq = existing?.seq ?? nextSeq()
      const spec: PreviewSpec = { itemId: id, uid, locator: selection.ref.locator, scope: 'instance', declarations: [], seq, move: { toIndex: wanted } }
      const effects = await measureEffects(() => {
        preview.apply(spec, element)
        return elementChildren(parent)
      })
      const after = elementChildren(parent)
      const toIndex = after.indexOf(element)
      if (toIndex < 0) {
        if (existing === undefined) forget(id)
        else syncPreview(existing)
        return fail('The page changed while the move was being measured. Try again.')
      }
      const item: StructuralChange = {
        id,
        seq,
        createdAt: Date.now(),
        page: here(),
        status: 'draft',
        target: withKnownSource({ ...buildRef(element, sources.get(element) ?? null), uid }, element),
        sideEffects: effects.sideEffects,
        expect: [],
        kind: 'structure',
        op: 'reorder',
        move: {
          fromIndex: index,
          toIndex,
          siblingCount: after.length,
          parent: labelOf(parent).split(' "')[0] ?? parent.localName,
          was,
          now: neighboursAt(after, toIndex),
          around: {
            before: after.slice(Math.max(0, toIndex - 5), toIndex).map((sibling) => anchorOf(sibling) as SiblingAnchor),
            after: after.slice(toIndex + 1, toIndex + 6).map((sibling) => anchorOf(sibling) as SiblingAnchor),
          },
        },
      }
      if (effects.partial) item.sideEffectsPartial = true
      item.expect = deriveExpectations(item)
      // A second move of the same element replaces the first (the engine keeps where it started); back at the start, no draft.
      const next = upsertEdit(present(), item)
      const stored = next.find((other) => other.id === id) ?? null
      commit(next)
      if (stored === null) forget(id)
      else remember(stored, effects)
      refresh()
      return { ok: true, item: stored }
    })

  const reorder = (toIndex: number): Promise<EditResult> => reorderWith(() => toIndex)

  const move = (delta: number): Promise<EditResult> =>
    reorderWith((index, count) => {
      if (!Number.isInteger(delta) || delta === 0) return 'Move by a whole number of positions, such as -1 or +1.'
      if (delta < 0 && index === 0) return 'This element is already the first of its siblings.'
      if (delta > 0 && index === count - 1) return 'This element is already the last of its siblings.'
      return Math.max(0, Math.min(count - 1, index + delta))
    })

  const structural = (op: 'hide' | 'remove'): Promise<EditResult> =>
    enqueue(async () => {
      clearErrors()
      const selection = target()
      if (selection === null) return fail('Select an element first.')
      const element = selection.element
      const uid = uidOf(element)
      // A reorder of the same element is another change and stays.
      const earlier = present().filter((item): item is StructuralChange => item.kind === 'structure' && item.status === 'draft' && item.target.uid === uid && item.op !== 'reorder')
      const same = earlier.find((item) => item.op === op)
      if (same !== undefined) return { ok: true, item: same }
      // Hide and remove of one element replace each other.
      const replaced = earlier[0]
      if (replaced !== undefined) preview.mute(replaced.id)
      const item: StructuralChange = {
        id: newId('c'),
        seq: nextSeq(),
        createdAt: Date.now(),
        page: here(),
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

  const setVerdict = (id: string, effectIndex: number, verdict: SideEffect['verdict']): void => {
    const source = present().find((item) => item.id === id)
    const effect = source?.sideEffects[effectIndex]
    if (source === undefined || effect === undefined) return
    const judged = (item: ChangeItem): ChangeItem => {
      // The same consequence recorded on another change of the same gesture (a corner resize sets width
      // AND height) gets the same verdict: one element cannot be both wanted and unwanted.
      if (item.status !== 'draft') return item
      if (item.id !== id && (item.target.uid !== source.target.uid || !sameEffects(item.sideEffects, source.sideEffects))) return item
      const index = item.id === id ? effectIndex : item.sideEffects.findIndex((other) => sameEffect(other, effect))
      if (item.sideEffects[index] === undefined || item.sideEffects[index].verdict === verdict) return item
      const sideEffects = item.sideEffects.map((one, at) => (at === index ? { ...one, verdict } : one))
      const changed = { ...item, sideEffects }
      return { ...changed, expect: deriveExpectations(changed) }
    }
    // One commit: one undo step.
    const before = present()
    const next = before.map(judged)
    if (next.some((item, index) => item !== before[index])) commit(next)
  }

  const setNote = (id: string, note: string): void =>
    update(id, (item) => {
      const text = note.trim()
      if ((item.note ?? '') === text) return item
      const { note: _old, ...rest } = item
      void _old
      return (text === '' ? rest : { ...rest, note: text }) as ChangeItem
    })

  // -------------------------------------------------------------------------
  // Notes
  // -------------------------------------------------------------------------

  const noteOf = (on: NoteChange['on']): NoteChange | null => {
    const uid = on === 'page' ? null : store.selection.value === null ? undefined : uidOf(store.selection.value.element)
    if (uid === undefined) return null
    return (
      store.items.value.find(
        (item): item is NoteChange => item.kind === 'note' && item.status === 'draft' && item.page === here() && item.on === on && (on === 'page' || item.target.uid === uid),
      ) ?? null
    )
  }

  const addNote = (text: string, on: NoteChange['on'] = 'element'): Promise<EditResult> =>
    enqueue(async () => {
      clearErrors()
      const written = text.trim()
      let element: Element
      if (on === 'page') element = document.body
      else {
        const selection = target()
        if (selection === null) return fail('Select an element first, or write a note for the whole page.')
        element = selection.element
      }
      const existing = noteOf(on)
      if (written === '') {
        if (existing !== null) deleteItem(existing.id)
        return { ok: true, item: null }
      }
      if (existing !== null && existing.text === written) return { ok: true, item: existing }
      const uid = uidOf(element)
      const item: NoteChange = {
        id: existing?.id ?? newId('c'),
        seq: existing?.seq ?? nextSeq(),
        createdAt: existing?.createdAt ?? Date.now(),
        page: here(),
        status: 'draft',
        target: withKnownSource({ ...buildRef(element, sources.get(element) ?? null), uid }, element),
        sideEffects: [],
        expect: [],
        kind: 'note',
        text: written,
        on,
      }
      item.expect = deriveExpectations(item)
      const next = existing === null ? [...present(), item] : present().map((other) => (other.id === existing.id ? item : other))
      commit(next)
      return { ok: true, item }
    })

  // -------------------------------------------------------------------------
  // Send
  // -------------------------------------------------------------------------

  const pendingSends = new Map<string, (message: Extract<ServerMessage, { type: 'session:sent' }>) => void>()
  const pendingPrompts = new Map<string, (message: Extract<ServerMessage, { type: 'session:prompt-text' }>) => void>()

  const toast = (text: string, tone: 'ok' | 'bad' = 'ok'): void => {
    store.toast.value = { text, tone, at: performance.now() }
  }

  const copyPrompt = (): Promise<{ prompt: string; copied: boolean }> =>
    enqueue(async () => {
      const drafts = store.allDrafts.value
      if (drafts.length === 0) {
        toast('Nothing to copy yet: make a change first.', 'bad')
        return { prompt: '', copied: false }
      }
      if (!bus.connected()) {
        toast('Not connected to primp.', 'bad')
        return { prompt: '', copied: false }
      }
      await sourcesSettled(SEND_WAITS_FOR_SOURCES_MS)
      const reqId = newId('p')
      const answer = await new Promise<Extract<ServerMessage, { type: 'session:prompt-text' }> | null>((resolve) => {
        const timer = window.setTimeout(() => {
          pendingPrompts.delete(reqId)
          resolve(null)
        }, SEND_TIMEOUT_MS)
        pendingPrompts.set(reqId, (message) => {
          window.clearTimeout(timer)
          pendingPrompts.delete(reqId)
          resolve(message)
        })
        bus.send({ type: 'session:prompt', reqId, ids: drafts.map((item) => item.id) })
      })
      if (answer === null || answer.prompt === '') {
        toast('primp did not render the prompt.', 'bad')
        return { prompt: '', copied: false }
      }
      const copied = await copy(answer.prompt)
      toast(copied ? `Prompt for ${answer.count} ${answer.count === 1 ? 'change' : 'changes'} copied` : 'The browser did not allow copying.', copied ? 'ok' : 'bad')
      return { prompt: answer.prompt, copied }
    })

  const send = (): Promise<string> =>
    enqueue(async () => {
      store.error.value = null
      if (store.allDrafts.value.length === 0) return ''
      if (!bus.connected()) {
        store.error.value = 'Not connected to primp. The changes are kept; send again once it is back.'
        toast(store.error.value, 'bad')
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
            reject(new Error('primp did not answer the send request.'))
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
          toast(store.error.value, 'bad')
          return ''
        }
        // The agent's hot reload must land on an untouched page: the sent previews go now.
        for (const id of sent.keys()) forget(id)
        // ... and so does a state the dock was holding: back to rest, as the page is for everybody else.
        store.state.value = null
        holdState()
        const items = present()
          .map((item) => sent.get(item.id) ?? item)
          .sort(bySeq)
        // Sent items cannot be un-sent: the undo history ends here.
        store.history.value = emptyHistory(items)
        const copied = await copy(answer.batch.prompt)
        batch(() => {
          store.sent.value = answer.note === undefined ? { prompt: answer.batch.prompt, count: sent.size, copied } : { prompt: answer.batch.prompt, count: sent.size, copied, note: answer.note }
          // What was sent, and the prompt when the clipboard refused it, are in the Changes panel.
          if (store.open.value) store.panel.value = 'changes'
        })
        refresh()
        return answer.batch.prompt
      } catch (error) {
        store.error.value = error instanceof Error ? error.message : String(error)
        // Said next to the toolbar's Send, where it was asked for.
        toast(store.error.value, 'bad')
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
    const mine = result.items.filter((item) => item.page === here() && item.status === 'draft' && (keptIds.has(item.id) || result.adopted.includes(item)))
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
    const hook = window.__primp
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
    const hook = window.__primp
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
      if (window.__primp === undefined) {
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

  const measureNow = (items: MeasureRequest): Measurement => {
    // `measure` lets go of a held state while it reads and puts it back; make sure of the latter.
    try {
      return measure(items, preview)
    } finally {
      holdState()
    }
  }

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
      case 'session:prompt-text':
        pendingPrompts.get(event.reqId)?.(event)
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

  // A stylesheet that finished loading (a hot update that swaps a <link>) has rules the held state has not seen.
  document.addEventListener(
    'load',
    (event) => {
      const loaded = event.target
      if (store.state.value !== null && loaded instanceof Element && (loaded.localName === 'link' || loaded.localName === 'style')) holdState()
    },
    true,
  )
  // Leaving the page: nothing stays forced in a document the browser may keep and show again.
  addEventListener('pagehide', () => {
    store.state.value = null
    holdState()
  })
  // A client-side navigation: back and forward here; pushState is noticed by the DOM change that
  // follows it (onPageChange), and, for a navigation that changes nothing in the DOM, by a slow poll.
  addEventListener('popstate', () => {
    followRoute()
    leftRoute()
  })
  window.setInterval(followRoute, 1000)

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
    setOpen,
    setPickMode: setOpen,
    escape,
    setPaused,
    addNote,
    noteOf,
    copyPrompt,
    elementOf,
    knownSource: (element) => sources.get(element),
    setState,
    setStyle,
    setStyles,
    resize,
    previewSize,
    previewMove,
    moveTarget,
    reorder,
    move,
    reorderRefusal() {
      const selection = store.selection.value
      void store.items.value
      return selection === null ? 'Select an element first.' : reorderRefusalOf(selection.element)
    },
    resizeRefusal() {
      const selection = store.selection.value
      return selection === null ? 'Select an element first.' : resizeRefusal(selection.element)
    },
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
    dispose() {
      store.state.value = null
      pinned = false
      holdState()
      picker.stop()
      setSelectCursor(false)
      if (store.paused.value) resumeMotion()
      preview.dispose()
    },
  }
}
