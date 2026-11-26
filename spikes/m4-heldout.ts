/**
 * M4 acceptance: layout-shift attribution on HELD-OUT pages.
 *
 * The pages in fixtures/cls-heldout were written by someone who had not seen the attribution
 * code, after it was finished, as realistic templates with decoys. This script only measures:
 * each page is loaded through primp with the real dock, the report the product would show is
 * compared with the page's answer key, and the totals are printed. The answer key is read here
 * and nowhere else.
 *
 * If you change the attributor because of what this prints, these pages are no longer held out:
 * say so (see FIRST_RUN at the end of this file) and get new ones.
 *
 *   pnpm spike:m4-heldout      the first set (now a development set)
 *   pnpm spike:m4-heldout2     the second set: the held-out measurement
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SourceLoc } from '../packages/protocol/src/change.ts'
import type { ShiftIssue } from '../packages/protocol/src/shift.ts'
import { startPrimp } from '../packages/server/src/app.ts'
import { createReport, launchBrowser, newPage, onCleanup, runCleanups, sleep, startFixture, TMP_ROOT, waitFor } from './lib/index.ts'

/** Target: the top culprit right on at least this share of positive pages. */
const TARGET = 0.8
const CONFIDENT = 0.7

interface ExpectedShift {
  cause: string
  culpritSelector: string
  acceptableCulpritSelectors?: string[]
  culpritFile: string
  culpritLine: number
  /** `file`: when the line is in another file of the page folder; default `culpritFile`. */
  acceptableCulpritLines?: { line: number; file?: string }[]
  minValue: number
}
interface Expected {
  page: string
  template: string
  positive: boolean
  shifts: ExpectedShift[]
  decoys?: string[]
  /** A selector to click, or a description that contains one in backticks or quotes. */
  interaction?: string | { selector: string; afterMs?: number; key?: string } | null
  notes?: string
}

type Verdict = 'correct' | 'conservative' | 'wrong' | 'missed' | 'clean' | 'accused'

interface Row {
  page: string
  template: string
  positive: boolean
  expected: string
  reported: string
  verdict: Verdict
  source: 'right' | 'wrong' | 'none' | '-'
  detail: string
}

/** `cls-heldout`: the first set, a development set since the fixes that followed its first run. `cls-heldout-2`: the held-out measurement. */
const SET = (process.argv[2] ?? 'cls-heldout') as 'cls-heldout' | 'cls-heldout-2'
const report = createReport(`M4 ${SET}: layout-shift attribution on pages the attributor was not built on`)

function interactionSelector(interaction: Expected['interaction']): { selector: string; afterMs: number; key?: string } | undefined {
  if (interaction === null || interaction === undefined) return undefined
  if (typeof interaction === 'object') return { selector: interaction.selector, afterMs: interaction.afterMs ?? 800, ...(interaction.key === undefined ? {} : { key: interaction.key }) }
  const quoted = /[`'"]([#.[][^`'"]+)[`'"]/.exec(interaction)?.[1] ?? /(#[\w-]+|\.[\w-]+(?:\s*[> ]\s*[\w.#-]+)*)/.exec(interaction)?.[1]
  return quoted === undefined ? undefined : { selector: quoted, afterMs: 800 }
}

try {
  const fixture = await startFixture(SET)
  const sessionDir = join(TMP_ROOT, `${SET}-sessions-${process.pid}`)
  const primp = await startPrimp({ projectRoot: fixture.dir, target: fixture.port, handleSignals: false, sessionDir })
  onCleanup(() => primp.close())
  const browser = await launchBrowser()
  const { page } = await newPage(browser, { viewport: { width: 1280, height: 800 } })

  const pages = readdirSync(fixture.dir)
    .filter((name) => existsSync(join(fixture.dir, name, 'expected.json')))
    .sort()
    .map((name) => ({ name, expected: JSON.parse(readFileSync(join(fixture.dir, name, 'expected.json'), 'utf8')) as Expected }))

  const rows: Row[] = []
  for (const { name, expected } of pages) {
    const interaction = interactionSelector(expected.interaction)
    const before = primp.session.shifts()?.at ?? 0
    await page.goto(`${primp.url}/${name}/`)
    if (interaction !== undefined) {
      await sleep(interaction.afterMs)
      // A trusted input event, as a person would make it: the browser then marks the shift as caused by input.
      if (interaction.key === undefined) await page.click(interaction.selector, { timeout: 5000 }).catch(() => undefined)
      else await page.press(interaction.selector, interaction.key, { timeout: 5000 }).catch(() => undefined)
    }
    const reported = await waitFor(() => (primp.session.shifts()?.at ?? 0) > before && primp.session.shifts()?.recording.url.includes(`/${name}/`), { what: `the shift report of ${name}`, timeoutMs: 25_000 }).then(
      () => true,
      () => false,
    )
    // The dock reports again when later entries arrive: let it finish.
    await sleep(1500)
    const latest = reported ? primp.session.shifts() : undefined
    const base = { page: name, template: expected.template, positive: expected.positive }
    if (latest === undefined || latest.report.status !== 'ok') {
      rows.push({ ...base, expected: expected.positive ? (expected.shifts[0]?.cause ?? '?') : 'no accusation', reported: latest === undefined ? 'no report' : latest.report.status, verdict: expected.positive ? 'missed' : 'clean', source: '-', detail: 'the page was not measured' })
      continue
    }
    const scored = latest.report.issues.filter((issue) => issue.scored).sort((a, b) => b.value - a.value)
    const describe = (issue: ShiftIssue): string => `${issue.cause}:${issue.culprit?.node.selector ?? '-'}@${issue.confidence.toFixed(2)}${issue.geometricMatch ? 'G' : ''} (${issue.value.toFixed(3)})`

    if (!expected.positive) {
      const accused = scored.filter((issue) => issue.confidence >= CONFIDENT && issue.culprit !== undefined)
      rows.push({ ...base, expected: 'no accusation', reported: scored.map(describe).join(' + ') || 'nothing scored', verdict: accused.length > 0 ? 'accused' : 'clean', source: '-', detail: `CLS ${latest.report.cls?.toFixed(3)}; excluded: ${latest.report.issues.filter((issue) => !issue.scored).map((issue) => issue.excluded ?? 'unscored').join(', ') || 'none'}` })
      continue
    }

    const want = expected.shifts[0] as ExpectedShift
    const top = scored[0]
    if (top === undefined) {
      rows.push({ ...base, expected: `${want.cause}:${want.culpritSelector}`, reported: 'nothing scored', verdict: 'missed', source: '-', detail: `CLS ${latest.report.cls?.toFixed(3)}; ${latest.report.issues.length} unscored issue(s)` })
      continue
    }
    const acceptable = [want.culpritSelector, ...(want.acceptableCulpritSelectors ?? [])]
    // Same element, whatever the two selectors look like.
    const culpritMatches =
      top.culprit === undefined
        ? false
        : await page.evaluate(
            ([reportedSelector, candidates]) => {
              let element: Element | null = null
              try {
                element = document.querySelector(reportedSelector as string)
              } catch {
                return false
              }
              if (element === null) return false
              return (candidates as string[]).some((selector) => {
                try {
                  return [...document.querySelectorAll(selector)].includes(element as Element)
                } catch {
                  return false
                }
              })
            },
            [top.culprit.node.selector, acceptable] as const,
          )
    const confident = top.confidence >= CONFIDENT && top.culprit !== undefined && top.cause !== 'unknown'
    const right = top.cause === want.cause && culpritMatches
    const verdict: Verdict = confident ? (right ? 'correct' : 'wrong') : 'conservative'
    const sourceLoc: SourceLoc | undefined = latest.culpritSources[top.id]
    const places = [{ file: want.culpritFile, line: want.culpritLine }, ...(want.acceptableCulpritLines ?? []).map((entry) => ({ file: entry.file === undefined ? want.culpritFile : `${name}/${entry.file.replace(`${name}/`, '')}`, line: entry.line }))]
    const source: Row['source'] = sourceLoc?.file === undefined ? 'none' : places.some((place) => place.file === sourceLoc.file && place.line === sourceLoc.line) ? 'right' : 'wrong'
    rows.push({
      ...base,
      expected: `${want.cause}:${want.culpritSelector}`,
      reported: describe(top) + (scored.length > 1 ? ` + ${scored.length - 1} more` : ''),
      verdict,
      source,
      detail: `${right ? 'its answer is right' : `cause ${top.cause === want.cause ? 'right' : 'wrong'}, culprit ${culpritMatches ? 'right' : 'wrong'}`}; source ${sourceLoc?.file ?? '-'}:${sourceLoc?.line ?? '-'} (${sourceLoc?.level ?? '-'}), expected ${want.culpritFile}:${want.culpritLine}`,
    })
  }

  report.section('Per page')
  for (const row of rows) report.info(`${row.verdict.toUpperCase().padEnd(12)} ${row.page.padEnd(30)} expected ${row.expected}\n${' '.repeat(13)}reported ${row.reported}\n${' '.repeat(13)}${row.detail}`)

  const positives = rows.filter((row) => row.positive)
  const negatives = rows.filter((row) => !row.positive)
  const count = (verdict: Verdict): number => rows.filter((row) => row.verdict === verdict).length
  const correct = count('correct')
  const sourced = positives.filter((row) => row.verdict === 'correct')
  report.section('Totals')
  report.info(
    `${positives.length} positive pages: ${correct} correct, ${count('conservative')} conservative (no confident claim), ${count('wrong')} wrong (a confident wrong claim), ${count('missed')} missed. ` +
      `${negatives.length} negative pages: ${count('clean')} clean, ${count('accused')} accused. ` +
      `Source line of the culprit, where the attribution was correct: ${sourced.filter((row) => row.source === 'right').length} right, ${sourced.filter((row) => row.source === 'wrong').length} wrong, ${sourced.filter((row) => row.source === 'none').length} unresolved of ${sourced.length}.`,
  )
  report.check('the set is the size it was written to be (at least 10 positive and 4 negative pages)', positives.length >= 10 && negatives.length >= 4, `${positives.length} positive, ${negatives.length} negative`)
  report.check(`the top culprit and cause are right, with confidence, on at least ${TARGET * 100}% of positive pages`, positives.length > 0 && correct / positives.length >= TARGET, `${correct} of ${positives.length} (${((correct / Math.max(1, positives.length)) * 100).toFixed(0)}%)`)
  report.check('no confident wrong claim on a positive page', count('wrong') === 0, rows.filter((row) => row.verdict === 'wrong').map((row) => `${row.page}: ${row.reported}`).join(' | ') || 'none')
  report.check('no negative page is accused with confidence', count('accused') === 0, rows.filter((row) => row.verdict === 'accused').map((row) => `${row.page}: ${row.reported}`).join(' | ') || 'none')
} catch (error) {
  report.check('spike ran to completion', false, error instanceof Error ? (error.stack ?? error.message) : String(error))
} finally {
  await runCleanups()
  report.finish()
}

/**
 * FIRST_RUN: the result of the first run of this script against the pages, before anything was
 * changed because of it. Filled in by hand when the pages arrive; later runs can be compared with it.
 */
export const FIRST_RUN =
  'First run, 2026-11-21, attributor as built against fixtures/cls-corpus only: 11 positive pages: 5 correct, 5 conservative, 0 wrong, 1 missed (45% correct; target 80%). ' +
  '5 negative pages: 5 clean, 0 accused. Source line right on 5 of the 5 correct ones. ' +
  'Not correct: pricing-ledgerly (missed: the inserted strip was classified dev-artifact because primp\'s own DOM wrapper is a frame of the insertion stack); ' +
  'product-tidewell, recipe-saltwater-kitchen, shop-grid-fernhill (unknown, no culprit: victims pushed out of the viewport have an empty current rect, which was read as movement up and left); ' +
  'dashboard-orderdesk, docs-quillstack (culprit right, cause unknown: a web font used by text inside the element that grew was not linked to it). ' +
  'The attributor was changed for these three defects afterwards, so this set is a development set from then on; fixtures/cls-heldout-2 is the held-out measurement.'

/**
 * HELD_OUT_RESULT: the one run of the second set (fixtures/cls-heldout-2), 2026-11-21, on the code
 * that contains the three fixes above and nothing made with knowledge of these pages.
 */
export const HELD_OUT_RESULT =
  '10 positive pages: 7 correct with confidence (70%; the target is 80%, so the check fails), 3 conservative, 0 wrong, 0 missed. ' +
  '4 negative pages: 4 clean, 0 accused. Source line right on 7 of the 7 correct ones. ' +
  'Conservative: event-tidepool (right element, cause unknown: the font comes from a separate stylesheet), help-brightdesk (nothing named: a font added with the FontFace API, a 0.007 shift), ' +
  'course-aldermoor (an image in a table cell: a header cell was named at 0.60, below the confidence line). ' +
  'Fixing these would make this set a development set too; a new one would then be needed for the next measurement.'
