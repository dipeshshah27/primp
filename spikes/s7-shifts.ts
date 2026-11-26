/**
 * Spike S7: layout-shift attribution.
 *
 *   browser -> primp proxy (injects the hook) -> relay (request log, cache policy) -> corpus server
 *
 *   A. Cold loads without the DevTools protocol. Candidate mechanisms are tried
 *      against a warm tab and a warm disk cache; the origin-side request log
 *      says which of them really re-fetch every resource.
 *   B. Every corpus page: a first load, then three cold replays in the same tab
 *      (`location.reload()`, under the policy A found to work). Each replay is
 *      checked against the request log, the hook's recording goes through the
 *      attributor, and the result is scored against `expected.json`.
 *   C. The same pages once more in fresh browser contexts, to see whether the
 *      cold replays measure the same thing.
 *   D. Hidden tab: what a background tab reports, and whether the validity flag catches it.
 *   E. Culprit to source line (optional: needs packages/source's static-HTML resolver).
 *   F. Held-out pages that were written after the attributor, with their first-run results on record.
 *   G. A real dev server: a stylesheet update pushed by Vite's client is a dev artifact.
 *
 * Run: pnpm spike:s7                    (exit 0 = pass)
 *      pnpm spike:s7 -- --only font     only pages whose name contains "font" (the run then fails as incomplete)
 *      pnpm spike:s7 -- --sections b,f  only these sections (fails as incomplete)
 *      pnpm spike:s7 -- --record        also writes the recordings used as unit-test fixtures
 *      S7_HEADED=1 pnpm spike:s7        runs the hidden-tab check in a real window as well
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Browser } from '@playwright/test'
import { attributeShifts } from '../packages/engine/src/shift-attributor.ts'
import { ShiftRecordingSchema, type ShiftRecording, type ShiftReport } from '../packages/protocol/src/shift.ts'
import { createReport, editFile, expect, launchBrowser, newPage, replaceOnce, REPO_ROOT, runCleanups, sleep, startFixture, startProxy, waitFor, type FixtureHandle, type ProxyHandle } from './lib/index.ts'
import { issueLabel, listCorpus, measureLoad, navigate, negativeProblems, scoreLoad, type CorpusPage, type LoadScore, type MeasuredLoad } from './s7-assets/corpus.ts'
import { HELDOUT_ROOT, startHeldoutServer } from './s7-assets/heldout-server.ts'
import { fixed, hookScript, readRecording } from './s7-assets/measure.ts'
import { launchRawChromium, type RawChromium, type RawTab } from './s7-assets/raw-chromium.ts'
import { cacheableOrigin, coldPolicy, startRelay, type Relay, type RelayPolicy } from './s7-assets/relay.ts'
import { resolveSources } from './s7-assets/source-lines.ts'

const COLD_LOADS = 3
const LANES = 4
const ACCURACY_TARGET = 0.8
const FIXTURE_DIR = join(REPO_ROOT, 'packages/engine/test/shift-recordings')

const argv = process.argv.slice(2)
const option = (name: string): string | undefined => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}
const only = option('--only')
const sections = new Set((option('--sections') ?? 'a,b,c,d,e,f,g').split(','))
const record = argv.includes('--record')
const verbose = argv.includes('--verbose')
const partial = only !== undefined || sections.size < 7

const report = createReport('S7 layout-shift attribution')

/** One relay + proxy pair. Pages measured on different lanes never share a request log. */
interface Lane {
  relay: Relay
  proxy: ProxyHandle
}

async function pool<T>(lanes: Lane[], items: T[], work: (item: T, lane: Lane) => Promise<void>): Promise<void> {
  const queue = [...items]
  await Promise.all(
    lanes.map(async (lane) => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await work(item, lane)
    }),
  )
}

/** Path without the query string and without the corpus's `/delay/<ms>` prefix: one name per resource. */
const resourceKey = (url: string): string => (url.split('?')[0] ?? url).replace(/^\/delay\/\d+/, '')
const requestsFor = (relay: Relay, tag: string): { key: string; conditionalUpstream: boolean }[] =>
  relay.log.filter((request) => request.tag === tag).map((request) => ({ key: resourceKey(request.url), conditionalUpstream: request.conditionalUpstream }))

// ---------------------------------------------------------------------------
// A. cold mechanisms
// ---------------------------------------------------------------------------

interface Mechanism {
  id: string
  label: string
  prime: RelayPolicy[]
  replay: RelayPolicy[]
  /**
   * How the replay is started. `reload`, `bust` and `bounce` are things a page can do to itself
   * (location.reload(), location.href). `newtab` closes the tab and opens the URL in a new one of
   * the same browser profile: the disk cache survives, the tab's in-memory cache does not.
   */
  how: 'reload' | 'bust' | 'bounce' | 'newtab'
}

const ORIGIN = cacheableOrigin()
const NO_STORE = coldPolicy({ noStore: true, stripConditionals: true })
/**
 * The policy S7 proposes for the proxy, on every response from the first one of a session:
 * no-store, validators and conditional request headers stripped, and
 * `Clear-Site-Data: "cache"` on documents.
 */
const SESSION_POLICY = coldPolicy({ noStore: true, stripConditionals: true, clearSiteData: true })

const MECHANISMS: Mechanism[] = [
  { id: 'none', label: 'warm tab, no mechanism: a plain location.reload()', prime: [ORIGIN], replay: [ORIGIN], how: 'reload' },
  { id: 'no-store-late', label: 'warm tab; no-store + validators stripped on every response, from the replay on; location.reload()', prime: [ORIGIN], replay: [ORIGIN, NO_STORE], how: 'reload' },
  { id: 'cache-bust', label: 'warm tab; a cache-busting query on the document URL', prime: [ORIGIN], replay: [ORIGIN], how: 'bust' },
  { id: 'clear-site-data', label: 'warm tab; Clear-Site-Data: "cache" on the document response; location.reload()', prime: [ORIGIN], replay: [ORIGIN, coldPolicy({ clearSiteData: true })], how: 'reload' },
  { id: 'clear+no-store-late', label: 'warm tab; Clear-Site-Data: "cache" + no-store + validators stripped, from the replay on; location.reload()', prime: [ORIGIN], replay: [ORIGIN, SESSION_POLICY], how: 'reload' },
  { id: 'bounce', label: 'warm tab; the same, but leaving for another site (http://127.0.0.1:<port>) and coming back through location.href', prime: [ORIGIN], replay: [ORIGIN, SESSION_POLICY], how: 'bounce' },
  { id: 'newtab-no-store', label: 'warm disk cache, NEW tab; no-store + validators stripped, no Clear-Site-Data', prime: [ORIGIN], replay: [ORIGIN, NO_STORE], how: 'newtab' },
  { id: 'newtab-clear', label: 'warm disk cache, NEW tab; Clear-Site-Data: "cache" + no-store + validators stripped', prime: [ORIGIN], replay: [ORIGIN, SESSION_POLICY], how: 'newtab' },
  { id: 'session', label: 'SESSION POLICY (used for B): Clear-Site-Data: "cache" + no-store + validators stripped from the first response on; location.reload()', prime: [ORIGIN, SESSION_POLICY], replay: [ORIGIN, SESSION_POLICY], how: 'reload' },
]

/** Another site that reaches the same proxy: `127.0.0.1` for a page on `localhost`. Any page of it will do. */
const bounceUrl = (proxy: ProxyHandle): string => `http://127.0.0.1:${proxy.port}/index.html`

interface MechanismResult {
  page: string
  resources: string[]
  primeShifts: number
  loads: { refetched: number; missing: string[]; conditional: number; cacheHits: number; shifts: number }[]
}

async function tryMechanism(browser: Browser, lane: Lane, page: CorpusPage, mechanism: Mechanism, replays: number): Promise<MechanismResult> {
  // One browser context for the whole trial: every load below shares its HTTP cache.
  const handle = await newPage(browser)
  try {
    let tab = handle.page
    const url = lane.proxy.url + page.path
    const windowMs = 1200
    // The relay's log outlives the trial: every tag must be unique to this mechanism and page.
    const tag = (step: string): string => `A|${mechanism.id}|${page.name}|${step}`
    lane.relay.setPolicies(mechanism.prime)
    lane.relay.tag(tag('prime'))
    await navigate(tab, { kind: 'goto', url })
    const prime = await measureLoad(tab, { observeMs: windowMs }, [])
    const resources = [...new Set(requestsFor(lane.relay, tag('prime')).map((request) => request.key))]
    lane.relay.setPolicies(mechanism.replay)
    const loads: MechanismResult['loads'] = []
    for (let load = 1; load <= replays; load++) {
      lane.relay.tag(tag(`replay${load}`))
      if (mechanism.how === 'newtab') {
        await tab.close()
        tab = await handle.context.newPage()
        await navigate(tab, { kind: 'goto', url })
      } else if (mechanism.how === 'bounce') await navigate(tab, { kind: 'bounce', via: bounceUrl(lane.proxy), url })
      else await navigate(tab, mechanism.how === 'bust' ? { kind: 'goto', url: `${url}?cold=${load}` } : { kind: 'reload' })
      const measured = await measureLoad(tab, { observeMs: windowMs }, [])
      const requests = requestsFor(lane.relay, tag(`replay${load}`)).filter((request) => request.key !== '/index.html')
      const seen = new Set(requests.map((request) => request.key))
      loads.push({
        refetched: resources.filter((key) => seen.has(key)).length,
        missing: resources.filter((key) => !seen.has(key)),
        conditional: requests.filter((request) => request.conditionalUpstream).length,
        cacheHits: cacheHits(measured.recording).length,
        shifts: measured.recording.shifts.length,
      })
    }
    return { page: page.name, resources, primeShifts: prime.recording.shifts.length, loads }
  } finally {
    await handle.close()
  }
}

/**
 * Resources the page itself says came from a cache: nothing was transferred. This is what the
 * product can check in the tab, where it has no request log. The hook script is the proxy's own.
 */
const cacheHits = (recording: ShiftRecording): string[] =>
  recording.resources.filter((resource) => resource.transferSize === 0 && !resource.url.startsWith('data:') && !resource.url.includes('/__primp/')).map((resource) => resource.url.replace(/^https?:\/\/[^/]+/, ''))

const isCold = (result: MechanismResult): boolean => result.loads.every((load) => load.missing.length === 0 && load.conditional === 0)

async function sectionA(browser: Browser, lanes: Lane[], corpus: CorpusPage[]): Promise<void> {
  report.section('A. cold loads without the DevTools protocol')
  report.info(
    'Set-up: the relay rewrites the corpus server\'s "no-store" into what an ordinary server sends (subresources "public, max-age=3600" with ETag and Last-Modified, documents "no-cache"), ' +
      'so the browser has a cache worth defeating. Each trial primes one browser context with a normal load, then replays in the SAME context. ' +
      '"Re-fetched" is read from the relay\'s log of requests that reached the origin side.',
  )
  const names = ['unsized-media/img-block', 'font-swap/sidebar-external-css', 'injected-content/cookie-bar-insertbefore', 'injected-content/skeleton-replace']
  const pages = names.map((name) => corpus.find((page) => page.name === name)).filter((page): page is CorpusPage => page !== undefined)
  expect(pages.length === names.length, 'cold-mechanism pages are missing from the corpus')

  const verdicts = new Map<string, MechanismResult[]>()
  for (const mechanism of MECHANISMS) {
    const results: MechanismResult[] = []
    await pool(lanes, pages, async (page, lane) => {
      results.push(await tryMechanism(browser, lane, page, mechanism, mechanism.id === 'session' ? COLD_LOADS : 2))
    })
    results.sort((a, b) => names.indexOf(a.page) - names.indexOf(b.page))
    verdicts.set(mechanism.id, results)
    const cold = results.every(isCold)
    const lines = results.map((result) => {
      const loads = result.loads.map((load) => `${load.refetched}/${result.resources.length} re-fetched${load.conditional > 0 ? ` (${load.conditional} conditional)` : ''}, ${load.cacheHits} cache hits, ${load.shifts} shift(s)`)
      return `${result.page.padEnd(42)} first load ${result.resources.length} requests, ${result.primeShifts} shift(s) | replays: ${loads.join(' | ')}`
    })
    report.info(`${cold ? 'COLD    ' : 'NOT COLD'} ${mechanism.label}\n${lines.join('\n')}`)
  }

  const none = verdicts.get('none') ?? []
  report.check(
    'the test bed has a warm cache: a plain reload does NOT re-fetch the subresources',
    none.length > 0 && none.every((result) => result.loads.every((load) => load.missing.length > 0)),
    none.map((result) => `${result.page}: ${result.loads.map((load) => `${load.refetched}/${result.resources.length} re-fetched, ${load.shifts} shift(s) (cold: ${result.primeShifts})`).join(' | ')}`).join('\n'),
  )
  const session = verdicts.get('session') ?? []
  report.check(
    `session policy (no-store + stripped validators + Clear-Site-Data from the first response): every resource re-fetched on ${COLD_LOADS} consecutive location.reload() calls, same shifts as the first load`,
    session.length > 0 && session.every(isCold) && session.every((result) => result.loads.every((load) => load.shifts === result.primeShifts && load.cacheHits === 0)),
    session.map((result) => `${result.page}: ${result.loads.map((load) => `${load.refetched}/${result.resources.length}, ${load.cacheHits} cache hits, ${load.shifts} shift(s)`).join(' | ')}`).join('\n'),
  )
  const newTab = verdicts.get('newtab-clear') ?? []
  report.check(
    'a disk cache left by an earlier, cacheable session is emptied by Clear-Site-Data: "cache" when the page opens in a new tab',
    newTab.length > 0 && newTab.every(isCold),
    newTab.map((result) => `${result.page}: ${result.loads.map((load) => `${load.refetched}/${result.resources.length}, ${load.cacheHits} cache hits`).join(' | ')}`).join('\n') +
      `\n(control without Clear-Site-Data: ${(verdicts.get('newtab-no-store') ?? []).map((result) => `${result.loads.map((load) => `${load.refetched}/${result.resources.length}`).join(' | ')}`).join('; ')})`,
  )
  // The page's own view (transferSize 0) must agree with the origin's log, or the product could not tell a warm replay from a cold one.
  const all = [...verdicts.values()].flat()
  const disagree = all.flatMap((result) => result.loads.filter((load) => (load.missing.length === 0) !== (load.cacheHits === 0)).map((load) => `${result.page}: ${load.missing.length} not re-fetched, ${load.cacheHits} cache hits reported by the page`))
  report.check(
    'the page can tell by itself: "a resource with transferSize 0" agrees with "not re-fetched" in the origin log on every load of every trial',
    all.length > 0 && disagree.length === 0,
    disagree.join('\n') || `${all.reduce((total, result) => total + result.loads.length, 0)} loads compared`,
  )
  report.info(`Verdicts: ${MECHANISMS.map((mechanism) => `${mechanism.id} ${(verdicts.get(mechanism.id) ?? []).every(isCold) ? 'COLD' : 'not cold'}`).join('; ')}.`)
}

// ---------------------------------------------------------------------------
// B. the corpus, cold
// ---------------------------------------------------------------------------

interface ColdLoad {
  measured: MeasuredLoad
  score?: LoadScore
  negative?: string[]
  /** Resources of the first load that this load did not re-fetch, or fetched conditionally, or that the page saw come from a cache. */
  notCold: string[]
  resources: number
}

interface PageResult {
  page: CorpusPage
  loads: ColdLoad[]
  fresh?: MeasuredLoad
}

async function runPageCold(browser: Browser, lane: Lane, page: CorpusPage): Promise<PageResult> {
  const selectors = page.expected.shifts.map((shift) => shift.culpritSelector)
  const handle = await newPage(browser)
  try {
    const url = lane.proxy.url + page.path
    // The lane has answered under the session policy since its first response. First load: what the page fetches.
    lane.relay.setPolicies([ORIGIN, SESSION_POLICY])
    lane.relay.tag(`${page.name}|first`)
    await navigate(handle.page, { kind: 'goto', url })
    await measureLoad(handle.page, { observeMs: Math.min(page.expected.observeMs ?? 2000, 1600) }, [])
    const resources = [...new Set(requestsFor(lane.relay, `${page.name}|first`).map((request) => request.key))]

    const loads: ColdLoad[] = []
    for (let load = 1; load <= COLD_LOADS; load++) {
      const tag = `${page.name}|cold${load}`
      lane.relay.tag(tag)
      await navigate(handle.page, { kind: 'reload' })
      const measured = await measureLoad(handle.page, page.expected, selectors)
      const requests = requestsFor(lane.relay, tag)
      const seen = new Set(requests.map((request) => request.key))
      const notCold = [
        ...resources.filter((key) => !seen.has(key)).map((key) => `${key} not re-fetched`),
        ...requests.filter((request) => request.conditionalUpstream).map((request) => `${request.key} fetched conditionally`),
        ...cacheHits(measured.recording).map((hit) => `${hit} came from a cache according to the page (transferSize 0)`),
      ]
      loads.push({
        measured,
        notCold,
        resources: resources.length,
        ...(page.expected.positive ? { score: scoreLoad(page.expected, measured) } : { negative: negativeProblems(page.expected, measured) }),
      })
    }
    return { page, loads }
  } finally {
    await handle.close()
  }
}

function sectionBReport(results: PageResult[]): void {
  const positives = results.filter((result) => result.page.expected.positive)
  const negatives = results.filter((result) => !result.page.expected.positive)

  // Per-page table.
  const rows: string[] = []
  for (const result of results) {
    const want = result.page.expected.positive ? result.page.expected.shifts.map((shift) => `${shift.cause}:${shift.culpritSelector}`).join(' + ') : '(nothing)'
    const got = result.loads.map((load) => {
      const issues = load.measured.report.issues
      return issues.length === 0 ? '-' : issues.map((issue) => issueLabel(issue) + (issue.scored ? '' : `[${issue.excluded}]`)).join(' + ')
    })
    const same = got.every((value) => value === got[0])
    rows.push(`${result.page.name.padEnd(42)} expected ${want}\n${' '.repeat(42)} detected ${same ? `${got[0]}  (x${got.length}, identical)` : got.join('  |  ')}`)
  }
  report.info(`Per page, three cold replays (cause:culprit@confidence, G = geometric match):\n${rows.join('\n')}`)

  report.check(
    'every replay of every page was cold: all resources of the first load re-fetched, none conditionally, no cache hit seen by the page',
    results.every((result) => result.loads.every((load) => load.notCold.length === 0)),
    results.flatMap((result) => result.loads.flatMap((load, index) => load.notCold.map((problem) => `${result.page.name} load ${index + 1}: ${problem}`))).join('\n') ||
      `${results.reduce((total, result) => total + result.loads.length, 0)} loads, ${results.reduce((total, result) => total + result.loads.reduce((sum, load) => sum + load.resources, 0), 0)} resource fetches verified in the origin-side log`,
  )
  report.check(
    'every page did what it is there to do (assertAfter) and every recording is a valid measurement',
    results.every((result) => result.loads.every((load) => load.measured.failedAsserts.length === 0 && load.measured.report.status === 'ok')),
    results
      .flatMap((result) =>
        result.loads.flatMap((load, index) => [
          ...load.measured.failedAsserts.map((expression) => `${result.page.name} load ${index + 1}: false: ${expression}`),
          ...(load.measured.report.status === 'ok' ? [] : [`${result.page.name} load ${index + 1}: status ${load.measured.report.status} (${load.measured.report.reason})`]),
        ]),
      )
      .join('\n') || 'all assertions hold; status ok on every load',
  )

  // Stability.
  const unstable = positives.filter((result) => new Set(result.loads.map((load) => load.measured.scored.length)).size > 1)
  const entryUnstable = results.filter((result) => new Set(result.loads.map((load) => load.measured.recording.shifts.length)).size > 1)
  const valueSpread = Math.max(0, ...results.map((result) => Math.max(...result.loads.map((load) => load.measured.report.cls ?? 0)) - Math.min(...result.loads.map((load) => load.measured.report.cls ?? 0))))
  report.check(
    `the ${COLD_LOADS} cold loads of every positive page give the same number of scored shifts`,
    positives.length > 0 && unstable.length === 0,
    unstable.length === 0
      ? `${positives.length} positive pages, scored issues per load identical on all; raw entry count identical on ${results.length - entryUnstable.length}/${results.length} pages; largest CLS difference between loads of one page ${valueSpread.toExponential(2)}`
      : unstable.map((result) => `${result.page.name}: ${result.loads.map((load) => load.measured.scored.length).join(', ')}`).join('\n'),
  )

  // Accuracy.
  const strictPages = positives.filter((result) => result.loads.every((load) => load.score?.strict === true))
  const topPages = positives.filter((result) => result.loads.every((load) => load.score?.top === true))
  const failing = positives.filter((result) => !strictPages.includes(result))
  const describeFailure = (result: PageResult): string =>
    `${result.page.name}: ` +
    result.loads
      .map((load, index) => `load ${index + 1}: ` + (load.score?.shifts ?? []).map((shift) => `want ${shift.expectedCause}:${shift.expectedCulprit} got ${shift.gotCause}:${shift.gotCulprit}@${shift.confidence}${shift.geometricMatch ? 'G' : ''}`).join(', ') + (load.score !== undefined && load.score.extra > 0 ? ` (+${load.score.extra} extra issue)` : ''))
      .join(' | ')
  const need = Math.ceil(ACCURACY_TARGET * positives.length)
  report.check(
    `top culprit and cause correct on at least ${ACCURACY_TARGET * 100}% of positive pages (all ${COLD_LOADS} loads)`,
    positives.length > 0 && topPages.length >= need,
    `${topPages.length}/${positives.length} pages (need ${need})` + (topPages.length < positives.length ? `\n${positives.filter((result) => !topPages.includes(result)).map(describeFailure).join('\n')}` : ''),
  )
  report.check(
    `stricter: EVERY expected shift attributed (right element, right cause, confidence >= 0.7, geometric match, no extra issue) on at least ${ACCURACY_TARGET * 100}% of positive pages`,
    positives.length > 0 && strictPages.length >= need,
    `${strictPages.length}/${positives.length} pages (need ${need})` + (failing.length > 0 ? `\n${failing.map(describeFailure).join('\n')}` : ''),
  )

  // Confusion table over every expected shift of every load.
  const causes = ['unsized-media', 'font-swap', 'injected-content', 'dev-artifact', 'unknown', 'missed'] as const
  const table = new Map<string, number>()
  let shiftsTotal = 0
  let shiftsRight = 0
  for (const result of positives) {
    for (const load of result.loads) {
      for (const shift of load.score?.shifts ?? []) {
        shiftsTotal++
        if (shift.ok) shiftsRight++
        const key = `${shift.expectedCause}>${shift.gotCause}`
        table.set(key, (table.get(key) ?? 0) + 1)
      }
    }
  }
  const header = `${'expected \\ detected'.padEnd(20)}${causes.map((cause) => cause.padStart(18)).join('')}`
  const body = (['unsized-media', 'font-swap', 'injected-content'] as const).map((want) => `${want.padEnd(20)}${causes.map((got) => String(table.get(`${want}>${got}`) ?? 0).padStart(18)).join('')}`)
  report.info(`Confusion table, cause of every expected shift on every cold load (${shiftsRight}/${shiftsTotal} with the right element too):\n${header}\n${body.join('\n')}`)

  const confidences = positives.flatMap((result) => result.loads.flatMap((load) => (load.score?.shifts ?? []).map((shift) => shift.confidence)))
  report.info(`Confidence on positive pages: min ${fixed(Math.min(...confidences), 2)}, max ${fixed(Math.max(...confidences), 2)}; geometric match on ${positives.flatMap((result) => result.loads.flatMap((load) => load.score?.shifts ?? [])).filter((shift) => shift.geometricMatch).length}/${shiftsTotal}`)

  const negativeFailures = negatives.flatMap((result) => result.loads.flatMap((load, index) => (load.negative ?? []).map((problem) => `${result.page.name} load ${index + 1}: ${problem}`)))
  report.check(
    'no negative page has a culprit at confidence >= 0.7, a scored issue, or a non-zero CLS',
    negatives.length > 0 && negativeFailures.length === 0,
    negativeFailures.join('\n') ||
      negatives.map((result) => `${result.page.name}: ${result.loads.map((load) => `${load.measured.recording.shifts.length} entries, ${load.measured.report.issues.filter((issue) => issue.excluded !== undefined).length} excused`).join(' | ')}`).join('\n'),
  )
}

// ---------------------------------------------------------------------------
// C. fresh contexts
// ---------------------------------------------------------------------------

async function sectionC(browser: Browser, lanes: Lane[], results: PageResult[]): Promise<void> {
  report.section('C. comparison: one load per page in a brand-new browser context')
  await pool(lanes, results, async (result, lane) => {
    lane.relay.setPolicies([ORIGIN])
    lane.relay.tag(`${result.page.name}|fresh`)
    const handle = await newPage(browser)
    try {
      await navigate(handle.page, { kind: 'goto', url: lane.proxy.url + result.page.path })
      result.fresh = await measureLoad(handle.page, result.page.expected, result.page.expected.shifts.map((shift) => shift.culpritSelector))
    } finally {
      await handle.close()
    }
  })
  const differences: string[] = []
  let largest = 0
  for (const result of results) {
    const fresh = result.fresh
    const cold = result.loads[0]?.measured
    if (fresh === undefined || cold === undefined) {
      differences.push(`${result.page.name}: not measured`)
      continue
    }
    const label = (load: MeasuredLoad): string => load.report.issues.map((issue) => `${issue.cause}:${issue.culprit?.node.selector ?? '-'}${issue.scored ? '' : `[${issue.excluded}]`}`).join(' + ')
    if (label(fresh) !== label(cold)) differences.push(`${result.page.name}: fresh context "${label(fresh)}", cold reload "${label(cold)}"`)
    const coldValues = result.loads.map((load) => load.measured.report.cls ?? 0)
    const difference = Math.min(...coldValues.map((value) => Math.abs(value - (fresh.report.cls ?? 0))))
    largest = Math.max(largest, difference)
    if (difference > 0.001) differences.push(`${result.page.name}: CLS ${fixed(fresh.report.cls ?? 0, 6)} in a fresh context, ${coldValues.map((value) => fixed(value, 6)).join(' / ')} on cold replays`)
  }
  report.check(
    'cold replays and fresh contexts report the same issues (cause, culprit) and the same CLS within 0.001',
    differences.length === 0,
    differences.join('\n') || `${results.length} pages compared; largest CLS difference ${largest.toExponential(2)}`,
  )
}

// ---------------------------------------------------------------------------
// D. hidden tab
// ---------------------------------------------------------------------------

interface TabReading {
  recording: ShiftRecording
  report: ShiftReport
  now: string
  contentY: number
}

async function readTab(chromium: RawChromium, tab: RawTab): Promise<TabReading> {
  const raw = await chromium.evaluate<{ recording: unknown; now: string; contentY: number }>(
    tab,
    `({ recording: window.__primp.recording(), now: document.visibilityState, contentY: document.querySelector('#content').getBoundingClientRect().y })`,
  )
  const recording = ShiftRecordingSchema.parse(raw.recording)
  return { recording, report: attributeShifts(recording), now: raw.now, contentY: raw.contentY }
}

const describeTab = (reading: TabReading): string =>
  `visibilityState now ${reading.now}; at navigation start ${reading.recording.visibility.atNavigationStart ?? '?'}; when the hook ran ${reading.recording.visibility.initial}; ` +
  `changes [${reading.recording.visibility.changes.map((change) => `${Math.round(change.t)}ms ${change.state}`).join(', ')}]; ` +
  `layout-shift entries ${reading.recording.shifts.length}; #content at y=${Math.round(reading.contentY)}; hook visibleThroughout=${reading.recording.visibility.visibleThroughout}; ` +
  `attributor status ${reading.report.status}${reading.report.reason === undefined ? '' : ` (${reading.report.reason})`}, cls ${reading.report.cls}`

async function hiddenTabRun(proxy: ProxyHandle, headed: boolean): Promise<void> {
  const chromium = await launchRawChromium({ headed })
  const mode = headed ? 'headed window' : 'headless (--headless=new)'
  try {
    const url = `${proxy.url}/unsized-media/img-block/`
    report.info(`${chromium.version}, ${mode}, started as an ordinary browser with a tab strip; tabs are switched with Target.createTarget / Target.activateTarget, nothing is emulated.`)
    const a = await chromium.open(url)
    await sleep(1600)
    const visible = await readTab(chromium, a)
    report.check(
      `[${mode}] tab in front: the load is a valid measurement`,
      visible.recording.visibility.visibleThroughout && visible.report.status === 'ok' && visible.recording.shifts.length === 1 && visible.report.issues.length === 1,
      describeTab(visible),
    )

    const b = await chromium.open('about:blank')
    await sleep(500)
    await chromium.reload(a)
    await sleep(1900)
    const hidden = await readTab(chromium, a)
    report.check(
      `[${mode}] tab reloaded in the background: the page shifts but reports nothing, and the result is tab_hidden, not "no shifts"`,
      hidden.now === 'hidden' &&
        hidden.recording.shifts.length === 0 &&
        Math.abs(hidden.contentY - visible.contentY) < 1 &&
        !hidden.recording.visibility.visibleThroughout &&
        hidden.report.status === 'tab_hidden' &&
        hidden.report.cls === null,
      `${describeTab(hidden)}\n(the image did arrive and push #content to the same y as in the visible load, ${Math.round(visible.contentY)}: the shift happened, unreported)`,
    )

    await chromium.activate(a)
    await sleep(700)
    const shownLater = await readTab(chromium, a)
    report.check(
      `[${mode}] bringing that tab to the front afterwards does not make it valid`,
      shownLater.now === 'visible' && shownLater.recording.shifts.length === 0 && !shownLater.recording.visibility.visibleThroughout && shownLater.report.status === 'tab_hidden',
      describeTab(shownLater),
    )

    // Visible at the start, hidden before the late image arrives.
    await chromium.reload(a)
    await sleep(250)
    await chromium.activate(b)
    await sleep(1700)
    const midLoad = await readTab(chromium, a)
    report.check(
      `[${mode}] tab hidden 250 ms into the load: tab_hidden`,
      !midLoad.recording.visibility.visibleThroughout && midLoad.report.status === 'tab_hidden' && midLoad.report.cls === null && midLoad.recording.visibility.changes.some((change) => change.state === 'hidden'),
      describeTab(midLoad),
    )

    // Hidden at the start, shown before the late image arrives: entries exist, the measurement is still not valid.
    await chromium.reload(a)
    await sleep(300)
    await chromium.activate(a)
    await sleep(1700)
    const shownEarly = await readTab(chromium, a)
    report.check(
      `[${mode}] tab hidden at navigation start and shown 300 ms later: still tab_hidden, although entries were recorded`,
      !shownEarly.recording.visibility.visibleThroughout && shownEarly.report.status === 'tab_hidden' && shownEarly.report.cls === null,
      describeTab(shownEarly),
    )

    const c = await chromium.open(url, { background: true })
    await sleep(1900)
    const background = await readTab(chromium, c)
    report.check(
      `[${mode}] tab opened in the background: tab_hidden`,
      background.recording.shifts.length === 0 && !background.recording.visibility.visibleThroughout && background.report.status === 'tab_hidden',
      describeTab(background),
    )
    if (record && !headed) {
      mkdirSync(FIXTURE_DIR, { recursive: true })
      writeFileSync(join(FIXTURE_DIR, 'hidden-tab__background-reload.json'), JSON.stringify(scrub(hidden.recording), null, 1) + '\n')
      writeFileSync(join(FIXTURE_DIR, 'hidden-tab__shown-after-300ms.json'), JSON.stringify(scrub(shownEarly.recording), null, 1) + '\n')
    }
  } finally {
    await chromium.close()
  }
}

async function sectionD(browser: Browser, corpus: FixtureHandle): Promise<void> {
  report.section('D. hidden tab')
  const proxy = await startProxy(corpus, { headScripts: [hookScript()] })
  const url = `${proxy.url}/unsized-media/img-block/`

  // Method (a) as Playwright offers it: a second page brought to the front.
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  try {
    const first = await context.newPage()
    await first.goto(url)
    const second = await context.newPage()
    await second.goto('about:blank')
    await second.bringToFront()
    await sleep(300)
    await first.reload()
    await sleep(1500)
    const state = await first.evaluate(() => ({ state: document.visibilityState, focus: document.hasFocus(), shifts: window.__primp?.recording().shifts.length ?? -1 }))
    report.info(
      `Method (a) with Playwright (page.bringToFront() on a second page, then reload the first), headless: the first page still says visibilityState=${state.state}, hasFocus=${state.focus}, ` +
        `and records ${state.shifts} shift(s). Playwright keeps every page it drives focused and visible, so this method cannot produce a hidden tab and is NOT conclusive. ` +
        `The checks below use the same Chromium binary started as an ordinary browser instead.`,
    )
  } finally {
    await context.close()
  }

  await hiddenTabRun(proxy, false)
  if (process.env.S7_HEADED === '1') await hiddenTabRun(proxy, true)
  else report.info('Headed run not requested (S7_HEADED=1 runs the same checks in a real window; it opens a browser window on this desktop).')
  await proxy.close()
}

// ---------------------------------------------------------------------------
// E. source lines
// ---------------------------------------------------------------------------

async function sectionE(browser: Browser, corpusFixture: FixtureHandle, corpus: CorpusPage[]): Promise<void> {
  report.section('E. culprit to source line')
  const outcome = await resolveSources(browser, corpusFixture, corpus.filter((page) => page.expected.positive))
  if (outcome.unavailable !== undefined) {
    report.skip('culprit resolves to its source line', outcome.unavailable, { optional: true })
    return
  }
  const lines = outcome.rows.map((row) => `${row.ok ? 'ok  ' : 'MISS'} ${row.page.padEnd(42)} ${row.culprit.padEnd(16)} ${row.kind.padEnd(13)} expected ${row.expected.padEnd(52)} got ${row.got}  [${row.via}]`)
  const right = outcome.rows.filter((row) => row.ok).length
  report.info(`Source line of every expected culprit (one load per page, hook built with stack capture):\n${lines.join('\n')}`)
  report.check(
    'culprit resolves to the labelled file and line on at least 80% of the expected shifts',
    outcome.rows.length > 0 && right >= Math.ceil(0.8 * outcome.rows.length),
    `${right}/${outcome.rows.length}: opening-tag culprits ${outcome.rows.filter((row) => row.kind === 'opening-tag' && row.ok).length}/${outcome.rows.filter((row) => row.kind === 'opening-tag').length} (packages/source static-HTML resolver), ` +
      `script-insert culprits ${outcome.rows.filter((row) => row.kind === 'script-insert' && row.ok).length}/${outcome.rows.filter((row) => row.kind === 'script-insert').length} (stack of the DOM call)`,
  )
}

// ---------------------------------------------------------------------------
// F. held-out pages
// ---------------------------------------------------------------------------

interface HeldoutExpected {
  page: string
  observeMs: number
  positive: boolean
  devArtifact?: boolean
  maxIssues?: number
  accept: { causes: string[]; culprits: string[] | null }[]
  notes: string
}

type HeldoutVerdict = 'correct' | 'conservative' | 'wrong'

async function sectionF(browser: Browser): Promise<void> {
  report.section('F. held-out pages (written after the attributor; not used to build it)')
  const server = await startHeldoutServer()
  const proxy = await startProxy(server, { headScripts: [hookScript()] })
  const names = [
    // Round 1: written after the attributor was built on the corpus.
    'ad-iframe-insert', 'decoy-abs-image', 'dev-style-inject', 'font-swap-two-blocks', 'height-transition', 'img-float', 'late-stylesheet', 'logo-in-flex-header', 'remove-banner', 'same-frame-two-causes', 'text-replace',
    // Round 2: written after the attributor was extended for round 1.
    'r2-details-open', 'r2-font-swap-table', 'r2-skeleton-too-small', 'r2-sticky-header-class', 'r2-template-before', 'r2-two-columns-same-time', 'r2-video-poster',
  ] // prettier-ignore
  const rows: string[] = []
  const verdicts: { name: string; verdict: HeldoutVerdict; detail: string }[] = []
  for (const name of names) {
    if (only !== undefined && !name.includes(only)) continue
    const expected = JSON.parse(readFileSync(join(HELDOUT_ROOT, name, 'expected.json'), 'utf8')) as HeldoutExpected
    const accepted = expected.accept[0] ?? { causes: [], culprits: null }
    const perLoad: { verdict: HeldoutVerdict; label: string }[] = []
    for (let load = 0; load < 3; load++) {
      const handle = await newPage(browser)
      try {
        await navigate(handle.page, { kind: 'goto', url: `${proxy.url}/${name}/` })
        const measured = await measureLoad(handle.page, { observeMs: expected.observeMs }, accepted.culprits ?? [])
        if (record && load === 0) {
          mkdirSync(FIXTURE_DIR, { recursive: true })
          writeFileSync(join(FIXTURE_DIR, `heldout__${name}.json`), JSON.stringify(scrub(measured.recording), null, 1) + '\n')
        }
        const issues = measured.report.issues
        const label = issues.length === 0 ? '(no issue)' : issues.map((issue) => issueLabel(issue) + (issue.scored ? '' : `[${issue.excluded}]`) + (issue.entries.length > 1 ? `x${issue.entries.length}` : '')).join(' + ')
        if (verbose) for (const issue of issues) console.log(`      ${name}: ${issue.evidence.join('\n        ')}`)
        let verdict: HeldoutVerdict
        if (measured.recording.shifts.length === 0) verdict = 'wrong' // the page is built to shift; nothing recorded means the test itself is broken
        else if (expected.devArtifact === true) {
          verdict = issues.every((issue) => issue.cause === 'dev-artifact' && !issue.scored) && (measured.report.cls ?? 0) === 0 ? 'correct' : issues.some((issue) => issue.scored && issue.confidence >= 0.7 && issue.cause !== 'unknown') ? 'wrong' : 'conservative'
        } else {
          const scored = measured.scored
          const topIndex = scored.reduce((best, issue, index) => (issue.value > (scored[best]?.value ?? 0) ? index : best), 0)
          const top = scored[topIndex]
          const culpritOk = accepted.culprits === null || (top !== undefined && (measured.culpritIs[topIndex] ?? []).some(Boolean))
          const causeOk = top !== undefined && accepted.causes.includes(top.cause)
          const confidentEnough = top !== undefined && (top.cause === 'unknown' || top.confidence >= 0.7)
          const tooMany = expected.maxIssues !== undefined && scored.length > expected.maxIssues
          const confidentWrong = scored.some((issue, index) => issue.confidence >= 0.7 && issue.cause !== 'unknown' && (!accepted.causes.includes(issue.cause) || !(accepted.culprits === null || (measured.culpritIs[index] ?? []).some(Boolean))))
          if (confidentWrong) verdict = 'wrong'
          else if (causeOk && culpritOk && confidentEnough && !tooMany) verdict = 'correct'
          else verdict = 'conservative'
        }
        perLoad.push({ verdict, label })
      } finally {
        await handle.close()
      }
    }
    const worst: HeldoutVerdict = perLoad.some((load) => load.verdict === 'wrong') ? 'wrong' : perLoad.every((load) => load.verdict === 'correct') ? 'correct' : 'conservative'
    const labels = perLoad.map((load) => load.label)
    const want = `${accepted.causes.join(' or ')}${accepted.culprits === null ? '' : `:${accepted.culprits.join(' or ')}`}`
    rows.push(`${worst.toUpperCase().padEnd(12)} ${name.padEnd(24)} accepted ${want}\n${' '.repeat(37)} detected ${labels.every((label) => label === labels[0]) ? `${labels[0]}  (x3, identical)` : labels.join('  |  ')}`)
    verdicts.push({ name, verdict: worst, detail: labels[0] ?? '' })
  }
  await proxy.close()
  await server.close()

  const count = (verdict: HeldoutVerdict): number => verdicts.filter((entry) => entry.verdict === verdict).length
  report.info(
    `Held-out pages, three loads each. CORRECT = accepted cause and culprit (confidence >= 0.7 unless the accepted cause is "unknown"); ` +
      `CONSERVATIVE = no confident claim, the real cause was not named; WRONG = a confident claim that is not accepted.\n${rows.join('\n')}\n` +
      `${count('correct')} correct, ${count('conservative')} conservative, ${count('wrong')} wrong of ${verdicts.length}. ` +
      `First run of these pages, before the attributor was changed for any of them: see FIRST_RUN in this file.`,
  )
  report.info(FIRST_RUN)
  const wrong = verdicts.filter((entry) => entry.verdict === 'wrong')
  report.check('no held-out page gets a confident wrong answer', verdicts.length > 0 && wrong.length === 0, wrong.map((entry) => `${entry.name}: ${entry.detail}`).join('\n') || `${verdicts.length} pages, 0 confident wrong`)
  const dev = verdicts.find((entry) => entry.name === 'dev-style-inject')
  if (dev !== undefined) report.check('a shift caused by a dev-server client injecting a <style> is classified dev-artifact and not scored', dev.verdict === 'correct', dev.detail)
}

// ---------------------------------------------------------------------------
// G. a real dev server
// ---------------------------------------------------------------------------

async function sectionG(browser: Browser): Promise<void> {
  report.section('G. real dev server (vite-react-19): a style update pushed by the dev client')
  const fixture = await startFixture('vite-react-19')
  const proxy = await startProxy(fixture, { headScripts: [hookScript()] })
  const handle = await newPage(browser)
  try {
    await handle.page.goto(`${proxy.url}/`, { waitUntil: 'load' })
    await waitFor(() => handle.record.webSockets.length > 0, { what: 'the HMR socket' })
    await sleep(1200)
    const before = await readRecording(handle.page)
    const devStyles = await handle.page.evaluate(() => document.querySelectorAll('style[data-vite-dev-id]').length)
    // The developer (or an agent) edits a CSS module; Vite's client rewrites its <style> element in the open page.
    editFile(fixture, 'src/components/Hero.module.css', replaceOnce('min-height: 220px;', 'min-height: 420px;'))
    await waitFor(() => handle.page.evaluate(() => getComputedStyle(document.querySelector('[data-label="hero-art"]') as Element).minHeight === '420px'), { what: 'the style update to reach the page' })
    await sleep(500)
    const after = await readRecording(handle.page)
    const result = attributeShifts(after)
    const fresh = after.shifts.slice(before.shifts.length)
    const issues = result.issues.filter((issue) => issue.entries.some((index) => fresh.some((entry) => entry.index === index)))
    report.check(
      'the shift that follows a Vite style update is classified dev-artifact and not scored',
      fresh.length > 0 && issues.length > 0 && issues.every((issue) => issue.cause === 'dev-artifact' && !issue.scored) && (result.cls ?? 0) === 0 && handle.record.documentRequests.length === 1,
      `${devStyles} <style data-vite-dev-id> elements in the page; load: ${before.shifts.length} entries; after the edit: ${fresh.length} new entries (value ${fixed(fresh.reduce((total, entry) => total + entry.value, 0), 5)}), ` +
        `no reload (${handle.record.documentRequests.length} document request); issues: ${issues.map((issue) => issueLabel(issue) + (issue.scored ? '' : `[${issue.excluded}]`)).join(' + ') || '(none)'}; page CLS ${result.cls}\n` +
        (issues[0]?.evidence.join('\n') ?? ''),
    )
    if (record && fresh.length > 0) {
      mkdirSync(FIXTURE_DIR, { recursive: true })
      writeFileSync(join(FIXTURE_DIR, 'vite__hmr-style-update.json'), JSON.stringify(scrub(after), null, 1) + '\n')
    }
    if (process.env.S7_DUMP !== undefined) writeFileSync(process.env.S7_DUMP, JSON.stringify(after, null, 1))
  } finally {
    await handle.close()
    await proxy.close()
    await fixture.stop()
  }
}

/** What the held-out pages gave the first time they were run, before any change made because of them. Kept for the record. */
const FIRST_RUN =
  'First run of the held-out pages (2026-11-20, attributor as it stood after being built against the corpus only): 8 correct, 3 conservative, 0 wrong of 11. ' +
  'Conservative: dev-style-inject -> unknown:#hero@0.60 (the injected <style> was not connected to the growth), ' +
  'font-swap-two-blocks -> unknown, no culprit (two elements grew in one frame; no single one explains every victim), ' +
  'img-float -> unknown, no culprit (a float pushes nothing by its own height). ' +
  'Counted correct by acceptance, without the real cause being named: height-transition -> unknown:#panel@0.60 (18 entries, one issue), ' +
  'late-stylesheet -> unknown:#site-header@0.60, remove-banner -> unknown, no culprit. ' +
  'The attributor was then extended for these patterns, so the table above is no longer a held-out result.'

// ---------------------------------------------------------------------------

/** Replaces the run's random port in a recording, so that fixtures do not change from run to run. */
function scrub(recording: ShiftRecording): ShiftRecording {
  return JSON.parse(JSON.stringify(recording).replace(/(localhost|127\.0\.0\.1):\d+/g, 'localhost:4310')) as ShiftRecording
}

async function main(): Promise<void> {
  const corpusFixture = await startFixture('cls-corpus')
  const corpus = listCorpus(corpusFixture.sourceDir).filter((page) => only === undefined || page.name.includes(only))
  const browser = await launchBrowser()
  const lanes: Lane[] = []
  for (let index = 0; index < LANES; index++) {
    const relay = await startRelay(corpusFixture, [ORIGIN, SESSION_POLICY])
    lanes.push({ relay, proxy: await startProxy(relay, { headScripts: [hookScript()] }) })
  }
  report.info(`corpus: ${corpus.length} pages (${corpus.filter((page) => page.expected.positive).length} positive, ${corpus.filter((page) => !page.expected.positive).length} negative); Chromium ${browser.version()} headless, 1280x800; ${LANES} pages measured side by side`)

  if (sections.has('a')) await sectionA(browser, lanes, listCorpus(corpusFixture.sourceDir))

  let results: PageResult[] = []
  if (sections.has('b')) {
    report.section(`B. corpus: a first load, then ${COLD_LOADS} cold replays (location.reload()) per page, in one tab`)
    const collected: PageResult[] = []
    await pool(lanes, corpus, async (page, lane) => {
      collected.push(await runPageCold(browser, lane, page))
    })
    results = corpus.map((page) => collected.find((result) => result.page === page)).filter((result): result is PageResult => result !== undefined)
    sectionBReport(results)
    if (record) {
      mkdirSync(FIXTURE_DIR, { recursive: true })
      for (const result of results) {
        const recording = result.loads[0]?.measured.recording
        if (recording !== undefined) writeFileSync(join(FIXTURE_DIR, `${result.page.name.replace('/', '__')}.json`), JSON.stringify(scrub(recording), null, 1) + '\n')
      }
      report.info(`wrote ${results.length} recordings to ${FIXTURE_DIR}`)
    }
    if (sections.has('c')) await sectionC(browser, lanes, results)
  }
  if (sections.has('d')) await sectionD(browser, corpusFixture)
  if (sections.has('e')) await sectionE(browser, corpusFixture, corpus)
  if (sections.has('f')) await sectionF(browser)
  if (sections.has('g')) await sectionG(browser)

  if (partial) report.check('complete run', false, 'this was a partial run (--only / --sections); it cannot pass')
}

try {
  await main()
} catch (error) {
  report.check('spike ran to completion', false, error instanceof Error ? (error.stack ?? error.message) : String(error))
} finally {
  await runCleanups()
  report.finish()
}
