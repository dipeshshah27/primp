#!/usr/bin/env node
// Starts the dev server on a free port, checks every page of the fixture and
// stops the server again. Exits 0 when every check that ran passed, 1 otherwise.
//
//   node scripts/smoke.mjs            HTTP checks, plus browser checks when
//                                     @playwright/test can be resolved
//   node scripts/smoke.mjs --break    also toggles the syntax error with
//                                     scripts/break.mjs (edits two component
//                                     files in place and restores them)
//   node scripts/smoke.mjs --no-browser
//
// A check that could not run is printed as SKIP and never counted as a pass.

import { spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ARGS = new Set(process.argv.slice(2))
const READY_TIMEOUT_MS = 120_000
const FETCH_TIMEOUT_MS = 60_000

/** @type {{ name: string, result: 'PASS' | 'FAIL' | 'SKIP', evidence: string }[]} */
const report = []

function record(name, result, evidence) {
  report.push({ name, result, evidence })
  console.log(`${result}  ${name}\n      ${evidence}`)
}

/** Runs one check. The callback returns evidence text or throws. */
async function check(name, run) {
  try {
    record(name, 'PASS', await run())
  } catch (error) {
    record(name, 'FAIL', error instanceof Error ? error.message : String(error))
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message)
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, 'localhost', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function get(url, init = {}) {
  return fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), ...init })
}

/** React separates adjacent text nodes with empty comments; drop them before matching text. */
const plainText = (html) => html.replaceAll('<!-- -->', '')

function nonceOf(csp) {
  return /'nonce-([^']+)'/.exec(csp ?? '')?.[1]
}

const labels = JSON.parse(readFileSync(join(ROOT, 'labels.json'), 'utf8'))
const labelsOn = (page) => labels.filter((entry) => entry.page === page)

// ---------------------------------------------------------------------------
// Dev server lifecycle
// ---------------------------------------------------------------------------

const port = await freePort()
const origin = `http://localhost:${port}`
const devScript = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts.dev

let serverLog = ''
const server = spawn(devScript, {
  cwd: ROOT,
  shell: true,
  detached: true, // own process group, so the whole tree can be killed
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    PORT: String(port),
    NEXT_TELEMETRY_DISABLED: '1',
    PATH: `${join(ROOT, 'node_modules', '.bin')}${delimiter}${process.env.PATH}`,
  },
})
server.stdout.on('data', (chunk) => (serverLog += chunk))
server.stderr.on('data', (chunk) => (serverLog += chunk))
const serverExited = new Promise((resolve) => server.once('exit', resolve))

let stopped = false
async function stopServer() {
  if (stopped) return
  stopped = true
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    try {
      process.kill(-server.pid, signal)
    } catch {
      return // group already gone
    }
    if (await Promise.race([serverExited.then(() => true), sleep(5000).then(() => false)])) {
      // The shell is gone; give its children a moment, then make sure.
      await sleep(300)
      try {
        process.kill(-server.pid, 'SIGKILL')
      } catch {
        // nothing left
      }
      return
    }
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    restoreBreak()
    stopServer().finally(() => process.exit(130))
  })
}

function runBreak(...args) {
  return spawnSync(process.execPath, [join(ROOT, 'scripts', 'break.mjs'), ...args], { encoding: 'utf8' })
}

let breakTouched = false
function restoreBreak() {
  if (breakTouched) runBreak('off')
}

async function waitUntilReady() {
  const started = Date.now()
  while (Date.now() - started < READY_TIMEOUT_MS) {
    if (server.exitCode !== null) throw new Error(`dev server exited with code ${server.exitCode}\n${serverLog}`)
    try {
      const response = await fetch(`${origin}/login`, { redirect: 'manual', signal: AbortSignal.timeout(30_000) })
      await response.arrayBuffer()
      if (response.status === 200) return Date.now() - started
    } catch {
      // not listening yet
    }
    await sleep(250)
  }
  throw new Error(`dev server not ready after ${READY_TIMEOUT_MS} ms\n${serverLog}`)
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function httpChecks() {
  await check('labels.json is current and positions point at "<tag"', async () => {
    const generated = spawnSync(process.execPath, [join(ROOT, 'scripts', 'gen-labels.mjs'), '--check'], { encoding: 'utf8' })
    expect(generated.status === 0, `gen-labels --check failed: ${generated.stderr.trim()}`)
    const sources = new Map()
    for (const entry of labels) {
      if (!sources.has(entry.file)) sources.set(entry.file, readFileSync(join(ROOT, entry.file), 'utf8').split('\n'))
      const at = sources.get(entry.file)[entry.line - 1]?.slice(entry.col - 1) ?? ''
      expect(at.startsWith(`<${entry.tag}`), `${entry.label}: ${entry.file}:${entry.line}:${entry.col} is "${at.slice(0, 20)}"`)
    }
    const server = labels.filter((entry) => entry.kind === 'server').length
    const client = labels.filter((entry) => entry.kind === 'client').length
    expect(labels.length >= 30 && server > 0 && client > 0, `need 30+ labels of both kinds, have ${server} server, ${client} client`)
    return `${labels.length} labels: ${server} server, ${client} client`
  })

  await check('dev server uses Turbopack, PORT and localhost', async () => {
    expect(/turbopack/i.test(serverLog), `no "Turbopack" in the dev server banner:\n${serverLog}`)
    expect(serverLog.includes(`localhost:${port}`), `banner does not mention localhost:${port}`)
    const banner = serverLog.split('\n').find((line) => /next\.js/i.test(line))?.trim()
    return `${banner}; listening on ${origin}`
  })

  const pages = ['/', '/actions', '/stream', '/big', '/login', '/csp', '/broken-toggle']
  const htmlOf = new Map()
  for (const page of pages) {
    await check(`GET ${page} is 200 with its labels`, async () => {
      const response = await get(`${origin}${page}`)
      const html = await response.text()
      htmlOf.set(page, { html, csp: response.headers.get('content-security-policy') })
      expect(response.status === 200, `status ${response.status}`)
      // Layout labels are on every page; the rest belong to this page.
      const expected = [...labels.filter((entry) => entry.file === 'app/layout.tsx'), ...labelsOn(page)]
      const missing = expected.filter((entry) => !html.includes(`data-label="${entry.label}"`)).map((entry) => entry.label)
      expect(missing.length === 0, `missing labels: ${missing.join(', ')}`)
      return `200, ${html.length} bytes, ${new Set(expected.map((entry) => entry.label)).size} expected labels present`
    })
  }

  await check('CSP header carries a fresh nonce and every script tag on / has it', async () => {
    const first = htmlOf.get('/')
    const nonce = nonceOf(first?.csp)
    expect(nonce, `no nonce in Content-Security-Policy: ${first?.csp}`)
    expect(!/script-src[^;]*'unsafe-inline'/.test(first.csp), 'script-src allows unsafe-inline')
    const scripts = first.html.match(/<script\b[^>]*>/g) ?? []
    const wrong = scripts.filter((tag) => !tag.includes(`nonce="${nonce}"`))
    expect(scripts.length > 0 && wrong.length === 0, `${wrong.length} of ${scripts.length} script tags lack the nonce: ${wrong[0]}`)
    const again = nonceOf((await get(`${origin}/`)).headers.get('content-security-policy'))
    expect(again && again !== nonce, 'the nonce did not change between two requests')
    return `${scripts.length} script tags, all with the request nonce; next request got a different nonce; policy: ${first.csp}`
  })

  await check('/csp has exactly one inline script without the nonce', async () => {
    const page = htmlOf.get('/csp')
    const nonce = nonceOf(page?.csp)
    const scripts = page.html.match(/<script\b[^>]*>/g) ?? []
    const bare = scripts.filter((tag) => !tag.includes(`nonce="${nonce}"`))
    expect(bare.length === 1, `expected 1 script tag without the nonce, found ${bare.length}`)
    expect(page.html.includes('window.__cspUnnonced = "ran"'), 'the un-nonced probe script is not in the HTML')
    return `${scripts.length} script tags, 1 without nonce (the probe that must be blocked)`
  })

  await check('global CSS has an @media rule and CSS module classes are scoped', async () => {
    const { html } = htmlOf.get('/')
    const hrefs = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/g)].map((match) => /href="([^"]+)"/.exec(match[0])?.[1])
    expect(hrefs.length > 0, 'no stylesheet links on /')
    let css = ''
    for (const href of hrefs) css += await (await get(new URL(href.replaceAll('&amp;', '&'), origin))).text()
    expect(/@media[^{]*max-width:\s*720px[^{]*\{[^}]*\.site-header/.test(css), 'global @media rule for .site-header not found')
    const heroClass = /data-label="home-hero" class="([^"]+)"/.exec(html)?.[1]
    expect(heroClass && heroClass !== 'hero', `home-hero class is "${heroClass}", expected a scoped module class`)
    expect(css.includes(`.${heroClass}`), `module class .${heroClass} not found in the served CSS`)
    return `${hrefs.length} stylesheet(s), ${css.length} bytes; module class "${heroClass}"`
  })

  await check('/big renders more than 10,000 host elements', async () => {
    const { html } = htmlOf.get('/big')
    const body = html.slice(html.indexOf('<body'), html.indexOf('</body>'))
    const elements = (body.match(/<(?!script\b|template\b|\/|!)[a-z][a-z0-9]*[\s>]/g) ?? []).length
    expect(elements > 10_000, `only ${elements} elements`)
    expect(labelsOn('/big').length === 3, `expected 3 labels on /big, labels.json has ${labelsOn('/big').length}`)
    return `${elements} element start tags in <body> (scripts excluded), 3 labelled`
  })

  await check('/stream sends the fallback first and the slow content later', async () => {
    const started = Date.now()
    const response = await get(`${origin}/stream`)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let html = ''
    let chunks = 0
    let fallbackAt
    let resolvedAt
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks += 1
      html += decoder.decode(value, { stream: true })
      if (fallbackAt === undefined && html.includes('data-label="stream-fallback"')) fallbackAt = Date.now() - started
      if (resolvedAt === undefined && html.includes('data-label="stream-resolved"')) resolvedAt = Date.now() - started
    }
    expect(fallbackAt !== undefined, 'fallback never arrived')
    expect(resolvedAt !== undefined, 'resolved content never arrived')
    const gap = resolvedAt - fallbackAt
    expect(gap >= 1000 && gap <= 4000, `resolved content came ${gap} ms after the fallback, expected about 1500`)
    return `fallback at ${fallbackAt} ms, resolved content at ${resolvedAt} ms (gap ${gap} ms), ${chunks} chunks`
  })

  await check('auth: /account redirects, login sets an HttpOnly cookie, /account greets', async () => {
    const anonymous = await get(`${origin}/account`)
    await anonymous.arrayBuffer()
    // A redirect() during a streamed render can also arrive as 200 with a meta refresh; a plain GET gets a 307.
    expect([307, 303, 302].includes(anonymous.status), `anonymous /account gave ${anonymous.status}`)
    expect(new URL(anonymous.headers.get('location'), origin).pathname === '/login', `redirected to ${anonymous.headers.get('location')}`)

    const form = (password) => ({
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
      body: new URLSearchParams({ username: 'demo', password }).toString(),
    })
    const bad = await get(`${origin}/api/login`, form('wrong'))
    expect(bad.status === 303 && bad.headers.get('location')?.includes('/login?error=1'), `bad login: ${bad.status} ${bad.headers.get('location')}`)
    expect(bad.headers.getSetCookie().length === 0, 'a failed login set a cookie')

    const good = await get(`${origin}/api/login`, form('demo'))
    const location = good.headers.get('location')
    expect(good.status === 303 && new URL(location, origin).pathname === '/account', `login: ${good.status} ${location}`)
    const cookie = good.headers.getSetCookie().find((value) => value.startsWith('session='))
    expect(cookie && /;\s*httponly/i.test(cookie), `Set-Cookie is "${cookie}"`)

    const account = await get(`${origin}/account`, { headers: { cookie: cookie.split(';')[0] } })
    const html = await account.text()
    expect(account.status === 200 && html.includes('Signed in as demo'), `/account with cookie: ${account.status}`)
    return `anonymous ${anonymous.status} -> /login; login 303 -> ${location}; Set-Cookie: ${cookie}; /account shows "Signed in as demo"`
  })

  await check('Server Action: same-origin POST increments, cross-origin POST is rejected', async () => {
    const read = async () => {
      const html = await (await get(`${origin}/actions`)).text()
      const formHtml = /<form[^>]*data-label="actions-form"[\s\S]*?<\/form>/.exec(html)?.[0] ?? ''
      return {
        count: Number(/data-label="actions-count" data-count="(-?\d+)"/.exec(html)?.[1]),
        actionField: /name="(\$ACTION_ID_[^"]+)"/.exec(formHtml)?.[1],
      }
    }
    const post = async (actionField, step, fromOrigin) => {
      const body = new FormData()
      body.set(actionField, '')
      body.set('step', String(step))
      body.set('note', 'smoke')
      const response = await get(`${origin}/actions`, { method: 'POST', headers: { origin: fromOrigin }, body })
      await response.arrayBuffer()
      return response.status
    }

    const before = await read()
    expect(Number.isInteger(before.count) && before.actionField, `could not read the form: ${JSON.stringify(before)}`)
    const okStatus = await post(before.actionField, 3, origin)
    const after = await read()
    expect(after.count === before.count + 3, `count went ${before.count} -> ${after.count} (status ${okStatus}), expected +3`)

    const foreign = `http://localhost:${port === 65535 ? port - 1 : port + 1}`
    const rejectedStatus = await post(after.actionField, 5, foreign)
    const unchanged = await read()
    expect(unchanged.count === after.count, `a POST with Origin ${foreign} changed the count ${after.count} -> ${unchanged.count}`)
    return `same origin: ${before.count} -> ${after.count} (HTTP ${okStatus}); Origin ${foreign}: HTTP ${rejectedStatus}, count stayed ${unchanged.count}`
  })
}

async function breakChecks() {
  const name = 'scripts/break.mjs on/off breaks and repairs /broken-toggle'
  if (!ARGS.has('--break')) {
    record(name, 'SKIP', 'not requested; run with --break (edits two component files in place and restores them)')
    return
  }
  await check(name, async () => {
    const probe = async () => {
      const response = await get(`${origin}/broken-toggle`)
      return { status: response.status, html: await response.text() }
    }
    const waitFor = async (predicate, what) => {
      const started = Date.now()
      let last
      while (Date.now() - started < 30_000) {
        last = await probe()
        if (predicate(last)) return { ...last, ms: Date.now() - started }
        await sleep(200)
      }
      throw new Error(`${what} not seen within 30 s; last status ${last?.status}`)
    }
    const healthy = (page) => page.status === 200 && page.html.includes('data-label="break-target-server"')
    const evidence = []
    breakTouched = true
    try {
      for (const target of ['server', 'client']) {
        const on = runBreak('on', target)
        expect(on.status === 0, `break on ${target} failed: ${on.stderr}`)
        const broken = await waitFor((page) => !healthy(page), `${target} build error`)
        const off = runBreak('off', target)
        expect(off.status === 0, `break off ${target} failed: ${off.stderr}`)
        const repaired = await waitFor(healthy, `${target} recovery`)
        evidence.push(`${target}: broken -> HTTP ${broken.status} after ${broken.ms} ms, repaired -> HTTP 200 after ${repaired.ms} ms`)
      }
    } finally {
      restoreBreak()
    }
    return evidence.join('; ')
  })
}

async function browserChecks() {
  const names = [
    'browser: CSP blocks the inline script without the nonce and nothing else from the app',
    'browser: hydration, Server Action submit and login work in Chromium',
  ]
  let chromium
  if (!ARGS.has('--no-browser')) {
    try {
      ;({ chromium } = await import('@playwright/test'))
    } catch {
      // not resolvable from here, for example in a copy outside the repo
    }
  }
  if (!chromium) {
    const why = ARGS.has('--no-browser') ? '--no-browser given' : '@playwright/test is not resolvable from this directory'
    for (const name of names) record(name, 'SKIP', why)
    return
  }

  const browser = await chromium.launch()
  try {
    await check(names[0], async () => {
      const context = await browser.newContext()
      const page = await context.newPage()
      const violations = []
      await page.exposeFunction('__reportViolation', (violation) => violations.push(violation))
      // addInitScript runs outside the page's CSP, so the listener is in place before any page script.
      await page.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (event) => {
          const element = event.composedPath()[0]
          window.__reportViolation({
            path: location.pathname,
            directive: event.effectiveDirective,
            element: element?.nodeName?.toLowerCase(),
            // Set when the element sits in a shadow root: the custom element that owns it.
            shadowHost: element?.getRootNode?.()?.host?.nodeName?.toLowerCase(),
            // The script that inserted the element.
            sourceFile: event.sourceFile,
          })
        })
      })
      const visited = ['/', '/actions', '/stream', '/login', '/csp']
      for (const path of visited) {
        await page.goto(`${origin}${path}`, { waitUntil: 'load' })
        if (path === '/stream') await page.waitForSelector('[data-label="stream-resolved"]')
        if (path === '/csp') await page.waitForSelector('[data-label="csp-status"][data-ready="true"]')
        await page.waitForTimeout(1000)
      }
      const nonced = await page.textContent('[data-label="csp-status-nonced"]')
      const unnonced = await page.textContent('[data-label="csp-status-unnonced"]')
      await context.close()
      expect(nonced === 'ran', `the inline script with the nonce: ${nonced}`)
      expect(unnonced === 'blocked', `the inline script without the nonce: ${unnonced}`)

      // Next's dev tools do not nonce their own <style> elements, so the strict
      // style-src blocks them: the ones in the <nextjs-portal> shadow root and
      // one @font-face block in <head>, all inserted by the next-devtools chunk.
      // Everything else has to be clean, and no script may be blocked except
      // the probe on /csp.
      const isDevToolsStyle = (entry) =>
        entry.directive === 'style-src-elem' &&
        entry.element === 'style' &&
        (entry.shadowHost === 'nextjs-portal' || /next-devtools/.test(entry.sourceFile ?? ''))
      const devToolsStyles = violations.filter(isDevToolsStyle)
      const others = violations.filter((entry) => !isDevToolsStyle(entry))
      const probe = others.filter((entry) => entry.path === '/csp' && entry.directive === 'script-src-elem' && entry.element === 'script')
      expect(probe.length === 1, `expected exactly 1 blocked script on /csp, got ${probe.length}`)
      expect(others.length === 1, `unexpected CSP violations from the app: ${JSON.stringify(others.filter((entry) => !probe.includes(entry)))}`)
      const perPage = visited.map((path) => `${path} ${devToolsStyles.filter((entry) => entry.path === path).length}`).join(', ')
      if (process.env.FIXTURE_CSP_STYLE === 'unsafe-inline') {
        expect(devToolsStyles.length === 0, `style-src is relaxed but ${devToolsStyles.length} styles were blocked`)
      }
      return `nonced script ran; un-nonced script blocked (1 script-src-elem violation on /csp, 0 on other pages); 0 violations from app content; blocked <style> elements of Next's own dev tools per page: ${perPage}`
    })

    await check(names[1], async () => {
      const context = await browser.newContext()
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))

      await page.goto(`${origin}/`, { waitUntil: 'load' })
      await page.click('[data-label="counter-inc"]')
      await page.waitForFunction(() => document.querySelector('[data-label="counter-value"]')?.textContent === '4')

      await page.goto(`${origin}/actions`, { waitUntil: 'load' })
      const before = Number(await page.getAttribute('[data-label="actions-count"]', 'data-count'))
      await page.fill('[data-label="actions-step"]', '2')
      const actionRequest = page.waitForRequest((request) => request.method() === 'POST')
      await page.click('[data-label="actions-submit"]')
      const request = await actionRequest
      await page.waitForFunction(
        (expected) => document.querySelector('[data-label="actions-count"]')?.getAttribute('data-count') === String(expected),
        before + 2,
      )
      const viaFetch = request.headers()['next-action'] !== undefined

      await page.goto(`${origin}/account`, { waitUntil: 'load' })
      expect(new URL(page.url()).pathname === '/login', `anonymous /account ended at ${page.url()}`)
      await page.click('[data-label="login-submit"]')
      await page.waitForURL(`${origin}/account`)
      const status = await page.textContent('[data-label="account-status"]')
      expect(status === 'Signed in as demo', `account status is "${status}"`)
      const cookie = (await context.cookies()).find((entry) => entry.name === 'session')
      expect(cookie?.httpOnly === true, `session cookie: ${JSON.stringify(cookie)}`)
      await context.close()
      expect(errors.length === 0, `page errors: ${errors.join(' | ')}`)
      return `client counter 3 -> 4; Server Action ${before} -> ${before + 2} (${viaFetch ? 'fetch with Next-Action header' : 'document POST'}); login -> "${status}", cookie httpOnly=${cookie.httpOnly}`
    })
  } finally {
    await browser.close()
  }
}

// ---------------------------------------------------------------------------

let exitCode = 1
try {
  const readyMs = await waitUntilReady()
  console.log(`dev server ready on ${origin} after ${readyMs} ms\n`)
  await httpChecks()
  await browserChecks()
  await breakChecks()
  const failed = report.filter((entry) => entry.result === 'FAIL').length
  const skipped = report.filter((entry) => entry.result === 'SKIP').length
  const passed = report.length - failed - skipped
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`)
  exitCode = failed === 0 ? 0 : 1
} catch (error) {
  console.error(`smoke: ${error instanceof Error ? error.message : error}`)
} finally {
  restoreBreak()
  await stopServer()
}
process.exit(exitCode)
