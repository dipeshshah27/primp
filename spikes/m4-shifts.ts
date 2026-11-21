/**
 * M4: layout shifts, end to end.
 *
 *   the page loads through primp        -> the dock reports its layout shifts
 *   agent: get_layout_shifts             -> culprit, cause, source line, instructions
 *   agent: verify_layout_shift (no fix)  -> fail, measured over three cold reloads
 *   tab in the background                -> tab_hidden, never pass
 *   agent patches the source             -> verify_layout_shift: pass
 *   a page that does not shift           -> ok with no issues
 *
 * Everything goes over the real stdio MCP shim and the real dock in headless Chromium.
 *
 *   pnpm spike:m4-shifts
 */

import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Client, type CallToolResult } from '@modelcontextprotocol/client'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import type { Page } from '@playwright/test'
import type { LayoutShiftsResult, ShiftVerificationResult } from '../packages/protocol/src/session.ts'
import { startPrimp } from '../packages/server/src/app.ts'
import { SESSION_DIR_ENV } from '../packages/server/src/session-file.ts'
import { createReport, editFile, expect, launchBrowser, newPage, onCleanup, REPO_ROOT, replaceOnce, runCleanups, sleep, startFixture, TMP_ROOT, waitFor } from './lib/index.ts'
import { launchRawChromium } from './s7-assets/raw-chromium.ts'

const CLI_ENTRY = join(REPO_ROOT, 'packages/cli/src/index.ts')
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
const SESSION_DIR = join(TMP_ROOT, `m4-shifts-sessions-${process.pid}`)
const PAGE = 'unsized-media/img-block'

interface Expected {
  shifts: { cause: string; culpritSelector: string; culpritFile: string; culpritLine: number; minValue: number }[]
}

const report = createReport('M4 layout shifts: report, hand to the agent, verify the fix by cold reloads')

try {
  mkdirSync(SESSION_DIR, { recursive: true })
  onCleanup(() => rmSync(SESSION_DIR, { recursive: true, force: true }))

  const fixture = await startFixture('cls-corpus')
  const expected = JSON.parse(readFileSync(join(fixture.dir, PAGE, 'expected.json'), 'utf8')) as Expected
  const want = expected.shifts[0] as Expected['shifts'][number]
  const primp = await startPrimp({ projectRoot: fixture.dir, target: fixture.port, handleSignals: false, sessionDir: SESSION_DIR })
  onCleanup(() => primp.close())
  const browser = await launchBrowser()
  const { page, record } = await newPage(browser, { viewport: { width: 1280, height: 800 } })

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', TSX_LOADER, CLI_ENTRY, 'mcp'],
    cwd: fixture.dir,
    env: { ...getDefaultEnvironment(), [SESSION_DIR_ENV]: SESSION_DIR },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'primp-spike-m4', version: '0.0.0' })
  onCleanup(() => client.close().catch(() => undefined))
  const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<{ result: T; text: string }> => {
    const answer = (await client.callTool({ name, arguments: args }, { timeout: 120_000 })) as CallToolResult
    const text = (answer.content as { type: string; text?: string }[]).map((part) => part.text ?? '').join('\n')
    expect(answer.isError !== true, `${name} failed: ${text}`)
    return { result: answer.structuredContent as T, text }
  }
  const replays = (result: ShiftVerificationResult): string =>
    result.replays.map((replay) => `#${replay.load} ${replay.status} cls ${replay.cls?.toFixed(3) ?? '-'} remaining ${replay.remaining?.toFixed(3) ?? '-'} cached ${replay.cached.length}`).join('; ')

  /** Loads a corpus page and waits until the dock has reported its shifts for this load. */
  const open = async (target: Page, path: string): Promise<void> => {
    const before = primp.session.shifts()?.at ?? 0
    await target.goto(`${primp.url}/${path}/`)
    await waitFor(() => (primp.session.shifts()?.at ?? 0) > before && primp.session.shifts()?.recording.url.includes(path), { what: `the shift report of ${path}`, timeoutMs: 20_000 })
  }

  report.section('A. The page reports, the agent reads')
  let issueId: string | undefined
  await report.attempt('get_layout_shifts names the image as the culprit, with cause, source line and fix instructions', async () => {
    await client.connect(transport)
    await open(page, PAGE)
    const { result, text } = await call<LayoutShiftsResult>('get_layout_shifts')
    expect(result.status === 'ok', `status ${result.status}: ${result.message}`)
    expect(result.issues.length === 1, `${result.issues.length} issues: ${result.message}`)
    const issue = result.issues[0] as LayoutShiftsResult['issues'][number]
    issueId = issue.id
    expect(issue.cause === want.cause, `cause ${issue.cause}, expected ${want.cause}`)
    expect(issue.culprit?.selector === want.culpritSelector, `culprit ${issue.culprit?.selector}, expected ${want.culpritSelector}`)
    expect(issue.value >= want.minValue, `value ${issue.value} below ${want.minValue}`)
    expect(issue.confidence >= 0.7, `confidence ${issue.confidence}`)
    expect(issue.source?.file === want.culpritFile && issue.source.line === want.culpritLine, `source ${issue.source?.file}:${issue.source?.line}, expected ${want.culpritFile}:${want.culpritLine}`)
    expect(text.includes('verify_layout_shift') && /width|aspect-ratio/.test(text), 'the instructions do not name the verify tool and the fix')
    return `${issue.id}: ${issue.cause} ${issue.value.toFixed(3)} by ${issue.culprit?.label} at ${issue.source?.file}:${issue.source?.line} (${issue.source?.level}), confidence ${issue.confidence}; page CLS ${result.cls?.toFixed(3)}`
  })

  if (issueId !== undefined) {
    const id = issueId
    report.section('B. Before the fix')
    await report.attempt('verify_layout_shift without a fix: fail, the shift is back in each of three cold reloads', async () => {
      const documentsBefore = record.documentRequests.length
      const { result } = await call<ShiftVerificationResult>('verify_layout_shift', { id })
      expect(result.status === 'fail', `status ${result.status}: ${result.hint} [${replays(result)}]`)
      expect(result.replays.length === 3 && result.replays.every((replay) => replay.status === 'ok' && (replay.remaining ?? 0) >= want.minValue), replays(result))
      expect(result.replays.every((replay) => replay.cached.length === 0), `a replay was not cold: ${replays(result)}`)
      expect(record.documentRequests.length - documentsBefore === 3, `the page loaded ${record.documentRequests.length - documentsBefore} times`)
      return `${result.hint} [${replays(result)}]`
    })

    await report.attempt('with the tab really in the background (ordinary Chromium tab strip, not Playwright): tab_hidden, not pass and not fail', async () => {
      // Playwright keeps every page it drives "visible", so this check uses Chromium started as an ordinary
      // browser. Its tab is the only one connected: the Playwright page steps aside for the duration.
      await page.goto('about:blank')
      const raw = await launchRawChromium()
      try {
        const before = primp.session.shifts()?.at ?? 0
        const tab = await raw.open(`${primp.url}/${PAGE}/`)
        await waitFor(() => (primp.session.shifts()?.at ?? 0) > before, { what: 'the shift report of the raw Chromium tab', timeoutMs: 20_000 })
        const front = await raw.evaluate<string>(tab, 'document.visibilityState')
        await raw.open('about:blank')
        await sleep(400)
        const behind = await raw.evaluate<string>(tab, 'document.visibilityState')
        expect(front === 'visible' && behind === 'hidden', `visibilityState in front ${front}, behind ${behind}`)
        const { result } = await call<ShiftVerificationResult>('verify_layout_shift', { id })
        expect(result.status === 'tab_hidden', `status ${result.status}: ${result.hint} [${replays(result)}]`)
        return `${raw.version}; visibilityState ${front} then ${behind}; ${result.hint} [${replays(result)}]`
      } finally {
        await raw.close()
        await open(page, PAGE)
      }
    })

    report.section('C. After the fix')
    await report.attempt('the agent reserves the space (width and height on the img): pass in three cold reloads', async () => {
      editFile(fixture, `${PAGE}/index.html`, replaceOnce('<img id="hero" src=', '<img id="hero" width="1200" height="400" style="max-width:100%;height:auto" src='))
      // The ids of the last listing are still the ones to verify; the agent does not have to list again.
      const { result } = await call<ShiftVerificationResult>('verify_layout_shift', { id })
      expect(result.status === 'pass', `status ${result.status}: ${result.hint} [${replays(result)}]`)
      expect(result.replays.length === 3 && result.replays.every((replay) => (replay.remaining ?? 1) === 0), replays(result))
      const after = await call<LayoutShiftsResult>('get_layout_shifts')
      expect(after.result.status === 'ok' && after.result.issues.length === 0, `after the fix: ${after.result.message}`)
      return `${result.hint} [${replays(result)}]; get_layout_shifts now: ${after.result.message}`
    })
  }

  report.section('D. Pages that must not be accused')
  for (const negative of ['negative/transform-animation', 'negative/reserved-space']) {
    await report.attempt(`${negative}: measured, and no issue`, async () => {
      await open(page, negative)
      const { result } = await call<LayoutShiftsResult>('get_layout_shifts')
      expect(result.status === 'ok', `status ${result.status}`)
      expect(result.issues.length === 0 && result.prompt === '', `${result.issues.length} issues: ${result.issues.map((issue) => `${issue.cause} ${issue.culprit?.label}`).join(', ')}`)
      return result.message
    })
  }

  report.section('E. Another cause')
  await report.attempt('font-swap/heading: cause font-swap with a culprit', async () => {
    await open(page, 'font-swap/heading')
    const { result } = await call<LayoutShiftsResult>('get_layout_shifts')
    expect(result.status === 'ok' && result.issues.length >= 1, result.message)
    const issue = result.issues[0] as LayoutShiftsResult['issues'][number]
    expect(issue.cause === 'font-swap' && issue.culprit !== null, `cause ${issue.cause}, culprit ${issue.culprit?.label}`)
    expect(/size-adjust|font-display|preload/.test(result.prompt), 'the instructions do not give a font fix')
    return `${issue.cause} ${issue.value.toFixed(3)} by ${issue.culprit?.label}; source ${issue.source?.file ?? 'unknown'}:${issue.source?.line ?? '-'}`
  })

  report.section('Hygiene')
  const errors = record.consoleErrors().map((entry) => entry.text)
  report.check('no console errors and no CSP violations in the page', errors.length === 0 && record.cspViolations.length === 0, errors.slice(0, 5).join('\n') || 'none')
} catch (error) {
  report.check('spike ran to completion', false, error instanceof Error ? (error.stack ?? error.message) : String(error))
} finally {
  await runCleanups()
  report.finish()
}
