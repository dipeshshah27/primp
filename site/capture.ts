/**
 * Screenshots and facts for the website, taken from the real product: `primp demo`'s site served
 * by its own demo server, primp started in front of it (as spikes/agent-check.ts does), headless
 * Chromium driving the dock through `window.__primp_test`, and primp's MCP tools called over
 * stdio, as an agent would.
 *
 * The "agent" here is this script: it edits the demo copy's css/site.css the way the shots need
 * (one change implemented correctly, one by editing a shared rule in place, which primp must
 * fail because another button changed with it; a note it leaves alone, which primp reports as
 * not_checkable). Everything primp reports is its own.
 *
 * Writes into site/public/shots/ (JPEG at 1.5x of a 1280x800 viewport unless noted):
 *   tray-{light,dark}       the dock open with the Changes panel: numbered pins, recorded changes
 *   edit-{light,dark}       the inspector next to the selected button
 *   shifts-{light,dark}     the Layout shifts panel with the seeded shift shown on the page
 *   verify-{light,dark}     the Verification panel after the "agent" edited the source
 *   step-edit-*, step-verify-*   the dock alone (popover and toolbar), cropped from edit and verify
 *   hover-light             a :hover edit previewed with the state held
 *   resize-light            a resize handle drag in progress
 *   facts.json              the strings the site quotes (summaries, hints, the shift, the change)
 *   prompt.txt              the prompt Send produced
 *
 *   pnpm site:capture                    (at the repository root; then rebuild the site)
 *   pnpm site:capture --out .tmp/shots   (a dry run into another directory)
 */

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
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
/** `--out <dir>`: write somewhere else (a dry run that leaves the site's shots alone). */
const outAt = process.argv.indexOf('--out')
const OUT = outAt < 0 ? join(HERE, 'public/shots') : resolve(process.argv[outAt + 1] ?? '.tmp/site-capture-out')
const WORK = join(TMP_ROOT, `site-capture-${process.pid}`)
const SITE = join(WORK, 'primp-demo')
const SESSIONS = join(WORK, 'sessions')
const CLI = join(REPO_ROOT, 'packages/cli/src/index.ts')
const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
const VIEWPORT = { width: 1280, height: 800 }
/** Screenshots are taken at 1.5 times the CSS size and kept as JPEG (each stays under ~300 kB). */
const SCALE = 1.5
const QUALITY = 84

/** The demo site's elements this script works on (packages/cli/demo-site/index.html). */
const PRIMARY_BUTTON = '.btn-primary'
const HEADLINE = '.hero-title'
const LEDE = '.hero-lede'
const CARD = '#features .feature-grid > li.feature:nth-child(1)'

type Dock = <M extends keyof PrimpTestHandle>(method: M, ...args: Parameters<PrimpTestHandle[M]>) => Promise<Awaited<ReturnType<PrimpTestHandle[M]>>>
type Box = { x: number; y: number; width: number; height: number }

function dockOf(page: Page): Dock {
  return ((method: string, ...args: unknown[]) =>
    page.evaluate(([name, values]) => (window as unknown as { __primp_test: Record<string, (...a: unknown[]) => unknown> }).__primp_test[name as string]?.(...(values as unknown[])), [method, args] as const)) as Dock
}

/** Clicks the first button whose text is `text` in any of the dock's frames. */
async function clickInDock(page: Page, text: string): Promise<boolean> {
  return page.evaluate((label) => {
    const frames = [...(document.querySelector('primp-root')?.shadowRoot?.querySelectorAll('iframe') ?? [])]
    for (const frame of frames) {
      const button = [...(frame.contentDocument?.querySelectorAll('button') ?? [])].find((candidate) => candidate.textContent?.trim() === label)
      if (button !== undefined) {
        button.click()
        return true
      }
    }
    return false
  }, text)
}

async function shoot(page: Page, name: string, clip?: Box): Promise<void> {
  const path = join(OUT, `${name}.jpg`)
  await sleep(450)
  await page.screenshot({ path, type: 'jpeg', quality: QUALITY, ...(clip === undefined ? {} : { clip }) })
  console.log(`  ${name}.jpg  ${(statSync(path).size / 1024).toFixed(0)} kB`)
}

/** The dock's popover and toolbar together, with a margin. */
async function dockClip(dock: Dock, margin = 14): Promise<Box> {
  const { bar, pop } = await dock('geometry')
  const boxes = [bar, ...(pop === null ? [] : [pop])]
  const left = Math.max(0, Math.min(...boxes.map((box) => box.x)) - margin)
  const top = Math.max(0, Math.min(...boxes.map((box) => box.y)) - margin)
  const right = Math.min(VIEWPORT.width, Math.max(...boxes.map((box) => box.x + box.width)) + margin)
  const bottom = Math.min(VIEWPORT.height, Math.max(...boxes.map((box) => box.y + box.height)) + margin)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** Light, then dark: the dock (theme "auto") and the demo site both follow the colour scheme. */
async function both(page: Page, name: string, clip?: () => Promise<Box>): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await sleep(250)
    await shoot(page, `${name}-${scheme}`, clip === undefined ? undefined : await clip())
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

const facts: Record<string, unknown> = { capturedAt: new Date().toISOString().slice(0, 10), dock: 'toolbar' }

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
  const { page } = await newPage(browser, { viewport: VIEWPORT, context: { deviceScaleFactor: SCALE } })
  await page.addInitScript(() => {
    ;(globalThis as unknown as { __name: (fn: unknown) => unknown }).__name = (fn) => fn
  })
  const dock = dockOf(page)
  const open = async (): Promise<void> => {
    await page.goto(`${primp.url}/`)
    await page.waitForFunction(() => (window as unknown as { __primp_test?: unknown }).__primp_test !== undefined, undefined, { timeout: 15_000 })
    await dock('ready')
    await dock('open', true)
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
  await dock('panel', 'shifts')
  await sleep(600)
  if (!(await clickInDock(page, 'Show on page'))) console.warn('  (no "Show on page" button in the shifts panel)')
  await sleep(600)
  await both(page, 'shifts')
  // Unpin the culprit outline again, or it stays on the page in the next shots.
  await clickInDock(page, 'Shown on page')
  await dock('panel', null)

  // --- An edit: side effects and a bystander; a second edit; a note -------------
  await dock('select', PRIMARY_BUTTON)
  const padding = await dock('setStyle', 'padding', '14px 26px', { media: null, scope: 'all-instances' })
  if (!padding.ok || padding.item === null) throw new Error(`padding: ${padding.error}`)
  const paddingItem = padding.item as ChangeItem
  await sleep(500)
  facts.edit = {
    id: paddingItem.id,
    label: paddingItem.target.label,
    summary: await dock('summary', paddingItem.id),
    source: `${paddingItem.target.source?.file}:${paddingItem.target.source?.line}`,
    change: paddingItem.kind === 'style' ? { property: paddingItem.property, before: paddingItem.before.authored ?? paddingItem.before.computed, after: paddingItem.after.authored ?? paddingItem.after.computed } : undefined,
    origin: paddingItem.kind === 'style' ? paddingItem.origin : undefined,
    bystanders: paddingItem.kind === 'style' ? (paddingItem.bystanders ?? []).map((entry) => entry.label) : [],
    sideEffects: paddingItem.sideEffects.slice(0, 6),
  }
  await both(page, 'edit')
  await both(page, 'step-edit', () => dockClip(dock))

  await dock('select', HEADLINE)
  const spacing = await dock('setStyle', 'letter-spacing', '-3px', { media: null, scope: 'instance' })
  if (!spacing.ok || spacing.item === null) throw new Error(`letter-spacing: ${spacing.error}`)
  await dock('select', LEDE)
  const note = await dock('addNote', 'Shorten this to one sentence.', { on: 'element' })
  if (!note.ok || note.item === null) throw new Error(`note: ${note.error}`)
  await sleep(500)
  await dock('panel', 'changes')
  await sleep(500)
  await both(page, 'tray')
  const prompt = await dock('send')
  writeFileSync(join(OUT, 'prompt.txt'), prompt)

  // --- The "agent": one change made right, one by editing the shared rule in place, the note left
  const pending = await call<PendingChanges>('get_pending_changes')
  const ids = pending.files.flatMap((group) => group.items).map((item) => item.id)
  const css = join(SITE, 'css/site.css')
  const sheet = readFileSync(css, 'utf8')
  const edited = sheet
    .replace('.btn {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  padding: 12px 20px;', '.btn {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  padding: 14px 26px;')
    .replace('  line-height: 1.02;\n  letter-spacing: -0.04em;\n  text-wrap: balance;', '  line-height: 1.02;\n  letter-spacing: -3px;\n  text-wrap: balance;')
  if (edited === sheet || edited.split('padding: 14px 26px').length !== 2 || !edited.includes('letter-spacing: -3px')) throw new Error('the css patch did not apply')
  writeFileSync(css, edited)
  const verified = await call<VerifyChangesResult>('verify_changes', { ids, waitMs: 2000 })
  facts.verify = {
    summary: verified.summary,
    results: verified.results.map((result) => ({ id: result.itemId, status: result.status, hint: result.hint })),
  }
  await waitFor(async () => (await dock('items')).filter((item) => item.verification !== undefined).length >= 2, { what: 'the dock to show the verdicts', timeoutMs: 10_000 })
  await dock('panel', 'verify')
  await sleep(600)
  await both(page, 'verify')
  await both(page, 'step-verify', () => dockClip(dock))
  writeFileSync(css, sheet)

  // --- States and resize, on a fresh load of the original page ----------------
  await sleep(1500)
  await open()
  await dock('select', PRIMARY_BUTTON)
  await dock('setState', 'hover')
  const hover = await dock('setStyle', 'background-color', '#3b2fd0', { media: null, scope: 'all-instances', state: 'hover' })
  if (!hover.ok) throw new Error(`hover: ${hover.error}`)
  await page.emulateMedia({ colorScheme: 'light' })
  await shoot(page, 'hover-light')

  await dock('setState', null)
  await dock('panel', null)
  await page.evaluate((selector) => document.querySelector(selector)?.scrollIntoView({ block: 'center' }), CARD)
  await sleep(500)
  await dock('select', CARD)
  const grid = await page.evaluate((selector) => {
    const rect = (document.querySelector(selector)?.parentElement as Element).getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  }, CARD)
  const handles = await dock('handles')
  const east = handles.e
  if (east === undefined) throw new Error(`no east handle: ${JSON.stringify(handles)}`)
  await page.mouse.move(east.x + east.width / 2, east.y + east.height / 2)
  await page.mouse.down()
  await page.mouse.move(east.x + east.width / 2 + 60, east.y + east.height / 2, { steps: 8 })
  const top = Math.max(0, grid.y - 90)
  await shoot(page, 'resize-light', { x: Math.max(0, grid.x - 40), y: top, width: Math.min(VIEWPORT.width, grid.width + 80), height: Math.min(VIEWPORT.height - top, grid.height + 160) })
  await page.mouse.up()

  writeFileSync(join(OUT, 'facts.json'), `${JSON.stringify(facts, null, 2)}\n`)
  console.log(JSON.stringify({ ...facts, edit: { ...(facts.edit as object), sideEffects: '...' } }, null, 2))
} catch (error) {
  process.exitCode = 1
  console.error(error)
} finally {
  await runCleanups()
}
