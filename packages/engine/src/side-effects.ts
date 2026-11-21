/**
 * Side-effect classifier: turns raw rect deltas into a short list a person can read.
 *
 * Pure: no DOM, no Node.
 *
 * Rules, in order:
 *  1. Deltas of the edited element(s) and their descendants are the intended change. They are
 *     returned as `primary` and never appear in `effects`.
 *  2. Ancestors of an edited element are tagged `relation: 'ancestor'`. Their resize is the direct
 *     consequence of the edit, so they are listed but left out of the summary line.
 *  3. Subtree collapse: an element whose delta equals its parent's delta joins the parent's group.
 *     Each group is reported once, as its top-most element with `subtreeCount`.
 *  4. Reflow collapse: a resized (or appeared/disappeared) element that is not an ancestor of the
 *     edit absorbs every moved/resized descendant, whatever its delta: when a box changes size its
 *     contents reflow, and that is one effect for a person. `reflowed` counts the absorbed ones.
 *  5. Independent of geometry, an element can newly overflow, change its text line count
 *     (`wrapped`) or leave the viewport (`offscreen`, reported for the top-most element only).
 */

import { DEFAULT_TOLERANCE, diff, indexById } from './rect-diff.ts'
import type { DiffOptions, OverflowAxes, Rect, RectDelta, Snapshot, SnapshotEntry } from './rect-diff.ts'

export type SideEffectType = 'moved' | 'resized' | 'overflow' | 'wrapped' | 'offscreen'

export interface SideEffect {
  /** Top-most element of the group. */
  id: number
  desc: string
  path: string
  type: SideEffectType
  /** `ancestor`: contains an edited element. `outside`: everything else. */
  relation: 'ancestor' | 'outside'
  before: Rect | null
  after: Rect | null
  dx: number
  dy: number
  dw: number
  dh: number
  /** Elements this effect stands for, including the top-most one. */
  subtreeCount: number
  /** Of those, descendants absorbed by rule 4 whose own delta differs from the top-most element's. */
  reflowed: number
  /** Set on `resized` effects whose element came into or went out of the layout. */
  presence?: 'appeared' | 'disappeared'
  /** `overflow` effects: the axes that newly overflow. */
  overflow?: OverflowAxes
  /** `wrapped` effects: text line counts. */
  lines?: { before: number; after: number }
  /** Human phrase without the subject, e.g. `moved up 48px`. */
  label: string
}

export interface ClassifyOptions extends DiffOptions {
  /** Ids of the element(s) the user edited. */
  edited?: readonly number[]
  /** Most clauses per effect type in the summary before the rest is folded into "N more". Default 2. */
  maxClausesPerType?: number
}

export interface SideEffectReport {
  /** Deltas of the edited element(s) and their descendants. */
  primary: RectDelta[]
  /** `outside` effects first, then by `subtreeCount` descending, then document order. */
  effects: SideEffect[]
  summary: string
  /** The page gained a horizontal scrollbar. */
  pageOverflowX: boolean
  /** Either snapshot hit the element cap, so the report covers only part of the page. */
  truncated: boolean
}

const MAX_DEPTH = 100_000

/** `diff` then `classify`. */
export function sideEffects(before: Snapshot, after: Snapshot, opts: ClassifyOptions = {}): SideEffectReport {
  return classify(before, after, diff(before, after, opts), opts)
}

export function classify(
  before: Snapshot,
  after: Snapshot,
  deltas: readonly RectDelta[],
  opts: ClassifyOptions = {},
): SideEffectReport {
  const tol = opts.tolerance ?? DEFAULT_TOLERANCE
  const prev = indexById(before)
  const next = indexById(after)
  const entryOf = (id: number): SnapshotEntry | undefined => next.get(id) ?? prev.get(id)
  const parentOf = (id: number): number => entryOf(id)?.parent ?? 0

  // Rule 1 and 2: who is primary, who is an ancestor of the edit.
  const edited = new Set(opts.edited ?? [])
  const spine = new Set<number>()
  for (const id of edited) {
    for (let p = parentOf(id), n = 0; p !== 0 && !spine.has(p) && n < MAX_DEPTH; p = parentOf(p), n++) spine.add(p)
  }
  const primaryMemo = new Map<number, boolean>()
  const isPrimary = (id: number): boolean => {
    const chain: number[] = []
    let result = false
    for (let cur = id; cur !== 0 && chain.length < MAX_DEPTH; cur = parentOf(cur)) {
      const known = primaryMemo.get(cur)
      if (known !== undefined) {
        result = known
        break
      }
      if (edited.has(cur)) {
        result = true
        primaryMemo.set(cur, true)
        break
      }
      chain.push(cur)
    }
    for (const c of chain) primaryMemo.set(c, result)
    return result
  }

  const primary: RectDelta[] = []
  const secondary: RectDelta[] = []
  const deltaOf = new Map<number, RectDelta>()
  for (const d of deltas) {
    if (isPrimary(d.id)) primary.push(d)
    else {
      secondary.push(d)
      deltaOf.set(d.id, d)
    }
  }

  // Rule 3: same delta as the parent -> same group.
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= tol
  const joins = (child: RectDelta, parent: RectDelta): boolean =>
    child.type === parent.type &&
    spine.has(child.id) === spine.has(parent.id) &&
    near(child.dx, parent.dx) &&
    near(child.dy, parent.dy) &&
    near(child.dw, parent.dw) &&
    near(child.dh, parent.dh)
  const groupMemo = new Map<number, number>()
  const groupOf = (d: RectDelta): number => {
    const chain: RectDelta[] = []
    let root = d.id
    for (let cur = d; chain.length < MAX_DEPTH; ) {
      const known = groupMemo.get(cur.id)
      if (known !== undefined) {
        root = known
        break
      }
      chain.push(cur)
      const up = deltaOf.get(parentOf(cur.id))
      if (up === undefined || !joins(cur, up)) {
        root = cur.id
        break
      }
      cur = up
    }
    for (const c of chain) groupMemo.set(c.id, root)
    return root
  }

  // Rule 4: the top-most resized ancestor outside the spine absorbs what is inside it.
  const absorbs = (id: number): boolean => {
    const d = deltaOf.get(id)
    return d !== undefined && d.type !== 'moved' && !spine.has(id)
  }
  const absorberMemo = new Map<number, number>()
  const absorberOf = (id: number): number => {
    // Walk up to the first ancestor with a known answer, then resolve back down.
    const chain: number[] = []
    let top = 0
    for (let cur = id; chain.length < MAX_DEPTH; ) {
      const p = parentOf(cur)
      if (p === 0) break
      const known = absorberMemo.get(cur)
      if (known !== undefined) {
        top = known
        break
      }
      chain.push(cur)
      cur = p
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      const cur = chain[i]!
      if (top === 0) {
        const p = parentOf(cur)
        // `top` is still the parent's own absorber here; none above it makes the parent top-most.
        if (absorbs(p)) top = p
      }
      absorberMemo.set(cur, top)
    }
    return chain.length === 0 ? top : absorberMemo.get(id)!
  }

  const counts = new Map<number, { total: number; reflowed: number }>()
  for (const d of secondary) {
    const own = groupOf(d)
    const final = absorberOf(d.id) || own
    let c = counts.get(final)
    if (c === undefined) counts.set(final, (c = { total: 0, reflowed: 0 }))
    c.total++
    if (own !== final) c.reflowed++
  }

  const effects: SideEffect[] = []
  const rectOf = (e: SnapshotEntry | undefined): Rect | null => (e ? { x: e.x, y: e.y, w: e.w, h: e.h } : null)
  const base = (id: number, type: SideEffectType) => {
    const b = prev.get(id)
    const a = next.get(id)
    const e = (a ?? b)!
    return {
      id,
      desc: e.desc,
      path: e.path,
      type,
      relation: spine.has(id) ? ('ancestor' as const) : ('outside' as const),
      before: rectOf(b),
      after: rectOf(a),
    }
  }

  for (const d of secondary) {
    const c = counts.get(d.id)
    if (c === undefined) continue
    const presence = d.type === 'appeared' || d.type === 'disappeared' ? d.type : undefined
    let label: string
    if (presence) label = presence
    else if (d.type === 'moved') label = movePhrase(d.dx, d.dy, tol)
    else label = resizePhrase(d.dw, d.dh, tol)
    if (c.reflowed > 0 && !presence) label += ` (${c.reflowed} inside reflowed)`
    effects.push({
      ...base(d.id, d.type === 'moved' ? 'moved' : 'resized'),
      dx: d.dx,
      dy: d.dy,
      dw: d.dw,
      dh: d.dh,
      subtreeCount: c.total,
      reflowed: c.reflowed,
      ...(presence ? { presence } : {}),
      label,
    })
  }

  // Rule 5: conditions that do not depend on the geometric grouping.
  const offscreen = new Set<number>()
  const conditions: SideEffect[] = []
  for (const a of after.entries) {
    const b = prev.get(a.id)
    if (b === undefined || isPrimary(a.id)) continue
    const geometry = { dx: a.x - b.x, dy: a.y - b.y, dw: a.w - b.w, dh: a.h - b.h, subtreeCount: 1, reflowed: 0 }
    const axes = newAxes(b.overflow, a.overflow)
    if (axes) {
      const how = axes === 'x' ? ' horizontally' : axes === 'y' ? ' vertically' : ''
      conditions.push({ ...base(a.id, 'overflow'), ...geometry, overflow: axes, label: `overflows${how}` })
    }
    if (a.lines !== undefined && b.lines !== undefined && a.lines !== b.lines) {
      const verb = a.lines > b.lines ? 'wrapped' : 'unwrapped'
      conditions.push({
        ...base(a.id, 'wrapped'),
        ...geometry,
        lines: { before: b.lines, after: a.lines },
        label: `${verb} to ${a.lines} ${a.lines === 1 ? 'line' : 'lines'}`,
      })
    }
    if (intersects(b, before.viewport) && !intersects(a, after.viewport)) offscreen.add(a.id)
  }
  const offscreenTops = new Map<number, SideEffect>()
  for (const a of after.entries) {
    if (!offscreen.has(a.id)) continue
    let top = a.id
    for (let p = a.parent, n = 0; offscreen.has(p) && n < MAX_DEPTH; p = parentOf(p), n++) top = p
    const existing = offscreenTops.get(top)
    if (existing) {
      existing.subtreeCount++
      continue
    }
    const t = next.get(top)!
    const b = prev.get(top)!
    const effect: SideEffect = {
      ...base(top, 'offscreen'),
      dx: t.x - b.x,
      dy: t.y - b.y,
      dw: t.w - b.w,
      dh: t.h - b.h,
      subtreeCount: 1,
      reflowed: 0,
      label: 'pushed out of view',
    }
    offscreenTops.set(top, effect)
    conditions.push(effect)
  }
  effects.push(...conditions)

  // Array.prototype.sort is stable, so ties keep document order.
  effects.sort((p, q) => {
    if (p.relation !== q.relation) return p.relation === 'outside' ? -1 : 1
    return q.subtreeCount - p.subtreeCount
  })

  const pageOverflowX = after.page.w - after.viewport.w > tol && !(before.page.w - before.viewport.w > tol)
  const truncated = before.truncated || after.truncated
  let summary = summarize(effects, { pageOverflowX, maxClausesPerType: opts.maxClausesPerType })
  if (truncated) summary += ` (checked ${after.entries.length} of ${after.total} elements)`
  return { primary, effects, summary, pageOverflowX, truncated }
}

/** One line such as `14 elements moved up 48px; .footer overflows`. */
export function summarize(
  effects: readonly SideEffect[],
  opts: { pageOverflowX?: boolean; maxClausesPerType?: number } = {},
): string {
  const max = opts.maxClausesPerType ?? 2
  const moved = new Buckets()
  const resized = new Buckets()
  const presence = new Buckets()
  const offscreen = new Buckets()
  const overflow = new Buckets()
  const wrapped: SideEffect[] = []

  for (const e of effects) {
    if (e.type === 'overflow') overflow.add('overflows', 'overflow', e, 1)
    else if (e.type === 'wrapped') wrapped.push(e)
    else if (e.type === 'offscreen') offscreen.add(e.label, e.label, e, e.subtreeCount)
    else if (e.relation === 'ancestor') continue
    else if (e.presence) presence.add(e.presence, e.presence, e, e.subtreeCount)
    else if (e.type === 'moved') moved.add(e.label, e.label, e, e.subtreeCount)
    else {
      const phrase = e.reflowed > 0 ? e.label.slice(0, e.label.lastIndexOf(' (')) : e.label
      resized.add(phrase, phrase, e, e.subtreeCount - e.reflowed)
    }
  }

  const out = [
    ...moved.clauses(max, 'moved'),
    ...resized.clauses(max, 'resized'),
    ...presence.clauses(max, 'appeared or disappeared'),
    ...offscreen.clauses(max, 'pushed out of view'),
    ...overflow.clauses(max, 'overflowing'),
  ]
  if (wrapped.length === 1) out.push(`${shortLabel(wrapped[0]!.desc)} ${wrapped[0]!.label}`)
  else if (wrapped.length > 1) out.push(`${wrapped.length} elements re-wrapped`)
  if (opts.pageOverflowX) out.push('page scrolls horizontally')
  return out.length === 0 ? 'no side effects' : out.join('; ')
}

/** `tag#id.a.b` -> `#id`, `tag.a.b` -> `.a`, `tag` -> `tag`. */
export function shortLabel(desc: string): string {
  const hash = desc.indexOf('#')
  const dot = desc.indexOf('.')
  if (hash !== -1 && (dot === -1 || hash < dot)) {
    const end = desc.indexOf('.', hash)
    return end === -1 ? desc.slice(hash) : desc.slice(hash, end)
  }
  if (dot !== -1) {
    const end = desc.indexOf('.', dot + 1)
    return end === -1 ? desc.slice(dot) : desc.slice(dot, end)
  }
  return desc
}

class Buckets {
  private readonly map = new Map<string, { count: number; first: SideEffect; one: string; many: string }>()

  add(one: string, many: string, effect: SideEffect, count: number): void {
    const b = this.map.get(one)
    if (b) b.count += count
    else this.map.set(one, { count, first: effect, one, many })
  }

  clauses(max: number, restWord: string): string[] {
    // Stable sort: equal counts keep first-seen order.
    const sorted = [...this.map.values()].sort((p, q) => q.count - p.count)
    const out = sorted
      .slice(0, max)
      .map((b) => (b.count === 1 ? `${shortLabel(b.first.desc)} ${b.one}` : `${b.count} elements ${b.many}`))
    let rest = 0
    for (const b of sorted.slice(max)) rest += b.count
    if (rest > 0) out.push(`${rest} more ${restWord}`)
    return out
  }
}

function px(n: number): string {
  return `${Math.round(Math.abs(n) * 2) / 2}px`
}

function movePhrase(dx: number, dy: number, tol: number): string {
  const parts: string[] = []
  if (Math.abs(dy) > tol) parts.push(`${dy < 0 ? 'up' : 'down'} ${px(dy)}`)
  if (Math.abs(dx) > tol) parts.push(`${dx < 0 ? 'left' : 'right'} ${px(dx)}`)
  return `moved ${parts.join(' and ')}`
}

function resizePhrase(dw: number, dh: number, tol: number): string {
  const parts: string[] = []
  if (Math.abs(dw) > tol) parts.push(`${px(dw)} ${dw < 0 ? 'narrower' : 'wider'}`)
  if (Math.abs(dh) > tol) parts.push(`${px(dh)} ${dh < 0 ? 'shorter' : 'taller'}`)
  return `became ${parts.join(' and ')}`
}

function newAxes(before: OverflowAxes | undefined, after: OverflowAxes | undefined): OverflowAxes | undefined {
  if (after === undefined) return undefined
  const x = after.includes('x') && !(before?.includes('x') ?? false)
  const y = after.includes('y') && !(before?.includes('y') ?? false)
  return x && y ? 'xy' : x ? 'x' : y ? 'y' : undefined
}

function intersects(r: Rect, vp: Rect): boolean {
  return r.x < vp.x + vp.w && r.x + r.w > vp.x && r.y < vp.y + vp.h && r.y + r.h > vp.y
}
