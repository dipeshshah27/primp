/**
 * Spike S5: is the edit side-effect check fast enough to run on every edit?
 *
 *   pnpm spike:s5        exits 0 when every check passes, 1 otherwise
 *
 * Pass criterion (from the plan): snapshot + diff + classify of 2,500 elements, p95 < 30 ms on
 * this machine; a 12,000-element page is truncated to the cap and stays under the same budget.
 *
 * What is measured, per run, inside the page with performance.now():
 *   relayout  the browser's own style + layout for the edit (forced by one read)
 *   collect   snapshot() once layout is clean
 *   snapshot  relayout + collect: the "after" snapshot as the overlay will pay for it
 *   diff, classify
 *   total     snapshot + diff + classify           <- the gated number, on both pages
 *   total x2  total plus a fresh "before" snapshot <- also gated on page A, reported on page B
 *
 * Pages: A (2,676 measured elements, cap lifted), B (12,091, default cap of 2,500) and, for
 * information only, C (about 50,000) plus page A under 4x CPU throttling.
 *
 * Correctness is checked against raw getBoundingClientRect / computed style / scroll sizes read
 * by separate code in s5-assets/inject.ts and compared here.
 */

import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { cpus } from 'node:os'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { chromium } from '@playwright/test'
import type { Browser, CDPSession, Page } from '@playwright/test'
import { build } from 'esbuild'
import type { RectDelta, SideEffect } from '../packages/engine/src/index.ts'
import type { BenchResult, EditName, Observation, RawRect, RawRow, S5Api } from './s5-assets/inject.ts'
import { buildPage } from './s5-assets/page.ts'

declare global {
  interface Window {
    __s5: S5Api
  }
}

const BUDGET_MS = 30
const RUNS = 50
const DEFAULT_CAP = 2500
const UNCAPPED = 1_000_000
const EDITS: EditName[] = ['banner', 'card', 'sidebar']
const VIEWPORT = { width: 1440, height: 900 }

// ---------------------------------------------------------------------------------------------
// Report plumbing

interface Check {
  name: string
  pass: boolean
  evidence: string
}
const checks: Check[] = []
function check(name: string, pass: boolean, evidence: string): void {
  checks.push({ name, pass, evidence })
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}\n        ${evidence}`)
}
function info(line: string): void {
  console.log(`  info  ${line}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? NaN
}
const p50 = (v: number[]): number => percentile(v, 0.5)
const p95 = (v: number[]): number => percentile(v, 0.95)
const max = (v: number[]): number => Math.max(...v)
const ms = (n: number): string => n.toFixed(2)
const pair = (v: number[]): string => `${ms(p50(v))}/${ms(p95(v))}`

// ---------------------------------------------------------------------------------------------
// Independent expectations, computed here from the raw rows the page returned.
// The rules restate the snapshot contract (rects rounded to 0.5px, changes over 0.5px count);
// no engine code is called.

interface Box {
  x: number
  y: number
  w: number
  h: number
}
const half = (n: number): number => Math.round(n * 2) / 2
const box = (r: RawRect | null): Box | null => (r ? { x: half(r[0]), y: half(r[1]), w: half(r[2]), h: half(r[3]) } : null)

function expectedDelta(row: RawRow): RectDelta | null {
  const b = box(row.before)
  const a = box(row.after)
  if (!b && !a) return null
  if (!b && a) return { id: row.id, type: 'appeared', dx: 0, dy: 0, dw: a.w, dh: a.h }
  if (b && !a) return { id: row.id, type: 'disappeared', dx: 0, dy: 0, dw: -b.w, dh: -b.h }
  const d = { dx: a!.x - b!.x, dy: a!.y - b!.y, dw: a!.w - b!.w, dh: a!.h - b!.h }
  if (Math.abs(d.dw) > 0.5 || Math.abs(d.dh) > 0.5) return { id: row.id, type: 'resized', ...d }
  if (Math.abs(d.dx) > 0.5 || Math.abs(d.dy) > 0.5) return { id: row.id, type: 'moved', ...d }
  return null
}

const sameDelta = (a: RectDelta | null | undefined, b: RectDelta | null | undefined): boolean =>
  (!a && !b) || (!!a && !!b && a.type === b.type && a.dx === b.dx && a.dy === b.dy && a.dw === b.dw && a.dh === b.dh)

class Oracle {
  readonly byId = new Map<number, RawRow>()
  readonly delta = new Map<number, RectDelta>()
  readonly spine = new Set<number>()
  constructor(readonly obs: Observation) {
    for (const r of obs.rows) this.byId.set(r.id, r)
    for (const r of obs.rows) {
      const d = expectedDelta(r)
      if (d) this.delta.set(r.id, d)
    }
    for (let p = this.byId.get(obs.editedId)?.parent ?? 0; p !== 0; p = this.byId.get(p)?.parent ?? 0) this.spine.add(p)
  }
  id(selector: string): number {
    const id = this.obs.known[selector]
    if (id === undefined) throw new Error(`page has no ${selector}`)
    return id
  }
  inside(row: RawRow, ancestor: number): boolean {
    for (let cur: RawRow | undefined = row; cur; cur = this.byId.get(cur.parent)) if (cur.id === ancestor) return true
    return false
  }
  /** Rows outside the edited subtree. */
  get others(): RawRow[] {
    return this.obs.rows.filter((r) => !r.primary)
  }
  /** Elements in a subtree (root included) whose rect changed. */
  changedInside(ancestor: number): number {
    return this.others.filter((r) => this.delta.has(r.id) && this.inside(r, ancestor)).length
  }
  inViewport(b: Box): boolean {
    const v = this.obs.viewport
    return b.x < v.scrollX + v.w && b.x + b.w > v.scrollX && b.y < v.scrollY + v.h && b.y + b.h > v.scrollY
  }
  /** In the viewport before, entirely outside it after. */
  pushedOut(): RawRow[] {
    return this.others.filter((r) => {
      const b = box(r.before)
      const a = box(r.after)
      return !!b && !!a && this.inViewport(b) && !this.inViewport(a)
    })
  }
  newlyOverflowing(): Map<number, string> {
    const out = new Map<number, string>()
    for (const r of this.others) {
      if (!r.before || !r.after) continue
      const axes = [...r.overflowAfter].filter((c) => !r.overflowBefore.includes(c)).join('')
      if (axes) out.set(r.id, axes)
    }
    return out
  }
  rewrapped(): RawRow[] {
    return this.others.filter(
      (r) => r.before && r.after && r.linesBefore !== null && r.linesAfter !== null && r.linesBefore !== r.linesAfter,
    )
  }
  short(row: RawRow): string {
    if (row.label.startsWith('#')) return row.label
    const cls = row.label.slice(row.label.indexOf('.') + 1).trim().split(/\s+/)[0]
    return cls ? `.${cls}` : row.label.slice(0, row.label.indexOf('.'))
  }
}

const sortedIds = (ids: Iterable<number>): string => [...ids].sort((a, b) => a - b).join(',')

/** Checks that hold for any edit: raw deltas, and the three geometry-independent effect types. */
function checkAgainstRaw(label: string, o: Oracle): void {
  const { obs } = o
  const engine = new Map<number, RectDelta>()
  for (const d of obs.deltas) engine.set(d.id, d)
  let disagree = 0
  const examples: string[] = []
  const ids = new Set<number>([...engine.keys(), ...o.byId.keys()])
  for (const id of ids) {
    if (!sameDelta(engine.get(id), o.delta.get(id))) {
      disagree++
      if (examples.length < 3) {
        examples.push(`${o.byId.get(id)?.label ?? `id ${id}`}: engine ${JSON.stringify(engine.get(id) ?? null)} raw ${JSON.stringify(o.delta.get(id) ?? null)}`)
      }
    }
  }
  check(
    `${label}: every raw delta equals the one derived from getBoundingClientRect`,
    disagree === 0 && obs.deltas.length > 0,
    `${obs.rows.length} elements compared, ${obs.deltas.length} engine deltas, ${o.delta.size} raw deltas, ${disagree} disagree${examples.length ? `; e.g. ${examples.join(' | ')}` : ''}`,
  )

  const effects = obs.report.effects
  const wrappedGot = effects.filter((e) => e.type === 'wrapped')
  const wrappedWant = o.rewrapped()
  const linesOk = wrappedGot.every((e) => {
    const r = o.byId.get(e.id)
    return r && e.lines?.before === r.linesBefore && e.lines?.after === r.linesAfter
  })
  check(
    `${label}: wrapped effects equal the elements whose (height / line-height) line count changed`,
    sortedIds(wrappedGot.map((e) => e.id)) === sortedIds(wrappedWant.map((r) => r.id)) && linesOk,
    `engine ${wrappedGot.length}, raw ${wrappedWant.length}, line counts ${linesOk ? 'match' : 'DIFFER'}`,
  )

  const overflowGot = effects.filter((e) => e.type === 'overflow')
  const overflowWant = o.newlyOverflowing()
  check(
    `${label}: overflow effects equal the elements whose scrollWidth/Height newly exceeds the client size`,
    overflowGot.map((e) => `${e.id}:${e.overflow}`).sort().join() === [...overflowWant].map(([id, a]) => `${id}:${a}`).sort().join(),
    `engine [${overflowGot.map((e) => `${e.desc}:${e.overflow}`).join(', ')}], raw [${[...overflowWant].map(([id, a]) => `${o.byId.get(id)?.label}:${a}`).join(', ')}]`,
  )

  const outGot = effects.filter((e) => e.type === 'offscreen')
  const out = o.pushedOut()
  const outIds = new Set(out.map((r) => r.id))
  const nearestVisible = (r: RawRow): number => {
    for (let p = o.byId.get(r.parent); p; p = o.byId.get(p.parent)) if (p.after) return p.id
    return 0
  }
  const tops = out.filter((r) => !outIds.has(nearestVisible(r)))
  check(
    `${label}: offscreen effects equal the top-most elements that left the viewport`,
    sortedIds(outGot.map((e) => e.id)) === sortedIds(tops.map((r) => r.id)) &&
      outGot.reduce((n, e) => n + e.subtreeCount, 0) === out.length,
    `engine ${outGot.length} groups covering ${outGot.reduce((n, e) => n + e.subtreeCount, 0)} elements, raw ${tops.length} groups covering ${out.length}`,
  )
}

function findEffect(obs: Observation, id: number, type: SideEffect['type']): SideEffect | undefined {
  return obs.report.effects.find((e) => e.id === id && e.type === type)
}

function describeEffect(e: SideEffect | undefined): string {
  return e ? `${e.desc} ${e.type} d=(${e.dx},${e.dy},${e.dw},${e.dh}) count=${e.subtreeCount} reflowed=${e.reflowed}` : 'no effect'
}

function conditionClauses(o: Oracle): string[] {
  const out: string[] = []
  const pushed = o.pushedOut()
  if (pushed.length === 1) out.push(`${o.short(pushed[0]!)} pushed out of view`)
  else if (pushed.length > 1) out.push(`${pushed.length} elements pushed out of view`)
  const over = [...o.newlyOverflowing().keys()]
  if (over.length === 1) out.push(`${o.short(o.byId.get(over[0]!)!)} overflows`)
  else if (over.length > 1) out.push(`${over.length} elements overflow`)
  const wrapped = o.rewrapped()
  if (wrapped.length === 1) {
    const r = wrapped[0]!
    const n = r.linesAfter!
    out.push(`${o.short(r)} ${n > r.linesBefore! ? 'wrapped' : 'unwrapped'} to ${n} ${n === 1 ? 'line' : 'lines'}`)
  } else if (wrapped.length > 1) out.push(`${wrapped.length} elements re-wrapped`)
  return out
}

const count = (n: number, one: string, many: string): string => (n === 1 ? one : `${n} elements ${many}`)

function checkBanner(obs: Observation): void {
  const o = new Oracle(obs)
  checkAgainstRaw('banner', o)
  const banner = o.byId.get(o.id('#promo-banner'))!
  const bannerH = box(banner.before)!.h
  check('banner: the banner is 48px tall before and has no box after (raw rect)', bannerH === 48 && banner.after === null, `before ${JSON.stringify(banner.before)}, after ${JSON.stringify(banner.after)}`)

  for (const sel of ['#site-header', '#layout', '#site-footer']) {
    const id = o.id(sel)
    const raw = o.delta.get(id)
    const e = findEffect(obs, id, 'moved')
    const want = o.changedInside(id)
    check(
      `banner: ${sel} is reported as one subtree moved up by the banner height`,
      !!raw && raw.type === 'moved' && raw.dy === -bannerH && !!e && e.dx === 0 && e.dy === -bannerH && e.subtreeCount === want && e.reflowed === 0 && e.relation === 'outside',
      `raw dy ${raw?.dy}, ${want} changed elements in the subtree; engine: ${describeEffect(e)}`,
    )
  }
  const outside = obs.report.effects.filter((e) => e.relation === 'outside')
  check(
    'banner: those three subtrees are the only effects outside the ancestors',
    sortedIds(outside.map((e) => e.id)) === sortedIds(['#site-header', '#layout', '#site-footer'].map((s) => o.id(s))),
    `outside effects: ${outside.map((e) => `${e.desc} (${e.type})`).join(', ')}`,
  )
  const fixed = o.id('#to-top')
  check('banner: the position:fixed button did not move and is not reported', !o.delta.has(fixed) && !obs.report.effects.some((e) => e.id === fixed), `raw delta ${JSON.stringify(o.delta.get(fixed) ?? null)}`)
  const primaryWant = obs.rows.filter((r) => r.primary && r.before).length
  check(
    'banner: the banner and its children are primary (disappeared), not side effects',
    obs.report.primary.length === primaryWant && obs.report.primary.every((d) => d.type === 'disappeared') && obs.report.primary.some((d) => d.id === banner.id),
    `${obs.report.primary.length} primary deltas, ${primaryWant} visible elements in the banner`,
  )
  const movers = o.others.filter((r) => {
    const d = o.delta.get(r.id)
    return d?.type === 'moved' && d.dx === 0 && d.dy === -bannerH
  })
  const want = [count(movers.length, '?', `moved up ${bannerH}px`), ...conditionClauses(o)].join('; ')
  check('banner: summary matches the count of elements whose raw rect moved up 48px', obs.report.summary === want, `engine "${obs.report.summary}" | raw "${want}"`)
}

function checkCard(obs: Observation): void {
  const o = new Oracle(obs)
  checkAgainstRaw('card', o)
  const card = o.delta.get(o.id('#card-0-1'))
  const grow = card?.dh ?? 0
  check('card: the edited card grew taller (raw rect) and is primary', !!card && card.type === 'resized' && grow > 0 && obs.report.primary.some((d) => d.id === card.id) && !obs.report.effects.some((e) => e.id === card.id), `raw delta ${JSON.stringify(card ?? null)}`)

  const siblings = ['#card-0-0', '#card-0-2', '#card-0-3'].map((s) => o.id(s))
  for (const id of siblings) {
    const raw = o.delta.get(id)
    const e = findEffect(obs, id, 'resized')
    const want = o.changedInside(id)
    check(
      `card: row sibling ${o.byId.get(id)!.label} stretched by the same height and absorbs its own reflow`,
      !!raw && raw.type === 'resized' && raw.dh === grow && raw.dw === 0 && !!e && e.dh === grow && e.dw === 0 && e.dx === 0 && e.dy === 0 && e.subtreeCount === want && e.relation === 'outside',
      `raw dh ${raw?.dh}, ${want} changed elements inside; engine: ${describeEffect(e)}`,
    )
  }
  for (const sel of ['#card-0-4', '#sec-1', '#site-footer']) {
    const id = o.id(sel)
    const raw = o.delta.get(id)
    const e = findEffect(obs, id, 'moved')
    const want = o.changedInside(id)
    check(
      `card: ${sel} is one subtree moved down by that height`,
      !!raw && raw.type === 'moved' && raw.dy === grow && raw.dx === 0 && !!e && e.dy === grow && e.dx === 0 && e.subtreeCount === want && e.reflowed === 0,
      `raw dy ${raw?.dy}, ${want} changed elements in the subtree; engine: ${describeEffect(e)}`,
    )
  }
  // Movers inside a stretched sibling are that sibling's reflow, not page-level movers.
  const movers = o.others.filter((r) => {
    const d = o.delta.get(r.id)
    return d?.type === 'moved' && d.dx === 0 && d.dy === grow && !siblings.some((s) => o.inside(r, s))
  })
  const taller = o.others.filter((r) => {
    const d = o.delta.get(r.id)
    return !o.spine.has(r.id) && d?.type === 'resized' && d.dx === 0 && d.dy === 0 && d.dw === 0 && d.dh === grow
  })
  const want = [count(movers.length, '?', `moved down ${grow}px`), count(taller.length, '?', `became ${grow}px taller`), ...conditionClauses(o)].join('; ')
  check('card: summary matches counts taken from raw rects', obs.report.summary === want, `engine "${obs.report.summary}" | raw "${want}"`)
}

function checkSidebar(obs: Observation): void {
  const o = new Oracle(obs)
  checkAgainstRaw('sidebar', o)
  const sidebar = o.delta.get(o.id('#sidebar'))
  check('sidebar: the sidebar is 60px wider (raw rect) and is primary', !!sidebar && sidebar.dw === 60 && obs.report.primary.some((d) => d.id === sidebar.id) && !obs.report.effects.some((e) => e.id === sidebar.id), `raw delta ${JSON.stringify(sidebar ?? null)}`)

  const contentId = o.id('#content')
  const content = o.delta.get(contentId)
  const e = findEffect(obs, contentId, 'resized')
  const inside = o.changedInside(contentId)
  check(
    'sidebar: #content moved right 60px, is 60px narrower, and stands for everything that reflowed inside it',
    !!content && content.dx === 60 && content.dw === -60 && !!e && sameDelta({ ...e, type: 'resized' }, content) && e.subtreeCount === inside && e.relation === 'outside',
    `raw delta ${JSON.stringify(content ?? null)}, ${inside} changed elements inside; engine: ${describeEffect(e)}`,
  )
  const footerId = o.id('#site-footer')
  const footer = o.delta.get(footerId)
  const fe = findEffect(obs, footerId, 'moved')
  check(
    'sidebar: the footer subtree moved down by the raw amount',
    !!footer && footer.type === 'moved' && footer.dy > 0 && !!fe && fe.dy === footer.dy && fe.dx === 0 && fe.subtreeCount === o.changedInside(footerId),
    `raw delta ${JSON.stringify(footer ?? null)}; engine: ${describeEffect(fe)}`,
  )
  const toolbar = o.byId.get(o.id('#toolbar'))!
  check(
    'sidebar: the fixed-width filter row no longer fits and is reported as overflowing',
    toolbar.overflowBefore === '' && toolbar.overflowAfter.includes('x') && findEffect(obs, toolbar.id, 'overflow')?.overflow === 'x',
    `raw overflow before "${toolbar.overflowBefore}" after "${toolbar.overflowAfter}"; engine: ${findEffect(obs, toolbar.id, 'overflow')?.label ?? 'no effect'}`,
  )
  const outsideGeometry = obs.report.effects.filter((x) => x.relation === 'outside' && (x.type === 'moved' || x.type === 'resized'))
  check(
    'sidebar: #content and the footer are the only moved/resized effects outside the ancestors',
    sortedIds(outsideGeometry.map((x) => x.id)) === sortedIds([contentId, footerId]),
    `${outsideGeometry.length} moved/resized effects for ${o.delta.size} raw deltas: ${outsideGeometry.map((x) => x.desc).join(', ')}`,
  )

  const movers = o.others.filter((r) => {
    const d = o.delta.get(r.id)
    return d?.type === 'moved' && d.dx === 0 && d.dy === footer?.dy && !o.inside(r, contentId)
  })
  const likeContent = o.others.filter((r) => !o.spine.has(r.id) && sameDelta(o.delta.get(r.id), content ? { ...content, id: r.id } : null))
  const phrase = `became 60px narrower and ${content?.dh}px taller`
  const want = [
    count(movers.length, '?', `moved down ${footer?.dy}px`),
    count(likeContent.length, `#content ${phrase}`, phrase),
    ...conditionClauses(o),
  ].join('; ')
  check('sidebar: summary matches counts taken from raw rects', obs.report.summary === want, `engine "${obs.report.summary}" | raw "${want}"`)
}

// ---------------------------------------------------------------------------------------------
// Browser plumbing

interface Served {
  server: Server
  origin: string
}

async function serve(routes: Map<string, { type: string; body: string }>): Promise<Served> {
  const server = createServer((req, res) => {
    const hit = routes.get((req.url ?? '/').split('?')[0]!)
    if (!hit) {
      res.writeHead(404).end('not found')
      return
    }
    res.writeHead(200, {
      'content-type': hit.type,
      'cache-control': 'no-store',
      // Cross-origin isolation gives performance.now() its fine-grained resolution.
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
      'cross-origin-resource-policy': 'same-origin',
    })
    res.end(hit.body)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

async function metric(cdp: CDPSession, name: string): Promise<number> {
  const { metrics } = await cdp.send('Performance.getMetrics')
  return metrics.find((m) => m.name === name)?.value ?? NaN
}

async function runBench(page: Page, edit: EditName, runs: number, cap: number): Promise<BenchResult> {
  return page.evaluate(([e, r, c]) => window.__s5.bench(e, r, { cap: c }), [edit, runs, cap] as const)
}

function printBench(title: string, results: Map<EditName, BenchResult>): void {
  console.log(`\n  ${title}`)
  console.log('  ms, p50/p95 over the runs           entries  relayout    collect     snapshot    diff       classify   total       max    total x2')
  for (const [edit, r] of results) {
    console.log(
      `  ${edit.padEnd(8)} ${String(r.runs).padStart(3)} runs`.padEnd(37) +
        `${String(r.entries).padStart(7)}  ${pair(r.relayout).padEnd(11)} ${pair(r.collect).padEnd(11)} ${pair(r.snapshot).padEnd(11)} ${pair(r.diff).padEnd(10)} ${pair(r.classify).padEnd(10)} ${pair(r.total1).padEnd(11)} ${ms(max(r.total1)).padEnd(6)} ${pair(r.total2)}`,
    )
  }
}

// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  let browser: Browser | undefined
  let served: Served | undefined
  const cleanup = async (): Promise<void> => {
    await browser?.close().catch(() => {})
    browser = undefined
    const s = served
    served = undefined
    if (s) {
      s.server.closeAllConnections()
      await new Promise<void>((resolve) => s.server.close(() => resolve()))
    }
  }
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => void cleanup().finally(() => process.exit(1)))
  }

  try {
    const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url))
    const bundle = await build({
      entryPoints: [here('./s5-assets/inject.ts')],
      bundle: true,
      write: false,
      format: 'iife',
      target: 'chrome120',
      minify: true,
      logLevel: 'silent',
    })
    const injectJs = bundle.outputFiles[0]!.text
    const product = await build({
      stdin: {
        contents:
          `export { snapshot, idOf, elementOf } from './packages/overlay/src/probe/snapshot.ts'\n` +
          `export { sideEffects } from './packages/engine/src/side-effects.ts'\n`,
        resolveDir: here('..'),
        loader: 'ts',
      },
      bundle: true,
      write: false,
      format: 'esm',
      target: 'chrome120',
      minify: true,
      logLevel: 'silent',
    })
    const productJs = product.outputFiles[0]!.text

    // 269 measured elements per section plus 255 of page chrome: 9 sections = 2,676, 44 = 12,091.
    const pageA = buildPage({ sections: 9, script: '/s5.js' })
    const pageB = buildPage({ sections: 44, script: '/s5.js' })
    served = await serve(
      new Map([
        ['/a.html', { type: 'text/html; charset=utf-8', body: pageA }],
        ['/b.html', { type: 'text/html; charset=utf-8', body: pageB }],
        ['/c.html', { type: 'text/html; charset=utf-8', body: buildPage({ sections: 185, script: '/s5.js' }) }],
        ['/s5.js', { type: 'text/javascript; charset=utf-8', body: injectJs }],
      ]),
    )

    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 })

    console.log('primp spike S5: rect snapshot + diff + side-effect classification')
    console.log(`  machine: ${cpus()[0]?.model ?? 'unknown CPU'} x${cpus().length}, node ${process.version}, chromium ${browser.version()} (headless), viewport ${VIEWPORT.width}x${VIEWPORT.height}`)
    console.log(`  shipped code (snapshot + diff + classify), minified: ${productJs.length} bytes, ${gzipSync(productJs).length} gzipped`)

    // -------------------------------------------------------------------------------------
    section('Page A: storefront layout, all elements measured (cap lifted so nothing is dropped)')
    const a = await context.newPage()
    const pageErrors: string[] = []
    a.on('pageerror', (e) => pageErrors.push(String(e)))
    await a.goto(`${served.origin}/a.html`, { waitUntil: 'load' })
    const cdpA = await context.newCDPSession(a)
    await cdpA.send('Performance.enable')

    const timer = await a.evaluate(() => window.__s5.timer())
    info(`performance.now() resolution ${timer.resolutionMs.toFixed(4)} ms (crossOriginIsolated=${timer.isolated})`)
    check('timer is fine enough to measure sub-millisecond steps', timer.resolutionMs <= 0.02, `${timer.resolutionMs.toFixed(4)} ms`)

    const sA = await a.evaluate((cap) => window.__s5.structure({ cap }), UNCAPPED)
    info(`DOM has ${sA.domElements} elements under body; snapshot has ${sA.entries} entries (${sA.withLines} with a line count, ${sA.withOverflow} overflowing), ${sA.bytes} bytes as JSON`)
    check('page A has at least 2,500 measured elements and is not truncated', sA.entries >= 2500 && !sA.truncated && sA.total === sA.entries, `${sA.entries} entries, total ${sA.total}, truncated ${sA.truncated}`)
    check('overlay root is excluded (light children and shadow tree)', sA.insideOverlay === 0 && sA.overlayElements > 1, `${sA.insideOverlay} entries inside [data-primp-root]; the page has ${sA.overlayElements} light elements there plus a shadow tree`)
    check('visibility:hidden boxes are left out', sA.invisibleBoxes === 7 && sA.invisibleEntries === 0, `${sA.invisibleEntries} entries among the ${sA.invisibleBoxes} elements of the closed dropdown (computed visibility: hidden)`)
    check('display:none subtree is skipped; open shadow roots of the app are walked', sA.hiddenMenuEntries === 0 && sA.shadowEntries === 2, `${sA.hiddenMenuEntries} entries from the hidden 40-link menu, ${sA.shadowEntries} entries from the app's own shadow root (expected 2)`)
    check('rects are document coordinates rounded to 0.5px and match raw getBoundingClientRect', sA.notHalfPixel === 0 && sA.rawMismatches === 0, `${sA.notHalfPixel} values off the 0.5px grid, ${sA.rawMismatches} rects further than 0.25px from raw (max error ${sA.maxRawError.toFixed(3)}px)`)
    check('ids are unique, parents are the nearest measured ancestor and come first', sA.duplicateIds === 0 && sA.badParents === 0 && sA.outOfOrder === 0, `${sA.duplicateIds} duplicate ids, ${sA.badParents} wrong parents, ${sA.outOfOrder} out of order`)
    check('two snapshots of an unchanged page are identical (stable ids, deterministic)', sA.repeatIdentical, `identical: ${sA.repeatIdentical}`)
    check('scrolling 700px changes no entry except position:fixed ones (document coordinates)', sA.scrolledIdentical === true, `identical after scroll: ${sA.scrolledIdentical}`)

    const mutations = await a.evaluate((cap) => window.__s5.mutationsDuringSnapshot({ cap }), UNCAPPED)
    check('snapshot writes nothing to the DOM', mutations === 0, `${mutations} mutation records during a snapshot (attributes, children, text)`)

    // Layout counting through CDP. The thrash loop proves the counter moves when layouts happen.
    await a.evaluate(() => window.__s5.revertEdit())
    const l0 = await metric(cdpA, 'LayoutCount')
    await a.evaluate((cap) => window.__s5.snapshotOnly({ cap }), UNCAPPED)
    const l1 = await metric(cdpA, 'LayoutCount')
    await a.evaluate((cap) => window.__s5.editThenSnapshot('sidebar', { cap }), UNCAPPED)
    const l2 = await metric(cdpA, 'LayoutCount')
    await a.evaluate(() => window.__s5.revertEdit())
    const l3 = await metric(cdpA, 'LayoutCount')
    await a.evaluate(() => window.__s5.thrash(10))
    const l4 = await metric(cdpA, 'LayoutCount')
    check('snapshot on a clean page forces no layout', l1 - l0 === 0, `LayoutCount +${l1 - l0}`)
    check('edit + snapshot costs exactly the one layout the edit owes', l2 - l1 === 1, `LayoutCount +${l2 - l1} (control: 10 deliberate write/read pairs gave +${l4 - l3})`)
    check('control: the layout counter is sensitive', l4 - l3 >= 10, `LayoutCount +${l4 - l3} for 10 write/read pairs`)

    section('Page A: three real edits, checked against raw measurements')
    const observations = new Map<EditName, Observation>()
    for (const edit of EDITS) {
      observations.set(edit, await a.evaluate(([e, cap]) => window.__s5.observe(e, { cap }), [edit, UNCAPPED] as const))
    }
    for (const edit of EDITS) {
      const obs = observations.get(edit)!
      console.log(`\n  edit "${edit}": ${obs.report.summary}`)
      const top = obs.report.effects.slice(0, 6).map((e) => `${e.desc} ${e.label}${e.subtreeCount > 1 ? ` [${e.subtreeCount}]` : ''}${e.relation === 'ancestor' ? ' (ancestor)' : ''}`)
      console.log(`        ${obs.deltas.length} raw deltas -> ${obs.report.primary.length} primary + ${obs.report.effects.length} effects; first: ${top.join(' | ')}`)
      if (edit === 'banner') checkBanner(obs)
      else if (edit === 'card') checkCard(obs)
      else checkSidebar(obs)
    }
    const seenTypes = new Set<string>()
    for (const obs of observations.values()) for (const e of obs.report.effects) seenTypes.add(e.type)
    check('the three edits exercise all five effect types', ['moved', 'resized', 'overflow', 'wrapped', 'offscreen'].every((t) => seenTypes.has(t)), `seen: ${[...seenTypes].sort().join(', ')}`)

    section(`Page A: timings, ${RUNS} runs per edit (first run included, no warm-up discarded)`)
    const benchA = new Map<EditName, BenchResult>()
    for (const edit of EDITS) benchA.set(edit, await runBench(a, edit, RUNS, UNCAPPED))
    printBench(`page A, ${sA.entries} elements`, benchA)
    for (const [edit, r] of benchA) {
      check(`page A "${edit}": snapshot + diff + classify p95 < ${BUDGET_MS} ms`, p95(r.total1) < BUDGET_MS && !r.truncated && r.entries >= 2500, `p50 ${ms(p50(r.total1))} ms, p95 ${ms(p95(r.total1))} ms, max ${ms(max(r.total1))} ms, first run ${ms(r.total1[0]!)} ms over ${r.entries} elements (${r.deltas} deltas -> ${r.effects} effects)`)
    }
    for (const [edit, r] of benchA) {
      check(`page A "${edit}": with a fresh "before" snapshot per edit, p95 still < ${BUDGET_MS} ms`, p95(r.total2) < BUDGET_MS, `p50 ${ms(p50(r.total2))} ms, p95 ${ms(p95(r.total2))} ms`)
    }

    const micro = await a.evaluate(([runs, cap]) => window.__s5.micro(runs, { cap }), [30, UNCAPPED] as const)
    info(`visibility filter: bare checkVisibility loop ${ms(p50(micro.visibilityOnly))} ms p50; full snapshot ${ms(p50(micro.full))} ms with it, ${ms(p50(micro.withHidden))} ms without (includeHidden)`)
    info(`where collect time goes (clean layout, p50 ms): bare getBoundingClientRect loop ${ms(p50(micro.rectsOnly))}; snapshot without lines/overflow ${ms(p50(micro.noLinesNoOverflow))}; + overflow flags ${ms(p50(micro.noLines))}; + line counts ${ms(p50(micro.noOverflow))}; full ${ms(p50(micro.full))}`)

    // -------------------------------------------------------------------------------------
    section('Alternative: IntersectionObserver rect collection (page A, sidebar edit)')
    const io = await a.evaluate(([runs, cap]) => window.__s5.ioBench('sidebar', runs, { cap }), [30, UNCAPPED] as const)
    const syncSidebar = benchA.get('sidebar')!
    info(`IO, ${io.elements} elements, edit applied inside a frame callback (best case): rects delivered after p50 ${ms(p50(io.wall))} / p95 ${ms(p95(io.wall))} ms wall; script time p50 ${ms(p50(io.script))} / p95 ${ms(p95(io.script))} ms; max rect error vs synchronous ${io.maxError.toFixed(3)}px`)
    info(`IO, edit applied from an ordinary task (as an input handler would): rects delivered after p50 ${ms(p50(io.wallFromTask))} / p95 ${ms(p95(io.wallFromTask))} ms wall; frames arrive every ${ms(io.frameInterval)} ms here`)
    info(`sync, same edit: snapshot p50 ${ms(p50(syncSidebar.snapshot))} / p95 ${ms(p95(syncSidebar.snapshot))} ms, of which relayout ${ms(p50(syncSidebar.relayout))} ms is work the browser must do either way`)

    section('Slower machine estimate: page A under 4x CPU throttling (informational)')
    await cdpA.send('Emulation.setCPUThrottlingRate', { rate: 4 })
    const slow = new Map<EditName, BenchResult>()
    for (const edit of EDITS) slow.set(edit, await runBench(a, edit, 20, UNCAPPED))
    await cdpA.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    printBench('page A, 4x CPU throttle, 20 runs per edit', slow)
    for (const [edit, r] of slow) info(`4x throttle "${edit}": total p95 ${ms(p95(r.total1))} ms (${p95(r.total1) < BUDGET_MS ? 'under' : 'OVER'} ${BUDGET_MS} ms)`)
    await a.close()

    // -------------------------------------------------------------------------------------
    section('Page B: same layout at 12,000+ elements, default cap')
    const b = await context.newPage()
    b.on('pageerror', (e) => pageErrors.push(String(e)))
    await b.goto(`${served.origin}/b.html`, { waitUntil: 'load' })
    const sB = await b.evaluate((cap) => window.__s5.structure({ cap }), DEFAULT_CAP)
    info(`DOM has ${sB.domElements} elements under body; ${sB.total} visible candidates; snapshot kept ${sB.entries}`)
    check('page B has at least 12,000 candidates and is truncated to the 2,500 cap', sB.total >= 12000 && sB.truncated && sB.entries <= DEFAULT_CAP && sB.entries === DEFAULT_CAP - sB.invisibleBoxes && sB.invisibleEntries === 0, `total ${sB.total}, entries ${sB.entries} (= cap ${DEFAULT_CAP} minus the ${sB.invisibleBoxes} visibility:hidden boxes that were selected and then filtered out), truncated ${sB.truncated}`)
    check('truncation keeps everything in the viewport', sB.inViewportDom > 0 && sB.inViewportKept === sB.inViewportDom, `${sB.inViewportKept} of ${sB.inViewportDom} in-viewport elements kept`)
    check('truncated snapshot is deterministic and structurally valid', sB.repeatIdentical && sB.duplicateIds === 0 && sB.badParents === 0 && sB.outOfOrder === 0 && sB.insideOverlay === 0 && sB.rawMismatches === 0, `identical twice: ${sB.repeatIdentical}; ${sB.badParents} wrong parents, ${sB.outOfOrder} out of order, ${sB.rawMismatches} rect mismatches`)

    const obsB = await b.evaluate(([e, cap]) => window.__s5.observe(e, { cap }), ['banner', DEFAULT_CAP] as const)
    const oB = new Oracle(obsB)
    const wrongB = obsB.deltas.filter((d) => !sameDelta(d, oB.delta.get(d.id))).length
    const moversB = obsB.report.effects.filter((e) => e.type === 'moved').reduce((n, e) => n + e.subtreeCount, 0)
    const goneB = obsB.deltas.filter((d) => d.type === 'disappeared').length
    const appearedB = obsB.deltas.filter((d) => d.type === 'appeared').length
    const visibleAfterB = obsB.rows.filter((r) => r.after).length
    info(`edit "banner" on page B: ${obsB.report.summary}`)
    check(
      'page B: deltas of the kept elements equal raw getBoundingClientRect, nothing is falsely "disappeared"',
      wrongB === 0 && obsB.report.truncated && obsB.report.primary.length === 4 && goneB === 4 && appearedB === 0,
      `${obsB.deltas.length} deltas over ${obsB.entries.after} kept elements, ${wrongB} disagree with raw; ${goneB} disappeared (banner + 3 children, all primary), ${appearedB} appeared; ${moversB} movers reported`,
    )
    check('page B: the summary says the page was only partly checked', obsB.report.summary.endsWith(`(checked ${obsB.entries.after} of ${visibleAfterB} elements)`), `"${obsB.report.summary}"`)

    const benchB = new Map<EditName, BenchResult>()
    for (const edit of EDITS) benchB.set(edit, await runBench(b, edit, RUNS, DEFAULT_CAP))
    printBench(`page B, ${sB.total} candidates capped to ${DEFAULT_CAP}`, benchB)
    for (const [edit, r] of benchB) {
      check(`page B "${edit}": capped snapshot + diff + classify p95 < ${BUDGET_MS} ms`, p95(r.total1) < BUDGET_MS && r.truncated && r.entries <= DEFAULT_CAP + 1, `p50 ${ms(p50(r.total1))} ms, p95 ${ms(p95(r.total1))} ms, max ${ms(max(r.total1))} ms over ${r.entries} of ${r.total} elements; relayout alone p50 ${ms(p50(r.relayout))} ms`)
    }
    for (const [edit, r] of benchB) {
      info(`page B "${edit}" with a fresh "before" snapshot per edit: p50 ${ms(p50(r.total2))} ms, p95 ${ms(p95(r.total2))} ms (${p95(r.total2) < BUDGET_MS ? 'under' : 'OVER'} ${BUDGET_MS} ms)`)
    }
    const uncappedB = new Map<EditName, BenchResult>()
    for (const edit of EDITS) uncappedB.set(edit, await runBench(b, edit, 20, UNCAPPED))
    printBench(`page B with the cap lifted (informational, 20 runs per edit)`, uncappedB)
    await b.close()

    // -------------------------------------------------------------------------------------
    section('Page C: where the cap stops helping (informational, about 50,000 elements, default cap)')
    const c = await context.newPage()
    c.on('pageerror', (e) => pageErrors.push(String(e)))
    await c.goto(`${served.origin}/c.html`, { waitUntil: 'load' })
    const benchC = new Map<EditName, BenchResult>()
    for (const edit of EDITS) benchC.set(edit, await runBench(c, edit, 10, DEFAULT_CAP))
    const firstC = benchC.get('card')!
    printBench(`page C, ${firstC.total} candidates capped to ${DEFAULT_CAP}, 10 runs per edit`, benchC)
    info(`the walk still reads every rect before the cap applies: collect p50 ${ms(p50(firstC.collect))} ms for ${firstC.total} candidates vs ${ms(p50(benchB.get('card')!.collect))} ms for ${benchB.get('card')!.total}`)
    for (const [edit, r] of benchC) info(`page C "${edit}": total p95 ${ms(p95(r.total1))} ms (${p95(r.total1) < BUDGET_MS ? 'under' : 'OVER'} ${BUDGET_MS} ms); the browser's own relayout is p50 ${ms(p50(r.relayout))} ms of that`)
    await c.close()

    check('no page errors', pageErrors.length === 0, pageErrors.length ? pageErrors.join(' | ') : 'none')
  } finally {
    await cleanup()
  }

  const failed = checks.filter((c) => !c.pass)
  console.log(`\n${failed.length === 0 ? 'S5 PASS' : 'S5 FAIL'}: ${checks.length - failed.length} of ${checks.length} checks passed`)
  for (const f of failed) console.log(`  failed: ${f.name}`)
  process.exitCode = failed.length === 0 ? 0 : 1
}

main().catch((err) => {
  console.error('S5 FAIL: spike crashed')
  console.error(err)
  process.exitCode = 1
})
