/**
 * Spike S1: does the proxy work in front of real dev servers?
 *
 *   pnpm spike:s1        exits 0 when every check passes, 1 otherwise
 *
 * For each app fixture (vite-react-19, next-16-turbopack, sveltekit-svelte-5, static-html) a
 * working copy is started on a free port, the proxy from packages/server is put in front of
 * it with one injected head script (spikes/lib/hooks/marker-hook.ts, which sets
 * `window.__primp_hook`), and headless Chromium is driven through `http://localhost:<proxy>`.
 *
 * Checks, by letter (the table at the end is fixture x letter):
 *   a  the page renders (every label of labels.json for that page is in the DOM) and the hook
 *      ran before any other script: first <script> in the HTML, first element of <head>,
 *      `document.scripts.length === 1` when it ran
 *   b  no console error, uncaught error or CSP violation that the same page does not also
 *      produce when loaded straight from the dev server; nothing mentions /__primp/.
 *      Next: the strict nonce policy is still enforced while the hook runs
 *   c  hot reload through the proxy: a source edit changes the DOM without a page load
 *      (a window marker and the hook's timestamp survive, no new document request).
 *      static-html has no live reload: a manual reload shows the edit, with the hook, never a 304
 *   d  the HMR WebSocket goes through the proxy and its frames are parsed
 *   e  streaming is preserved (Next /stream): the chunk with the hook arrives >= 1 s before the end
 *   f  login survives (Next route handler + cookie, SvelteKit form action, Vite cookie)
 *   g  a Next Server Action POST works
 *   h  redirects stay on the proxy origin
 *   i  time to first byte, direct and through the proxy (informational, not a criterion)
 *   x  extras beyond the brief: Next client-side navigation, a 1 MB document, 404 pages
 *   z  the harness cleaned up: dev server gone, working copy removed, checked-in sources untouched
 *
 * Negative controls are part of f, g and h: the same request sent straight to the dev server
 * with the proxy's Origin must be rejected (or name the dev server's port), otherwise the
 * check through the proxy would prove nothing.
 */

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Browser, Page } from '@playwright/test'
import {
  createReport,
  editFile,
  expect,
  FIXTURES_ROOT,
  groupAlive,
  labelsInDom,
  labelsOnPage,
  launchBrowser,
  MARKER_HOOK_ENTRY,
  median,
  newPage,
  percentile,
  rawNavigate,
  rawRequest,
  replaceOnce,
  runCleanups,
  since,
  sleep,
  startFixture,
  startProxy,
  waitFor,
  type CspViolation,
  type FixtureHandle,
  type FixtureName,
  type PageHandle,
  type PageRecord,
  type ProxyHandle,
  type RecordedFrame,
  type PrimpHookMarker,
} from './lib/index.ts'

declare global {
  interface Window {
    __s1_marker?: string
  }
}

const HOOK_SRC = '/__primp/hook.js'
const HOOK_TAG_START = `<script src="${HOOK_SRC}"`
const HMR_TIMEOUT_MS = 20_000
const TTFB_SAMPLES = 20
/** Streaming criterion for Next /stream. */
const STREAM_GAP_MS = 1000
const FORM = 'application/x-www-form-urlencoded'

const report = createReport('S1: the proxy in front of real dev servers')
const ttfbRows: string[] = []
const fixtureSeconds: string[] = []

interface Ctx {
  browser: Browser
  fixture: FixtureHandle
  proxy: ProxyHandle
}

const token = (): string => `s1${randomBytes(4).toString('hex')}`
const ms = (value: number | undefined): string => (value === undefined ? '?' : value.toFixed(1))

// ---------------------------------------------------------------------------------------------
// Small helpers

async function open(ctx: Ctx, url: string): Promise<PageHandle> {
  const handle = await newPage(ctx.browser)
  await handle.page.goto(url, { waitUntil: 'load' })
  return handle
}

/** Waits until nothing new has been recorded for `quietMs`. */
async function quiet(activity: () => number, quietMs = 500, maxMs = 8000): Promise<void> {
  const deadline = Date.now() + maxMs
  let last = activity()
  let stableSince = Date.now()
  while (Date.now() < deadline) {
    await sleep(50)
    const now = activity()
    if (now !== last) {
      last = now
      stableSince = Date.now()
    } else if (Date.now() - stableSince >= quietMs) return
  }
}

const activityOf = (record: PageRecord, proxy?: ProxyHandle) => (): number =>
  record.console.length + record.cspViolations.length + record.responses.length + record.pageErrors.length + (proxy?.frames.length ?? 0)

function readHook(page: Page): Promise<PrimpHookMarker | undefined> {
  return page.evaluate(() => window.__primp_hook)
}

function textOf(page: Page, selector: string): Promise<string> {
  return page.evaluate((sel) => document.querySelector(sel)?.textContent ?? '', selector)
}

function attributeOf(page: Page, selector: string, name: string): Promise<string | null> {
  return page.evaluate(([sel, attr]) => document.querySelector(sel)?.getAttribute(attr) ?? null, [selector, name] as const)
}

/** React has attached its props to the element, so its event handlers work. */
function reactHydrated(page: Page, selector: string): Promise<unknown> {
  return page.waitForFunction(
    (sel) => {
      const element = document.querySelector(sel)
      return element !== null && Object.keys(element).some((key) => key.startsWith('__reactProps$'))
    },
    selector,
    { timeout: 20_000 },
  )
}

/** Makes port numbers, nonces and cache-busting queries comparable between two origins. */
function normalise(text: string): string {
  return text
    .replace(/localhost:\d+/g, 'localhost:PORT')
    .replace(/'nonce-[^']*'/g, "'nonce-X'")
    .replace(/([?&])(v|t)=[\w-]+/g, '$1$2=X')
}

function violationKey(violation: CspViolation): string {
  return normalise(`${violation.effectiveDirective} blocked=${violation.blockedURI} by=${violation.sourceFile} target=<${violation.target}>`)
}

function tally(keys: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1)
  return counts
}

/** Entries of `mine` that `baseline` does not have (as multisets). */
function extra(mine: string[], baseline: string[]): string[] {
  const allowed = tally(baseline)
  const out: string[] = []
  for (const key of mine) {
    const left = allowed.get(key) ?? 0
    if (left > 0) allowed.set(key, left - 1)
    else out.push(key)
  }
  return out
}

function problemsOf(record: PageRecord): { errors: string[]; violations: string[] } {
  return {
    errors: [
      ...record.consoleErrors().map((entry) => normalise(`console.error: ${entry.text}`)),
      ...record.pageErrors.map((error) => normalise(`uncaught: ${error.split('\n', 1)[0] ?? ''}`)),
    ],
    violations: record.cspViolations.map(violationKey),
  }
}

function short(list: string[], limit = 3): string {
  const shown = list.slice(0, limit).map((entry) => (entry.length > 220 ? `${entry.slice(0, 220)}...` : entry))
  return shown.join(' | ') + (list.length > limit ? ` | (+${list.length - limit} more)` : '')
}

function countsText(counts: Record<string, number>): string {
  const parts = Object.entries(counts).map(([name, count]) => `${name} x${count}`)
  return parts.length > 0 ? parts.join(', ') : 'none'
}

// ---------------------------------------------------------------------------------------------
// a: render and injection order

async function checkRender(ctx: Ctx, handle: PageHandle, path: string): Promise<void> {
  const { fixture, proxy } = ctx
  const { page } = handle
  await report.attempt('a  page renders; the hook ran before any other script', async () => {
    // The document as sent, before any script could rearrange it.
    const raw = await rawNavigate(proxy.url + path)
    expect(raw.status === 200, `GET ${path} through the proxy answered ${raw.status}`)
    const html = raw.text
    const tagAt = html.indexOf(HOOK_TAG_START)
    expect(tagAt !== -1, 'the document has no injected hook tag')
    expect(html.indexOf(HOOK_TAG_START, tagAt + 1) === -1, 'the hook tag was injected more than once')
    const firstScript = html.search(/<script\b/i)
    expect(firstScript === tagAt, `the first <script> is at byte ${firstScript}, the hook tag at ${tagAt}`)
    const tag = html.slice(tagAt, html.indexOf('>', tagAt) + 1)
    expect(!/\s(async|defer|type)\b/i.test(tag), `the hook tag is not a plain synchronous script: ${tag}`)
    expect(/<head\b[^>]*>$/i.test(html.slice(0, tagAt)), 'the hook tag does not directly follow <head>')

    const wanted = labelsOnPage(fixture, path).map((entry) => entry.label)
    expect(wanted.length > 0, `labels.json lists nothing for ${path}`)
    let missing: string[] = wanted
    await waitFor(
      async () => {
        const present = new Set(await labelsInDom(page))
        missing = wanted.filter((label) => !present.has(label))
        return missing.length === 0
      },
      { timeoutMs: 15_000, what: 'all labels' },
    ).catch(() => undefined)
    expect(missing.length === 0, `${missing.length} of ${wanted.length} labels are not in the DOM: ${missing.slice(0, 8).join(', ')}`)

    const hook = await readHook(page)
    expect(hook !== undefined, 'window.__primp_hook is not set: the injected script did not run')
    expect(hook.runs === 1, `the hook ran ${hook.runs} times`)
    expect(hook.scriptsAtRun === 1, `document.scripts.length was ${hook.scriptsAtRun} when the hook ran, expected 1`)
    expect(hook.firstInHead, 'the hook was not the first element child of <head> when it ran')
    expect(hook.readyState === 'loading', `document.readyState was "${hook.readyState}" when the hook ran`)
    const after = await page.evaluate(() => ({
      scripts: document.scripts.length,
      firstInHead: document.head.firstElementChild?.getAttribute('src') ?? null,
    }))
    return (
      `${wanted.length}/${wanted.length} labels on ${path}; hook tag is the first <script> (byte ${tagAt}, directly after <head>); ` +
      `at run time: t=${ms(hook.t)} ms, document.scripts.length=1, first element of <head>, readyState=loading, body not yet parsed=${!hook.bodyAtRun}; ` +
      `after load: ${after.scripts} scripts, head.firstElementChild src=${after.firstInHead}`
    )
  })
}

// ---------------------------------------------------------------------------------------------
// b: nothing new on the console

async function checkClean(ctx: Ctx, viaProxy: PageHandle, path: string): Promise<void> {
  const { fixture, proxy } = ctx
  await report.attempt('b  no console error or CSP violation caused by the proxy or the hook', async () => {
    const direct = await open(ctx, fixture.url + path)
    try {
      await Promise.all([quiet(activityOf(direct.record)), quiet(activityOf(viaProxy.record))])
      const base = problemsOf(direct.record)
      const mine = problemsOf(viaProxy.record)
      const newErrors = extra(mine.errors, base.errors)
      const newViolations = extra(mine.violations, base.violations)
      expect(newErrors.length === 0, `${newErrors.length} console/page errors only through the proxy: ${short(newErrors)}`)
      expect(newViolations.length === 0, `${newViolations.length} CSP violations only through the proxy: ${short(newViolations)}`)
      const mentioning = [...mine.errors, ...mine.violations].filter((entry) => entry.includes('__primp'))
      expect(mentioning.length === 0, `problems that mention the injected script: ${short(mentioning)}`)
      const hookResponses = viaProxy.record.responses.filter((entry) => entry.url === proxy.url + HOOK_SRC)
      expect(hookResponses.length === 1 && hookResponses[0]?.status === 200, `hook.js responses: ${JSON.stringify(hookResponses)}`)
      const failed = viaProxy.record.failedRequests.filter((entry) => !direct.record.failedRequests.some((other) => normalise(other.url) === normalise(entry.url)))
      expect(failed.length === 0, `requests that failed only through the proxy: ${JSON.stringify(failed.slice(0, 3))}`)
      const bad = viaProxy.record.responses.filter((entry) => entry.status >= 400)
      const badDirect = direct.record.responses.filter((entry) => entry.status >= 400)
      expect(bad.length <= badDirect.length, `HTTP errors through the proxy: ${JSON.stringify(bad.slice(0, 3))}`)
      const warnings = proxy.logs.filter((entry) => entry.level === 'warn' || entry.level === 'error')
      expect(warnings.length === 0, `the proxy logged: ${short(warnings.map((entry) => entry.message))}`)
      const kinds = countsText(Object.fromEntries(tally(mine.violations.map((key) => key.split(' ', 1)[0] ?? ''))))
      return (
        `through the proxy: ${mine.errors.length} console/page errors, ${mine.violations.length} CSP violations (${kinds}); ` +
        `direct: ${base.errors.length} and ${base.violations.length}; only through the proxy: 0 and 0; ` +
        `hook.js 200; ${viaProxy.record.responses.length} responses, none failed; proxy warnings 0`
      )
    } finally {
      await direct.close()
    }
  })
}

// ---------------------------------------------------------------------------------------------
// b (Next): is the page's Content-Security-Policy still enforced?

type Outcome = 'ran' | 'blocked'

interface CspProbe {
  /** The fixture's own two inline scripts on /csp, as its client component reports them. */
  fixtureNonced: string
  fixtureUnnonced: string
  /** Inline scripts the test adds through DOM APIs, without and with a nonce. */
  domUnnonced: Outcome
  domNonced: Outcome
  /** Inline scripts the test adds through the HTML parser (document.write), without and with a nonce. */
  writtenUnnonced: Outcome
  writtenNonced: Outcome
  /** An `onclick` attribute set and clicked by the test. */
  handler: Outcome
  /** A `javascript:` link clicked by the test. */
  javascriptUrl: Outcome
  hook: PrimpHookMarker | undefined
  /** Effective directives of the script violations reported for the test's own injections, sorted. */
  violations: string[]
  /** Violations on the page whose blocked URI or source file is under /__primp/. */
  fromPrimp: number
}

declare global {
  interface Window {
    __s1_probe?: Record<string, number>
    __s1_late?: string[]
  }
}

/**
 * Loads /csp from `origin` and tries every way a test can add an inline script. The nonce
 * used for the "with nonce" cases is read from the injected hook tag when there is one, so a
 * pass also shows that the hook was given the right nonce.
 */
async function probeCsp(ctx: Ctx, origin: string): Promise<CspProbe> {
  const handle = await newPage(ctx.browser)
  const { page, record } = handle
  try {
    await page.goto(`${origin}/csp`, { waitUntil: 'load' })
    await page.waitForSelector('[data-label="csp-status"][data-ready="true"]', { timeout: 20_000 })
    const fixtureNonced = await textOf(page, '[data-label="csp-status-nonced"]')
    const fixtureUnnonced = await textOf(page, '[data-label="csp-status-unnonced"]')
    const hook = await readHook(page)
    await quiet(activityOf(record))
    const scriptViolations = (): CspViolation[] => record.cspViolations.filter((entry) => entry.effectiveDirective.startsWith('script-src'))
    const before = scriptViolations().length

    await page.evaluate(() => {
      const probe: Record<string, number> = {}
      window.__s1_probe = probe
      const source = document.querySelector<HTMLScriptElement>('script[data-primp]') ?? document.querySelector<HTMLScriptElement>('script[nonce]')
      const plain = document.createElement('script')
      plain.textContent = 'window.__s1_probe.domUnnonced = 1'
      document.head.appendChild(plain)
      const nonced = document.createElement('script')
      nonced.nonce = source?.nonce ?? ''
      nonced.textContent = 'window.__s1_probe.domNonced = 1'
      document.head.appendChild(nonced)
      const button = document.createElement('button')
      button.setAttribute('onclick', 'window.__s1_probe.handler = 1')
      document.body.appendChild(button)
      button.click()
      button.remove()
      const link = document.createElement('a')
      link.href = 'javascript:void(window.__s1_probe.javascriptUrl = 1)'
      document.body.appendChild(link)
      link.click()
      link.remove()
    })
    // The handler and the javascript: URL are reported asynchronously.
    await waitFor(() => scriptViolations().length >= before + 2, { timeoutMs: 5000, what: 'violation reports for the blocked handler and javascript: URL' }).catch(() => undefined)
    await sleep(200)
    const early = scriptViolations().slice(before).map((entry) => entry.effectiveDirective)
    const fromPrimp = record.cspViolations.filter((entry) => `${entry.blockedURI} ${entry.sourceFile}`.includes('__primp')).length

    // Last, because it replaces the document: scripts written through the parser. The
    // document keeps its policy; document.open() drops the listeners, so a new one is added.
    await page.evaluate(() => {
      const source = document.querySelector<HTMLScriptElement>('script[data-primp]') ?? document.querySelector<HTMLScriptElement>('script[nonce]')
      const nonce = source?.nonce ?? ''
      const late: string[] = []
      window.__s1_late = late
      document.open()
      document.addEventListener('securitypolicyviolation', (event) => late.push(event.effectiveDirective))
      document.write(
        '<!doctype html><title>s1</title>' +
          '<script>window.__s1_probe.writtenUnnonced = 1</scr' +
          `ipt><script nonce="${nonce}">window.__s1_probe.writtenNonced = 1</scr` +
          'ipt><p>written</p>',
      )
      document.close()
    })
    await waitFor(() => page.evaluate(() => (window.__s1_late?.length ?? 0) > 0), { timeoutMs: 5000, what: 'the violation report for the written script' }).catch(() => undefined)
    const result = await page.evaluate(() => ({ probe: window.__s1_probe ?? {}, late: window.__s1_late ?? [] }))
    const outcome = (name: string): Outcome => (result.probe[name] === 1 ? 'ran' : 'blocked')
    return {
      fixtureNonced,
      fixtureUnnonced,
      domUnnonced: outcome('domUnnonced'),
      domNonced: outcome('domNonced'),
      writtenUnnonced: outcome('writtenUnnonced'),
      writtenNonced: outcome('writtenNonced'),
      handler: outcome('handler'),
      javascriptUrl: outcome('javascriptUrl'),
      hook,
      violations: [...early, ...result.late].sort(),
      fromPrimp,
    }
  } finally {
    await handle.close()
  }
}

// ---------------------------------------------------------------------------------------------
// c: hot reload

interface HotEdit {
  name: string
  file: string
  search: string
  selector: string
  /** The HMR frame that must reach the browser because of this edit. */
  frame: (frame: RecordedFrame) => boolean
  frameWhat: string
  /** More to verify after the update; returns evidence text. */
  after?: () => Promise<string>
}

/** The HMR socket of this page is open and has gone quiet, so an edit made now is not missed. */
async function hmrReady(ctx: Ctx, handle: PageHandle): Promise<void> {
  await waitFor(() => handle.record.webSockets.length > 0 && ctx.proxy.frames.some((frame) => frame.direction === 'upstream-to-client'), {
    timeoutMs: 15_000,
    what: 'the HMR socket to open through the proxy',
  })
  await quiet(activityOf(handle.record, ctx.proxy), 400)
}

async function checkHotEdit(ctx: Ctx, handle: PageHandle, edit: HotEdit): Promise<void> {
  const { fixture, proxy } = ctx
  const { page, record } = handle
  await report.attempt(edit.name, async () => {
    const marker = token()
    const stamp = token()
    await page.evaluate((value) => {
      window.__s1_marker = value
    }, marker)
    const hookBefore = await readHook(page)
    const documents = record.documentRequests.length
    const loads = record.loads
    const frameMark = proxy.frames.length
    const before = await textOf(page, edit.selector)
    expect(before !== '' && !before.includes(stamp), `${edit.selector} is missing before the edit`)

    const written = editFile(fixture, edit.file, replaceOnce(edit.search, `${edit.search} ${stamp}`))
    await waitFor(async () => (await textOf(page, edit.selector)).includes(stamp), {
      timeoutMs: HMR_TIMEOUT_MS,
      what: `${edit.selector} to show the edited text`,
    })
    const latency = since(written.writtenAt)

    expect((await page.evaluate(() => window.__s1_marker)) === marker, 'the window marker is gone: the page was reloaded')
    const hookAfter = await readHook(page)
    expect(hookAfter !== undefined && hookAfter.t === hookBefore?.t && hookAfter.runs === 1, 'the hook ran again: the page was reloaded')
    expect(record.documentRequests.length === documents, `document requests went ${documents} -> ${record.documentRequests.length}`)
    expect(record.loads === loads, `load events went ${loads} -> ${record.loads}`)
    const frame = await proxy.waitForFrame(edit.frame, { from: frameMark, timeoutMs: 5000, what: edit.frameWhat })
    await quiet(activityOf(record, proxy), 300, 3000)
    const sinceEdit = proxy.frameSummary(frameMark)
    const more = edit.after === undefined ? '' : `; ${await edit.after()}`
    return (
      `${edit.file} edited -> ${edit.selector} updated ${latency} ms after the write; window marker and hook timestamp kept, ` +
      `document requests stayed ${documents}, load events stayed ${loads}; ` +
      `${edit.frameWhat} seen by the proxy ${ms(frame.t - written.writtenAt)} ms after the write ` +
      `(server frames since the edit: ${countsText(sinceEdit.serverTypes)})${more}`
    )
  })
}

// ---------------------------------------------------------------------------------------------
// d: the HMR socket

async function checkSocket(ctx: Ctx, handle: PageHandle, pathPattern: RegExp, requiredServerTypes: string[]): Promise<void> {
  const { fixture, proxy } = ctx
  await report.attempt('d  the HMR WebSocket goes through the proxy and its frames are parsed', async () => {
    const sockets = handle.record.webSockets
    expect(sockets.length > 0, 'the page opened no WebSocket')
    const off = sockets.filter((url) => !url.startsWith(`ws://localhost:${proxy.port}/`))
    expect(off.length === 0, `WebSockets that bypass the proxy: ${off.join(', ')} (dev server is on ${fixture.port})`)
    const summary = proxy.frameSummary()
    expect(summary.tunnels.length > 0, 'the proxy tunnelled no upgrade')
    const browserPaths = new Set(sockets.map((url) => url.replace(/^ws:\/\/[^/]+/, '')))
    const unknown = summary.tunnels.filter((tunnel) => !pathPattern.test(tunnel.path))
    expect(unknown.length === 0, `unexpected tunnel paths: ${unknown.map((tunnel) => tunnel.path).join(', ')}`)
    const matched = summary.tunnels.filter((tunnel) => browserPaths.has(tunnel.path))
    expect(matched.length > 0, `no tunnel has the path and query the browser used (${[...browserPaths].join(', ')})`)
    expect(summary.byDirection['upstream-to-client'] > 0, 'no frame from the dev server was parsed')
    expect(summary.nonJsonText === 0, `${summary.nonJsonText} text frames did not parse as JSON, so the frame parser may be out of step`)
    const missing = requiredServerTypes.filter((type) => (summary.serverTypes[type] ?? 0) === 0)
    expect(missing.length === 0, `server frame types never seen: ${missing.join(', ')}`)
    const binary = proxy.frames.filter((frame) => frame.kind === 'binary')
    const binaryText =
      binary.length === 0
        ? 'binary frames: none'
        : `binary frames: ${binary.length} (${binary.filter((frame) => frame.direction === 'upstream-to-client').length} from the server; sizes ${binary
            .slice(0, 6)
            .map((frame) => frame.bytes)
            .join(', ')}${binary.length > 6 ? ', ...' : ''} bytes)`
    const sample = proxy.frames.find((frame) => frame.direction === 'upstream-to-client' && frame.kind === 'text')
    return (
      `browser socket ${sockets[0]} (proxy port ${proxy.port}, dev server ${fixture.port}); ${summary.tunnels.length} tunnel(s), path ${summary.tunnels[0]?.path}; ` +
      `${summary.total} messages parsed: ${summary.byDirection['upstream-to-client']} from the server, ${summary.byDirection['client-to-upstream']} from the browser; ` +
      `${countsText(summary.byKind as Record<string, number>)}; server JSON types: ${countsText(summary.serverTypes)}; ` +
      `browser JSON types: ${countsText(summary.clientTypes)}; browser JSON events: ${countsText(summary.clientEvents)}; ${binaryText}; ` +
      `first server text frame: ${sample?.text?.slice(0, 100)}`
    )
  })
}

// ---------------------------------------------------------------------------------------------
// i: time to first byte

async function measureTtfb(ctx: Ctx, path: string): Promise<void> {
  const { fixture, proxy } = ctx
  try {
    for (let i = 0; i < 3; i++) {
      await rawNavigate(fixture.url + path)
      await rawNavigate(proxy.url + path)
    }
    const direct: number[] = []
    const via: number[] = []
    for (let i = 0; i < TTFB_SAMPLES; i++) {
      direct.push((await rawNavigate(fixture.url + path)).firstByteMs)
      via.push((await rawNavigate(proxy.url + path)).firstByteMs)
    }
    const line =
      `${fixture.name} ${path}: document TTFB median ${median(direct).toFixed(2)} ms direct, ${median(via).toFixed(2)} ms through the proxy ` +
      `(+${(median(via) - median(direct)).toFixed(2)} ms); p95 ${percentile(direct, 0.95).toFixed(2)} / ${percentile(via, 0.95).toFixed(2)} ms; n=${TTFB_SAMPLES} each, alternating, new connection per request`
    report.info(`i  ${line}`)
    ttfbRows.push(line)
  } catch (error) {
    report.check('i  time to first byte could be measured', false, error instanceof Error ? error.message : String(error))
  }
}

// ---------------------------------------------------------------------------------------------
// Fixture runs

/** Source files the spike edits, per fixture; the checked-in copies must come out unchanged. */
const EDITED: Record<string, string[]> = {
  'vite-react-19': ['src/components/Hero.tsx'],
  'next-16-turbopack': ['components/client/Counter.tsx', 'components/server/StatsPanel.tsx'],
  'sveltekit-svelte-5': ['src/lib/components/Hero.svelte'],
  'static-html': ['index.html'],
}

async function withFixture(name: FixtureName, body: (ctx: Ctx) => Promise<void>, browser: Browser): Promise<void> {
  report.section(name)
  const started = performance.now()
  const checkedIn = (): string => (EDITED[name] ?? []).map((file) => readFileSync(join(FIXTURES_ROOT, name, file), 'utf8')).join('\u0000')
  const sourcesBefore = checkedIn()
  let fixture: FixtureHandle | undefined
  let proxy: ProxyHandle | undefined
  const contextsBefore = browser.contexts().length
  try {
    fixture = await startFixture(name)
    proxy = await startProxy(fixture, { headScripts: [{ name: 'hook.js', entry: MARKER_HOOK_ENTRY }] })
    report.info(`dev server ${fixture.url} (ready in ${fixture.startupMs} ms, working copy ${fixture.dir}); proxy ${proxy.url}`)
    await body({ browser, fixture, proxy })
  } catch (error) {
    const output = fixture?.output().trimEnd().split('\n').slice(-15).join('\n') ?? '(dev server did not start)'
    report.check(
      'all checks of this fixture ran',
      false,
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n--- dev server output ---\n${output}`,
    )
  } finally {
    for (const context of browser.contexts().slice(contextsBefore)) await context.close().catch(() => {})
    await proxy?.close()
    await fixture?.stop()
    if (fixture !== undefined && proxy !== undefined) {
      const refused = async (url: string): Promise<boolean> =>
        fetch(url, { signal: AbortSignal.timeout(2000) }).then(
          () => false,
          () => true,
        )
      const alive = groupAlive(fixture.pid)
      const copyLeft = existsSync(fixture.dir)
      const devClosed = await refused(fixture.url)
      const proxyClosed = await refused(proxy.url)
      const untouched = checkedIn() === sourcesBefore
      report.check(
        'z  cleanup: dev server stopped, ports closed, working copy removed, checked-in sources untouched',
        !alive && !copyLeft && devClosed && proxyClosed && untouched,
        `process group ${fixture.pid} alive=${alive}; ${fixture.url} refused=${devClosed}; ${proxy.url} refused=${proxyClosed}; ` +
          `working copy exists=${copyLeft}; ${(EDITED[name] ?? []).length} edited file(s) byte-identical in fixtures/${name}=${untouched}`,
      )
    }
    fixtureSeconds.push(`${name} ${((performance.now() - started) / 1000).toFixed(1)} s`)
  }
}

/**
 * Stops the dev server and starts it again on the same port, as a developer or an agent does.
 * Must be the last check of a fixture: `ctx.fixture` is stopped afterwards.
 */
async function checkRestart(ctx: Ctx): Promise<void> {
  const { fixture, proxy } = ctx
  await report.attempt('x  dev server restart: 502 page with the hook while down, the open page recovers by itself', async () => {
    const handle = await open(ctx, `${proxy.url}/`)
    const { page, record } = handle
    await hmrReady(ctx, handle)
    const lastTunnel = Math.max(0, ...proxy.frames.map((frame) => frame.tunnelId))
    await fixture.stop()
    const down = await rawNavigate(`${proxy.url}/`)
    expect(down.status === 502, `with the dev server stopped the proxy answered ${down.status}`)
    expect(down.text.includes(HOOK_TAG_START), 'the 502 page has no hook tag')
    const restarted = await startFixture(fixture.name, { port: fixture.port, copyName: `${fixture.name}-restarted` })
    const started = performance.now()
    try {
      const frame = await proxy.waitForFrame((entry) => entry.tunnelId > lastTunnel && entry.direction === 'upstream-to-client' && entry.kind === 'text', {
        timeoutMs: 30_000,
        what: 'a new HMR socket through the proxy after the restart',
      })
      const wanted = labelsOnPage(restarted, '/').map((entry) => entry.label)
      await waitFor(
        async () => {
          const present = new Set(await labelsInDom(page))
          return record.loads >= 2 && wanted.every((label) => present.has(label))
        },
        { timeoutMs: 30_000, what: 'the page to be loaded again with all labels' },
      )
      const recovered = since(started)
      const hook = await readHook(page)
      expect(hook !== undefined && hook.scriptsAtRun === 1 && hook.firstInHead, 'the hook did not run first in the reloaded page')
      const up = await rawNavigate(`${proxy.url}/`)
      expect(up.status === 200, `after the restart the proxy answered ${up.status}`)
      return (
        `stopped: GET / -> 502 with the hook tag; restarted on port ${restarted.port} (ready in ${restarted.startupMs} ms): the open page reloaded itself ` +
        `(${record.loads} loads, ${wanted.length} labels, hook first) ${recovered} ms after the server was ready; new HMR socket ${frame.path}`
      )
    } finally {
      await handle.close()
      await restarted.stop()
    }
  })
}

/** A missing page keeps its status through the proxy and still gets the hook (the dock must work on error pages). */
async function checkNotFound(ctx: Ctx, expectedStatus: number): Promise<void> {
  await report.attempt('x  an unknown path keeps its status and still gets the hook', async () => {
    const direct = await rawNavigate(`${ctx.fixture.url}/s1-no-such-page`)
    const via = await rawNavigate(`${ctx.proxy.url}/s1-no-such-page`)
    expect(direct.status === expectedStatus, `the dev server answered ${direct.status}, expected ${expectedStatus}`)
    expect(via.status === direct.status, `status ${direct.status} became ${via.status}`)
    expect(via.text.includes(HOOK_TAG_START), `the ${via.status} page has no hook tag`)
    return `GET /s1-no-such-page: ${direct.status} direct, ${via.status} through the proxy, hook tag present`
  })
}

async function runVite(ctx: Ctx): Promise<void> {
  const { proxy } = ctx
  const home = await open(ctx, `${proxy.url}/`)
  await checkRender(ctx, home, '/')
  await checkClean(ctx, home, '/')

  await hmrReady(ctx, home)
  await checkHotEdit(ctx, home, {
    name: 'c  hot reload through the proxy (React component)',
    file: 'src/components/Hero.tsx',
    search: 'Ship the layout you meant to ship',
    selector: '[data-label="hero-title"]',
    frame: (frame) => frame.direction === 'upstream-to-client' && frame.jsonType === 'update' && (frame.text ?? '').includes('Hero.tsx'),
    frameWhat: 'Vite "update" frame naming Hero.tsx',
  })
  await checkSocket(ctx, home, /^\/\?token=/, ['connected', 'update'])
  report.notApplicable('e  streaming is preserved', 'the fixture is a client-rendered SPA; its document is one static chunk')

  await report.attempt('f  cookie login state persists across a reload', async () => {
    const { page, context } = home
    const status = '[data-label="session-status"]'
    expect((await attributeOf(page, status, 'data-session')) === 'out', 'the page did not start signed out')
    await page.click('[data-label="login-button"]')
    await waitFor(async () => (await attributeOf(page, status, 'data-session')) === 'in', { what: 'signed-in state' })
    const cookie = (await context.cookies(proxy.url)).find((entry) => entry.name === 'session')
    expect(cookie?.value === 'abc', `cookie "session" is ${JSON.stringify(cookie)}`)
    const response = await page.reload({ waitUntil: 'load' })
    await waitFor(async () => (await attributeOf(page, status, 'data-session')) !== null, { what: 'the page after reload' })
    const after = await attributeOf(page, status, 'data-session')
    expect(after === 'in', `after the reload the session state is "${after}"`)
    const hook = await readHook(page)
    expect(hook !== undefined && hook.firstInHead && hook.scriptsAtRun === 1, 'the hook did not run first after the reload')
    return `clicked sign in -> cookie session=abc on ${cookie?.domain}${cookie?.path}; reload answered ${response?.status()}; still "${await textOf(page, status)}"; hook ran first again`
  })
  report.notApplicable('g  Server Action POST', 'not a Next app')
  report.notApplicable('h  redirects stay on the proxy origin', 'the fixture never redirects (unknown paths get the SPA fallback with 200)')
  await checkNotFound(ctx, 200) // Vite's SPA fallback answers every unknown path with index.html
  await measureTtfb(ctx, '/')
  await checkRestart(ctx)
}

async function runNext(ctx: Ctx): Promise<void> {
  const { browser, fixture, proxy } = ctx
  const home = await open(ctx, `${proxy.url}/`)
  await checkRender(ctx, home, '/')
  await checkClean(ctx, home, '/')

  await report.attempt('b  the strict nonce CSP stays in force while the hook runs', async () => {
    const direct = await rawNavigate(`${fixture.url}/csp`)
    const via = await rawNavigate(`${proxy.url}/csp`)
    const directCsp = String(direct.headers['content-security-policy'] ?? '')
    const viaCsp = String(via.headers['content-security-policy'] ?? '')
    const nonce = /'nonce-([^']+)'/.exec(viaCsp)?.[1]
    expect(nonce !== undefined, `no nonce in the policy through the proxy: ${viaCsp}`)
    const directive = (csp: string, name: string): string =>
      normalise(csp)
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${name} `)) ?? ''
    for (const name of ['default-src', 'script-src', 'style-src', 'object-src', 'base-uri', 'form-action', 'frame-ancestors']) {
      expect(directive(viaCsp, name) === directive(directCsp, name), `${name} changed: "${directive(directCsp, name)}" -> "${directive(viaCsp, name)}"`)
    }
    expect(directive(viaCsp, 'script-src').includes("'strict-dynamic'"), 'script-src lost strict-dynamic')
    expect(via.text.includes(`${HOOK_TAG_START} nonce="${nonce}"`), "the hook tag does not carry the response's nonce")
    const directParts = new Set(normalise(directCsp).split(';').map((part) => part.trim()))
    const added = normalise(viaCsp)
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part !== '' && !directParts.has(part))

    const baseline = await probeCsp(ctx, fixture.url)
    const mine = await probeCsp(ctx, proxy.url)
    expect(mine.fixtureNonced === 'ran', `the fixture's nonced inline script: ${mine.fixtureNonced}`)
    expect(mine.fixtureUnnonced === 'blocked', `the fixture's un-nonced inline script: ${mine.fixtureUnnonced}`)
    expect(mine.hook !== undefined && mine.hook.hasNonce && mine.hook.scriptsAtRun === 1 && mine.hook.firstInHead, `hook on /csp: ${JSON.stringify(mine.hook)}`)
    expect(mine.writtenUnnonced === 'blocked', 'a parser-inserted inline script WITHOUT the nonce ran: the policy is no longer enforced')
    expect(mine.handler === 'blocked', 'an inline event handler ran: the policy is no longer enforced')
    expect(mine.javascriptUrl === 'blocked', 'a javascript: URL ran: the policy is no longer enforced')
    expect(mine.writtenNonced === 'ran', "a parser-inserted inline script with the hook tag's nonce was blocked")
    expect(mine.domNonced === 'ran', "a DOM-created inline script with the hook tag's nonce was blocked")
    const outcomes = (probe: CspProbe): string =>
      `fixture nonced ${probe.fixtureNonced}, fixture un-nonced ${probe.fixtureUnnonced}, written un-nonced ${probe.writtenUnnonced}, written nonced ${probe.writtenNonced}, ` +
      `DOM-created un-nonced ${probe.domUnnonced}, DOM-created nonced ${probe.domNonced}, inline handler ${probe.handler}, javascript: URL ${probe.javascriptUrl}`
    expect(outcomes(mine) === outcomes(baseline), `the policy behaves differently through the proxy.\nproxy:  ${outcomes(mine)}\ndirect: ${outcomes(baseline)}`)
    expect(mine.violations.join(', ') === baseline.violations.join(', '), `script violations differ. proxy: ${mine.violations.join(', ')}; direct: ${baseline.violations.join(', ')}`)
    expect(mine.violations.length === 3, `expected a violation report for each of the 3 blocked injections, got: ${mine.violations.join(', ') || 'none'}`)
    expect(mine.fromPrimp === 0, `${mine.fromPrimp} violations name the injected script`)
    return (
      `policy through the proxy keeps script-src "${directive(viaCsp, 'script-src')}" and style-src "${directive(viaCsp, 'style-src')}" unchanged; ` +
      `added or changed by the proxy: ${added.length > 0 ? added.join('; ') : 'nothing'}; hook tag carries the response's nonce and ran first. ` +
      `In Chromium through the proxy: ${outcomes(mine)}; identical when loaded straight from the dev server. ` +
      `Script violations reported: ${mine.violations.join(', ')}; none names /__primp/. ` +
      `Note: "DOM-created un-nonced ${mine.domUnnonced}" is 'strict-dynamic' at work (Chromium lets a script element created by a running script execute), with and without the proxy`
    )
  })

  // c: one client component and one server component. The counter is bumped first: if either
  // update reloaded the page, the count would be back at 3.
  await reactHydrated(home.page, '[data-label="counter-inc"]')
  await home.page.click('[data-label="counter-inc"]')
  await home.page.click('[data-label="counter-inc"]')
  const counter = (): Promise<string> => textOf(home.page, '[data-label="counter-value"]')
  await waitFor(async () => (await counter()) === '5', { what: 'the counter to reach 5' })
  const counterKept = async (): Promise<string> => {
    const value = await counter()
    expect(value === '5', `the client counter went from 5 to ${value}: component state was lost`)
    return 'client counter state kept (5)'
  }
  await hmrReady(ctx, home)
  await checkHotEdit(ctx, home, {
    name: 'c  hot reload through the proxy (client component)',
    file: 'components/client/Counter.tsx',
    search: '        Reset',
    selector: '[data-label="counter-reset"]',
    frame: (frame) => frame.direction === 'upstream-to-client' && frame.jsonType === 'turbopack-message',
    frameWhat: 'Turbopack "turbopack-message" frame',
    after: counterKept,
  })
  await checkHotEdit(ctx, home, {
    name: 'c  hot reload through the proxy (server component)',
    file: 'components/server/StatsPanel.tsx',
    search: 'Server-rendered stats',
    selector: '[data-label="stats-heading"]',
    frame: (frame) => frame.direction === 'upstream-to-client' && frame.jsonType === 'serverComponentChanges',
    frameWhat: 'Next "serverComponentChanges" frame',
    after: counterKept,
  })
  await checkSocket(ctx, home, /^\/_next\/hmr\?id=/, ['turbopack-connected', 'built', 'turbopack-message', 'serverComponentChanges'])
  await home.close()

  await report.attempt('e  streaming is preserved on /stream', async () => {
    await rawNavigate(`${proxy.url}/stream`) // compiles the route
    // Identity encoding, so the direct body can be searched (the dev server would gzip it).
    const direct = await rawNavigate(`${fixture.url}/stream`, { headers: { 'Accept-Encoding': 'identity' } })
    const via = await rawNavigate(`${proxy.url}/stream`)
    expect(via.status === 200, `/stream answered ${via.status}`)
    const hookAt = via.arrivalOf(HOOK_SRC)
    const fallbackAt = via.arrivalOf('data-label="stream-fallback"')
    const resolvedAt = via.arrivalOf('data-label="stream-resolved"')
    expect(hookAt !== undefined, 'the hook tag is not in the streamed document')
    expect(fallbackAt !== undefined && resolvedAt !== undefined, 'fallback or resolved content missing from the document')
    expect(via.chunks.length >= 2, `the document arrived in ${via.chunks.length} chunk`)
    expect(
      via.endMs - hookAt >= STREAM_GAP_MS,
      `the chunk with the hook arrived at ${ms(hookAt)} ms and the response ended at ${ms(via.endMs)} ms: only ${ms(via.endMs - hookAt)} ms apart`,
    )
    expect(resolvedAt - fallbackAt >= STREAM_GAP_MS, `fallback at ${ms(fallbackAt)} ms, resolved content at ${ms(resolvedAt)} ms`)
    const directFallback = direct.arrivalOf('data-label="stream-fallback"')

    const handle = await newPage(browser)
    const { page } = handle
    const started = performance.now()
    await page.goto(`${proxy.url}/stream`, { waitUntil: 'commit' })
    await page.waitForSelector('[data-label="stream-fallback"]', { state: 'visible', timeout: 15_000 })
    const fallbackSeen = since(started)
    const early = await page.evaluate(() => ({
      resolved: document.querySelector('[data-label="stream-resolved"]') !== null,
      hook: window.__primp_hook !== undefined,
      readyState: document.readyState,
    }))
    expect(early.hook, 'the hook had not run when the fallback was visible')
    expect(!early.resolved, 'the resolved content was already there when the fallback became visible')
    await page.waitForSelector('[data-label="stream-resolved"]', { state: 'visible', timeout: 15_000 })
    const resolvedSeen = since(started)
    expect(resolvedSeen - fallbackSeen >= STREAM_GAP_MS, `browser saw the fallback at ${fallbackSeen} ms and the content at ${resolvedSeen} ms`)
    await handle.close()
    return (
      `raw client through the proxy: headers ${ms(via.headersMs)} ms, first byte ${ms(via.firstByteMs)} ms, chunk with the hook ${ms(hookAt)} ms, ` +
      `fallback ${ms(fallbackAt)} ms, resolved content ${ms(resolvedAt)} ms, end ${ms(via.endMs)} ms, ${via.chunks.length} chunks ` +
      `(hook ${ms(via.endMs - hookAt)} ms before the end; criterion >= ${STREAM_GAP_MS}); ` +
      `direct: first byte ${ms(direct.firstByteMs)} ms, fallback ${ms(directFallback)} ms, end ${ms(direct.endMs)} ms, ${direct.chunks.length} chunks; ` +
      `Chromium: fallback visible at ${fallbackSeen} ms (hook already ran, readyState ${early.readyState}, resolved content absent), content at ${resolvedSeen} ms`
    )
  })

  await report.attempt('f  login through the proxy sets the cookie; /account shows the signed-in state', async () => {
    const handle = await newPage(browser)
    const { page, context, record } = handle
    await page.goto(`${proxy.url}/account`, { waitUntil: 'load' })
    expect(page.url() === `${proxy.url}/login`, `signed out, /account led to ${page.url()}`)
    await page.click('[data-label="login-submit"]')
    await page.waitForURL(`${proxy.url}/account`, { timeout: 20_000 })
    const status = await textOf(page, '[data-label="account-status"]')
    expect(status === 'Signed in as demo', `account status is "${status}"`)
    const cookie = (await context.cookies(proxy.url)).find((entry) => entry.name === 'session')
    expect(cookie?.value === 'demo' && cookie.httpOnly, `cookie "session" is ${JSON.stringify(cookie)}`)
    await page.reload({ waitUntil: 'load' })
    expect(page.url() === `${proxy.url}/account`, `after a reload the page is ${page.url()}`)
    expect((await textOf(page, '[data-label="account-status"]')) === 'Signed in as demo', 'the signed-in state did not survive a reload')
    const post = record.responses.find((entry) => entry.method === 'POST' && entry.url === `${proxy.url}/api/login`)
    expect(post?.status === 303, `POST /api/login answered ${post?.status}`)
    const off = record.documentRequests.filter((url) => !url.startsWith(`${proxy.url}/`))
    expect(off.length === 0, `document requests that left the proxy origin: ${off.join(', ')}`)
    const hook = await readHook(page)
    expect(hook !== undefined && hook.scriptsAtRun === 1, 'the hook did not run first on /account')
    await handle.close()
    return (
      `signed out: /account -> ${proxy.url}/login; form POST /api/login -> 303 -> /account "Signed in as demo"; ` +
      `cookie session=demo (HttpOnly, domain ${cookie.domain}); still signed in after reload; ` +
      `all ${record.documentRequests.length} document requests on the proxy origin`
    )
  })

  await report.attempt('g  Server Action POST works through the proxy', async () => {
    const outputMark = fixture.output().length
    const handle = await newPage(browser)
    const { page, record } = handle
    await page.goto(`${proxy.url}/actions`, { waitUntil: 'load' })
    await reactHydrated(page, '[data-label="actions-submit"]')
    const count = async (): Promise<number> => Number(await attributeOf(page, '[data-label="actions-count"]', 'data-count'))
    const before = await count()
    expect(Number.isInteger(before), 'could not read the saved value')
    await page.fill('[data-label="actions-step"]', '3')
    await page.fill('[data-label="actions-note"]', 'via proxy')
    const requested = page.waitForRequest((request) => request.method() === 'POST', { timeout: 15_000 })
    await page.click('[data-label="actions-submit"]')
    const request = await requested
    const actionHeader = request.headers()['next-action']
    await waitFor(async () => (await count()) === before + 3, { timeoutMs: 15_000, what: `the saved value to become ${before + 3}` })
    await quiet(activityOf(record), 300, 3000)
    const posts = record.responses.filter((entry) => entry.method === 'POST')
    expect(posts.length === 1 && posts[0]?.status === 200, `POST responses: ${JSON.stringify(posts)}`)
    expect(request.url() === `${proxy.url}/actions`, `the action was posted to ${request.url()}`)
    expect(record.documentRequests.length === 1, 'the page was reloaded by the action')

    // The same action as a plain form POST (no JavaScript), through the proxy and, as a
    // control, straight to the dev server with the proxy's Origin.
    const readForm = async (origin: string): Promise<{ count: number; field: string | undefined }> => {
      const html = (await rawRequest(`${origin}/actions`, { headers: { Accept: 'text/html' } })).text
      const form = /<form[^>]*data-label="actions-form"[\s\S]*?<\/form>/.exec(html)?.[0] ?? ''
      return {
        count: Number(/data-label="actions-count" data-count="(-?\d+)"/.exec(html)?.[1]),
        field: /name="(\$ACTION_ID_[^"]+)"/.exec(form)?.[1],
      }
    }
    const post = async (target: string, field: string, step: number): Promise<number> => {
      const body = new FormData()
      body.set(field, '')
      body.set('step', String(step))
      body.set('note', 's1')
      const response = await fetch(`${target}/actions`, {
        method: 'POST',
        headers: { origin: proxy.url },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
      })
      await response.arrayBuffer()
      return response.status
    }
    const start = await readForm(proxy.url)
    expect(start.field !== undefined && start.count === before + 3, `could not read the form through the proxy: ${JSON.stringify(start)}`)
    const viaStatus = await post(proxy.url, start.field, 2)
    const afterVia = await readForm(proxy.url)
    expect(afterVia.count === start.count + 2, `form POST through the proxy: HTTP ${viaStatus}, value ${start.count} -> ${afterVia.count}`)
    const outputBeforeControl = fixture.outputSince(outputMark)
    expect(
      !/Invalid Server Actions request|does not match `origin` header/i.test(outputBeforeControl),
      `the dev server complained:\n${outputBeforeControl.trim().split('\n').slice(-6).join('\n')}`,
    )
    const controlMark = fixture.output().length
    const controlStatus = await post(fixture.url, afterVia.field ?? start.field, 5)
    const afterControl = await readForm(proxy.url)
    await sleep(200)
    const controlOutput = fixture.outputSince(controlMark)
    const rejected = afterControl.count === afterVia.count && controlStatus >= 400
    expect(
      rejected,
      `control failed: a POST straight to the dev server with Origin ${proxy.url} was accepted (HTTP ${controlStatus}, value ${afterVia.count} -> ${afterControl.count}), so this check proves nothing`,
    )
    await handle.close()
    return (
      `Chromium: fetch POST /actions with Next-Action ${actionHeader === undefined ? 'header absent' : 'header'} -> 200, saved value ${before} -> ${before + 3}, no reload; ` +
      `plain form POST through the proxy: HTTP ${viaStatus}, ${start.count} -> ${afterVia.count}; no "Invalid Server Actions request" in the dev server output; ` +
      `control (same POST straight to the dev server, Origin = proxy): HTTP ${controlStatus}, value stayed ${afterControl.count}` +
      `${/Invalid Server Actions request/.test(controlOutput) ? ', dev server logged "Invalid Server Actions request"' : ''}`
    )
  })

  await report.attempt('h  redirects stay on the proxy origin', async () => {
    const account = await rawNavigate(`${proxy.url}/account`)
    const accountLocation = String(account.headers.location ?? '')
    expect(account.status === 307, `GET /account without a cookie answered ${account.status}`)
    expect(new URL(accountLocation, `${proxy.url}/account`).href === `${proxy.url}/login`, `Location ${accountLocation} does not lead to the proxy's /login`)
    const loginRequest = { method: 'POST', headers: { 'Content-Type': FORM, Accept: 'text/html' }, body: 'username=demo&password=demo' }
    const login = await rawRequest(`${proxy.url}/api/login`, { ...loginRequest, headers: { ...loginRequest.headers, Origin: proxy.url } })
    const loginLocation = String(login.headers.location ?? '')
    expect(login.status === 303, `POST /api/login answered ${login.status}`)
    expect(loginLocation === `${proxy.url}/account`, `Location is ${loginLocation}, expected ${proxy.url}/account`)
    const setCookie = (login.headers['set-cookie'] ?? []).join(' | ')
    expect(/^session=demo;/.test(setCookie) && !/domain=/i.test(setCookie), `Set-Cookie through the proxy: ${setCookie}`)
    const wrong = await rawRequest(`${proxy.url}/api/login`, { ...loginRequest, body: 'username=demo&password=nope', headers: { ...loginRequest.headers, Origin: proxy.url } })
    expect(wrong.headers.location === `${proxy.url}/login?error=1`, `failed login Location: ${wrong.headers.location}`)
    const direct = await rawRequest(`${fixture.url}/api/login`, { ...loginRequest, headers: { ...loginRequest.headers, Origin: fixture.url } })
    const directLocation = String(direct.headers.location ?? '')
    return (
      `GET /account (no cookie): 307 Location ${accountLocation}; POST /api/login: 303 Location ${loginLocation}; wrong password: Location ${wrong.headers.location}; ` +
      `Set-Cookie "${setCookie}"; for comparison the dev server itself answers Location ${directLocation} ` +
      `(${directLocation.includes(`:${fixture.port}`) ? 'absolute, names its own port, so the proxy rewrote it' : 'no dev-server port in it'})`
    )
  })

  await report.attempt('x  client-side navigation (RSC fetches) works through the proxy', async () => {
    const handle = await open(ctx, `${proxy.url}/`)
    const { page, record } = handle
    await reactHydrated(page, 'a[href="/actions"]')
    const hook = await readHook(page)
    await page.click('a[href="/actions"]')
    await page.waitForURL(`${proxy.url}/actions`, { timeout: 20_000 })
    await page.waitForSelector('[data-label="actions-title"]', { timeout: 20_000 })
    const after = await readHook(page)
    expect(record.documentRequests.length === 1, `the navigation loaded a new document (${record.documentRequests.join(', ')})`)
    expect(after !== undefined && after.t === hook?.t, 'the hook ran again')
    const rsc = record.responses.filter((entry) => /[?&]_rsc=/.test(entry.url))
    expect(rsc.length > 0 && rsc.every((entry) => entry.status === 200 && entry.url.startsWith(`${proxy.url}/`)), `RSC responses: ${JSON.stringify(rsc.slice(0, 3))}`)
    await handle.close()
    return `Link click / -> /actions: URL ${proxy.url}/actions, 1 document request in total, ${rsc.length} RSC fetch(es) all 200 on the proxy origin, hook not re-run`
  })

  await report.attempt('x  a 1 MB document (/big, 12,000 elements) passes through with the hook', async () => {
    await rawNavigate(`${proxy.url}/big`)
    const direct = await rawNavigate(`${fixture.url}/big`, { headers: { 'Accept-Encoding': 'identity' } })
    const via = await rawNavigate(`${proxy.url}/big`)
    const tag = /<script src="\/__primp\/hook\.js"[^>]*><\/script>/.exec(via.text)?.[0] ?? ''
    expect(via.status === 200 && tag !== '', `status ${via.status}, hook tag "${tag}"`)
    const rows = (html: string): number => html.split('<li').length - 1
    expect(rows(via.text) === rows(direct.text) && rows(via.text) >= 3000, `rows: ${rows(direct.text)} direct, ${rows(via.text)} through the proxy`)
    expect(via.body.length === direct.body.length + Buffer.byteLength(tag), `size ${direct.body.length} direct, ${via.body.length} through the proxy, tag ${Buffer.byteLength(tag)} bytes`)
    return `${via.body.length} bytes in ${via.chunks.length} chunks through the proxy = ${direct.body.length} direct + ${Buffer.byteLength(tag)} for the hook tag; ${rows(via.text)} rows; first byte ${ms(via.firstByteMs)} ms, end ${ms(via.endMs)} ms (direct ${ms(direct.firstByteMs)} / ${ms(direct.endMs)} ms)`
  })
  await checkNotFound(ctx, 404)
  await measureTtfb(ctx, '/')
  await checkRestart(ctx)
}

async function runSvelteKit(ctx: Ctx): Promise<void> {
  const { browser, fixture, proxy } = ctx
  const home = await open(ctx, `${proxy.url}/`)
  await checkRender(ctx, home, '/')
  await checkClean(ctx, home, '/')

  // Hydration gate and state that a reload would reset: the client-side measurement counter.
  const { page } = home
  const measured = (): Promise<string> => textOf(page, '[data-label="measure-count"]')
  await waitFor(
    async () => {
      if ((await measured()) === '0') await page.click('[data-label="measure-button"]')
      return (await measured()) !== '0'
    },
    { timeoutMs: 15_000, intervalMs: 200, what: 'the page to hydrate' },
  )
  await page.click('[data-label="measure-button"]')
  const measuredBefore = await measured()
  await hmrReady(ctx, home)
  await checkHotEdit(ctx, home, {
    name: 'c  hot reload through the proxy (Svelte component)',
    file: 'src/lib/components/Hero.svelte',
    search: 'Sign in to continue',
    selector: '[data-label="hero-cta"]',
    frame: (frame) => frame.direction === 'upstream-to-client' && frame.jsonType === 'update' && (frame.text ?? '').includes('Hero.svelte'),
    frameWhat: 'Vite "update" frame naming Hero.svelte',
    after: async () => {
      const value = await measured()
      expect(value === measuredBefore, `the page's client state went from ${measuredBefore} to ${value}`)
      return `client state in +page.svelte kept (${value} measurements)`
    },
  })
  await checkSocket(ctx, home, /^\/\?token=/, ['connected', 'update'])

  await report.attempt('e  streaming is preserved on /streamed (extra; the brief names only Next)', async () => {
    await rawNavigate(`${proxy.url}/streamed`)
    const direct = await rawNavigate(`${fixture.url}/streamed`)
    const via = await rawNavigate(`${proxy.url}/streamed`)
    const hookAt = via.arrivalOf(HOOK_SRC)
    const shellAt = via.arrivalOf('data-label="streamed-shell"')
    const valueAt = via.arrivalOf('streamed value arrived')
    expect(via.status === 200 && hookAt !== undefined && shellAt !== undefined && valueAt !== undefined, `shell or value missing (HTTP ${via.status})`)
    const directGap = direct.endMs - (direct.arrivalOf('data-label="streamed-shell"') ?? direct.endMs)
    // The fixture delays the value by 800 ms; anything near that means the shell was not held back.
    expect(via.endMs - hookAt >= 600, `hook chunk at ${ms(hookAt)} ms, end at ${ms(via.endMs)} ms`)
    expect(valueAt - shellAt >= 600, `shell at ${ms(shellAt)} ms, value at ${ms(valueAt)} ms`)
    return (
      `through the proxy: chunk with the hook ${ms(hookAt)} ms, shell ${ms(shellAt)} ms, streamed value ${ms(valueAt)} ms, end ${ms(via.endMs)} ms, ` +
      `${via.chunks.length} chunks (hook ${ms(via.endMs - hookAt)} ms before the end; fixture delay 800 ms, threshold 600); direct: shell-to-end ${ms(directGap)} ms`
    )
  })

  await report.attempt('f  form action POST works through the proxy (no cross-site 403); the session survives a reload', async () => {
    const { context, record } = home
    const responsesBefore = record.responses.length
    await page.fill('[data-label="signin-name"]', 'Ada')
    await page.click('[data-label="signin-submit"]')
    await waitFor(async () => (await textOf(page, '[data-label="account-title"]')).includes('Ada'), {
      timeoutMs: 15_000,
      what: 'the account card',
    })
    const posts = record.responses.slice(responsesBefore).filter((entry) => entry.method === 'POST')
    expect(posts.length === 1 && posts[0]?.status === 200, `POST responses: ${JSON.stringify(posts)}`)
    expect(posts[0]?.url.startsWith(`${proxy.url}/`), `the form was posted to ${posts[0]?.url}`)
    const forbidden = record.responses.filter((entry) => entry.status === 403)
    expect(forbidden.length === 0, `403 responses: ${JSON.stringify(forbidden)}`)
    const cookie = (await context.cookies(proxy.url)).find((entry) => entry.name === 'primp_fixture_user')
    expect(cookie?.value === 'Ada' && cookie.httpOnly, `session cookie is ${JSON.stringify(cookie)}`)
    await page.reload({ waitUntil: 'load' })
    const title = await textOf(page, '[data-label="account-title"]')
    expect(title.includes('Ada'), `after a reload the account card reads "${title}"`)

    // The no-JavaScript path: a real form POST answered with a redirect.
    const form = { method: 'POST', headers: { 'Content-Type': FORM, Accept: 'text/html', Origin: proxy.url }, body: 'name=Bo' }
    const native = await rawRequest(`${proxy.url}/?/signin`, form)
    expect(native.status === 303, `plain form POST through the proxy answered ${native.status}: ${native.text.slice(0, 120)}`)
    const control = await rawRequest(`${fixture.url}/?/signin`, form)
    expect(
      control.status === 403,
      `control failed: the dev server accepted a POST with Origin ${proxy.url} sent straight to it (HTTP ${control.status}), so this check proves nothing`,
    )
    return (
      `Chromium (use:enhance fetch): POST ${posts[0]?.url.replace(proxy.url, '')} -> 200, account card "${title}", cookie primp_fixture_user=Ada (HttpOnly), no 403; ` +
      `still signed in after reload; plain form POST through the proxy: 303 Location ${native.headers.location}; ` +
      `control (same POST straight to the dev server, Origin = proxy): ${control.status} "${control.text.slice(0, 60)}"`
    )
  })
  report.notApplicable('g  Server Action POST', 'not a Next app; the SvelteKit form action is covered by f')

  await report.attempt('h  redirects stay on the proxy origin', async () => {
    const form = { method: 'POST', headers: { 'Content-Type': FORM, Accept: 'text/html', Origin: proxy.url }, body: 'name=Cy' }
    const signin = await rawRequest(`${proxy.url}/?/signin`, form)
    const location = String(signin.headers.location ?? '')
    expect(signin.status === 303, `sign-in answered ${signin.status}`)
    expect(new URL(location, `${proxy.url}/`).origin === proxy.url, `Location ${location} leaves the proxy origin`)
    const handle = await newPage(browser, { context: { javaScriptEnabled: false } })
    await handle.page.goto(`${proxy.url}/`, { waitUntil: 'load' })
    await handle.page.fill('[data-label="signin-name"]', 'Di')
    await handle.page.click('[data-label="signin-submit"]')
    await handle.page.waitForSelector('[data-label="account-title"]', { timeout: 15_000 })
    const landed = handle.page.url()
    const title = await handle.page.textContent('[data-label="account-title"]')
    const documents = handle.record.documentRequests
    await handle.close()
    expect(landed === `${proxy.url}/`, `after the redirect the browser is at ${landed}`)
    expect(documents.every((url) => url.startsWith(`${proxy.url}/`)), `document requests: ${documents.join(', ')}`)
    return `POST /?/signin: 303 Location ${location}; Chromium with JavaScript off: native form POST -> redirect -> ${landed} "${title}"; ${documents.length} document requests, all on the proxy origin`
  })
  await checkNotFound(ctx, 404)
  await measureTtfb(ctx, '/')
  await checkRestart(ctx)
}

async function runStatic(ctx: Ctx): Promise<void> {
  const { fixture, proxy } = ctx
  const home = await open(ctx, `${proxy.url}/`)
  await checkRender(ctx, home, '/')
  await checkClean(ctx, home, '/')

  await report.attempt('c  an edit shows after a manual reload, with the hook, never from a stale 304', async () => {
    const { page, record } = home
    const title = '[data-label="hero-title"]'
    const stamp = token()
    const first = await readHook(page)
    const etag = String((await rawNavigate(`${fixture.url}/`)).headers.etag ?? '')
    expect(etag !== '', 'the fixture sent no ETag, so the 304 case cannot be exercised')

    // Unchanged file: the dev server would answer 304 to a revalidation.
    const same = await page.reload({ waitUntil: 'load' })
    expect(same?.status() === 200, `reload of the unchanged page answered ${same?.status()}`)
    const second = await readHook(page)
    expect(second !== undefined && second.firstInHead && second.scriptsAtRun === 1, 'the hook did not run first after reloading the unchanged page')

    editFile(fixture, 'index.html', replaceOnce('Notebooks that lie flat and stay shut', `Notebooks that lie flat and stay shut ${stamp}`))
    await sleep(300)
    expect(!(await textOf(page, title)).includes(stamp), 'the page changed without a reload, which this fixture cannot do')
    const reloaded = await page.reload({ waitUntil: 'load' })
    expect(reloaded?.status() === 200, `reload after the edit answered ${reloaded?.status()}`)
    const text = await textOf(page, title)
    expect(text.includes(stamp), `after the reload the title reads "${text}"`)
    const third = await readHook(page)
    expect(third !== undefined && third.firstInHead && third.scriptsAtRun === 1 && third.runs === 1, 'the hook did not run first after the reload')

    // The same thing with explicit validators, as a browser cache would send them.
    const freshTag = String((await rawNavigate(`${fixture.url}/`)).headers.etag ?? '')
    expect(freshTag !== '' && freshTag !== etag, `the ETag did not change with the edit (${etag} -> ${freshTag})`)
    const validators = { 'If-None-Match': freshTag, 'If-Modified-Since': new Date(Date.now() + 60_000).toUTCString() }
    const directConditional = await rawNavigate(`${fixture.url}/`, { headers: validators })
    const viaConditional = await rawNavigate(`${proxy.url}/`, { headers: validators })
    expect(directConditional.status === 304, `control failed: the dev server answered ${directConditional.status} to a matching If-None-Match`)
    expect(viaConditional.status === 200, `the proxy answered ${viaConditional.status} to a conditional document request`)
    expect(viaConditional.text.includes(HOOK_TAG_START) && viaConditional.text.includes(stamp), 'the conditional response lacks the hook or the edit')
    expect(viaConditional.headers.etag === undefined && viaConditional.headers['last-modified'] === undefined, 'the injected document still carries validators')
    const documentStatuses = record.responses.filter((entry) => entry.resourceType === 'document').map((entry) => entry.status)
    return (
      `reload of the unchanged page: 200 with the hook; edit of index.html not visible before a reload; reload: 200, title shows the edit, hook ran first ` +
      `(hook t ${ms(first?.t)} -> ${ms(second.t)} -> ${ms(third.t)} ms, one run per document); document statuses ${documentStatuses.join(', ')}; ` +
      `conditional GET with the current ETag: dev server 304, proxy 200 with hook and no ETag/Last-Modified`
    )
  })

  await report.attempt('d  no upgrade traffic on a site without live reload', async () => {
    expect(home.record.webSockets.length === 0, `the page opened ${home.record.webSockets.join(', ')}`)
    expect(proxy.frames.length === 0, `the proxy recorded ${proxy.frames.length} frames`)
    return 'the page opens no WebSocket and the proxy tunnelled none; the HMR criterion does not apply to this fixture'
  })
  report.notApplicable('e  streaming is preserved', 'static files, no streamed route')
  report.notApplicable('f  login survives', 'the fixture has no login')
  report.notApplicable('g  Server Action POST', 'not a Next app')
  report.notApplicable('h  redirects stay on the proxy origin', 'the fixture server never redirects')
  await checkNotFound(ctx, 404)
  await measureTtfb(ctx, '/')
}

// ---------------------------------------------------------------------------------------------

function printMatrix(names: FixtureName[]): void {
  const letters = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'x', 'z']
  const cell = (name: string, letter: string): string => {
    const entries = report.entries.filter((entry) => entry.group === name && entry.name.startsWith(`${letter}  `))
    if (report.entries.some((entry) => entry.group === name && entry.name === 'all checks of this fixture ran')) {
      if (entries.length === 0) return 'FAIL*'
    }
    if (entries.length === 0) return '-'
    if (entries.some((entry) => entry.result === 'fail' || entry.result === 'skipped')) return 'FAIL'
    if (entries.every((entry) => entry.result === 'n/a')) return 'n/a'
    return `PASS${entries.length > 1 ? ` x${entries.filter((entry) => entry.result === 'pass').length}` : ''}`
  }
  console.log(`\n${'check'.padEnd(6)}${names.map((name) => name.padEnd(21)).join('')}`)
  for (const letter of letters) console.log(`${letter.padEnd(6)}${names.map((name) => cell(name, letter).padEnd(21)).join('')}`)
  console.log('(FAIL* = the fixture run stopped before this check; "-" = no such check recorded)')
}

const FIXTURES: [FixtureName, (ctx: Ctx) => Promise<void>][] = [
  ['vite-react-19', runVite],
  ['next-16-turbopack', runNext],
  ['sveltekit-svelte-5', runSvelteKit],
  ['static-html', runStatic],
]

try {
  const browser = await launchBrowser()
  report.info(`Chromium ${browser.version()}, headless; Node ${process.version}`)
  for (const [name, run] of FIXTURES) await withFixture(name, run, browser)
} catch (error) {
  report.section('harness')
  report.check('the spike ran to completion', false, error instanceof Error ? (error.stack ?? error.message) : String(error))
} finally {
  await runCleanups()
  printMatrix(FIXTURES.map(([name]) => name))
  console.log('\ni  document time to first byte (informational):')
  for (const row of ttfbRows) console.log(`   ${row}`)
  console.log(`\ntime per fixture: ${fixtureSeconds.join(', ')}`)
  report.finish()
}
