import type { OverflowAxes, Rect, Snapshot, SnapshotEntry } from '../src/rect-diff.ts'

/** [id, parent, desc, path, x, y, w, h, extra?] */
export type Row = [
  id: number,
  parent: number,
  desc: string,
  path: string,
  x: number,
  y: number,
  w: number,
  h: number,
  extra?: { overflow?: OverflowAxes; lines?: number },
]

export function snap(
  rows: Row[],
  meta: { viewport?: Rect; page?: { w: number; h: number }; total?: number; pinned?: boolean } = {},
): Snapshot {
  const entries: SnapshotEntry[] = rows.map(([id, parent, desc, path, x, y, w, h, extra]) => ({
    id,
    parent,
    desc,
    path,
    x,
    y,
    w,
    h,
    ...extra,
  }))
  const total = meta.total ?? entries.length
  return {
    entries,
    total,
    truncated: total > entries.length,
    pinned: meta.pinned ?? false,
    viewport: meta.viewport ?? { x: 0, y: 0, w: 1000, h: 600 },
    page: meta.page ?? { w: 1000, h: 600 },
  }
}
