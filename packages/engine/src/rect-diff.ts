/**
 * Geometry snapshot types and the raw rect diff.
 *
 * Pure: no DOM, no Node. The browser probe (packages/overlay/src/probe/snapshot.ts)
 * produces `Snapshot` values; everything here runs on plain JSON.
 */

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Axes on which an element's content is larger than its own box. */
export type OverflowAxes = 'x' | 'y' | 'xy'

export interface SnapshotEntry extends Rect {
  /** Stable per-session numeric id (the probe keeps it in a WeakMap). Never 0. */
  id: number
  /** Id of the nearest ancestor that is also in the snapshot, or 0 for none. */
  parent: number
  /** Short descriptor: `tag#id.class1.class2`. */
  desc: string
  /** Child-index path from the snapshot root, e.g. `2.0.3` (`~` marks a shadow-tree step). */
  path: string
  /** Set when scrollWidth/scrollHeight exceed clientWidth/clientHeight. Absent when nothing overflows. */
  overflow?: OverflowAxes
  /** Number of text lines, for elements with their own text. A hint, not a guarantee. */
  lines?: number
}

export interface Snapshot {
  /** Document order; x/y are document coordinates rounded to 0.5px. */
  entries: SnapshotEntry[]
  /** Number of elements with a box found before the cap was applied. */
  total: number
  /** True when the cap dropped some of them. */
  truncated: boolean
  /**
   * True when the snapshot was taken with the ids of an earlier snapshot pinned, so that an id
   * missing here really is gone and was not merely dropped by the cap.
   */
  pinned: boolean
  /** Visual viewport in document coordinates (x/y are the scroll offsets). */
  viewport: Rect
  /** Scrollable size of the document. */
  page: { w: number; h: number }
}

export type DeltaType = 'moved' | 'resized' | 'appeared' | 'disappeared'

export interface RectDelta {
  id: number
  /** `resized` wins over `moved` when both position and size changed. */
  type: DeltaType
  dx: number
  dy: number
  dw: number
  dh: number
}

export interface DiffOptions {
  /** A component counts as changed only when it differs by more than this. Default 0.5px. */
  tolerance?: number
}

export const DEFAULT_TOLERANCE = 0.5

export function indexById(snapshot: Snapshot): Map<number, SnapshotEntry> {
  const map = new Map<number, SnapshotEntry>()
  for (const e of snapshot.entries) map.set(e.id, e)
  return map
}

/**
 * Raw per-element deltas between two snapshots.
 *
 * Order: elements present in `after` in document order, then `disappeared` elements in the
 * document order of `before`.
 *
 * Truncation: an id missing from a truncated snapshot may only have been dropped by the cap, so
 * `appeared` is reported only when `before` is complete, and `disappeared` only when `after` is
 * complete or was taken with the earlier ids pinned.
 */
export function diff(before: Snapshot, after: Snapshot, opts: DiffOptions = {}): RectDelta[] {
  const tol = opts.tolerance ?? DEFAULT_TOLERANCE
  const prev = indexById(before)
  const out: RectDelta[] = []
  const reportAppeared = !before.truncated
  const reportDisappeared = !after.truncated || after.pinned
  let matched = 0

  for (const a of after.entries) {
    const b = prev.get(a.id)
    if (b === undefined) {
      if (reportAppeared) out.push({ id: a.id, type: 'appeared', dx: 0, dy: 0, dw: a.w, dh: a.h })
      continue
    }
    matched++
    const dx = a.x - b.x
    const dy = a.y - b.y
    const dw = a.w - b.w
    const dh = a.h - b.h
    if (Math.abs(dw) > tol || Math.abs(dh) > tol) {
      out.push({ id: a.id, type: 'resized', dx, dy, dw, dh })
    } else if (Math.abs(dx) > tol || Math.abs(dy) > tol) {
      out.push({ id: a.id, type: 'moved', dx, dy, dw, dh })
    }
  }

  if (reportDisappeared && matched < before.entries.length) {
    const now = new Set<number>()
    for (const a of after.entries) now.add(a.id)
    for (const b of before.entries) {
      if (!now.has(b.id)) out.push({ id: b.id, type: 'disappeared', dx: 0, dy: 0, dw: -b.w, dh: -b.h })
    }
  }
  return out
}
