/**
 * The dock's state, as signals. Components read them; only the controller writes them.
 */

import { computed, signal, type ReadonlySignal, type Signal } from '@preact/signals'
import { canRedo, canUndo, emptyHistory, type ItemHistory } from '@primp/engine/items'
import type { ChangeItem, ElementState, Ref, SourceLoc } from '@primp/protocol/change'
import type { SessionInfo } from '@primp/protocol/messages'
import type { ShiftReport } from '@primp/protocol/shift'
import type { ElementStyles } from '../probe/styles.ts'

export type TabName = 'edits' | 'shifts' | 'verify'

/** What the popover shows: the inspector of the selection, or a panel opened from the toolbar. */
export type PanelName = 'inspector' | 'changes' | 'shifts' | 'verify' | 'settings'

export type ThemeSetting = 'auto' | 'dark' | 'light'

export interface SourceState {
  state: 'resolving' | 'done' | 'failed'
  loc: SourceLoc | null
}

export interface Crumb {
  label: string
  element: Element
}

export interface Selection {
  element: Element
  ref: Ref
  styles: ElementStyles
  /** How many elements an all-instances edit would cover. */
  instances: number
  /** Ancestors from the outermost shown one down to the element itself. */
  crumbs: Crumb[]
  hasChild: boolean
  /** Where it stands among its parent's element children; null without a parent element. */
  position: { index: number; count: number } | null
}

export interface ShiftState {
  report: ShiftReport
  culpritSources: Record<string, SourceLoc>
  receivedAt: number
}

/** Something to outline on the page: an element to follow, or a fixed rectangle. */
export interface Outline {
  kind: 'hover' | 'selected' | 'previous' | 'current' | 'culprit'
  element?: Element
  rect?: { x: number; y: number; width: number; height: number }
  /** Coordinate space of `rect`. Default `viewport`. */
  space?: 'viewport' | 'document'
  label?: string
}

export interface SentState {
  prompt: string
  count: number
  /** False: the clipboard refused; the dock shows the prompt for manual copying. */
  copied: boolean
  /** The session's own words for what happened to the batch (`session:sent.note`), replacing the dock's. */
  note?: string
  /** An agent was waiting for this Send (MCP `wait_for_changes`): it has the changes, nothing needs pasting. */
  toAgent?: boolean
}

export interface Store {
  info: Signal<SessionInfo | null>
  connected: Signal<boolean>
  /** The first `session:state` has arrived. */
  ready: Signal<boolean>
  history: Signal<ItemHistory>
  /** Every item the dock knows, ordered by `seq`. */
  items: ReadonlySignal<ChangeItem[]>
  /** The page the tab shows now (path and query), followed through client-side navigation. */
  route: Signal<string>
  /** Drafts made on this page. */
  drafts: ReadonlySignal<ChangeItem[]>
  /** Drafts of the whole session; what Send sends. */
  allDrafts: ReadonlySignal<ChangeItem[]>
  canUndo: ReadonlySignal<boolean>
  canRedo: ReadonlySignal<boolean>
  /** Ids of drafts whose element is not in the page right now. */
  detached: Signal<ReadonlySet<string>>
  /** One-line side-effect summary per item id, as the engine worded it when the edit was made. */
  summaries: Signal<ReadonlyMap<string, string>>
  selection: Signal<Selection | null>
  /** Source of the selected element. */
  source: Signal<SourceState | null>
  /**
   * The dock is open: the toolbar is shown and selection is on (the page's clicks select instead
   * of reaching the app; Alt lets one through). Closed, primp is a launcher button and the page
   * gets every event. Written through `controller.setOpen`.
   */
  open: Signal<boolean>
  /** Same as `open`; kept under its old name for the test handle and older checks. */
  pickMode: ReadonlySignal<boolean>
  /** The popover's content; null: no popover. */
  panel: Signal<PanelName | null>
  /** The numbered pins on changed elements are hidden. */
  pinsHidden: Signal<boolean>
  /** The page's animations and transitions are paused by primp. */
  paused: Signal<boolean>
  theme: Signal<ThemeSetting>
  /** A short confirmation shown next to the toolbar for a moment ("Prompt copied"); tone `bad` for a refusal. */
  toast: Signal<{ text: string; tone: 'ok' | 'bad'; at: number } | null>
  /** Why the last resize (a handle drag or the size fields) recorded nothing or only part; cleared by the next edit. */
  resizeNote: Signal<string | null>
  hovered: Signal<Element | null>
  /** Extra outlines (shift victims, a side effect being pointed at). */
  outlines: Signal<Outline[]>
  scope: Signal<'instance' | 'all-instances'>
  /** `@media` query new edits are scoped to; null: none. */
  media: Signal<string | null>
  /**
   * The interaction state the selected element is shown in and new edits are made for; null: at rest.
   * Kept across selections, like a tool mode; back to rest after Send. Written through `controller.setState`.
   */
  state: Signal<ElementState | null>
  tab: Signal<TabName>
  shifts: Signal<ShiftState | null>
  /** A recording was sent and its report has not arrived. */
  shiftsPending: Signal<boolean>
  sent: Signal<SentState | null>
  sending: Signal<boolean>
  /** The last refusal (an invalid value, a failed send), shown until the next action. */
  error: Signal<string | null>
  busy: Signal<boolean>
}

export function createStore(page: string): Store {
  const history = signal<ItemHistory>(emptyHistory())
  const items = computed(() => history.value.present)
  const open = signal(false)
  const route = signal(page)
  return {
    route,
    info: signal(null),
    connected: signal(false),
    ready: signal(false),
    history,
    items,
    drafts: computed(() => items.value.filter((item) => item.status === 'draft' && item.page === route.value)),
    allDrafts: computed(() => items.value.filter((item) => item.status === 'draft')),
    canUndo: computed(() => canUndo(history.value)),
    canRedo: computed(() => canRedo(history.value)),
    detached: signal(new Set()),
    summaries: signal(new Map()),
    selection: signal(null),
    source: signal(null),
    open,
    pickMode: computed(() => open.value),
    panel: signal(null),
    pinsHidden: signal(false),
    paused: signal(false),
    theme: signal('auto'),
    resizeNote: signal(null),
    toast: signal(null),
    hovered: signal(null),
    outlines: signal([]),
    scope: signal('instance'),
    media: signal(null),
    state: signal(null),
    tab: signal('edits'),
    shifts: signal(null),
    shiftsPending: signal(false),
    sent: signal(null),
    sending: signal(false),
    error: signal(null),
    busy: signal(false),
  }
}
