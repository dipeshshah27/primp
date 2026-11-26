/**
 * In-page half of spike S5. Bundled with esbuild and served as the first script in <head>,
 * the way the proxy injects the overlay. Nothing here touches the DOM at load time.
 *
 * It exposes `window.__s5` with:
 *  - bench():      timings of snapshot / diff / classify around a real edit
 *  - observe():    one edit, with the engine's report next to raw getBoundingClientRect
 *                  measurements taken by separate code (the spike compares the two in Node)
 *  - structure():  invariants of a snapshot (overlay excluded, rounding, parents, raw rects)
 *  - ioBench():    the IntersectionObserver alternative, for comparison
 */

import { classify, diff } from '../../packages/engine/src/index.ts'
import type { RectDelta, SideEffectReport, Snapshot } from '../../packages/engine/src/index.ts'
import { OVERLAY_ROOT_ATTR, elementOf, idOf, snapshot } from '../../packages/overlay/src/probe/snapshot.ts'
import type { SnapshotOptions } from '../../packages/overlay/src/probe/snapshot.ts'

export type EditName = 'banner' | 'card' | 'sidebar'

const EDITS: Record<EditName, { selector: string; css: string }> = {
  banner: { selector: '#promo-banner', css: '#promo-banner{display:none!important}' },
  card: { selector: '#card-0-1', css: '#card-0-1{padding:28px!important}' },
  sidebar: { selector: '#sidebar', css: '#sidebar{flex-basis:300px!important;width:300px!important}' },
}

// Edits go through one constructable stylesheet, like the real preview layer.
let sheet: CSSStyleSheet | undefined
function previewSheet(): CSSStyleSheet {
  if (!sheet) {
    sheet = new CSSStyleSheet()
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
  }
  return sheet
}
function apply(edit: EditName): void {
  previewSheet().replaceSync(EDITS[edit].css)
}
function revert(): void {
  previewSheet().replaceSync('')
}
function settle(): void {
  void document.body.offsetHeight
}
const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()))
const now = (): number => performance.now()

function editedId(edit: EditName): number {
  const el = document.querySelector(EDITS[edit].selector)
  if (!el) throw new Error(`missing ${EDITS[edit].selector}`)
  return idOf(el)
}

/** The "after" snapshot always pins the "before" ids, so both cover the same elements under the cap. */
function afterOptions(before: Snapshot, edited: number, base: SnapshotOptions): SnapshotOptions {
  const pin = new Set<number>([edited])
  for (const e of before.entries) pin.add(e.id)
  return { ...base, pin }
}

export interface BenchResult {
  runs: number
  entries: number
  total: number
  truncated: boolean
  deltas: number
  effects: number
  summary: string
  /** Per run, in ms. */
  baseline: number[] // snapshot on a clean layout (the "before")
  relayout: number[] // the browser's own style + layout for the edit, forced by one read
  collect: number[] // snapshot right after that (layout already clean)
  snapshot: number[] // relayout + collect: what the "after" snapshot costs on a dirty page
  diff: number[]
  classify: number[]
  total1: number[] // snapshot + diff + classify (the S5 criterion)
  total2: number[] // baseline + snapshot + diff + classify (both snapshots taken per edit)
}

async function bench(edit: EditName, runs: number, opts: SnapshotOptions = {}): Promise<BenchResult> {
  const out: BenchResult = {
    runs,
    entries: 0,
    total: 0,
    truncated: false,
    deltas: 0,
    effects: 0,
    summary: '',
    baseline: [],
    relayout: [],
    collect: [],
    snapshot: [],
    diff: [],
    classify: [],
    total1: [],
    total2: [],
  }
  const edited = editedId(edit)
  for (let i = 0; i < runs; i++) {
    revert()
    settle()
    await frame()

    const t0 = now()
    const before = snapshot(document.body, opts)
    const t1 = now()

    apply(edit)
    const t2 = now()
    settle() // one read: the browser recalculates style and lays out the edit here
    const t3 = now()
    const after = snapshot(document.body, afterOptions(before, edited, opts))
    const t4 = now()
    const deltas = diff(before, after)
    const t5 = now()
    const report = classify(before, after, deltas, { edited: [edited] })
    const t6 = now()

    out.baseline.push(t1 - t0)
    out.relayout.push(t3 - t2)
    out.collect.push(t4 - t3)
    out.snapshot.push(t4 - t2)
    out.diff.push(t5 - t4)
    out.classify.push(t6 - t5)
    out.total1.push(t6 - t2)
    out.total2.push(t1 - t0 + (t6 - t2))
    out.entries = after.entries.length
    out.total = after.total
    out.truncated = after.truncated
    out.deltas = deltas.length
    out.effects = report.effects.length
    out.summary = report.summary
  }
  revert()
  settle()
  return out
}

/** One edit, then the snapshot, with no read in between: used to count forced layouts over CDP. */
function editThenSnapshot(edit: EditName, opts: SnapshotOptions = {}): number {
  apply(edit)
  return snapshot(document.body, opts).entries.length
}
function snapshotOnly(opts: SnapshotOptions = {}): number {
  return snapshot(document.body, opts).entries.length
}
function revertEdit(): void {
  revert()
  settle()
}
/** Deliberate write/read loop, to prove the layout counter the spike reads is sensitive. */
function thrash(times: number): void {
  const el = document.getElementById('site-footer')!
  for (let i = 0; i < times; i++) {
    el.style.paddingBottom = `${32 + (i % 2)}px`
    void el.offsetHeight
  }
  el.style.paddingBottom = ''
  settle()
}

/** Mutations recorded while a snapshot runs. Must be 0: the snapshot only reads. */
function mutationsDuringSnapshot(opts: SnapshotOptions = {}): number {
  let seen = 0
  const mo = new MutationObserver((records) => (seen += records.length))
  mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
  snapshot(document.body, opts)
  seen += mo.takeRecords().length
  mo.disconnect()
  return seen
}

// ---------------------------------------------------------------------------------------------
// Independent measurements. Nothing below calls snapshot(); it walks the DOM with
// querySelectorAll and reads raw getBoundingClientRect, computed style and scroll sizes.
// idOf() is used only to give the spike a key to join on.

export type RawRect = [x: number, y: number, w: number, h: number]
export interface RawRow {
  id: number
  parent: number
  label: string
  primary: boolean
  before: RawRect | null
  after: RawRect | null
  linesBefore: number | null
  linesAfter: number | null
  overflowBefore: string
  overflowAfter: string
}
interface RawMeasure {
  rect: RawRect | null
  lines: number | null
  overflow: string
}

/** body and everything under it, open shadow trees included, minus the overlay root. */
function appElements(): Element[] {
  const out: Element[] = []
  const add = (el: Element): void => {
    if (el.hasAttribute(OVERLAY_ROOT_ATTR)) return
    out.push(el)
    if (el.shadowRoot) for (const c of Array.from(el.shadowRoot.children)) add(c)
    for (const c of Array.from(el.children)) add(c)
  }
  add(document.body)
  return out
}

function hasOwnText(el: Element): boolean {
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '') return true
  }
  return false
}

function rawMeasure(el: Element): RawMeasure {
  const r = el.getBoundingClientRect()
  if (!(r.width > 0 && r.height > 0)) return { rect: null, lines: null, overflow: '' }
  if (getComputedStyle(el).visibility !== 'visible') return { rect: null, lines: null, overflow: '' }
  const rect: RawRect = [r.left + window.scrollX, r.top + window.scrollY, r.width, r.height]
  let lines: number | null = null
  if (hasOwnText(el)) {
    const cs = getComputedStyle(el)
    if (cs.whiteSpace === 'nowrap' || cs.getPropertyValue('text-wrap-mode') === 'nowrap') lines = 1
    else {
      const inner =
        r.height -
        parseFloat(cs.paddingTop) -
        parseFloat(cs.paddingBottom) -
        parseFloat(cs.borderTopWidth) -
        parseFloat(cs.borderBottomWidth)
      lines = Math.round(inner / parseFloat(cs.lineHeight))
    }
  }
  const h = el as HTMLElement
  let overflow = ''
  if (h.clientWidth > 0 && el.childNodes.length > 0) {
    if (h.scrollWidth - h.clientWidth > 1) overflow += 'x'
    if (h.scrollHeight - h.clientHeight > 1) overflow += 'y'
  }
  return { rect, lines, overflow }
}

function parentAcrossShadow(n: Node): Node | null {
  const p = n.parentNode
  return p instanceof ShadowRoot ? p.host : p
}

function labelOf(el: Element): string {
  return el.id ? `#${el.id}` : `${el.localName}.${el.getAttribute('class') ?? ''}`
}

export interface Observation {
  edit: EditName
  editedId: number
  viewport: { w: number; h: number; scrollX: number; scrollY: number }
  rows: RawRow[]
  known: Record<string, number>
  deltas: RectDelta[]
  report: SideEffectReport
  entries: { before: number; after: number; truncated: boolean }
}

const KNOWN = [
  '#promo-banner',
  '#site-header',
  '#layout',
  '#sidebar',
  '#content',
  '#toolbar',
  '#sec-0',
  '#sec-1',
  '#card-0-0',
  '#card-0-1',
  '#card-0-2',
  '#card-0-3',
  '#card-0-4',
  '#site-footer',
  '#to-top',
]

function observe(edit: EditName, opts: SnapshotOptions = {}): Observation {
  revert()
  settle()
  const edited = editedId(edit)
  const editedEl = document.querySelector(EDITS[edit].selector)!
  const els = appElements()

  const before = snapshot(document.body, opts)
  const rawBefore = els.map(rawMeasure)
  apply(edit)
  const after = snapshot(document.body, afterOptions(before, edited, opts))
  const rawAfter = els.map(rawMeasure)
  const deltas = diff(before, after)
  const report = classify(before, after, deltas, { edited: [edited] })

  const rows: RawRow[] = els.map((el, i) => ({
    id: idOf(el),
    parent: el === document.body ? 0 : idOf(parentAcrossShadow(el) as Element),
    label: labelOf(el),
    primary: editedEl.contains(el),
    before: rawBefore[i]!.rect,
    after: rawAfter[i]!.rect,
    linesBefore: rawBefore[i]!.lines,
    linesAfter: rawAfter[i]!.lines,
    overflowBefore: rawBefore[i]!.overflow,
    overflowAfter: rawAfter[i]!.overflow,
  }))
  const known: Record<string, number> = {}
  for (const sel of KNOWN) {
    const el = document.querySelector(sel)
    if (el) known[sel] = idOf(el)
  }
  const result: Observation = {
    edit,
    editedId: edited,
    viewport: {
      w: document.documentElement.clientWidth,
      h: document.documentElement.clientHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    },
    rows,
    known,
    deltas,
    report,
    entries: { before: before.entries.length, after: after.entries.length, truncated: before.truncated || after.truncated },
  }
  revert()
  settle()
  return result
}

export interface Structure {
  domElements: number
  entries: number
  total: number
  truncated: boolean
  viewport: Snapshot['viewport']
  page: Snapshot['page']
  insideOverlay: number
  overlayElements: number
  hiddenMenuEntries: number
  /** Elements that have a box but computed `visibility` other than visible, and entries among them. */
  invisibleBoxes: number
  invisibleEntries: number
  shadowEntries: number
  notHalfPixel: number
  duplicateIds: number
  badParents: number
  outOfOrder: number
  maxRawError: number
  rawMismatches: number
  withLines: number
  withOverflow: number
  inViewportDom: number
  inViewportKept: number
  repeatIdentical: boolean
  scrolledIdentical: boolean | null
  bytes: number
}

/** Invariants of one snapshot, checked against the DOM with separate code. */
function structure(opts: SnapshotOptions = {}): Structure {
  revert()
  settle()
  window.scrollTo(0, 0)
  const snap = snapshot(document.body, opts)
  const again = snapshot(document.body, opts)
  const seen = new Set<number>()
  const order = new Map<number, number>()
  let insideOverlay = 0
  let hiddenMenuEntries = 0
  let shadowEntries = 0
  let notHalfPixel = 0
  let duplicateIds = 0
  let badParents = 0
  let outOfOrder = 0
  let maxRawError = 0
  let rawMismatches = 0
  let withLines = 0
  let withOverflow = 0
  const isHalf = (n: number): boolean => Number.isInteger(n * 2)
  snap.entries.forEach((e, i) => {
    if (seen.has(e.id)) duplicateIds++
    seen.add(e.id)
    order.set(e.id, i)
    const el = elementOf(e.id)
    if (!el) {
      badParents++
      return
    }
    const rootNode = el.getRootNode()
    const host = rootNode instanceof ShadowRoot ? rootNode.host : null
    if (host) shadowEntries++
    if (el.closest(`[${OVERLAY_ROOT_ATTR}]`) || host?.closest(`[${OVERLAY_ROOT_ATTR}]`)) insideOverlay++
    if (el.closest('#mobile-menu')) hiddenMenuEntries++
    if (!isHalf(e.x) || !isHalf(e.y) || !isHalf(e.w) || !isHalf(e.h)) notHalfPixel++
    if (e.lines !== undefined) withLines++
    if (e.overflow !== undefined) withOverflow++
    // The parent must be the nearest ancestor (through shadow hosts) that is itself in the snapshot,
    // and must come earlier in the list.
    let nearest: Element | null = null
    for (let cur = parentAcrossShadow(el); cur; cur = parentAcrossShadow(cur)) {
      if (cur instanceof Element && order.has(idOf(cur)) && cur !== el) {
        nearest = cur
        break
      }
    }
    if ((e.parent === 0 ? null : elementOf(e.parent)) !== nearest) badParents++
    if (e.parent !== 0) {
      const pi = order.get(e.parent)
      if (pi === undefined || pi >= i) outOfOrder++
    }
    const r = el.getBoundingClientRect()
    const err = Math.max(
      Math.abs(e.x - (r.left + window.scrollX)),
      Math.abs(e.y - (r.top + window.scrollY)),
      Math.abs(e.w - r.width),
      Math.abs(e.h - r.height),
    )
    if (err > maxRawError) maxRawError = err
    if (err > 0.25 + 1e-9) rawMismatches++
  })

  // Everything visible in the viewport should survive the cap (when it fits).
  const vw = document.documentElement.clientWidth
  const vh = document.documentElement.clientHeight
  let inViewportDom = 0
  let inViewportKept = 0
  let invisibleBoxes = 0
  let invisibleEntries = 0
  for (const el of appElements()) {
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'visible') {
      invisibleBoxes++
      if (seen.has(idOf(el))) invisibleEntries++
      continue
    }
    if (r.width > 0 && r.height > 0 && r.left < vw && r.right > 0 && r.top < vh && r.bottom > 0) {
      inViewportDom++
      if (seen.has(idOf(el))) inViewportKept++
    }
  }

  // Document coordinates: the same snapshot after scrolling, apart from the viewport itself and
  // position:fixed elements, whose document position follows the scroll.
  let scrolledIdentical: boolean | null = null
  if (!snap.truncated) {
    window.scrollTo(0, 700)
    const scrolled = snapshot(document.body, opts)
    const fixed = new Set<number>()
    for (const e of snap.entries) {
      const el = elementOf(e.id)
      if (el && getComputedStyle(el).position === 'fixed') fixed.add(e.id)
    }
    const strip = (s: Snapshot): string => JSON.stringify(s.entries.filter((e) => !fixed.has(e.id)))
    scrolledIdentical = strip(scrolled) === strip(snap) && scrolled.viewport.y === 700
    window.scrollTo(0, 0)
    settle()
  }

  return {
    domElements: document.querySelectorAll('body, body *').length,
    entries: snap.entries.length,
    total: snap.total,
    truncated: snap.truncated,
    viewport: snap.viewport,
    page: snap.page,
    insideOverlay,
    overlayElements: document.querySelectorAll(`[${OVERLAY_ROOT_ATTR}], [${OVERLAY_ROOT_ATTR}] *`).length,
    hiddenMenuEntries,
    invisibleBoxes,
    invisibleEntries,
    shadowEntries,
    notHalfPixel,
    duplicateIds,
    badParents,
    outOfOrder,
    maxRawError,
    rawMismatches,
    withLines,
    withOverflow,
    inViewportDom,
    inViewportKept,
    repeatIdentical: JSON.stringify(snap) === JSON.stringify(again),
    scrolledIdentical,
    bytes: JSON.stringify(snap).length,
  }
}

// ---------------------------------------------------------------------------------------------
// Cost breakdown and the IntersectionObserver alternative.

let blackhole = 0

export interface Micro {
  rectsOnly: number[]
  visibilityOnly: number[]
  withHidden: number[]
  noLinesNoOverflow: number[]
  noLines: number[]
  noOverflow: number[]
  full: number[]
}

/** Clean-layout timings with features switched off, to see where the time goes. */
async function micro(runs: number, opts: SnapshotOptions = {}): Promise<Micro> {
  revert()
  settle()
  const out: Micro = { rectsOnly: [], visibilityOnly: [], withHidden: [], noLinesNoOverflow: [], noLines: [], noOverflow: [], full: [] }
  const all = Array.from(document.body.querySelectorAll('*'))
  for (let i = 0; i < runs; i++) {
    await frame()
    let t = now()
    let sink = 0
    for (const el of all) sink += el.getBoundingClientRect().width
    out.rectsOnly.push(now() - t)
    t = now()
    for (const el of all) sink += el.checkVisibility({ visibilityProperty: true }) ? 1 : 0
    out.visibilityOnly.push(now() - t)
    blackhole = sink
    t = now()
    snapshot(document.body, { ...opts, includeHidden: true })
    out.withHidden.push(now() - t)
    t = now()
    snapshot(document.body, { ...opts, lines: false, overflow: false })
    out.noLinesNoOverflow.push(now() - t)
    t = now()
    snapshot(document.body, { ...opts, lines: false })
    out.noLines.push(now() - t)
    t = now()
    snapshot(document.body, { ...opts, overflow: false })
    out.noOverflow.push(now() - t)
    t = now()
    snapshot(document.body, opts)
    out.full.push(now() - t)
  }
  return out
}

export interface IoResult {
  elements: number
  /** Edit applied inside a requestAnimationFrame callback -> all rects delivered (best case). */
  wall: number[]
  /** Edit applied from an ordinary task, as an input handler would -> all rects delivered. */
  wallFromTask: number[]
  /** Script time only: observe() calls plus reading the entries in the callback. */
  script: number[]
  /** Largest difference to a synchronous snapshot of the same state, in px. */
  maxError: number
  /** Median gap between animation frames, in ms. */
  frameInterval: number
}

function ioCollect(els: Element[]): Promise<{ script: number; rects: Map<Element, DOMRectReadOnly> }> {
  return new Promise((resolve) => {
    const rects = new Map<Element, DOMRectReadOnly>()
    let script = 0
    const io = new IntersectionObserver((entries) => {
      const c0 = now()
      for (const e of entries) rects.set(e.target, e.boundingClientRect)
      script += now() - c0
      if (rects.size >= els.length) {
        io.disconnect()
        resolve({ script, rects })
      }
    })
    const o0 = now()
    for (const el of els) io.observe(el)
    script += now() - o0
  })
}

async function ioBench(edit: EditName, runs: number, opts: SnapshotOptions = {}): Promise<IoResult> {
  revert()
  settle()
  const els = snapshot(document.body, opts)
    .entries.map((e) => elementOf(e.id))
    .filter((el): el is Element => el !== null)
  const gaps: number[] = []
  for (let i = 0, last = (await frame(), now()); i < 20; i++) {
    await frame()
    const t = now()
    gaps.push(t - last)
    last = t
  }
  gaps.sort((p, q) => p - q)
  const out: IoResult = { elements: els.length, wall: [], wallFromTask: [], script: [], maxError: 0, frameInterval: gaps[10]! }
  for (let i = 0; i < runs; i++) {
    revert()
    settle()
    await frame()
    apply(edit)
    const t0 = now()
    const { script, rects } = await ioCollect(els)
    out.wall.push(now() - t0)
    out.script.push(script)
    if (i === 0) {
      for (const [el, r] of rects) {
        const live = el.getBoundingClientRect()
        if (live.width === 0 && live.height === 0) continue
        out.maxError = Math.max(out.maxError, Math.abs(live.left - r.left), Math.abs(live.top - r.top), Math.abs(live.width - r.width))
      }
    }
  }
  for (let i = 0; i < runs; i++) {
    revert()
    settle()
    await frame()
    // Leave the frame callback and land at a varying point of the frame interval.
    await new Promise((resolve) => setTimeout(resolve, 1 + ((i * 7) % 15)))
    apply(edit)
    const t0 = now()
    await ioCollect(els)
    out.wallFromTask.push(now() - t0)
  }
  revert()
  settle()
  return out
}

function timer(): { isolated: boolean; resolutionMs: number } {
  let smallest = Infinity
  let last = now()
  for (let i = 0; i < 200000 && smallest > 0.001; i++) {
    const t = now()
    if (t > last) {
      smallest = Math.min(smallest, t - last)
      last = t
    }
  }
  return { isolated: self.crossOriginIsolated, resolutionMs: smallest }
}

const api = {
  blackhole: () => blackhole,
  bench,
  observe,
  structure,
  micro,
  ioBench,
  timer,
  editThenSnapshot,
  snapshotOnly,
  revertEdit,
  thrash,
  mutationsDuringSnapshot,
}
export type S5Api = typeof api
;(globalThis as unknown as { __s5: S5Api }).__s5 = api
