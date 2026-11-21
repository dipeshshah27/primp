/**
 * `window.__primp_test`: a small handle for end-to-end tests. Every method goes through the
 * controller, the same code the dock's buttons and inputs call, and returns plain JSON.
 * It is always present; it adds nothing a page script could not already do by clicking.
 */

import type { ChangeItem, ElementState, Ref, SideEffect } from '@primp/protocol/change'
import type { MeasureRequest, Measurement } from './probe/measure.ts'
import { forcedNow } from './probe/states.ts'
import { suggestProperties, supportedProperties } from './probe/properties.ts'
import { summarizeRecorded } from './probe/effects.ts'
import { summaryKey, type Controller, type EffectsCost, type SizeRequest, type StyleEdit, type StyleEditOptions } from './state/controller.ts'
import type { ShiftState, TabName } from './state/store.ts'
import type { DragState, HandleName, ViewRect } from './ui/handles.ts'
import type { DockHandle } from './ui/mount.ts'

export interface TestEditResult {
  ok: boolean
  error?: string
  /** The recorded item after the edit; null when the edit restored the original and the item was deleted. */
  item: ChangeItem | null
  /** `setStyles` and `resize`: every item the gesture recorded (one per property). */
  items?: ChangeItem[]
}

export interface TestState {
  connected: boolean
  ready: boolean
  mounted: boolean
  pickMode: boolean
  tab: TabName
  collapsed: boolean
  canUndo: boolean
  canRedo: boolean
  /** Ids of drafts whose element is not in the page. */
  detached: string[]
  /** Text of the preview stylesheet. */
  previewCss: string
  previewsSuspended: boolean
  error: string | null
  source: { state: string; file?: string; line?: number; level?: string } | null
  sent: { count: number; copied: boolean } | null
  /** Main-thread cost of the last side-effect measurement (both snapshots, diff, conversion). */
  lastEffects: EffectsCost | null
  /** The State control: the state the selection is shown in and edits are made for; null at rest. */
  activeState: ElementState | null
  /** The states at least one rule of the page styles the selected element in. */
  statesWithRules: ElementState[]
  /** What is forced on the page right now: `rules` of the page were given the marker selector, `unreadable` stylesheets could not be looked at. */
  forced: { state: ElementState; rules: number; unreadable: number } | null
}

export interface PrimpTestHandle {
  /** Resolves when the dock is mounted and the first `session:state` has arrived. */
  ready(): Promise<void>
  /** Selects the first element matching `cssSelector`, as a click in pick mode would. */
  select(cssSelector: string): Promise<Ref>
  selection(): Ref | null
  /** Sets the State control (`hover`, `focus`, `focus-visible`, `active`); null: back to rest. */
  setState(state: ElementState | null): Promise<void>
  /** `options.state` makes the edit for that state whatever the State control says; `null` for a resting edit. */
  setStyle(property: string, value: string, options?: StyleEditOptions): Promise<TestEditResult>
  /** Several properties as one gesture: one side-effect measurement, one undo step, one item per property. */
  setStyles(edits: StyleEdit[], options?: StyleEditOptions): Promise<TestEditResult>
  /**
   * Resizes the selection to a BORDER-BOX size in CSS px (what a handle drag produces): records
   * `width` / `height` for its box-sizing, in whole px. Refused for inline elements and for a size
   * that does not change the box.
   */
  resize(size: SizeRequest, options?: StyleEditOptions): Promise<TestEditResult>
  /** Moves the selection by `delta` positions among its siblings: -1 is "Move earlier", +1 "Move later". */
  move(delta: number): Promise<TestEditResult>
  /** Moves the selection to `toIndex` (from 0) among its parent's element children. */
  reorder(toIndex: number): Promise<TestEditResult>
  /** Viewport rects of the handles shown now (resize: `e`, `s`, `se`; reorder: `grip`), to drive a real mouse drag on them. */
  handles(): Partial<Record<HandleName, ViewRect>>
  /** The handle drag in progress: the size shown, or the drop position and its insertion line; null when none. */
  drag(): DragState | null
  hide(): Promise<TestEditResult>
  remove(): Promise<TestEditResult>
  undo(): Promise<ChangeItem[]>
  redo(): Promise<ChangeItem[]>
  /** Every item the dock knows, drafts and sent ones, ordered by `seq`. */
  items(): ChangeItem[]
  setVerdict(itemId: string, effectIndex: number, verdict: SideEffect['verdict']): Promise<ChangeItem | null>
  /** Presses Send; resolves with the prompt. */
  send(): Promise<string>
  /** Sends the layout-shift recording now and resolves with the attributed report. */
  shiftReport(): Promise<ShiftState>
  /** Runs the measure path of `session:measure` locally. */
  measure(request: MeasureRequest): Promise<Measurement>
  // Beyond the minimum, for checks that need them:
  /** The one-line side-effect summary of an item, as the tray shows it. */
  summary(itemId: string): string
  pick(on: boolean): void
  deleteItem(itemId: string): Promise<ChangeItem[]>
  setNote(itemId: string, note: string): Promise<ChangeItem | null>
  /** Every property the autocomplete knows. */
  properties(): string[]
  suggest(typed: string): string[]
  openTab(tab: TabName): void
  collapse(collapsed: boolean): void
  state(): TestState
}

declare global {
  interface Window {
    __primp_test?: PrimpTestHandle
  }
}

export function installTestHandle(c: Controller, dock: DockHandle): PrimpTestHandle {
  const { store } = c
  const items = (): ChangeItem[] => store.items.value
  const result = async (edit: ReturnType<Controller['setStyle']>): Promise<TestEditResult> => {
    const outcome = await edit
    if (!outcome.ok) return { ok: false, error: outcome.error, item: null }
    return outcome.items === undefined ? { ok: true, item: outcome.item } : { ok: true, item: outcome.item, items: outcome.items }
  }
  const find = (id: string): ChangeItem | null => items().find((item) => item.id === id) ?? null

  const handle: PrimpTestHandle = {
    async ready() {
      await c.ready()
      for (let i = 0; i < 200 && !dock.mounted(); i++) await new Promise((resolve) => setTimeout(resolve, 10))
      if (!dock.mounted()) throw new Error('the dock did not mount')
    },
    async select(cssSelector) {
      await c.idle()
      const element = document.querySelector(cssSelector)
      if (element === null) throw new Error(`no element matches ${cssSelector}`)
      c.select(element)
      const selection = store.selection.value
      if (selection === null) throw new Error(`could not select ${cssSelector}`)
      return selection.ref
    },
    selection: () => store.selection.value?.ref ?? null,
    async setState(state) {
      await c.idle()
      c.setState(state)
    },
    setStyle: (property, value, options) => result(c.setStyle(property, value, options)),
    setStyles: (edits, options) => result(c.setStyles(edits, options)),
    resize: (size, options) => result(c.resize(size, options)),
    move: (delta) => result(c.move(delta)),
    reorder: (toIndex) => result(c.reorder(toIndex)),
    handles() {
      dock.highlighter.flush()
      return dock.handles.rects()
    },
    drag: () => dock.handles.drag(),
    hide: () => result(c.structural('hide')),
    remove: () => result(c.structural('remove')),
    async undo() {
      await c.idle()
      c.undo()
      return items()
    },
    async redo() {
      await c.idle()
      c.redo()
      return items()
    },
    items,
    async setVerdict(itemId, effectIndex, verdict) {
      await c.idle()
      c.setVerdict(itemId, effectIndex, verdict)
      return find(itemId)
    },
    send: () => c.send(),
    shiftReport: () => c.requestShifts(),
    async measure(request) {
      await c.idle()
      return c.measure(request)
    },
    summary(itemId) {
      const item = find(itemId)
      if (item === null) return ''
      return store.summaries.value.get(summaryKey(item)) ?? summarizeRecorded(item.sideEffects)
    },
    pick: (on) => c.setPickMode(on),
    async deleteItem(itemId) {
      await c.idle()
      c.deleteItem(itemId)
      return items()
    },
    async setNote(itemId, note) {
      await c.idle()
      c.setNote(itemId, note)
      return find(itemId)
    },
    properties: () => supportedProperties(),
    suggest: (typed) => suggestProperties(typed, [], 50),
    openTab(tab) {
      store.tab.value = tab
    },
    collapse: (collapsed) => dock.setCollapsed(collapsed),
    state() {
      const source = store.source.value
      const sent = store.sent.value
      const forced = forcedNow()
      return {
        connected: store.connected.value,
        ready: store.ready.value,
        mounted: dock.mounted(),
        pickMode: store.pickMode.value,
        tab: store.tab.value,
        collapsed: dock.frame.classList.contains('collapsed'),
        canUndo: store.canUndo.value,
        canRedo: store.canRedo.value,
        detached: [...store.detached.value],
        previewCss: c.preview.css(),
        previewsSuspended: c.preview.suspended(),
        error: store.error.value,
        source:
          source === null
            ? null
            : {
                state: source.state,
                ...(source.loc?.file === undefined ? {} : { file: source.loc.file }),
                ...(source.loc?.line === undefined ? {} : { line: source.loc.line }),
                ...(source.loc === null ? {} : { level: source.loc.level }),
              },
        sent: sent === null ? null : { count: sent.count, copied: sent.copied },
        lastEffects: c.lastEffects(),
        activeState: store.state.value,
        statesWithRules: store.selection.value?.styles.states ?? [],
        forced: forced === undefined ? null : { state: forced.state, rules: forced.rules, unreadable: forced.unreadable },
      }
    },
  }
  window.__primp_test = handle
  return handle
}
