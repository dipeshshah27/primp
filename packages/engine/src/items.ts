/**
 * Pure helpers for lists of change items: the dock's draft list (same-edit key, merge, no-op
 * detection, undo/redo) and the views shared by the dock and the prompt (grouping by source
 * file, counts by status).
 *
 * Pure: no DOM, no Node. Nothing here mutates its arguments.
 */

import type { ChangeItem, ItemStatus, StyleChange } from '@reglet/protocol/change'
import { deriveExpectations } from './expect.ts'
import { normalizeValue } from './units.ts'

// ---------------------------------------------------------------------------
// Same edit, merge, no-op
// ---------------------------------------------------------------------------

/**
 * Two items with the same key are the same edit made twice (the second replaces the first):
 * style changes on the same element, property, media condition and scope; structural changes
 * on the same element with the same operation.
 */
export function editKey(item: ChangeItem): string {
  return item.kind === 'style'
    ? JSON.stringify(['style', item.target.uid, item.property.trim().toLowerCase(), normalizeValue(item.condition.media ?? ''), item.scope])
    : JSON.stringify(['structure', item.target.uid, item.op])
}

/**
 * Folds a newer edit of the same property into the draft that already exists.
 *
 * Kept from `existing`: identity (`id`, `seq`, `createdAt`, `page`, `status`, `batchId`), the
 * target, the styling system, and above all the ORIGINAL `before` and `origin`: `incoming` was
 * measured with the first preview still applied, so its `before` is the first edit's `after`.
 * Taken from `incoming`: `after`, `condition`, `sideEffects`, `sideEffectsPartial`, and a note
 * when it has one. `longhands` take `before` from `existing` and `after` from `incoming`.
 *
 * Two things go beyond copying:
 *   - a verdict the user already gave (`expected` / `unwanted`) is carried over to the incoming
 *     side effect on the same element (same selector and type) when that one is still
 *     `unreviewed`, so re-typing a value does not silently drop a "must not move";
 *   - `expect` is derived again from the merged item, because both the surviving `before`
 *     values and the carried verdicts change what must hold. When nothing was carried and the
 *     longhands agree this equals `incoming.expect`.
 */
export function mergeStyleEdit(existing: StyleChange, incoming: StyleChange): StyleChange {
  const verdicts = new Map<string, StyleChange['sideEffects'][number]['verdict']>()
  for (const effect of existing.sideEffects) {
    if (effect.verdict !== 'unreviewed') verdicts.set(`${effect.type}\n${effect.selector}`, effect.verdict)
  }
  const sideEffects = incoming.sideEffects.map((effect) => {
    const earlier = verdicts.get(`${effect.type}\n${effect.selector}`)
    return effect.verdict === 'unreviewed' && earlier !== undefined ? { ...effect, verdict: earlier } : effect
  })

  let longhands: StyleChange['longhands']
  if (incoming.longhands !== undefined) {
    longhands = {}
    for (const [property, value] of Object.entries(incoming.longhands)) {
      longhands[property] = { before: existing.longhands?.[property]?.before ?? value.before, after: value.after }
    }
  }

  const { longhands: _dropped, verification: _stale, ...kept } = existing
  void _dropped
  void _stale
  const merged: Omit<StyleChange, 'expect'> = {
    ...kept,
    after: incoming.after,
    condition: incoming.condition,
    sideEffects,
    ...(longhands === undefined ? {} : { longhands }),
    ...(incoming.sideEffectsPartial === undefined ? {} : { sideEffectsPartial: incoming.sideEffectsPartial }),
    ...(incoming.note === undefined ? {} : { note: incoming.note }),
  }
  if (incoming.sideEffectsPartial === undefined) delete merged.sideEffectsPartial
  return { ...merged, expect: deriveExpectations(merged) }
}

const same = (a: string, b: string): boolean => normalizeValue(a) === normalizeValue(b)

/**
 * True when a style change changes nothing, so the dock can delete the draft: the computed
 * value after equals the one before, every recorded longhand is unchanged, and the authored
 * value is the same as before (or the one before could not be read, in which case there is
 * nothing to tell them apart by). A structural change is never a no-op.
 */
export function isNoop(item: ChangeItem): boolean {
  if (item.kind !== 'style') return false
  if (!same(item.before.computed, item.after.computed)) return false
  if (item.before.authored !== undefined && !same(item.before.authored, item.after.authored)) return false
  return Object.values(item.longhands ?? {}).every((value) => same(value.before, value.after))
}

/**
 * Adds an edit to a draft list: merged into the draft with the same key when there is one
 * (see `mergeStyleEdit`; a repeated structural edit replaces the earlier one and keeps its
 * identity), appended otherwise. An edit that ends up changing nothing removes its draft.
 * Items that are no longer drafts are never merged into.
 */
export function upsertEdit(items: readonly ChangeItem[], incoming: ChangeItem): ChangeItem[] {
  const key = editKey(incoming)
  const index = items.findIndex((item) => item.status === 'draft' && editKey(item) === key)
  const existing = index < 0 ? undefined : items[index]
  if (existing === undefined) return isNoop(incoming) ? [...items] : [...items, incoming]
  const merged: ChangeItem =
    existing.kind === 'style' && incoming.kind === 'style'
      ? mergeStyleEdit(existing, incoming)
      : { ...incoming, id: existing.id, seq: existing.seq, createdAt: existing.createdAt }
  const out = [...items]
  if (isNoop(merged)) out.splice(index, 1)
  else out[index] = merged
  return out
}

// ---------------------------------------------------------------------------
// Undo / redo
// ---------------------------------------------------------------------------

/** Most undo steps kept; older ones are forgotten. */
export const HISTORY_DEPTH = 100

export interface ItemHistory {
  /** Earlier lists, oldest first. At most `HISTORY_DEPTH`. */
  past: ChangeItem[][]
  present: ChangeItem[]
  /** Undone lists, next redo first. */
  future: ChangeItem[][]
}

export type HistoryAction =
  /** A user edit: the new list becomes the present, the old one can be undone to, redo is cleared. */
  | { type: 'commit'; items: ChangeItem[] }
  /** A change that is not the user's edit (server state, a verification result): replaces the present, keeps undo and redo. */
  | { type: 'replace'; items: ChangeItem[] }
  | { type: 'undo' }
  | { type: 'redo' }
  /** Forget everything and start from this list. */
  | { type: 'reset'; items: ChangeItem[] }

export function emptyHistory(items: ChangeItem[] = []): ItemHistory {
  return { past: [], present: items, future: [] }
}

/** Undo/redo over item lists. Returns the same object when the action changes nothing. */
export function historyReducer(state: ItemHistory, action: HistoryAction, depth: number = HISTORY_DEPTH): ItemHistory {
  switch (action.type) {
    case 'commit': {
      if (action.items === state.present) return state
      const past = [...state.past, state.present]
      return { past: past.length > depth ? past.slice(past.length - depth) : past, present: action.items, future: [] }
    }
    case 'replace':
      return action.items === state.present ? state : { ...state, present: action.items }
    case 'undo': {
      const previous = state.past[state.past.length - 1]
      if (previous === undefined) return state
      return { past: state.past.slice(0, -1), present: previous, future: [state.present, ...state.future] }
    }
    case 'redo': {
      const next = state.future[0]
      if (next === undefined) return state
      const past = [...state.past, state.present]
      return { past: past.length > depth ? past.slice(past.length - depth) : past, present: next, future: state.future.slice(1) }
    }
    case 'reset':
      return emptyHistory(action.items)
  }
}

export const canUndo = (state: ItemHistory): boolean => state.past.length > 0
export const canRedo = (state: ItemHistory): boolean => state.future.length > 0

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface FileGroup {
  /**
   * Source file of the items. Null for the last group: items without a source, and items whose
   * source is only a ranked guess (`level: 'candidates'`), which must not be shown under a file
   * as if it were known.
   */
  file: string | null
  items: ChangeItem[]
}

/** The file an item is known to live in, or null. */
export function knownFile(item: ChangeItem): string | null {
  const source = item.target.source
  if (source === null || source.level === 'candidates' || source.file === undefined || source.file === '') return null
  return source.file
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Groups items by source file. Groups are ordered by file path; inside a group items are
 * ordered by line, then column (unknown positions last), then `seq`, then id. Items without a
 * known file form one final group, ordered by `seq`, then id.
 */
export function groupByFile(items: readonly ChangeItem[]): FileGroup[] {
  const byFile = new Map<string, ChangeItem[]>()
  const unknown: ChangeItem[] = []
  for (const item of items) {
    const file = knownFile(item)
    if (file === null) {
      unknown.push(item)
      continue
    }
    const list = byFile.get(file)
    if (list === undefined) byFile.set(file, [item])
    else list.push(item)
  }
  const bySeq = (a: ChangeItem, b: ChangeItem): number => a.seq - b.seq || compareText(a.id, b.id)
  const position = (n: number | undefined): number => n ?? Number.MAX_SAFE_INTEGER
  const groups: FileGroup[] = [...byFile.keys()].sort(compareText).map((file) => ({
    file,
    items: (byFile.get(file) ?? []).sort((a, b) => {
      const sa = a.target.source
      const sb = b.target.source
      return position(sa?.line) - position(sb?.line) || position(sa?.col) - position(sb?.col) || bySeq(a, b)
    }),
  }))
  if (unknown.length > 0) groups.push({ file: null, items: unknown.sort(bySeq) })
  return groups
}

const STATUSES: readonly ItemStatus[] = ['draft', 'queued', 'claimed', 'verified', 'failed', 'dismissed']

/** Number of items per status; every status is present, in lifecycle order. */
export function countsByStatus(items: readonly ChangeItem[]): Record<ItemStatus, number> {
  const counts = Object.fromEntries(STATUSES.map((status) => [status, 0])) as Record<ItemStatus, number>
  for (const item of items) counts[item.status] = (counts[item.status] ?? 0) + 1
  return counts
}
