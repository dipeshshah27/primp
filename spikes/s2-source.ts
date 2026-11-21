/**
 * Spike S2: map a DOM element back to its source file, line and column in dev, with nothing
 * installed in the project.
 *
 *   pnpm spike:s2            exits 0 on pass, 1 on fail
 *   S2_ONLY=vite-react-19 pnpm spike:s2     one fixture (the run then FAILS: incomplete)
 *   S2_VERBOSE=1 pnpm spike:s2              also prints every resolved element
 *
 * For every entry of each fixture's labels.json the spike finds the element by `data-label`,
 * collects evidence in the page with packages/source/src/browser, resolves it in Node with
 * packages/source/src/node and only then compares the answer with the label.
 *
 * The collector and the resolver never see `data-label` or labels.json: the collector is
 * handed the element, its attribute allowlist does not contain `data-label`, and the
 * resolver's tag scoring drops the values of data-* attributes it reads from source files.
 *
 * Criteria (from the plan):
 *   - React fixtures (Vite, Next incl. Server Components): >= 95% exact file+line   -> must pass
 *     (checked strictly: right file and line AND reported at level `exact`; on Next also for
 *     server and client components separately)
 *   - /big pages (> 10,000 elements): no crash; match rate reported separately; an element
 *     React kept no stack for must be downgraded, never reported as exact when wrong
 *   - Svelte and static HTML: rate reported against a 95% target
 */

import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from '@playwright/test'
import { createResolver, type NextStrategy, type Resolver } from '../packages/source/src/node/index.ts'
import type { Evidence, SourceResult } from '../packages/source/src/types.ts'
import {
  bundleBrowser,
  createReport,
  editFile,
  launchBrowser,
  newPage,
  percentile,
  readFixtureFile,
  runCleanups,
  sleep,
  startFixture,
  startProxy,
  waitFor,
  type FixtureHandle,
  type FixtureLabel,
  type FixtureName,
  type PageHandle,
  type ProxyHandle,
  type Report,
} from './lib/index.ts'
import type { HookInfo, PageFacts, S2Probe } from './s2-assets/probe-entry.ts'

const HOOK_ENTRY = fileURLToPath(new URL('./s2-assets/hook-entry.ts', import.meta.url))
const PROBE_ENTRY = fileURLToPath(new URL('./s2-assets/probe-entry.ts', import.meta.url))
const TARGET = 0.95
const VERBOSE = process.env.S2_VERBOSE === '1'
const ONLY = process.env.S2_ONLY

type ProbeWindow = Window & { __primpS2: S2Probe }

interface Expected {
  file: string
  /** Undefined for unlabelled elements, where only the file is known. */
  line?: number
  col?: number
  tag: string
}

interface Case {
  page: string
  /** Label, or a description for unlabelled samples. */
  name: string
  instance: number
  kind: string
  expected: Expected
  evidence: Evidence | null
  result?: SourceResult
  fileOk: boolean
  lineOk: boolean
  colOk: boolean
  note?: string
}

const pct = (part: number, whole: number): string => (whole === 0 ? 'n/a' : `${((100 * part) / whole).toFixed(1)}%`)
const ms = (value: number): string => (Number.isNaN(value) ? 'n/a' : value < 10 ? `${value.toFixed(2)} ms` : `${value.toFixed(1)} ms`)
const where = (result: SourceResult | undefined): string =>
  result?.file === undefined ? '(nothing)' : `${result.file}:${result.line ?? '?'}:${result.col ?? '?'}`

function tally<T extends string>(values: readonly T[]): string {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1]).map(([key, count]) => `${key} ${count}`).join(', ') || 'none'
}

function judge(entry: Omit<Case, 'fileOk' | 'lineOk' | 'colOk'>): Case {
  const { expected, result } = entry
  const fileOk = result?.file === expected.file
  const lineOk = fileOk && expected.line !== undefined && result?.line === expected.line
  const colOk = lineOk && result?.col === expected.col
  return { ...entry, fileOk, lineOk, colOk }
}

/**
 * A result that claims more than is true: the one thing the resolver must never produce.
 * `exact` promises the file and the line, `file` promises the file. A `usage` result names
 * where a component is used, not the element's tag, so here it counts as a line claim too.
 */
function wrongExact(entry: Case): boolean {
  const level = entry.result?.level
  if (level === 'file') return !entry.fileOk
  if (level !== 'exact') return false
  return entry.expected.line === undefined ? !entry.fileOk : !entry.lineOk
}

/** 1-based positions of every `<tag` opening in `source`, in file order. Answer key for unlabelled samples. */
function tagPositions(source: string, tag: string): { line: number; col: number }[] {
  const positions: { line: number; col: number }[] = []
  const opening = new RegExp(`<${tag}(?=[\\s/>])`, 'g')
  for (let match = opening.exec(source); match; match = opening.exec(source)) {
    const before = source.slice(0, match.index)
    // A tag named in a `//` comment is not markup (the Vite fixture's header comment mentions <tr> and <td>).
    if (/^\s*(?:\/\/|\*)/.test(before.slice(before.lastIndexOf('\n') + 1))) continue
    positions.push({ line: before.split('\n').length, col: match.index - before.lastIndexOf('\n') })
  }
  return positions
}

/**
 * Expected position of an unlabelled element of a /big page, from the fixture's source alone:
 * the page writes one row template, so a row is the first `<rowTag` of the file and its n-th
 * cell is the n-th `<cellTag`.
 */
function templateExpectation(source: string, file: string, evidence: Evidence, rowTag: string, cellTag: string): Expected {
  const tag = evidence.context.tag
  const position = tag === rowTag ? tagPositions(source, rowTag)[0] : tagPositions(source, cellTag)[evidence.context.path.at(-1)?.ofType ?? -1]
  return position ? { file, tag, line: position.line, col: position.col } : { file, tag }
}

/**
 * Graceful downgrade, stated independently of the resolver: an element React kept no call-site
 * stack for may only be reported at level `exact` when its source file holds exactly one
 * opening tag of that name. With several, nothing the browser sends can prove which one made
 * the element, so `exact` would be a guess even when it happens to be right.
 */
function notDowngraded(cases: readonly Case[], source: string): Case[] {
  return cases.filter(
    (entry) => entry.evidence?.react?.stackState !== 'captured' && entry.result?.level === 'exact' && tagPositions(source, entry.expected.tag).length !== 1,
  )
}

function downgradeSummary(cases: readonly Case[]): string {
  const without = cases.filter((entry) => entry.evidence?.react?.stackState !== 'captured')
  return `${without.length} of ${cases.length} resolved elements had no call-site stack; their levels: ${tally(without.map((entry) => entry.result?.level ?? 'candidates'))}`
}

function sampleLine(report: Report, title: string, sample: { total: number }, cases: readonly Case[]): void {
  const sampleMs = cases.map((entry) => entry.result?.resolveMs ?? NaN)
  const levels = ['exact', 'file', 'candidates'] as const
  const perLevel = levels
    .map((level) => {
      const at = cases.filter((entry) => entry.result?.level === level)
      return `${level} ${at.length} (line right on ${at.filter((entry) => entry.lineOk).length})`
    })
    .join(', ')
  report.info(
    `${title} unlabelled sample (${cases.length} of ${sample.total} rows and cells, expected line taken from the row template in the source): ` +
      `file right on ${cases.filter((entry) => entry.fileOk).length}/${cases.length}, file+line right on ${cases.filter((entry) => entry.lineOk).length}/${cases.length}; ` +
      `levels: ${perLevel}; via: ${tally(cases.map((entry) => entry.result?.via ?? 'none'))}; ` +
      `resolution p50 ${ms(percentile(sampleMs, 0.5))}, p95 ${ms(percentile(sampleMs, 0.95))}`,
  )
}

/** Waits until the number of elements carrying framework debug data stops changing (hydration finished). */
async function settle(page: Page, wantFramework: boolean): Promise<PageFacts> {
  let previous = -1
  let stable = 0
  const started = performance.now()
  for (;;) {
    const facts = await page.evaluate(() => (window as unknown as ProbeWindow).__primpS2.facts())
    const marked = facts.withFiber + facts.withSvelteMeta
    stable = marked === previous ? stable + 1 : 0
    previous = marked
    const elapsed = performance.now() - started
    if (stable >= 2 && (marked > 0 || !wantFramework || elapsed > 8000)) return facts
    if (elapsed > 15_000) return facts
    await sleep(150)
  }
}

async function open(page: Page, url: string, wantFramework: boolean): Promise<PageFacts> {
  await page.goto(url, { waitUntil: 'load' })
  return settle(page, wantFramework)
}

function instanceIndexes(count: number): number[] {
  if (count <= 8) return Array.from({ length: count }, (_, index) => index)
  return [...new Set([0, 1, Math.floor(count / 2), count - 2, count - 1])]
}

async function collectLabel(page: Page, label: FixtureLabel, pagePath: string, indexes?: number[]): Promise<Omit<Case, 'fileOk' | 'lineOk' | 'colOk'>[]> {
  const expected: Expected = { file: label.file, line: label.line, col: label.col, tag: label.tag }
  const count = await page.evaluate((name) => (window as unknown as ProbeWindow).__primpS2.count(name), label.label)
  if (count === 0) {
    return [{ page: pagePath, name: label.label, instance: 0, kind: label.kind, expected, evidence: null, note: 'element not in the DOM' }]
  }
  const cases: Omit<Case, 'fileOk' | 'lineOk' | 'colOk'>[] = []
  for (const index of indexes ?? instanceIndexes(count)) {
    const evidence = await page.evaluate(([name, at]) => (window as unknown as ProbeWindow).__primpS2.collect(name, at), [label.label, index] as const)
    cases.push({ page: pagePath, name: label.label, instance: index, kind: label.kind, expected, evidence })
  }
  return cases
}

async function resolveAll(resolver: Resolver, pending: Omit<Case, 'fileOk' | 'lineOk' | 'colOk'>[]): Promise<Case[]> {
  const cases: Case[] = []
  for (const entry of pending) {
    const result = entry.evidence ? await resolver.resolve(entry.evidence) : undefined
    cases.push(judge({ ...entry, result }))
  }
  return cases
}

interface Summary {
  total: number
  line: number
  file: number
  col: number
  exactLevel: number
  wrongExact: Case[]
  misses: Case[]
}

/** One row per label: a label with several instances counts once and matches only if every sampled instance does. */
function byLabel(cases: readonly Case[]): Case[] {
  const groups = new Map<string, Case[]>()
  for (const entry of cases) {
    const key = `${entry.page}\u0000${entry.name}`
    groups.set(key, [...(groups.get(key) ?? []), entry])
  }
  return [...groups.values()].map((group) => group.find((entry) => !entry.lineOk) ?? group.find((entry) => !entry.colOk) ?? (group[0] as Case))
}

function summarise(cases: readonly Case[]): Summary {
  const rows = byLabel(cases)
  return {
    total: rows.length,
    line: rows.filter((entry) => entry.lineOk).length,
    file: rows.filter((entry) => entry.fileOk).length,
    col: rows.filter((entry) => entry.colOk).length,
    exactLevel: rows.filter((entry) => entry.lineOk && entry.result?.level === 'exact').length,
    wrongExact: cases.filter(wrongExact),
    misses: rows.filter((entry) => !entry.lineOk),
  }
}

/**
 * The React criterion, read strictly: the right file and line is not enough, the resolver must
 * also have reported it at level `exact`. A right line offered as one of several candidates
 * does not count.
 */
const reactCriterion = (summary: Summary): boolean => summary.total > 0 && summary.exactLevel / summary.total >= TARGET

function describeMiss(entry: Case): string {
  const result = entry.result
  const expected = `${entry.expected.file}:${entry.expected.line ?? '?'}:${entry.expected.col ?? '?'}`
  const got = result ? `${where(result)} level=${result.level} via=${result.via}` : (entry.note ?? 'no evidence')
  const notes = result?.notes.length ? `\n      notes: ${result.notes.join(' | ')}` : ''
  const react = entry.evidence?.react
  const state = react ? ` react.stackState=${react.stackState} hostFiber=${react.hostFiber}` : entry.evidence?.svelte ? ' svelte' : ' no framework evidence'
  return `${entry.page} ${entry.name}[${entry.instance}] (${entry.kind} <${entry.expected.tag}>) expected ${expected}, got ${got};${state}${notes}`
}

function printCases(report: Report, title: string, cases: readonly Case[]): Summary {
  const summary = summarise(cases)
  const resolved = cases.filter((entry) => entry.result)
  const collect = resolved.map((entry) => entry.evidence?.collectMs ?? NaN)
  const resolve = resolved.map((entry) => entry.result?.resolveMs ?? NaN)
  report.info(
    `${title}: ${summary.total} labels (${cases.length} elements)\n` +
      `exact file+line ${summary.line}/${summary.total} (${pct(summary.line, summary.total)}), ` +
      `file ${summary.file}/${summary.total} (${pct(summary.file, summary.total)}), ` +
      `file+line+col ${summary.col}/${summary.total} (${pct(summary.col, summary.total)})\n` +
      `levels: ${tally(resolved.map((entry) => entry.result?.level ?? 'candidates'))}; via: ${tally(resolved.map((entry) => entry.result?.via ?? 'none'))}\n` +
      `collection p50 ${ms(percentile(collect, 0.5))}, p95 ${ms(percentile(collect, 0.95))}; ` +
      `resolution p50 ${ms(percentile(resolve, 0.5))}, p95 ${ms(percentile(resolve, 0.95))}, max ${ms(Math.max(...resolve))} (first use of each script included)`,
  )
  for (const miss of summary.misses) report.info(`MISS ${describeMiss(miss)}`)
  if (VERBOSE) {
    for (const entry of cases) {
      report.info(`${entry.lineOk ? 'ok  ' : 'MISS'} ${entry.page} ${entry.name}[${entry.instance}] -> ${where(entry.result)} ${entry.result?.level} ${entry.result?.via}`)
    }
  }
  return summary
}

function checkNoWrongExact(report: Report, title: string, cases: readonly Case[]): void {
  const wrong = cases.filter(wrongExact)
  const exact = cases.filter((entry) => entry.result?.level === 'exact').length
  const file = cases.filter((entry) => entry.result?.level === 'file').length
  report.check(
    `${title}: no result claims more than is true (exact = file and line right, file = file right)`,
    wrong.length === 0,
    wrong.length === 0 ? `${exact} results at level exact with the right file and line, ${file} at level file with the right file` : wrong.map(describeMiss).join('\n'),
  )
}

interface Session {
  fixture: FixtureHandle
  proxy: ProxyHandle
  resolver: Resolver
  browser: Browser
}

async function startSession(name: FixtureName, browser: Browser, scripts: { hook: string; probe: string }): Promise<Session> {
  const fixture = await startFixture(name)
  const proxy = await startProxy(fixture, {
    headScripts: [
      { name: 'hook.js', code: scripts.hook },
      { name: 'probe.js', code: scripts.probe },
    ],
  })
  const resolver = createResolver({ projectRoot: fixture.dir, target: fixture.url })
  return { fixture, proxy, resolver, browser }
}

async function endSession(session: Session): Promise<void> {
  await session.proxy.close()
  await session.fixture.stop()
}

function checkPageHealth(report: Report, title: string, handle: PageHandle, hook: HookInfo | undefined, wantRenderer: boolean): void {
  const errors = handle.record.pageErrors
  const renderer = hook?.renderers[0]
  const ok = errors.length === 0 && hook?.present === true && (!wantRenderer || renderer !== undefined)
  report.check(
    `${title}: hook and collector load without page errors`,
    ok,
    `page errors ${errors.length}${errors[0] ? ` (${errors[0].split('\n')[0]})` : ''}; hook present ${hook?.present}` +
      `${hook?.source ? ` (${hook.source})` : ''}; renderers ${hook?.renderers.length ?? 0}` +
      (renderer ? ` (${renderer.packageName ?? 'react'} ${renderer.version}, bundleType ${renderer.bundleType})` : ''),
  )
}

const hookInfo = (page: Page): Promise<HookInfo> => page.evaluate(() => (window as unknown as ProbeWindow).__primpS2.hook())

/**
 * Edits a source file so every line below the first moves down by one, waits for the dev
 * server's update, and requires the same element to resolve to its old line + 1. Proves the
 * resolver follows hot updates instead of reusing a stale source map.
 */
async function checkFollowsEdit(report: Report, session: Session, page: Page, title: string, label: FixtureLabel): Promise<void> {
  await report.attempt(`${title}: after an edit that moves <${label.tag}> down one line, it resolves to the new line`, async () => {
    const edit = editFile(session.fixture, label.file, (source) => {
      const firstBreak = source.indexOf('\n')
      return `${source.slice(0, firstBreak + 1)}// s2: one line added by the spike\n${source.slice(firstBreak + 1)}`
    })
    session.resolver.invalidate()
    let last: SourceResult | undefined
    await waitFor(
      async () => {
        const evidence = await page.evaluate((name) => (window as unknown as ProbeWindow).__primpS2.collect(name, 0), label.label)
        if (!evidence) return false
        last = await session.resolver.resolve(evidence)
        return last.file === label.file && last.line === label.line + 1 && last.level === 'exact'
      },
      { timeoutMs: 15_000, intervalMs: 100, what: `${label.label} to resolve to line ${label.line + 1} (last: ${where(last)} ${last?.level})` },
    )
    return `${label.file}:${label.line} -> ${where(last)} at level ${last?.level}, ${(performance.now() - edit.writtenAt).toFixed(0)} ms after the write`
  })
}

// ---------------------------------------------------------------------------------------------
// vite-react-19
// ---------------------------------------------------------------------------------------------

async function runVite(report: Report, browser: Browser, scripts: { hook: string; probe: string }): Promise<void> {
  report.section('vite-react-19')
  const session = await startSession('vite-react-19', browser, scripts)
  try {
    const labels = session.fixture.labels
    const handle = await newPage(browser)
    const facts = await open(handle.page, `${session.proxy.url}/`, true)
    checkPageHealth(report, '/', handle, await hookInfo(handle.page), true)
    report.info(`/ has ${facts.elements} elements, ${facts.withFiber} with a fiber`)

    const pending = []
    for (const label of labels.filter((entry) => entry.page === '/')) pending.push(...(await collectLabel(handle.page, label, '/')))
    const cases = await resolveAll(session.resolver, pending)
    const summary = printCases(report, 'vite-react-19 /', cases)
    report.check(
      'React (Vite): at least 95% of labelled elements resolve to the exact file and line, reported at level exact',
      reactCriterion(summary),
      `file+line right on ${summary.line}/${summary.total} = ${pct(summary.line, summary.total)}; right and reported at level exact on ` +
        `${summary.exactLevel}/${summary.total} = ${pct(summary.exactLevel, summary.total)}; column also right on ${summary.col}`,
    )
    checkNoWrongExact(report, 'vite-react-19 /', cases)

    // Warm pass: the same evidence again, source maps cached.
    const warm = await resolveAll(session.resolver, pending)
    const warmMs = warm.map((entry) => entry.result?.resolveMs ?? NaN)
    report.info(`warm resolution (same evidence again): p50 ${ms(percentile(warmMs, 0.5))}, p95 ${ms(percentile(warmMs, 0.95))}`)

    const heroTitle = labels.find((entry) => entry.label === 'hero-title')
    if (heroTitle) await checkFollowsEdit(report, session, handle.page, 'vite-react-19', heroTitle)
    await handle.close()

    // /big: 13,007 elements. StrictMode (default) and ?nostrict behave differently, both are measured.
    for (const variant of ['/big', '/big?nostrict']) {
      await report.attempt(`${variant}: ${'>'} 10,000 elements, collect and resolve without a crash`, async () => {
        const big = await newPage(browser)
        try {
          const bigFacts = await open(big.page, session.proxy.url + variant, true)
          const all = await big.page.evaluate(() => (window as unknown as ProbeWindow).__primpS2.timeAll('body *'))
          const bigPending = []
          for (const label of labels.filter((entry) => entry.page === '/big')) {
            const count = await big.page.evaluate((name) => (window as unknown as ProbeWindow).__primpS2.count(name), label.label)
            const indexes = count > 8 ? [0, 1, 1000, 1998, 1999, 2000, count - 1].filter((index) => index < count) : undefined
            bigPending.push(...(await collectLabel(big.page, label, variant, indexes)))
          }
          const labelled = await resolveAll(session.resolver, bigPending)
          const sample = await big.page.evaluate(() => (window as unknown as ProbeWindow).__primpS2.sample('.big-table tr, .big-table td', 80))
          const bigSource = readFixtureFile(session.fixture, 'src/pages/Big.tsx')
          const unlabelled = await resolveAll(
            session.resolver,
            sample.evidence.map((evidence, index) => ({
              page: variant,
              name: `sample <${evidence.context.tag}>`,
              instance: index,
              kind: 'client',
              expected: templateExpectation(bigSource, 'src/pages/Big.tsx', evidence, 'tr', 'td'),
              evidence,
            })),
          )
          report.info(
            `${variant}: ${bigFacts.elements} elements; collecting all ${all.total} took ${ms(all.ms)} (${((all.ms / all.total) * 1000).toFixed(1)} us each, max ${ms(all.maxMs)}); ` +
              `call-site stack on ${all.withStack}, React's placeholder on ${all.placeholder}, no call-site frame on ${all.missing}`,
          )
          const elementCases = labelled
          const lineOk = elementCases.filter((entry) => entry.lineOk).length
          report.info(
            `${variant} labelled elements (${elementCases.length} incl. instances of big-cell-name): exact file+line ${lineOk}/${elementCases.length} (${pct(lineOk, elementCases.length)}), ` +
              `file ${elementCases.filter((entry) => entry.fileOk).length}/${elementCases.length}; levels: ${tally(elementCases.map((entry) => entry.result?.level ?? 'candidates'))}; ` +
              `via: ${tally(elementCases.map((entry) => entry.result?.via ?? 'none'))}`,
          )
          for (const entry of elementCases) {
            report.info(
              `  ${entry.lineOk ? 'ok  ' : 'MISS'} ${entry.name}[${entry.instance}] stack=${entry.evidence?.react?.stackState} -> ${where(entry.result)} level=${entry.result?.level} via=${entry.result?.via}` +
                (entry.lineOk ? '' : ` (expected ${entry.expected.file}:${entry.expected.line}:${entry.expected.col}; ${entry.result?.notes.join(' | ')})`),
            )
          }
          sampleLine(report, variant, sample, unlabelled)
          const everything = [...labelled, ...unlabelled]
          const wrong = everything.filter(wrongExact)
          if (big.record.pageErrors.length > 0) throw new Error(`page errors: ${big.record.pageErrors[0]}`)
          if (everything.some((entry) => !entry.result)) throw new Error('an element produced no result')
          if (wrong.length > 0) throw new Error(`claims more than is true:\n${wrong.map(describeMiss).join('\n')}`)
          const guessed = notDowngraded(everything, bigSource)
          if (guessed.length > 0) throw new Error(`reported exact without a stack although the file has several such tags:\n${guessed.map(describeMiss).join('\n')}`)
          return (
            `${all.total} elements collected, ${everything.length} resolved, no errors; labelled exact file+line ${lineOk}/${elementCases.length}, ` +
            `file ${elementCases.filter((entry) => entry.fileOk).length}/${elementCases.length}; no result claims more than is true; ${downgradeSummary(everything)}`
          )
        } finally {
          await big.close()
        }
      })
    }
  } finally {
    await endSession(session)
  }
}

// ---------------------------------------------------------------------------------------------
// next-16-turbopack
// ---------------------------------------------------------------------------------------------

async function runNext(report: Report, browser: Browser, scripts: { hook: string; probe: string }): Promise<void> {
  report.section('next-16-turbopack')
  const session = await startSession('next-16-turbopack', browser, scripts)
  try {
    const labels = session.fixture.labels
    const pages = [...new Set(labels.map((entry) => entry.page ?? '/'))].filter((page) => page !== '/big' && page !== '/account')
    const handle = await newPage(browser)
    const pending: Omit<Case, 'fileOk' | 'lineOk' | 'colOk'>[] = []
    let health: HookInfo | undefined

    for (const path of pages) {
      const onPage = labels.filter((entry) => entry.page === path)
      const transient = onPage.filter((entry) => entry.note !== undefined)
      if (transient.length > 0) {
        // In the DOM only while the response is still streaming: collect during the navigation.
        await handle.page.goto(session.proxy.url + path, { waitUntil: 'commit' })
        for (const label of transient) {
          const seen = await handle.page.evaluate((name) => (window as unknown as ProbeWindow).__primpS2.collectTransient(name, 8000), label.label)
          pending.push({
            page: path,
            name: label.label,
            instance: 0,
            kind: label.kind,
            expected: { file: label.file, line: label.line, col: label.col, tag: label.tag },
            evidence: seen.evidence,
            note: `transient element: seen ${seen.sightings} times, framework evidence ${seen.hadFramework}`,
          })
        }
        await handle.page.waitForLoadState('load')
        await settle(handle.page, true)
      } else {
        await open(handle.page, session.proxy.url + path, true)
      }
      health ??= await hookInfo(handle.page)
      for (const label of onPage.filter((entry) => entry.note === undefined)) pending.push(...(await collectLabel(handle.page, label, path)))
    }

    // /account needs the session cookie: log in through the real form.
    await open(handle.page, `${session.proxy.url}/login`, true)
    await Promise.all([handle.page.waitForURL('**/account'), handle.page.click('form[action="/api/login"] button[type="submit"]')])
    await settle(handle.page, true)
    for (const label of labels.filter((entry) => entry.page === '/account')) pending.push(...(await collectLabel(handle.page, label, '/account')))

    checkPageHealth(report, 'all routes', handle, health, true)

    const cases = await resolveAll(session.resolver, pending)
    const summary = printCases(report, 'next-16-turbopack (all routes except /big), default strategy: Next endpoint first, source maps second', cases)
    const server = summarise(cases.filter((entry) => entry.kind === 'server'))
    const client = summarise(cases.filter((entry) => entry.kind === 'client'))
    report.info(
      `server components: exact file+line ${server.line}/${server.total} (${pct(server.line, server.total)}); ` +
        `client components: ${client.line}/${client.total} (${pct(client.line, client.total)})`,
    )
    for (const path of [...pages, '/account']) {
      const onPage = summarise(cases.filter((entry) => entry.page === path))
      report.info(`  ${path}: ${onPage.line}/${onPage.total}`)
    }
    report.check(
      'React (Next, server and client components): at least 95% of labelled elements resolve to the exact file and line, reported at level exact',
      reactCriterion(summary) && reactCriterion(server) && reactCriterion(client),
      `file+line right on ${summary.line}/${summary.total} = ${pct(summary.line, summary.total)} (server ${server.line}/${server.total}, client ${client.line}/${client.total}); ` +
        `right and reported at level exact on ${summary.exactLevel}/${summary.total} = ${pct(summary.exactLevel, summary.total)} ` +
        `(server ${server.exactLevel}/${server.total}, client ${client.exactLevel}/${client.total}); column also right on ${summary.col}`,
    )
    checkNoWrongExact(report, 'next-16-turbopack', cases)

    // The same evidence through each symbolication strategy on its own.
    const strategies: NextStrategy[] = ['endpoint-only', 'source-maps-only']
    for (const strategy of strategies) {
      const resolver = createResolver({ projectRoot: session.fixture.dir, target: session.fixture.url, next: strategy })
      const alternative = await resolveAll(resolver, pending)
      const alt = summarise(alternative)
      const altServer = summarise(alternative.filter((entry) => entry.kind === 'server'))
      const altClient = summarise(alternative.filter((entry) => entry.kind === 'client'))
      const altMs = alternative.map((entry) => entry.result?.resolveMs ?? NaN)
      report.info(
        `strategy ${strategy}: exact file+line ${alt.line}/${alt.total} (${pct(alt.line, alt.total)}); server ${altServer.line}/${altServer.total}, client ${altClient.line}/${altClient.total}; ` +
          `column right on ${alt.col}; wrong-at-exact ${alt.wrongExact.length}; resolution p50 ${ms(percentile(altMs, 0.5))}, p95 ${ms(percentile(altMs, 0.95))}`,
      )
      for (const miss of alt.misses.slice(0, 6)) report.info(`  ${strategy} MISS ${describeMiss(miss)}`)
    }

    // Follow an edit in a client component and in a server component.
    await open(handle.page, `${session.proxy.url}/`, true)
    await waitFor(() => session.proxy.frames.some((frame) => frame.direction === 'upstream-to-client'), { what: 'the HMR socket' })
    const counter = labels.find((entry) => entry.label === 'counter-dec')
    if (counter) await checkFollowsEdit(report, session, handle.page, 'next client component', counter)
    const title = labels.find((entry) => entry.label === 'home-title')
    if (title) await checkFollowsEdit(report, session, handle.page, 'next server component', title)
    await handle.close()

    await report.attempt('/big: > 10,000 elements, collect and resolve without a crash', async () => {
      const big = await newPage(browser)
      try {
        const facts = await open(big.page, `${session.proxy.url}/big`, true)
        const all = await big.page.evaluate(() => (window as unknown as ProbeWindow).__primpS2.timeAll('body *'))
        const bigPending = []
        for (const label of labels.filter((entry) => entry.page === '/big')) bigPending.push(...(await collectLabel(big.page, label, '/big')))
        const labelled = await resolveAll(session.resolver, bigPending)
        // The labelled middle marker is an <li> of the same list but not a row of the template.
        const sample = await big.page.evaluate(() => (window as unknown as ProbeWindow).__primpS2.sample('.big-list li:not([data-marker]), .big-list span', 80))
        const bigSource = readFixtureFile(session.fixture, 'app/big/page.tsx')
        const unlabelled = await resolveAll(
          session.resolver,
          sample.evidence.map((evidence, index) => ({
            page: '/big',
            name: `sample <${evidence.context.tag}>`,
            instance: index,
            kind: 'server',
            expected: templateExpectation(bigSource, 'app/big/page.tsx', evidence, 'li', 'span'),
            evidence,
          })),
        )
        report.info(
          `/big: ${facts.elements} elements; collecting all ${all.total} took ${ms(all.ms)} (${((all.ms / all.total) * 1000).toFixed(1)} us each, max ${ms(all.maxMs)}); ` +
            `call-site stack on ${all.withStack}, React's placeholder on ${all.placeholder}, no call-site frame on ${all.missing}`,
        )
        const lineOk = labelled.filter((entry) => entry.lineOk).length
        for (const entry of labelled) {
          report.info(
            `  ${entry.lineOk ? 'ok  ' : 'MISS'} ${entry.name} stack=${entry.evidence?.react?.stackState} -> ${where(entry.result)} level=${entry.result?.level} via=${entry.result?.via}` +
              (entry.lineOk ? '' : ` (expected ${entry.expected.file}:${entry.expected.line}:${entry.expected.col}; ${entry.result?.notes.join(' | ')})`),
          )
        }
        sampleLine(report, '/big', sample, unlabelled)
        const everything = [...labelled, ...unlabelled]
        const wrong = everything.filter(wrongExact)
        if (big.record.pageErrors.length > 0) throw new Error(`page errors: ${big.record.pageErrors[0]}`)
        if (everything.some((entry) => !entry.result)) throw new Error('an element produced no result')
        if (wrong.length > 0) throw new Error(`claims more than is true:\n${wrong.map(describeMiss).join('\n')}`)
        const guessed = notDowngraded(everything, bigSource)
        if (guessed.length > 0) throw new Error(`reported exact without a stack although the file has several such tags:\n${guessed.map(describeMiss).join('\n')}`)
        return (
          `${all.total} elements collected, ${everything.length} resolved, no errors; labelled exact file+line ${lineOk}/${labelled.length}; ` +
          `no result claims more than is true; ${downgradeSummary(everything)}`
        )
      } finally {
        await big.close()
      }
    })
  } finally {
    await endSession(session)
  }
}

// ---------------------------------------------------------------------------------------------
// sveltekit-svelte-5
// ---------------------------------------------------------------------------------------------

async function runSvelte(report: Report, browser: Browser, scripts: { hook: string; probe: string }): Promise<void> {
  report.section('sveltekit-svelte-5')
  const session = await startSession('sveltekit-svelte-5', browser, scripts)
  try {
    const labels = session.fixture.labels
    const handle = await newPage(browser)
    const pending: Omit<Case, 'fileOk' | 'lineOk' | 'colOk'>[] = []
    const unhydrated: Omit<Case, 'fileOk' | 'lineOk' | 'colOk'>[] = []

    await open(handle.page, `${session.proxy.url}/`, true)
    const health = await hookInfo(handle.page)
    for (const label of labels.filter((entry) => (entry.page === '/' || entry.everyPage === true) && entry.when !== 'signed-in')) {
      pending.push(...(await collectLabel(handle.page, label, '/')))
    }
    for (const path of ['/about', '/streamed', '/server-only']) {
      // /server-only ships no client JavaScript, so nothing there ever carries framework data.
      await open(handle.page, session.proxy.url + path, path !== '/server-only')
      if (path === '/streamed') await handle.page.waitForLoadState('networkidle')
      for (const label of labels.filter((entry) => entry.page === path && entry.everyPage !== true)) pending.push(...(await collectLabel(handle.page, label, path)))
      if (path === '/server-only') {
        // The layout's elements are on this page too, here without any framework data. They are
        // already counted once (on /, hydrated), so this second look is reported on its own.
        for (const label of labels.filter((entry) => entry.everyPage === true)) unhydrated.push(...(await collectLabel(handle.page, label, path)))
      }
    }
    // The signed-in labels: sign in through the real form.
    await open(handle.page, `${session.proxy.url}/`, true)
    await handle.page.fill('#signin-name', 'Spike')
    await handle.page.click('#signin button[type="submit"]')
    // AccountCard replaces SignInForm in place and reuses its id, so wait for the form's own field to go.
    await handle.page.waitForSelector('#signin-name', { state: 'detached' })
    await handle.page.waitForSelector('section.account')
    await settle(handle.page, true)
    for (const label of labels.filter((entry) => entry.when === 'signed-in')) pending.push(...(await collectLabel(handle.page, label, '/ (signed in)')))

    checkPageHealth(report, 'all routes', handle, health, false)
    const cases = await resolveAll(session.resolver, pending)
    const summary = printCases(report, 'sveltekit-svelte-5', cases)
    const hydrated = summarise(cases.filter((entry) => entry.kind === 'client'))
    const other = summarise(cases.filter((entry) => entry.kind !== 'client'))
    report.info(
      `elements Svelte created on the client: ${hydrated.line}/${hydrated.total} (${pct(hydrated.line, hydrated.total)}); ` +
        `csr=false page and app.html template (no __svelte_meta): ${other.line}/${other.total}`,
    )
    report.check(
      'Svelte: file+line right on at least 95% of labels (the target; the level is reported next to it)',
      summary.line / summary.total >= TARGET,
      `file+line right on ${summary.line}/${summary.total} = ${pct(summary.line, summary.total)}; right and reported at level exact on ` +
        `${summary.exactLevel}/${summary.total} = ${pct(summary.exactLevel, summary.total)}; column also right on ${summary.col}`,
    )
    if (summary.exactLevel / summary.total < TARGET) {
      const short = byLabel(cases).filter((entry) => !(entry.lineOk && entry.result?.level === 'exact'))
      report.info(
        `NOTE: counted strictly (right AND reported at level exact) Svelte is at ${pct(summary.exactLevel, summary.total)}, below the 95% target. ` +
          `The ${short.length} labels short of exact, by kind in labels.json: ${tally(short.map((entry) => entry.kind))} ` +
          `(server = csr false page, static = app.html; neither is touched by Svelte on the client); with __svelte_meta: ` +
          `${short.filter((entry) => entry.evidence?.svelte?.loc !== undefined).length}. Hydrated elements: ${hydrated.exactLevel}/${hydrated.total} at level exact.`,
      )
    }
    const layout = await resolveAll(session.resolver, unhydrated)
    const layoutSummary = summarise(layout)
    report.info(
      `layout elements seen again on /server-only, where nothing is hydrated (${layoutSummary.total} labels, not part of the rate above): ` +
        `first candidate has the right file+line on ${layoutSummary.line}/${layoutSummary.total}, right file on ${layoutSummary.file}/${layoutSummary.total}; ` +
        `levels: ${tally(layout.map((entry) => entry.result?.level ?? 'candidates'))}; via: ${tally(layout.map((entry) => entry.result?.via ?? 'none'))}`,
    )
    for (const miss of layoutSummary.misses) report.info(`  unhydrated MISS ${describeMiss(miss)}`)
    checkNoWrongExact(report, 'sveltekit-svelte-5', [...cases, ...layout])
    await handle.close()
  } finally {
    await endSession(session)
  }
}

// ---------------------------------------------------------------------------------------------
// static-html
// ---------------------------------------------------------------------------------------------

async function runStatic(report: Report, browser: Browser, scripts: { hook: string; probe: string }): Promise<void> {
  report.section('static-html')
  const session = await startSession('static-html', browser, scripts)
  try {
    const labels = session.fixture.labels
    const handle = await newPage(browser)
    const pending: Omit<Case, 'fileOk' | 'lineOk' | 'colOk'>[] = []
    let health: HookInfo | undefined
    for (const path of [...new Set(labels.map((entry) => entry.page ?? '/'))]) {
      await open(handle.page, session.proxy.url + path, false)
      health ??= await hookInfo(handle.page)
      for (const label of labels.filter((entry) => entry.page === path)) pending.push(...(await collectLabel(handle.page, label, path)))
    }
    checkPageHealth(report, 'all pages', handle, health, false)
    const cases = await resolveAll(session.resolver, pending)
    const summary = printCases(report, 'static-html', cases)
    report.check(
      'static HTML: file+line right on at least 95% of labels (the target; the level is reported next to it)',
      summary.line / summary.total >= TARGET,
      `file+line right on ${summary.line}/${summary.total} = ${pct(summary.line, summary.total)}; right and reported at level exact on ` +
        `${summary.exactLevel}/${summary.total} = ${pct(summary.exactLevel, summary.total)}; column also right on ${summary.col}`,
    )
    checkNoWrongExact(report, 'static-html', cases)
    await handle.close()
  } finally {
    await endSession(session)
  }
}

// ---------------------------------------------------------------------------------------------

const RUNNERS: Partial<Record<FixtureName, (report: Report, browser: Browser, scripts: { hook: string; probe: string }) => Promise<void>>> = {
  'vite-react-19': runVite,
  'next-16-turbopack': runNext,
  'sveltekit-svelte-5': runSvelte,
  'static-html': runStatic,
}

const report = createReport('S2 source mapping: DOM element -> file:line:col')
try {
  report.section('injected scripts')
  const hook = await bundleBrowser(HOOK_ENTRY, { minify: true })
  const probe = await bundleBrowser(PROBE_ENTRY, { minify: true })
  const collectorOnly = await bundleBrowser(fileURLToPath(new URL('../packages/source/src/browser/index.ts', import.meta.url)), { minify: true })
  report.info(
    `synchronous <head> hook (bippy/install-hook-only): ${hook.length} bytes minified, ${gzipSync(hook).length} gzipped\n` +
      `collectors (packages/source/src/browser, loaded later with the probe): ${collectorOnly.length} bytes minified, ${gzipSync(collectorOnly).length} gzipped`,
  )
  report.check('the synchronous hook stays under 4 kB minified', hook.length < 4096, `${hook.length} bytes`)

  const browser = await launchBrowser()
  for (const [name, run] of Object.entries(RUNNERS) as [FixtureName, NonNullable<(typeof RUNNERS)[FixtureName]>][]) {
    if (ONLY !== undefined && ONLY !== name) continue
    try {
      await run(report, browser, { hook, probe })
    } catch (error) {
      report.check(`${name}: ran to completion`, false, error instanceof Error ? (error.stack ?? error.message) : String(error))
    }
  }
  if (ONLY !== undefined) report.skip('all four fixtures', `S2_ONLY=${ONLY}: only one fixture was run, so the spike is incomplete`)
} catch (error) {
  report.check('spike ran to completion', false, error instanceof Error ? (error.stack ?? error.message) : String(error))
} finally {
  await runCleanups()
  report.finish()
}
