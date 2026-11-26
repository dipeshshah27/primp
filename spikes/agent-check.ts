/**
 * Release gate with a REAL agent: headless Claude Code, given nothing but the sentence the README
 * tells a user to say, on the demo site.
 *
 *   1. "Fix the layout shift primp found, then verify it."
 *   2. (after an edit made in the dock and sent) "Implement the primp changes and verify them."
 *   3. (after a :hover change and a reorder made in the dock and sent) the same sentence again.
 *
 * The agent has primp's MCP tools and Read/Edit/Grep/Glob in the demo directory, and no other
 * instructions. Whether it succeeded is decided here, not by what it says: the page is measured
 * again after it finished.
 *
 * This calls the `claude` CLI three times with your account (model: haiku by default, capped at
 * $1 per call). Set AGENT_MODEL to try another model.
 *
 *   pnpm spike:agent
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PrimpTestHandle } from '../packages/overlay/src/test-handle.ts'
import { prepareDemo, startDemoServer } from '../packages/cli/src/demo.ts'
import { startPrimp } from '../packages/server/src/app.ts'
import { createReport, expect, launchBrowser, newPage, onCleanup, REPO_ROOT, runCleanups, sleep, TMP_ROOT, waitFor } from './lib/index.ts'

const report = createReport('Real agent: headless Claude Code drives primp from the README sentences alone')
const CLAUDE = join(homedir(), '.local', 'bin', 'claude')
const MODEL = process.env.AGENT_MODEL ?? 'haiku'
const WORK = join(TMP_ROOT, `agent-${process.pid}`)
const SITE = join(WORK, 'primp-demo')
const SESSIONS = join(WORK, 'sessions')
const CLI = join(REPO_ROOT, 'packages/cli/src/index.ts')
const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
const TIMEOUT_MS = 300_000
/** Variables of the session this script may be running inside; a child `claude` must not inherit them. */
const PARENT_ENV = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_CHILD_NOTES_DIR', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_PID', 'CLAUDE_EFFORT']
const PRIMP_TOOLS = ['get_session', 'get_pending_changes', 'wait_for_changes', 'verify_changes', 'get_layout_shifts', 'verify_layout_shift', 'dismiss_change'].map((name) => `mcp__primp__${name}`)

interface AgentRun {
  ok: boolean
  seconds: number
  /** Names of the tools it called, in order. */
  tools: string[]
  /** Its last message. */
  answer: string
  cost: number | undefined
  turns: number | undefined
  problem?: string
}

/** One headless Claude Code run in the demo directory. */
async function agent(prompt: string, configPath: string): Promise<AgentRun> {
  const args = [
    '-p', prompt,
    '--mcp-config', configPath,
    '--strict-mcp-config',
    '--allowedTools', [...PRIMP_TOOLS, 'Read', 'Edit', 'Grep', 'Glob'].join(','),
    '--tools', 'ToolSearch,Read,Edit,Grep,Glob',
    '--model', MODEL,
    '--permission-mode', 'dontAsk',
    '--setting-sources', 'project,local',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--max-budget-usd', '1.00',
    '--output-format', 'stream-json',
    '--verbose',
  ]
  const env = { ...process.env }
  for (const key of PARENT_ENV) delete env[key]
  const started = performance.now()
  const child = spawn(CLAUDE, args, { cwd: SITE, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  const kill = (): void => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
  onCleanup(kill)
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    kill()
  }, TIMEOUT_MS)
  const code = await new Promise<number | null>((done) => {
    child.once('error', () => done(null))
    child.once('close', (exit) => done(exit))
  })
  clearTimeout(timer)

  const tools: string[] = []
  let answer = ''
  let cost: number | undefined
  let turns: number | undefined
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue
    let event: { type?: string; message?: { content?: { type?: string; name?: string }[] }; result?: string; total_cost_usd?: number; num_turns?: number; is_error?: boolean }
    try {
      event = JSON.parse(line) as typeof event
    } catch {
      continue
    }
    if (event.type === 'assistant') for (const part of event.message?.content ?? []) if (part.type === 'tool_use' && part.name !== undefined) tools.push(part.name)
    if (event.type === 'result') {
      answer = event.result ?? ''
      cost = event.total_cost_usd
      turns = event.num_turns
    }
  }
  const seconds = (performance.now() - started) / 1000
  const problem = timedOut ? `timed out after ${TIMEOUT_MS / 1000} s` : code !== 0 ? `claude exited with ${code}: ${(stderr || answer || stdout).slice(-400)}` : undefined
  return { ok: problem === undefined, seconds, tools, answer, cost, turns, ...(problem === undefined ? {} : { problem }) }
}

const describeRun = (run: AgentRun): string =>
  `${MODEL}, ${run.seconds.toFixed(0)} s, ${run.turns ?? '?'} turns, $${run.cost?.toFixed(3) ?? '?'}; tools: ${run.tools.map((name) => name.replace('mcp__primp__', '')).join(' > ')}\n        it said: ${run.answer.replace(/\s+/g, ' ').slice(0, 400)}`

try {
  if (!existsSync(CLAUDE)) throw new Error(`the claude CLI is not at ${CLAUDE}`)
  mkdirSync(SESSIONS, { recursive: true })
  onCleanup(() => rmSync(WORK, { recursive: true, force: true }))

  prepareDemo(SITE)
  const server = await startDemoServer(SITE)
  onCleanup(() => server.close())
  const primp = await startPrimp({ projectRoot: SITE, target: server.port, handleSignals: false, sessionDir: SESSIONS })
  onCleanup(() => primp.close())
  const browser = await launchBrowser()
  const { page } = await newPage(browser, { viewport: { width: 1280, height: 800 } })
  const dock = <M extends keyof PrimpTestHandle>(method: M, ...args: Parameters<PrimpTestHandle[M]>): Promise<Awaited<ReturnType<PrimpTestHandle[M]>>> =>
    page.evaluate(([name, values]) => (window as unknown as { __primp_test: Record<string, (...a: unknown[]) => unknown> }).__primp_test[name as string]?.(...(values as unknown[])), [method, args] as const) as Promise<
      Awaited<ReturnType<PrimpTestHandle[M]>>
    >
  /** Loads the page and returns the scored layout shifts of that load, as primp reports them. */
  const loadAndMeasure = async (): Promise<{ status: string; scored: number; cls: number | null }> => {
    const before = primp.session.shifts()?.at ?? 0
    await page.goto(`${primp.url}/`)
    await waitFor(() => (primp.session.shifts()?.at ?? 0) > before, { what: 'the shift report of the load', timeoutMs: 20_000 })
    await sleep(1500)
    const latest = primp.session.shifts()
    return { status: latest?.report.status ?? 'none', scored: latest?.report.issues.filter((issue) => issue.scored).length ?? -1, cls: latest?.report.cls ?? null }
  }

  const configPath = join(WORK, 'mcp.json')
  writeFileSync(configPath, JSON.stringify({ mcpServers: { primp: { type: 'stdio', command: process.execPath, args: ['--import', TSX, CLI, 'mcp'], env: { PRIMP_SESSION_DIR: SESSIONS } } } }, null, 2))

  report.section('1. "Fix the layout shift primp found, then verify it."')
  const before = await loadAndMeasure()
  report.check('the demo page has its seeded layout shift before the agent starts', before.status === 'ok' && before.scored === 1, `status ${before.status}, ${before.scored} scored shift(s), CLS ${before.cls?.toFixed(3)}`)
  const htmlBefore = readFileSync(join(SITE, 'index.html'), 'utf8')
  const first = await agent('Fix the layout shift primp found, then verify it.', configPath)
  report.check('the agent ran to the end', first.ok, first.problem ?? describeRun(first))
  if (first.ok) {
    report.check('it used primp: read the shifts, then asked primp to verify', first.tools.includes('mcp__primp__get_layout_shifts') && first.tools.includes('mcp__primp__verify_layout_shift'), describeRun(first))
    const htmlAfter = readFileSync(join(SITE, 'index.html'), 'utf8')
    const cssAfter = readFileSync(join(SITE, 'css/site.css'), 'utf8')
    report.check('it changed the source', htmlAfter !== htmlBefore || /aspect-ratio/.test(cssAfter), htmlAfter === htmlBefore ? 'css/site.css now has aspect-ratio' : `index.html: ${htmlAfter.split('\n').find((line) => line.includes('id="hero-art"'))?.trim()}`)
    const after = await loadAndMeasure()
    report.check('measured again here, independently of the agent: the shift is gone', after.status === 'ok' && after.scored === 0, `status ${after.status}, ${after.scored} scored shift(s), CLS ${after.cls?.toFixed(3)} (before: ${before.cls?.toFixed(3)})`)
  }

  report.section('2. "Implement the primp changes and verify them."')
  await page.goto(`${primp.url}/`)
  await page.waitForFunction(() => (window as unknown as { __primp_test?: unknown }).__primp_test !== undefined, undefined, { timeout: 15_000 })
  await dock('ready')
  await dock('select', '.btn-primary')
  const padding = await dock('setStyle', 'padding', '14px 26px', { media: null, scope: 'all-instances' })
  await dock('select', '.hero-title')
  const spacing = await dock('setStyle', 'letter-spacing', '-1px', { media: null, scope: 'instance' })
  const prompt = await dock('send')
  const ids = [padding.item?.id, spacing.item?.id].filter((id): id is string => id !== undefined)
  report.check('two edits were made in the dock and sent', padding.ok && spacing.ok && ids.length === 2 && prompt.length > 0, `items ${ids.join(', ')}; prompt ${prompt.length} chars`)
  const second = await agent('Implement the primp changes and verify them.', configPath)
  report.check('the agent ran to the end', second.ok, second.problem ?? describeRun(second))
  if (second.ok) {
    report.check('it used primp: took the changes, then asked primp to verify', second.tools.includes('mcp__primp__get_pending_changes') && second.tools.includes('mcp__primp__verify_changes'), describeRun(second))
    const statuses = ids.map((id) => `${id}: ${primp.session.item(id)?.status} (${primp.session.item(id)?.verification?.status ?? 'not verified'})`)
    report.check('primp verified both changes', ids.every((id) => primp.session.item(id)?.status === 'verified'), statuses.join('; '))
    await page.goto(`${primp.url}/`)
    await sleep(800)
    const measured = await page.evaluate(() => {
      const button = getComputedStyle(document.querySelector('.btn-primary') as Element)
      const title = getComputedStyle(document.querySelector('.hero-title') as Element)
      return { padding: `${button.paddingTop} ${button.paddingRight} ${button.paddingBottom} ${button.paddingLeft}`, spacing: title.letterSpacing }
    })
    report.check('measured again here, independently: the page has the requested values', measured.padding === '14px 26px 14px 26px' && measured.spacing === '-1px', `button padding ${measured.padding}; headline letter-spacing ${measured.spacing}`)
    const others = await page.evaluate(() => getComputedStyle(document.querySelector('.btn:not(.btn-primary)') as Element).paddingTop)
    report.info(`the secondary button's padding-top is ${others} (12px means the agent kept the change to the primary button)`)
  }

  report.section('3. A :hover change and a reorder: "Implement the primp changes and verify them."')
  const featureNames = (): Promise<string[]> => page.evaluate(() => [...document.querySelectorAll('.feature-grid > li h3')].map((element) => element.textContent?.trim() ?? ''))
  /** The primary button's background under a real mouse hover, once it has settled; the pointer is moved off afterwards. */
  const hoveredBackground = async (): Promise<string> => {
    await page.hover('.btn-primary')
    await sleep(400)
    const value = await page.evaluate(() => getComputedStyle(document.querySelector('.btn-primary') as Element).backgroundColor)
    await page.mouse.move(1, 1)
    return value
  }
  await page.goto(`${primp.url}/`)
  await page.waitForFunction(() => (window as unknown as { __primp_test?: unknown }).__primp_test !== undefined, undefined, { timeout: 15_000 })
  await dock('ready')
  const featuresBefore = await featureNames()
  const hoverBefore = await hoveredBackground()
  await dock('select', '.btn-primary')
  const hover = await dock('setStyle', 'background-color', '#525252', { media: null, scope: 'all-instances', state: 'hover' })
  await dock('select', '.feature-grid > li.feature:nth-child(3)')
  const moved = await dock('reorder', 0)
  const thirdPrompt = await dock('send')
  const thirdIds = [hover.item?.id, moved.item?.id].filter((id): id is string => id !== undefined)
  report.check(
    'a :hover change and a reorder were made in the dock and sent',
    hover.ok && hover.item?.kind === 'style' && hover.item.condition.state === 'hover' && moved.ok && moved.item?.kind === 'structure' && moved.item.op === 'reorder' && thirdIds.length === 2 && thirdPrompt.length > 0,
    `items ${thirdIds.join(', ')}; features ${featuresBefore.join(', ')}; hover background before ${hoverBefore}; prompt ${thirdPrompt.length} chars${hover.error === undefined ? '' : `; hover: ${hover.error}`}${moved.error === undefined ? '' : `; move: ${moved.error}`}`,
  )
  const third = await agent('Implement the primp changes and verify them.', configPath)
  report.check('the agent ran to the end', third.ok, third.problem ?? describeRun(third))
  if (third.ok) {
    report.check('it used primp: took the changes, then asked primp to verify', third.tools.includes('mcp__primp__get_pending_changes') && third.tools.includes('mcp__primp__verify_changes'), describeRun(third))
    const statuses = thirdIds.map((id) => `${id}: ${primp.session.item(id)?.status} (${primp.session.item(id)?.verification?.status ?? 'not verified'})`)
    report.check('primp verified both changes', thirdIds.every((id) => primp.session.item(id)?.status === 'verified'), statuses.join('; '))
    // Measured here with a fresh load and a real mouse hover, not with primp's emulation.
    await page.goto(`${primp.url}/`)
    await sleep(800)
    const featuresAfter = await featureNames()
    const hoverAfter = await hoveredBackground()
    const resting = await page.evaluate(() => getComputedStyle(document.querySelector('.btn-primary') as Element).backgroundColor)
    report.check('measured again here, independently: the hover background is rgb(82, 82, 82) under a real mouse hover', hoverAfter === 'rgb(82, 82, 82)', `hover ${hoverBefore} -> ${hoverAfter}; at rest ${resting}`)
    const featuresExpected = [featuresBefore[2], featuresBefore[0], featuresBefore[1], ...featuresBefore.slice(3)]
    report.check('measured again here, independently: the third feature card is now the first', featuresBefore.length === 6 && featuresAfter.join() === featuresExpected.join(), `${featuresBefore.join(', ')} -> ${featuresAfter.join(', ')}`)
    report.info(`the primary button's resting background is ${resting} (rgb(10, 10, 10) means the agent left the resting style alone)`)
  }
} catch (error) {
  report.check('spike ran to completion', false, error instanceof Error ? (error.stack ?? error.message) : String(error))
} finally {
  await runCleanups()
  report.finish()
}
