/**
 * `reglet demo`, played through as the README tells it:
 *
 *   reglet demo            -> a site appears in ./reglet-demo, reglet runs in front of it
 *   the page               -> the dock is there; the Shifts tab has the seeded jump
 *   agent (MCP)            -> get_layout_shifts names the picture and its line in index.html
 *   agent edits index.html -> verify_layout_shift: pass
 *   an edit in the dock    -> Send, the agent implements it in css/site.css, verify_changes: pass
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
import type { RegletTestHandle } from '../packages/overlay/src/test-handle.ts'
import { createReport, expect, launchBrowser, newPage, onCleanup, REPO_ROOT, runCleanups, sleep, TMP_ROOT, waitFor } from './lib/index.ts'

const report = createReport('reglet demo: the seeded layout shift, found, fixed and verified')
const WORK = join(TMP_ROOT, `demo-${process.pid}`)
const SITE = join(WORK, 'reglet-demo')
const SESSIONS = join(WORK, 'sessions')
const CLI = join(REPO_ROOT, 'packages/cli/src/index.ts')
const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
const ENV = { REGLET_SESSION_DIR: SESSIONS, NO_COLOR: '1' }

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
  const started = await report.attempt('reglet demo creates the site, starts reglet in front of it and prints what to do', async () => {
    await waitFor(() => output.includes('Fix the layout shift reglet found'), { what: 'the demo guide', timeoutMs: 30_000 }).catch((error: unknown) => {
      throw new Error(`${String(error)}\n${output}`)
    })
    url = /open\s+(http:\/\/localhost:\d+)/.exec(output)?.[1] ?? ''
    expect(url !== '', `no proxy URL in:\n${output}`)
    expect(existsSync(join(SITE, 'index.html')) && existsSync(join(SITE, 'css/site.css')) && existsSync(join(SITE, 'img/harbour.svg')), 'the demo site was not copied')
    return `site in ${SITE.replace(REPO_ROOT, '.')}; reglet at ${url}; guide printed (${output.split('\n').length} lines)`
  })

  if (started) {
    const browser = await launchBrowser()
    const { page, record } = await newPage(browser, { viewport: { width: 1280, height: 800 } })
    const dock = <M extends keyof RegletTestHandle>(method: M, ...args: Parameters<RegletTestHandle[M]>): Promise<Awaited<ReturnType<RegletTestHandle[M]>>> =>
      page.evaluate(([name, values]) => (window as unknown as { __reglet_test: Record<string, (...a: unknown[]) => unknown> }).__reglet_test[name as string]?.(...(values as unknown[])), [method, args] as const) as Promise<
        Awaited<ReturnType<RegletTestHandle[M]>>
      >

    const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', TSX, CLI, 'mcp'], cwd: SITE, env: { ...getDefaultEnvironment(), ...ENV }, stderr: 'pipe' })
    const client = new Client({ name: 'reglet-demo-check', version: '0.0.0' })
    onCleanup(() => client.close().catch(() => undefined))
    const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<{ result: T; text: string }> => {
      const answer = (await client.callTool({ name, arguments: args }, { timeout: 120_000 })) as CallToolResult
      const text = (answer.content as { type: string; text?: string }[]).map((part) => part.text ?? '').join('\n')
      expect(answer.isError !== true, `${name} failed: ${text}`)
      return { result: answer.structuredContent as T, text }
    }

    report.section('The seeded layout shift')
    let shiftId: string | undefined
    await report.attempt('the dock reports the jump; get_layout_shifts names the picture, its cause and its line in index.html', async () => {
      await page.goto(`${url}/`)
      await page.waitForFunction(() => (window as unknown as { __reglet_test?: unknown }).__reglet_test !== undefined, undefined, { timeout: 15_000 })
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
      const after = before.replace('<img id="hero-art" class="hero-art"', '<img id="hero-art" class="hero-art" width="1200" height="420" style="height:auto"')
      expect(after !== before, 'the patch did not apply')
      writeFileSync(file, after)
      const { result } = await call<ShiftVerificationResult>('verify_layout_shift', { id: shiftId })
      expect(result.status === 'pass', `${result.status}: ${result.hint}`)
      expect(result.replays.length === 3 && result.replays.every((replay) => replay.cached.length === 0), `replays: ${JSON.stringify(result.replays)}`)
      return result.hint
    })

    report.section('An edit from the dock')
    await report.attempt('button padding changed in the dock, implemented in css/site.css by the agent, verified (the page is reloaded by reglet: no hot reload here)', async () => {
      await dock('ready')
      await dock('select', '.btn-primary')
      const edit = await dock('setStyle', 'padding', '14px 26px', { media: null, scope: 'all-instances' })
      expect(edit.ok && edit.item !== null, `the edit was not recorded: ${edit.error ?? 'no item'}`)
      const prompt = await dock('send')
      expect(prompt.includes('padding'), 'Send returned no prompt')
      const pending = (await call<PendingChanges>('get_pending_changes')).result
      const item = pending.files.flatMap((group) => group.items)[0] as ChangeItem | undefined
      expect(item !== undefined && item.target.source?.file === 'index.html', `claimed ${pending.count}; source ${item?.target.source?.file}`)
      const css = join(SITE, 'css/site.css')
      writeFileSync(css, readFileSync(css, 'utf8').replace('.btn-primary {\n', '.btn-primary {\n  padding: 14px 26px;\n'))
      const { result } = await call<VerifyChangesResult>('verify_changes', { ids: [(item as ChangeItem).id], waitMs: 2000 })
      const verdict = result.results[0]
      expect(verdict?.status === 'pass', `${verdict?.status}: ${verdict?.hint}`)
      await sleep(300)
      const shown = (await dock('items')).find((candidate) => candidate.id === (item as ChangeItem).id)?.verification?.status
      expect(shown === 'pass', `the dock shows ${shown}`)
      return `${result.summary} ${verdict?.hint}; the dock shows ${shown}`
    })

    report.section('Stop')
    await report.attempt('Ctrl+C stops reglet and the demo server; the site with the fixes stays', async () => {
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
