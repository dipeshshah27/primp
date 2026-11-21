/**
 * Geometry snapshot of the visible page, taken in the browser.
 *
 * Reads only: no attribute, style or DOM write happens here, so the whole call costs at most the
 * one layout the browser already owes (the edit that was just previewed). Element ids live in a
 * WeakMap, never on the element.
 */

import type { OverflowAxes, Snapshot, SnapshotEntry } from '../../../engine/src/rect-diff.ts'

export interface SnapshotOptions {
  /** Most entries returned. Default 2,500. */
  cap?: number
  /**
   * Ids that must survive the cap: pass the ids of the "before" snapshot (and of the edited
   * element) when taking the "after" snapshot, so the two cover the same elements.
   */
  pin?: Iterable<number>
  /** Count text lines for elements that have their own text. Default true. */
  lines?: boolean
  /** Read scroll/client sizes to flag overflowing containers. Default true. */
  overflow?: boolean
  /** Also measure elements hidden with `visibility: hidden`. Default false. */
  includeHidden?: boolean
}

export const DEFAULT_CAP = 2500
/** Marks the reglet overlay host; it and everything inside it are never measured. */
export const OVERLAY_ROOT_ATTR = 'data-reglet-root'

const ids = new WeakMap<Element, number>()
const refs = new Map<number, WeakRef<Element>>()
const collected = new FinalizationRegistry<number>((id) => refs.delete(id))
let nextId = 1

/** Stable per-session id of an element. Assigned on first use. */
export function idOf(el: Element): number {
  let id = ids.get(el)
  if (id === undefined) {
    id = nextId++
    ids.set(el, id)
    refs.set(id, new WeakRef(el))
    collected.register(el, id)
  }
  return id
}

/** The element behind an id, or null when it was never seen or has been garbage-collected. */
export function elementOf(id: number): Element | null {
  return refs.get(id)?.deref() ?? null
}

// Selection key when the page has more candidates than the cap: distance band first (0 = in the
// viewport, then one band per viewport height away), larger boxes first inside a band.
const BANDS = 16
const AREA_BUCKETS = 32

const VISIBILITY_CHECK: CheckVisibilityOptions = { visibilityProperty: true }

export function snapshot(root?: Element, opts: SnapshotOptions = {}): Snapshot {
  const doc = root?.ownerDocument ?? document
  const top: Element | null = root ?? doc.body
  const win = doc.defaultView ?? window
  const cap = Math.max(1, opts.cap ?? DEFAULT_CAP)
  const wantLines = opts.lines ?? true
  const wantOverflow = opts.overflow ?? true

  const docEl = doc.documentElement
  const vw = docEl.clientWidth
  const vh = docEl.clientHeight
  const sx = win.scrollX
  const sy = win.scrollY
  const pinned = opts.pin !== undefined
  const viewport = { x: sx, y: sy, w: vw, h: vh }
  if (top === null) {
    // Called before <body> exists.
    return { entries: [], total: 0, truncated: false, pinned, viewport, page: { w: docEl.scrollWidth, h: docEl.scrollHeight } }
  }
  // visibility:hidden boxes still take part in layout but nobody sees them move. They are filtered
  // after the cap, so the check runs on at most `cap` elements however large the page is.
  const skipHidden = !(opts.includeHidden ?? false) && typeof top.checkVisibility === 'function'

  const overlayRoots = Array.from(doc.querySelectorAll(`[${OVERLAY_ROOT_ATTR}]`))
  const overlayRoot = overlayRoots.length === 1 ? overlayRoots[0] : undefined
  const isOverlay =
    overlayRoots.length === 0
      ? undefined
      : overlayRoot
        ? (el: Element) => el === overlayRoot
        : (el: Element) => overlayRoots.includes(el)

  // Phase 1: walk in document order and read every rect. Candidates are kept as parallel arrays.
  const els: Element[] = []
  const parents: number[] = [] // index of the nearest candidate ancestor, or -1
  const paths: string[] = []
  const xs: number[] = []
  const ys: number[] = []
  const ws: number[] = []
  const hs: number[] = []
  const flags: number[] = [] // bit 0: has content, bit 1: has its own text

  const visit = (el: Element, parent: number, path: string): void => {
    if (isOverlay?.(el)) return
    const r = el.getBoundingClientRect()
    const w = r.width
    const h = r.height
    let self = parent
    if (w > 0 && h > 0) {
      self = els.length
      els.push(el)
      parents.push(parent)
      paths.push(path)
      xs.push(r.left)
      ys.push(r.top)
      ws.push(w)
      hs.push(h)
      flags.push(0)
    } else if (w === 0 && h === 0 && el.firstElementChild !== null && win.getComputedStyle(el).display === 'none') {
      return // nothing inside a display:none subtree has a box
    }
    if (el.localName === 'svg') return // graphics, not layout

    const prefix = path === '' ? '' : `${path}.`
    const shadow = el.shadowRoot
    if (shadow !== null) {
      let i = 0
      for (let c = shadow.firstElementChild; c !== null; c = c.nextElementSibling) visit(c, self, `${prefix}~${i++}`)
    }
    let i = 0
    let content = 0
    for (let n = el.firstChild; n !== null; n = n.nextSibling) {
      const t = n.nodeType
      if (t === 1) {
        content |= 1
        visit(n as Element, self, prefix + i++)
      } else if (t === 3 && (content & 2) === 0 && /\S/.test((n as Text).data)) {
        content |= 3
      }
    }
    if (self !== parent) flags[self] = content
  }
  visit(top, -1, '')

  // Phase 2: apply the cap.
  const total = els.length
  let keep: Uint8Array | undefined
  if (total > cap) {
    keep = new Uint8Array(total)
    const keys = new Uint16Array(total)
    const histogram = new Uint32Array(BANDS * AREA_BUCKETS)
    const pin = opts.pin === undefined ? undefined : opts.pin instanceof Set ? (opts.pin as Set<number>) : new Set(opts.pin)
    let room = cap
    for (let i = 0; i < total; i++) {
      if (pin !== undefined && room > 0) {
        const id = ids.get(els[i]!)
        if (id !== undefined && pin.has(id)) {
          keep[i] = 1
          room--
          continue
        }
      }
      const x = xs[i]!
      const y = ys[i]!
      const w = ws[i]!
      const h = hs[i]!
      const away = Math.max(0, -(y + h), y - vh, -(x + w), x - vw)
      const band = away === 0 ? 0 : Math.min(BANDS - 1, 1 + Math.floor(away / Math.max(1, vh)))
      const area = Math.min(w * h, 0x7fffffff) | 0
      const size = 31 - Math.clz32(area | 1) // floor(log2(area)), 0..30
      const key = band * AREA_BUCKETS + (AREA_BUCKETS - 1 - size)
      keys[i] = key
      histogram[key]!++
    }
    // Take whole key classes while they fit, then fill the last class in document order.
    let limit = 0
    while (limit < histogram.length && histogram[limit]! <= room) room -= histogram[limit++]!
    for (let i = 0; i < total; i++) {
      if (keep[i] === 1) continue
      const key = keys[i]!
      if (key < limit) keep[i] = 1
      else if (key === limit && room > 0) {
        keep[i] = 1
        room--
      }
    }
  }

  // Phase 3: emit entries for the kept candidates. Still reads only.
  const entries: SnapshotEntry[] = []
  const entryIds = new Int32Array(total) // 0 for dropped candidates
  const nearest = new Int32Array(total) // id of the nearest kept ancestor
  const range = wantLines ? doc.createRange() : undefined
  let hidden = 0
  for (let i = 0; i < total; i++) {
    const p = parents[i]!
    const parentId = p < 0 ? 0 : entryIds[p]! || nearest[p]!
    nearest[i] = parentId
    if (keep !== undefined && keep[i] === 0) continue
    const el = els[i]!
    if (skipHidden && !el.checkVisibility(VISIBILITY_CHECK)) {
      hidden++
      continue
    }
    const id = idOf(el)
    entryIds[i] = id
    const entry: SnapshotEntry = {
      id,
      parent: parentId,
      desc: describe(el),
      path: paths[i]!,
      x: half(xs[i]! + sx),
      y: half(ys[i]! + sy),
      w: half(ws[i]!),
      h: half(hs[i]!),
    }
    const content = flags[i]!
    if (wantOverflow && content !== 0) {
      const overflow = overflowOf(el)
      if (overflow !== undefined) entry.overflow = overflow
    }
    if (range !== undefined && (content & 2) !== 0) entry.lines = countLines(range, el)
    entries.push(entry)
  }

  return {
    entries,
    total: total - hidden,
    truncated: keep !== undefined,
    pinned,
    viewport,
    page: { w: docEl.scrollWidth, h: docEl.scrollHeight },
  }
}

function half(n: number): number {
  return Math.round(n * 2) / 2
}

/** `tag#id.class1.class2` */
function describe(el: Element): string {
  let out = el.localName
  const id = el.id
  if (id !== '') out += `#${id}`
  const cls = el.getAttribute('class')
  if (cls !== null && cls !== '') {
    let taken = 0
    for (const name of cls.split(/\s+/)) {
      if (name === '') continue
      out += `.${name}`
      if (++taken === 2) break
    }
  }
  return out
}

function overflowOf(el: Element): OverflowAxes | undefined {
  const cw = el.clientWidth
  if (cw === 0) return undefined // inline box, or no box of its own
  const x = el.scrollWidth - cw > 1
  const y = el.scrollHeight - el.clientHeight > 1
  return x ? (y ? 'xy' : 'x') : y ? 'y' : undefined
}

/** Rows of inline content: a fragment starts a new line when its middle lies below the current line. */
function countLines(range: Range, el: Element): number {
  range.selectNodeContents(el)
  const rects = range.getClientRects()
  let lines = 0
  let bottom = -Infinity
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]!
    if (r.width === 0 || r.height === 0) continue
    if (r.top + r.height / 2 >= bottom) lines++
    if (r.bottom > bottom) bottom = r.bottom
  }
  return lines
}
