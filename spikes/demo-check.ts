/**
 * `primp demo`, played through as the README tells it:
 *
 *   primp demo            -> a site appears in ./primp-demo, primp runs in front of it
 *   the page               -> the dock is there; its Layout shifts panel has the seeded jump
 *   agent (MCP)            -> get_layout_shifts names the picture and its line in index.html
 *   agent edits index.html -> verify_layout_shift: pass
 *   an edit in the dock    -> Send, the agent implements it in css/site.css, verify_changes: pass
 *   a reorder and a :hover -> one Send, the agent edits index.html and css/site.css, verify_changes: both pass
 *
 * The CLI is the real one, started as a child process from source.
 *
 *   pnpm spike:demo
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Client, type CallToolResult } from '@modelcontextprotocol/client'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import type { ChangeItem } from '../packages/protocol/src/change.ts'
import type { LayoutShiftsResult, PendingChanges, ShiftVerificationResult, VerifyChangesResult } from '../packages/protocol/src/session.ts'
import type { PrimpTestHandle } from '../packages/overlay/src/test-handle.ts'
import { createReport, expect, launchBrowser, newPage, onCleanup, REPO_ROOT, runCleanups, sleep, TMP_ROOT, waitFor } from './lib/index.ts'

const report = createReport('primp demo: the seeded layout shift, found, fixed and verified')
const WORK = join(TMP_ROOT, `demo-${process.pid}`)
const SITE = join(WORK, 'primp-demo')
const SESSIONS = join(WORK, 'sessions')
const CLI = join(REPO_ROOT, 'packages/cli/src/index.ts')
const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
const ENV = { PRIMP_SESSION_DIR: SESSIONS, NO_COLOR: '1' }
/** The feature cards of the demo page, in source order. */
const FEATURES = ['Checks from 32 regions', 'Alerts that route themselves', 'Traces with every alert', 'Status pages', 'Cron and heartbeats', 'Certificates and domains']

try {
  mkdirSync(SESSIONS, { recursive: true })
  onCleanup(() => rmSync(WORK, { recursive: true, force: true }))

  report.section('Start')
  let output = ''
  const child = spawn(process.execPath, ['--import', TSX, CLI, 'demo', '--dir', SITE, '--no-open'], { cwd: WORK, env: { ...process.env, ...ENV }, stdio: ['ignore', 'pipe', 'pipe'] })
  onCleanup(() => {
    if (child.exitCode === null) child.kill('SIGKILL')
  })
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
  let url = ''
  const started = await report.attempt('primp demo creates the site, starts primp in front of it and prints what to do', async () => {
    await waitFor(() => output.includes('Fix the layout shift primp found'), { what: 'the demo guide', timeoutMs: 30_000 }).catch((error: unknown) => {
      throw new Error(`${String(error)}\n${output}`)
    })
    url = /open\s+(http:\/\/localhost:\d+)/.exec(output)?.[1] ?? ''
    expect(url !== '', `no proxy URL in:\n${output}`)
    expect(existsSync(join(SITE, 'index.html')) && existsSync(join(SITE, 'css/site.css')) && existsSync(join(SITE, 'img/dashboard.svg')), 'the demo site was not copied')
    return `site in ${SITE.replace(REPO_ROOT, '.')}; primp at ${url}; guide printed (${output.split('\n').length} lines)`
  })

  if (started) {
    const browser = await launchBrowser()
    const { page, record } = await newPage(browser, { viewport: { width: 1280, height: 800 } })
    const dock = <M extends keyof PrimpTestHandle>(method: M, ...args: Parameters<PrimpTestHandle[M]>): Promise<Awaited<ReturnType<PrimpTestHandle[M]>>> =>
      page.evaluate(([name, values]) => (window as unknown as { __primp_test: Record<string, (...a: unknown[]) => unknown> }).__primp_test[name as string]?.(...(values as unknown[])), [method, args] as const) as Promise<
        Awaited<ReturnType<PrimpTestHandle[M]>>
      >

    const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', TSX, CLI, 'mcp'], cwd: SITE, env: { ...getDefaultEnvironment(), ...ENV }, stderr: 'pipe' })
    const client = new Client({ name: 'primp-demo-check', version: '0.0.0' })
    onCleanup(() => client.close().catch(() => undefined))
    const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<{ result: T; text: string }> => {
      const answer = (await client.callTool({ name, arguments: args }, { timeout: 120_000 })) as CallToolResult
      const text = (answer.content as { type: string; text?: string }[]).map((part) => part.text ?? '').join('\n')
      expect(answer.isError !== true, `${name} failed: ${text}`)
      return { result: answer.structuredContent as T, text }
    }

    report.section('The seeded layout shift')
    let shiftId: string | undefined
    await report.attempt('the dock reports the jump; get_layout_shifts names the product screenshot, its cause and its line in index.html', async () => {
      await page.goto(`${url}/`)
      await page.waitForFunction(() => (window as unknown as { __primp_test?: unknown }).__primp_test !== undefined, undefined, { timeout: 15_000 })
      await dock('ready')
      await client.connect(transport)
      const shown = await dock('shiftReport')
      expect(shown.report.status === 'ok' && shown.report.issues.some((issue) => issue.scored), `the dock's report: ${shown.report.status}, ${shown.report.issues.length} issues`)
      const { result, text } = await call<LayoutShiftsResult>('get_layout_shifts')
      expect(result.status === 'ok' && result.issues.length === 1, `${result.status}: ${result.message}`)
      const issue = result.issues[0] as LayoutShiftsResult['issues'][number]
      shiftId = issue.id
      const line = readFileSync(join(SITE, 'index.html'), 'utf8').split('\n').findIndex((text) => text.includes('<img id="hero-art"')) + 1
      expect(issue.cause === 'unsized-media' && issue.culprit?.selector === '#hero-art', `cause ${issue.cause}, culprit ${issue.culprit?.selector}`)
      expect(issue.source?.file === 'index.html' && issue.source.line === line, `source ${issue.source?.file}:${issue.source?.line}, the tag is on line ${line}`)
      expect(issue.value > 0.05, `value ${issue.value}`)
      expect(/width|aspect-ratio/.test(text), 'the instructions do not say how to fix it')
      return `${issue.cause} ${issue.value.toFixed(3)} by ${issue.culprit?.selector} at ${issue.source?.file}:${issue.source?.line} (${issue.source?.level}), confidence ${issue.confidence}; page CLS ${result.cls?.toFixed(3)}`
    })
    await report.attempt('the agent reserves the space in index.html; verify_layout_shift passes over three cold reloads', async () => {
      expect(shiftId !== undefined, 'no shift id from the previous check')
      const file = join(SITE, 'index.html')
      const before = readFileSync(file, 'utf8')
      const after = before.replace('<img id="hero-art" class="hero-art"', '<img id="hero-art" class="hero-art" width="1200" height="750" style="height:auto"')
      expect(after !== before, 'the patch did not apply')
      writeFileSync(file, after)
      const { result } = await call<ShiftVerificationResult>('verify_layout_shift', { id: shiftId })
      expect(result.status === 'pass', `${result.status}: ${result.hint}`)
      expect(result.replays.length === 3 && result.replays.every((replay) => replay.cached.length === 0), `replays: ${JSON.stringify(result.replays)}`)
      return result.hint
    })

    report.section('An edit from the dock')
    await report.attempt('button padding changed in the dock, implemented in css/site.css by the agent, verified (the page is reloaded by primp: no hot reload here)', async () => {
      await dock('ready')
      await dock('select', '.btn-primary')
      const edit = await dock('setStyle', 'padding', '14px 26px', { media: null, scope: 'all-instances' })
      expect(edit.ok && edit.item !== null, `the edit was not recorded: ${edit.error ?? 'no item'}`)
      // `.btn` sets the padding of both primary buttons (the change) and of the secondary one, which must be left alone.
      const recorded = edit.item as ChangeItem
      const bystanders = recorded.kind === 'style' ? (recorded.bystanders ?? []) : []
      const origin = recorded.kind === 'style' ? recorded.origin : undefined
      expect(origin?.via === 'rule' && origin.selector === '.btn' && origin.alsoStyles === 1, `origin: ${JSON.stringify(origin)}`)
      expect(bystanders.length === 1 && bystanders[0]!.label.includes('Read the docs'), `bystanders: ${JSON.stringify(bystanders.map((entry) => entry.label))}`)
      const secondary = bystanders[0]!
      expect(secondary.values['padding-top'] === '12px' && secondary.values['padding-left'] === '20px', `the secondary button's recorded padding: ${JSON.stringify(secondary.values)}`)
      const prompt = await dock('send')
      expect(prompt.includes('padding'), 'Send returned no prompt')
      expect(prompt.includes(secondary.label) && prompt.includes('Do not edit the rule in place'), 'the prompt does not name the secondary button as an element to leave alone')
      const pending = (await call<PendingChanges>('get_pending_changes')).result
      const item = pending.files.flatMap((group) => group.items)[0] as ChangeItem | undefined
      expect(item !== undefined && item.target.source?.file === 'index.html', `claimed ${pending.count}; source ${item?.target.source?.file}`)
      const css = join(SITE, 'css/site.css')
      writeFileSync(css, readFileSync(css, 'utf8').replace('.btn-primary {\n', '.btn-primary {\n  padding: 14px 26px;\n'))
      const { result } = await call<VerifyChangesResult>('verify_changes', { ids: [(item as ChangeItem).id], waitMs: 2000 })
      const verdict = result.results[0]
      expect(verdict?.status === 'pass', `${verdict?.status}: ${verdict?.hint}`)
      const kept = verdict?.checks.filter((check) => check.expectation.type === 'unchanged') ?? []
      expect(kept.length === 4 && kept.every((check) => check.status === 'pass' && check.note === undefined), `bystander checks: ${kept.map((check) => `${check.status} ${check.actual}`).join(', ')}`)
      await sleep(300)
      const shown = (await dock('items')).find((candidate) => candidate.id === (item as ChangeItem).id)?.verification?.status
      expect(shown === 'pass', `the dock shows ${shown}`)
      return `${result.summary} ${verdict?.hint}; the dock shows ${shown}; bystander ${secondary.label} (rule .btn also styles ${origin?.alsoStyles} other element) kept its padding in ${kept.length} checks`
    })

    report.section('A reorder and a :hover change from the dock, in one batch')
    await report.attempt('the third feature card moved to the front and a :hover background on the primary button, sent together; the agent edits index.html and css/site.css; both pass after primp reloads the page', async () => {
      const featureNames = (): Promise<string[]> => page.evaluate(() => [...document.querySelectorAll('.feature-grid > li h3')].map((element) => element.textContent?.trim() ?? ''))
      await dock('ready')
      const before = await featureNames()
      expect(before.join() === FEATURES.join(), `the features read ${before.join(', ')}`)
      await dock('select', '.feature-grid > li.feature:nth-child(3)')
      const moved = await dock('reorder', 0)
      expect(moved.ok && moved.item?.kind === 'structure' && moved.item.op === 'reorder', `the move was not recorded: ${moved.error ?? JSON.stringify(moved.item?.kind)}`)
      await dock('select', '.btn-primary')
      const hover = await dock('setStyle', 'background-color', '#525252', { media: null, scope: 'all-instances', state: 'hover' })
      expect(hover.ok && hover.item?.kind === 'style' && hover.item.condition.state === 'hover', `the :hover edit was not recorded: ${hover.error ?? JSON.stringify(hover.item?.kind)}`)
      const prompt = await dock('send')
      expect(prompt.includes('move this element') && prompt.includes('only in the `:hover` state'), 'the prompt does not carry both changes')
      const afterSend = await featureNames()
      expect(afterSend.join() === before.join(), `after Send the page shows ${afterSend.join(', ')}: the reorder preview was not put back`)
      const pending = (await call<PendingChanges>('get_pending_changes')).result
      const claimed = pending.files.flatMap((group) => group.items)
      const ids = [(moved.item as ChangeItem).id, (hover.item as ChangeItem).id]
      expect(claimed.length === 2 && ids.every((id) => claimed.some((item) => item.id === id && item.status === 'claimed')), `claimed: ${claimed.map((item) => `${item.id} ${item.status}`).join(', ')}`)
      // The "agent": the third <li class="feature"> block goes before the first; a :hover rule for the primary button.
      const html = join(SITE, 'index.html')
      const source = readFileSync(html, 'utf8')
      const blocks = [...source.matchAll(/ {10}<li class="feature">\n[\s\S]*?<\/li>\n/g)].map((match) => match[0])
      expect(blocks.length === 6 && blocks[2]!.includes(FEATURES[2]!), `found ${blocks.length} feature blocks in index.html`)
      const reordered = source.replace(`${blocks[0]}${blocks[1]}${blocks[2]}`, `${blocks[2]}${blocks[0]}${blocks[1]}`)
      expect(reordered !== source, 'the reorder patch did not apply')
      writeFileSync(html, reordered)
      const css = join(SITE, 'css/site.css')
      const sheet = readFileSync(css, 'utf8')
      // After the page's own `.btn-primary:hover` rule, so this one wins.
      const withHover = sheet.replace('.hero-art {', '.btn-primary:hover {\n  background: #525252;\n}\n\n.hero-art {')
      expect(withHover !== sheet, 'the :hover patch did not apply')
      writeFileSync(css, withHover)
      const { result } = await call<VerifyChangesResult>('verify_changes', { ids, waitMs: 2000 })
      const statuses = result.results.map((verdict) => `${verdict.itemId === ids[0] ? 'reorder' : ':hover'} ${verdict.status}: ${verdict.hint}`)
      expect(result.results.length === 2 && result.results.every((verdict) => verdict.status === 'pass'), statuses.join(' | '))
      const after = await featureNames()
      const expected = [FEATURES[2], FEATURES[0], FEATURES[1], ...FEATURES.slice(3)]
      expect(after.join() === expected.join(), `the page shows ${after.join(', ')}`)
      await page.hover('.btn-primary')
      await waitFor(async () => (await page.evaluate(() => getComputedStyle(document.querySelector('.btn-primary') as Element).backgroundColor)) === 'rgb(82, 82, 82)', { what: 'the hover background under a real mouse hover', timeoutMs: 3000 })
      await page.mouse.move(1, 1)
      return `${result.summary}\n        ${statuses.join('\n        ')}\n        in the page: ${after.join(', ')}; real hover on the primary button rgb(82, 82, 82)`
    })

    report.section('Stop')
    await report.attempt('Ctrl+C stops primp and the demo server; the site with the fixes stays', async () => {
      await client.close()
      child.kill('SIGINT')
      await waitFor(() => child.exitCode !== null || child.signalCode !== null, { what: 'the CLI to exit', timeoutMs: 10_000 })
      expect(readdirSync(SESSIONS).length === 0, 'a session file was left behind')
      const html = readFileSync(join(SITE, 'index.html'), 'utf8')
      expect(html.includes('width="1200"'), 'the fixed index.html is gone')
      const errors = record.consoleErrors().map((entry) => entry.text)
      return `exit code ${child.exitCode}; console errors during the demo: ${errors.length}`
    })
  }
} catch (error) {
  report.check('spike ran to completion', false, error instanceof Error ? (error.stack ?? error.message) : String(error))
} finally {
  await runCleanups()
  report.finish()
}
