/**
 * Screenshots for the landing page, taken from the real product: `primp demo`'s site served by
 * its own demo server, primp started in front of it (as spikes/agent-check.ts does), headless
 * Chromium driving the dock through `window.__primp_test`, and primp's MCP tools called over
 * stdio, as an agent would.
 *
 * The "agent" here is this script: it edits the demo copy's css/site.css the way the shots need
 * (one change implemented correctly, one by editing a shared rule in place, which primp must
 * fail because another button changed with it). Everything primp reports is its own.
 *
 * Writes into site/assets/shots/:
 *   shifts-{light,dark}.jpg   the Shifts tab with the seeded layout shift
 *   edit-{light,dark}.jpg     an edit in the Edits tab: the selected button and its rules
 *   tray-{light,dark}.jpg     the recorded changes, with what else moved and the bystander
 *   step-edit-*, step-verify-*   the dock alone, cropped from the tray and verify shots
 *   verify-{light,dark}.jpg   the Verify tab after the "agent" edited the source: one pass, one fail
 *   hover-light.jpg           a :hover edit previewed with the state held
 *   resize-light.jpg          a resize handle drag in progress
 *   facts.json                the strings the landing page quotes (summaries, hints, the shift)
 *   prompt.txt                the prompt Send produced
 *
 *   pnpm exec tsx site/capture.ts
 */

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Client, type CallToolResult } from '@modelcontextprotocol/client'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import type { Page } from '@playwright/test'
import type { ChangeItem } from '../packages/protocol/src/change.ts'
import type { LayoutShiftsResult, PendingChanges, VerifyChangesResult } from '../packages/protocol/src/session.ts'
import type { PrimpTestHandle } from '../packages/overlay/src/test-handle.ts'
import { prepareDemo, startDemoServer } from '../packages/cli/src/demo.ts'
import { startPrimp } from '../packages/server/src/app.ts'
import { launchBrowser, newPage, onCleanup, REPO_ROOT, runCleanups, sleep, TMP_ROOT, waitFor } from '../spikes/lib/index.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'assets/shots')
const WORK = join(TMP_ROOT, `site-capture-${process.pid}`)
const SITE = join(WORK, 'primp-demo')
const SESSIONS = join(WORK, 'sessions')
const CLI = join(REPO_ROOT, 'packages/cli/src/index.ts')
const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
/** Screenshots are taken at 1.5 times the CSS size and kept as JPEG (each stays under ~300 kB). */
const SCALE = 1.5
const QUALITY = 84

type Dock = <M extends keyof PrimpTestHandle>(method: M, ...args: Parameters<PrimpTestHandle[M]>) => Promise<Awaited<ReturnType<PrimpTestHandle[M]>>>

function dockOf(page: Page): Dock {
  return ((method: string, ...args: unknown[]) =>
    page.evaluate(([name, values]) => (window as unknown as { __primp_test: Record<string, (...a: unknown[]) => unknown> }).__primp_test[name as string]?.(...(values as unknown[])), [method, args] as const)) as Dock
}

/** Runs `body` with the dock's own document (inside the shadow root of `<primp-root>`). */
async function inDock(page: Page, body: string): Promise<unknown> {
  return page.evaluate((code) => {
    const frame = document.querySelector('primp-root')?.shadowRoot?.querySelector('iframe')
    const doc = frame?.contentDocument
    if (doc == null) throw new Error('the dock frame is not there')
    return new Function('doc', code)(doc)
  }, body)
}

async function shoot(page: Page, name: string, clip?: { x: number; y: number; width: number; height: number }): Promise<void> {
  const path = join(OUT, `${name}.jpg`)
  await sleep(400)
  await page.screenshot({ path, type: 'jpeg', quality: QUALITY, ...(clip === undefined ? {} : { clip }) })
  console.log(`  ${name}.jpg  ${(statSync(path).size / 1024).toFixed(0)} kB`)
}

/** The dock's frame on the page, with a margin. */
async function dockClip(page: Page, margin = 14): Promise<{ x: number; y: number; width: number; height: number }> {
  const rect = await page.evaluate(() => {
    const frame = document.querySelector('primp-root')?.shadowRoot?.querySelector('iframe')
    if (frame == null) throw new Error('the dock frame is not there')
    const box = frame.getBoundingClientRect()
    return { x: box.x, y: box.y, width: box.width, height: box.height }
  })
  const x = Math.max(0, rect.x - margin)
  const y = Math.max(0, rect.y - margin)
  return { x, y, width: Math.min(1280 - x, rect.width + 2 * margin), height: Math.min(800 - y, rect.height + 2 * margin) }
}

/** Light, then dark (the dock follows the colour scheme; the demo site has none of its own). */
async function both(page: Page, name: string, clip?: { x: number; y: number; width: number; height: number }): Promise<void> {
  await page.emulateMedia({ colorScheme: 'light' })
  await shoot(page, `${name}-light`, clip)
  await page.emulateMedia({ colorScheme: 'dark' })
  await shoot(page, `${name}-dark`, clip)
  await page.emulateMedia({ colorScheme: 'light' })
}

const facts: Record<string, unknown> = { capturedAt: new Date().toISOString().slice(0, 10) }

try {
  mkdirSync(SESSIONS, { recursive: true })
  mkdirSync(OUT, { recursive: true })
  onCleanup(() => rmSync(WORK, { recursive: true, force: true }))
  prepareDemo(SITE)
  const server = await startDemoServer(SITE)
  onCleanup(() => server.close())
  const primp = await startPrimp({ projectRoot: SITE, target: server.port, handleSignals: false, sessionDir: SESSIONS })
  onCleanup(() => primp.close())

  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', TSX, CLI, 'mcp'], cwd: SITE, env: { ...getDefaultEnvironment(), PRIMP_SESSION_DIR: SESSIONS }, stderr: 'pipe' })
  const client = new Client({ name: 'primp-site-capture', version: '0.0.0' })
  onCleanup(() => client.close().catch(() => undefined))
  const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const answer = (await client.callTool({ name, arguments: args }, { timeout: 120_000 })) as CallToolResult
    if (answer.isError === true) throw new Error(`${name} failed: ${JSON.stringify(answer.content)}`)
    return answer.structuredContent as T
  }

  const browser = await launchBrowser()
  const { page } = await newPage(browser, { viewport: { width: 1280, height: 800 }, context: { deviceScaleFactor: SCALE } })
  await page.addInitScript(() => {
    ;(globalThis as unknown as { __name: (fn: unknown) => unknown }).__name = (fn) => fn
  })
  const dock = dockOf(page)
  const open = async (): Promise<void> => {
    await page.goto(`${primp.url}/`)
    await page.waitForFunction(() => (window as unknown as { __primp_test?: unknown }).__primp_test !== undefined, undefined, { timeout: 15_000 })
    await dock('ready')
  }

  // --- The seeded layout shift ------------------------------------------------
  await open()
  await client.connect(transport)
  const shifts = await dock('shiftReport')
  const issue = shifts.report.issues.find((candidate) => candidate.scored)
  if (issue === undefined) throw new Error(`no scored shift: ${shifts.report.status}`)
  const listed = await call<LayoutShiftsResult>('get_layout_shifts')
  const tool = listed.issues[0]
  facts.shift = {
    cause: issue.cause,
    value: Number(issue.value.toFixed(3)),
    culprit: issue.culprit?.node.selector,
    confidence: issue.confidence,
    evidence: issue.evidence,
    source: tool?.source == null ? null : `${tool.source.file}:${tool.source.line}`,
    level: tool?.source?.level ?? null,
  }
  dock('openTab', 'shifts')
  await sleep(600)
  await inDock(page, `const button = [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Show on page'); if (!button) throw new Error('no Show on page button'); button.click()`)
  await sleep(600)
  await both(page, 'shifts')
  // Unpin the culprit outline again, or it stays on the page in the next shots.
  await inDock(page, `const button = [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Shown on page'); if (button) button.click()`)

  // --- An edit: side effects and a bystander ---------------------------------
  dock('openTab', 'edits')
  await dock('select', '.btn-primary')
  const padding = await dock('setStyle', 'padding', '14px 26px', { media: null, scope: 'all-instances' })
  if (!padding.ok || padding.item === null) throw new Error(`padding: ${padding.error}`)
  const paddingItem = padding.item as ChangeItem
  await sleep(500)
  facts.edit = {
    label: paddingItem.target.label,
    summary: await dock('summary', paddingItem.id),
    source: `${paddingItem.target.source?.file}:${paddingItem.target.source?.line}`,
    origin: paddingItem.kind === 'style' ? paddingItem.origin : undefined,
    bystanders: paddingItem.kind === 'style' ? (paddingItem.bystanders ?? []).map((entry) => entry.label) : [],
    sideEffects: paddingItem.sideEffects.slice(0, 6),
  }
  await both(page, 'edit')

  await dock('select', '.hero-title')
  const spacing = await dock('setStyle', 'letter-spacing', '-1px', { media: null, scope: 'instance' })
  if (!spacing.ok || spacing.item === null) throw new Error(`letter-spacing: ${spacing.error}`)
  await sleep(500)
  await inDock(page, `const body = doc.querySelector('.body'); body.scrollTop = body.scrollHeight`)
  await both(page, 'tray')
  await both(page, 'step-edit', await dockClip(page))
  const prompt = await dock('send')
  writeFileSync(join(OUT, 'prompt.txt'), prompt)

  // --- The "agent": one change made right, one by editing the shared rule in place
  const pending = await call<PendingChanges>('get_pending_changes')
  const ids = pending.files.flatMap((group) => group.items).map((item) => item.id)
  const css = join(SITE, 'css/site.css')
  const sheet = readFileSync(css, 'utf8')
  const edited = sheet
    .replace('.btn {\n  display: inline-block;\n  padding: 10px 18px;', '.btn {\n  display: inline-block;\n  padding: 14px 26px;')
    .replace('  line-height: 1.1;\n  letter-spacing: -0.02em;', '  line-height: 1.1;\n  letter-spacing: -1px;')
  if (edited === sheet || edited.split('14px 26px').length !== 2 || !edited.includes('letter-spacing: -1px')) throw new Error('the css patch did not apply')
  writeFileSync(css, edited)
  const verified = await call<VerifyChangesResult>('verify_changes', { ids, waitMs: 2000 })
  facts.verify = {
    summary: verified.summary,
    results: verified.results.map((result) => ({ id: result.itemId, status: result.status, hint: result.hint })),
  }
  await waitFor(async () => (await dock('items')).filter((item) => item.verification !== undefined).length >= 2, { what: 'the dock to show both verdicts', timeoutMs: 10_000 })
  dock('openTab', 'verify')
  await sleep(600)
  await both(page, 'verify')
  await both(page, 'step-verify', await dockClip(page))
  writeFileSync(css, sheet)

  // --- States and resize, on a fresh load of the original page ----------------
  await sleep(1500)
  await open()
  dock('openTab', 'edits')
  await dock('select', '.btn-primary')
  await dock('setState', 'hover')
  const hover = await dock('setStyle', 'background-color', '#0a3f44', { media: null, scope: 'all-instances', state: 'hover' })
  if (!hover.ok) throw new Error(`hover: ${hover.error}`)
  await page.emulateMedia({ colorScheme: 'light' })
  await shoot(page, 'hover-light')

  await dock('setState', null)
  await dock('collapse', true)
  await page.evaluate(() => document.querySelector('#beans')?.scrollIntoView({ block: 'start' }))
  await sleep(500)
  await dock('select', '.bean-grid > li.bean:nth-child(1)')
  const grid = await page.evaluate(() => {
    const rect = (document.querySelector('.bean-grid') as Element).getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  })
  const handles = await dock('handles')
  const east = handles.e
  if (east === undefined) throw new Error(`no east handle: ${JSON.stringify(handles)}`)
  await page.mouse.move(east.x + east.width / 2, east.y + east.height / 2)
  await page.mouse.down()
  await page.mouse.move(east.x + east.width / 2 + 60, east.y + east.height / 2, { steps: 8 })
  await shoot(page, 'resize-light', { x: Math.max(0, grid.x - 40), y: Math.max(0, grid.y - 90), width: Math.min(1280, grid.width + 80), height: grid.height + 160 })
  await page.mouse.up()

  writeFileSync(join(OUT, 'facts.json'), `${JSON.stringify(facts, null, 2)}\n`)
  console.log(JSON.stringify(facts, null, 2))
} catch (error) {
  process.exitCode = 1
  console.error(error)
} finally {
  await runCleanups()
}
