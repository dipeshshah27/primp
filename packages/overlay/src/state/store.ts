/**
 * The dock's state, as signals. Components read them; only the controller writes them.
 */

import { computed, signal, type ReadonlySignal, type Signal } from '@preact/signals'
import { canRedo, canUndo, emptyHistory, type ItemHistory } from '@reglet/engine/items'
import type { ChangeItem, Ref, SourceLoc } from '@reglet/protocol/change'
import type { SessionInfo } from '@reglet/protocol/messages'
import type { ShiftReport } from '@reglet/protocol/shift'
import type { ElementStyles } from '../probe/styles.ts'

export type TabName = 'edits' | 'shifts' | 'verify'

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
}

export interface Store {
  info: Signal<SessionInfo | null>
  connected: Signal<boolean>
  /** The first `session:state` has arrived. */
  ready: Signal<boolean>
  history: Signal<ItemHistory>
  /** Every item the dock knows, ordered by `seq`. */
  items: ReadonlySignal<ChangeItem[]>
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
  pickMode: Signal<boolean>
  hovered: Signal<Element | null>
  /** Extra outlines (shift victims, a side effect being pointed at). */
  outlines: Signal<Outline[]>
  scope: Signal<'instance' | 'all-instances'>
  /** `@media` query new edits are scoped to; null: none. */
  media: Signal<string | null>
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
  return {
    info: signal(null),
    connected: signal(false),
    ready: signal(false),
    history,
    items,
    drafts: computed(() => items.value.filter((item) => item.status === 'draft' && item.page === page)),
    allDrafts: computed(() => items.value.filter((item) => item.status === 'draft')),
    canUndo: computed(() => canUndo(history.value)),
    canRedo: computed(() => canRedo(history.value)),
    detached: signal(new Set()),
    summaries: signal(new Map()),
    selection: signal(null),
    source: signal(null),
    pickMode: signal(false),
    hovered: signal(null),
    outlines: signal([]),
    scope: signal('instance'),
    media: signal(null),
    tab: signal('edits'),
    shifts: signal(null),
    shiftsPending: signal(false),
    sent: signal(null),
    sending: signal(false),
    error: signal(null),
    busy: signal(false),
  }
}
