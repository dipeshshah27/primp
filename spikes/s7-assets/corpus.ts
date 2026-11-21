/**
 * The layout-shift corpus as spike S7 uses it: the page list, one measured
 * load, and the scoring of an attribution against `expected.json`.
 *
 * `expected.json` is the answer key. It is read here, for SCORING only; the
 * attributor is handed the hook's recording and nothing else.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { attributeShifts, CONFIDENT } from '../../packages/engine/src/shift-attributor.ts'
import type { ShiftCause, ShiftIssue, ShiftRecording, ShiftReport } from '../../packages/protocol/src/shift.ts'
import { sleep } from '../lib/index.ts'
import { readRecording } from './measure.ts'

export interface ExpectedShift {
  cause: ShiftCause
  culpritSelector: string
  culpritFile: string
  culpritLine: number
  culpritLineKind: 'opening-tag' | 'script-insert'
  triggerFile?: string
  triggerLine?: number
  measuredValues?: number[]
}

export interface Expected {
  page: string
  positive: boolean
  observeMs?: number
  entryCount?: number
  shifts: ExpectedShift[]
  interactions?: { afterMs?: number; click: string }[]
  minEntriesWithRecentInput?: number
  assertAfter?: string[]
}

export interface CorpusPage {
  /** `unsized-media/img-block` */
  name: string
  group: string
  /** URL path, with trailing slash. */
  path: string
  expected: Expected
}

const GROUPS = ['unsized-media', 'font-swap', 'injected-content', 'multi', 'negative']

export function listCorpus(corpusDir: string): CorpusPage[] {
  const pages: CorpusPage[] = []
  for (const group of GROUPS) {
    for (const entry of readdirSync(join(corpusDir, group)).sort()) {
      const file = join(corpusDir, group, entry, 'expected.json')
      if (!existsSync(file)) continue
      pages.push({ name: `${group}/${entry}`, group, path: `/${group}/${entry}/`, expected: JSON.parse(readFileSync(file, 'utf8')) as Expected })
    }
  }
  return pages
}

export type Navigation = { kind: 'goto'; url: string } | { kind: 'reload' } | { kind: 'bounce'; via: string; url: string }

/**
 * Starts a navigation and returns when the new document has committed.
 *
 * `reload` is `location.reload()` and `bounce` is two assignments to
 * `location.href`, all made by the page itself: what the dock's "Re-run cold"
 * button can do in an ordinary tab, with no help from the browser's debugging
 * protocol. A bounce leaves for `via`, a URL of ANOTHER SITE (the proxy under
 * `127.0.0.1` when the page is on `localhost`), and comes straight back. The
 * tab gets a new renderer process on the way, and with it an empty in-memory
 * resource cache, which nothing else clears.
 */
export async function navigate(page: Page, navigation: Navigation): Promise<void> {
  if (navigation.kind === 'goto') {
    await page.goto(navigation.url, { waitUntil: 'commit' })
    return
  }
  if (navigation.kind === 'bounce') {
    await Promise.all([
      page.waitForURL(navigation.via, { waitUntil: 'commit' }),
      page.evaluate((to) => {
        setTimeout(() => (location.href = to), 0)
      }, navigation.via),
    ])
    await Promise.all([
      page.waitForURL(navigation.url, { waitUntil: 'commit' }),
      page.evaluate((to) => {
        setTimeout(() => (location.href = to), 0)
      }, navigation.url),
    ])
    return
  }
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'commit' }),
    page.evaluate(() => {
      setTimeout(() => location.reload(), 0)
    }),
  ])
}

export interface MeasuredLoad {
  recording: ShiftRecording
  report: ShiftReport
  /** Scored issues in time order. */
  scored: ShiftIssue[]
  /** For each scored issue: is its culprit the same element as `selectors[i]`? Checked in the page, by identity. */
  culpritIs: boolean[][]
  /** `assertAfter` expressions that were false: the page did not do what it is there to do. */
  failedAsserts: string[]
}

/**
 * Watches a load that has just committed for the page's `observeMs`, performs
 * its scripted clicks, then reads the hook's recording and runs the attributor.
 */
export async function measureLoad(page: Page, expected: Pick<Expected, 'observeMs' | 'interactions' | 'assertAfter'>, selectors: string[]): Promise<MeasuredLoad> {
  const observeMs = expected.observeMs ?? 2000
  for (const step of expected.interactions ?? []) {
    await sleep(step.afterMs ?? 0)
    await page.click(step.click)
  }
  // The window is measured on the page's own clock, from its navigation start.
  await page.waitForFunction((ms) => performance.now() >= ms, observeMs, { polling: 50, timeout: observeMs + 15_000 })
  const recording = await readRecording(page)
  const report = attributeShifts(recording)
  const scored = report.issues.filter((issue) => issue.scored).sort((a, b) => a.startTime - b.startTime)
  const culpritIs = await page.evaluate(
    ([found, wanted]) =>
      (found as (string | null)[]).map((selector) =>
        (wanted as string[]).map((want) => {
          if (selector === null) return false
          try {
            const element = document.querySelector(selector)
            return element !== null && element === document.querySelector(want)
          } catch {
            return false
          }
        }),
      ),
    [scored.map((issue) => issue.culprit?.node.selector ?? null), selectors] as const,
  )
  const failedAsserts: string[] = []
  for (const expression of expected.assertAfter ?? []) {
    // The corpus pages have no Content-Security-Policy, so a string can be evaluated.
    const holds = await page.evaluate(expression).catch(() => false)
    if (holds !== true) failedAsserts.push(expression)
  }
  return { recording, report, scored, culpritIs, failedAsserts }
}

export interface ShiftScore {
  expectedCause: ShiftCause
  expectedCulprit: string
  gotCause: ShiftCause | 'missed'
  gotCulprit: string
  culpritOk: boolean
  confidence: number
  geometricMatch: boolean
  ok: boolean
}

export interface LoadScore {
  /** Every expected shift has its own issue, in order, with the right culprit and cause at confidence >= 0.7, and there is no extra scored issue. */
  strict: boolean
  /** The brief's criterion: the largest issue names the culprit and cause of the page's largest expected shift. */
  top: boolean
  shifts: ShiftScore[]
  scoredIssues: number
  /** Scored issues beyond the expected ones. */
  extra: number
}

const medianOf = (values: number[] | undefined): number => {
  if (values === undefined || values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[sorted.length >> 1] ?? 0
}

/** Scores one load of a positive page. `load.culpritIs` must have been computed against `expected.shifts[*].culpritSelector`. */
export function scoreLoad(expected: Expected, load: MeasuredLoad): LoadScore {
  const shifts = expected.shifts.map((want, index): ShiftScore => {
    const issue = load.scored[index]
    if (issue === undefined) {
      return { expectedCause: want.cause, expectedCulprit: want.culpritSelector, gotCause: 'missed', gotCulprit: '-', culpritOk: false, confidence: 0, geometricMatch: false, ok: false }
    }
    const culpritOk = load.culpritIs[index]?.[index] === true
    return {
      expectedCause: want.cause,
      expectedCulprit: want.culpritSelector,
      gotCause: issue.cause,
      gotCulprit: issue.culprit?.node.selector ?? '-',
      culpritOk,
      confidence: issue.confidence,
      geometricMatch: issue.geometricMatch,
      ok: culpritOk && issue.cause === want.cause && issue.confidence >= CONFIDENT && issue.geometricMatch,
    }
  })
  const extra = Math.max(0, load.scored.length - expected.shifts.length)
  // Largest issue against the largest expected shift.
  let top = false
  if (load.scored.length > 0 && expected.shifts.length > 0) {
    const topIssueIndex = load.scored.reduce((best, issue, index) => (issue.value > (load.scored[best]?.value ?? 0) ? index : best), 0)
    const topExpectedIndex = expected.shifts.reduce((best, shift, index) => (medianOf(shift.measuredValues) > medianOf(expected.shifts[best]?.measuredValues) ? index : best), 0)
    const issue = load.scored[topIssueIndex]
    const want = expected.shifts[topExpectedIndex]
    top =
      issue !== undefined &&
      want !== undefined &&
      load.culpritIs[topIssueIndex]?.[topExpectedIndex] === true &&
      issue.cause === want.cause &&
      issue.confidence >= CONFIDENT &&
      issue.geometricMatch
  }
  return { strict: shifts.every((shift) => shift.ok) && extra === 0, top, shifts, scoredIssues: load.scored.length, extra }
}

/** A negative page fails when anything is scored, or any issue names a culprit at or above the confidence threshold. */
export function negativeProblems(expected: Expected, load: MeasuredLoad): string[] {
  const problems: string[] = []
  const confident = load.report.issues.filter((issue) => issue.culprit !== undefined && issue.confidence >= CONFIDENT)
  if (confident.length > 0) problems.push(`culprit at confidence >= ${CONFIDENT}: ${confident.map((issue) => `${issue.cause} ${issue.culprit?.node.selector} @${issue.confidence}`).join(', ')}`)
  if (load.scored.length > 0) problems.push(`${load.scored.length} scored issue(s): ${load.scored.map((issue) => `${issue.cause}@${issue.confidence}`).join(', ')}`)
  if ((load.report.cls ?? 0) !== 0) problems.push(`CLS ${load.report.cls}`)
  const excused = load.report.issues.filter((issue) => issue.excluded === 'recent-input').length
  if (excused < (expected.minEntriesWithRecentInput ?? 0)) problems.push(`expected at least ${expected.minEntriesWithRecentInput} entry excused for recent input, saw ${excused}`)
  return problems
}

/** `cause:#culprit@confidence` with a `G` for a geometric match; the short form used in the tables. */
export function issueLabel(issue: ShiftIssue): string {
  return `${issue.cause}:${issue.culprit?.node.selector ?? '-'}@${issue.confidence.toFixed(2)}${issue.geometricMatch ? 'G' : ''}`
}
