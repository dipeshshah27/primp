import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { chromium, type Browser } from '@playwright/test'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { WebSocketServer, type RawData } from 'ws'
import { onCleanup, runCleanups, startProxy, startUpstream } from './helpers.ts'

/**
 * The CSP assumptions of `src/csp.ts`, checked in a real Chromium: under each
 * policy the injected script must run, load a second script, open the overlay
 * socket and style the page through a constructable stylesheet.
 */

interface ProbeResult {
  nonceSeen: boolean
  ws: string
  message: string | undefined
  laterScript: boolean
  /** What the hook could still do once the whole document was parsed. */
  deferred: { ws: string; script: string }
  styles: Record<'constructable' | 'insertRule' | 'setProperty' | 'styleElement' | 'styleAttribute', boolean>
  violations: string[]
}

/** Stands in for the overlay hook. */
const PROBE = `
(() => {
  const r = (window.__r = { nonce: document.currentScript && document.currentScript.nonce, violations: [], ws: 'pending', deferred: { ws: 'pending', script: 'pending' } })
  document.addEventListener('securitypolicyviolation', (e) => r.violations.push(e.effectiveDirective))
  const sheet = new CSSStyleSheet()
  sheet.replaceSync('html { outline: 3px solid rgb(1, 2, 3) }')
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
  sheet.insertRule('html { border-top-color: rgb(4, 5, 6) }', 1)
  document.documentElement.style.setProperty('caret-color', 'rgb(7, 8, 9)')
  const style = document.createElement('style')
  style.textContent = 'html { column-rule-color: rgb(10, 11, 12) }'
  document.documentElement.appendChild(style)
  const probe = document.createElement('i')
  probe.setAttribute('style', 'color: rgb(13, 14, 15)')
  document.documentElement.appendChild(probe)
  r.read = () => {
    const computed = getComputedStyle(document.documentElement)
    return {
      nonceSeen: !!r.nonce,
      ws: r.ws,
      message: r.message,
      laterScript: window.__later === true,
      deferred: r.deferred,
      styles: {
        constructable: computed.outlineColor === 'rgb(1, 2, 3)',
        insertRule: computed.borderTopColor === 'rgb(4, 5, 6)',
        setProperty: computed.caretColor === 'rgb(7, 8, 9)',
        styleElement: computed.columnRuleColor === 'rgb(10, 11, 12)',
        styleAttribute: getComputedStyle(probe).color === 'rgb(13, 14, 15)',
      },
      violations: r.violations,
    }
  }
  const ws = new WebSocket('ws://' + location.host + '/__primp/ws')
  ws.onopen = () => { r.ws = 'open'; ws.send('hi') }
  ws.onerror = () => { r.ws = 'error' }
  ws.onmessage = (e) => { r.message = e.data }
  const later = document.createElement('script')
  later.src = '/__primp/later.js'
  if (r.nonce) later.nonce = r.nonce
  document.documentElement.appendChild(later)
  document.addEventListener('DOMContentLoaded', () => {
    const ws2 = new WebSocket('ws://' + location.host + '/__primp/ws')
    ws2.onopen = () => { r.deferred.ws = 'open' }
    ws2.onerror = () => { r.deferred.ws = 'error' }
    const script = document.createElement('script')
    script.src = '/__primp/later.js?deferred'
    if (r.nonce) script.nonce = r.nonce
    script.onload = () => { r.deferred.script = 'loaded' }
    script.onerror = () => { r.deferred.script = 'blocked' }
    document.documentElement.appendChild(script)
  })
})()
`

let browser: Browser
beforeAll(async () => {
  browser = await chromium.launch()
})
afterAll(async () => {
  await browser?.close()
})
afterEach(runCleanups)

async function probe(url: string): Promise<{ csp: string | undefined; result: ProbeResult }> {
  const page = await browser.newPage()
  try {
    const response = await page.goto(url)
    // Functions, not strings: Playwright evaluates a string with eval(), which these policies forbid.
    await page.waitForFunction(
      () => {
        const r = (window as unknown as { __r?: { ws: string; message?: string; deferred: { ws: string; script: string } } }).__r
        return r !== undefined && (r.ws === 'error' || r.message !== undefined) && r.deferred.ws !== 'pending' && r.deferred.script !== 'pending'
      },
      undefined,
      { timeout: 5000 },
    )
    const result = await page.evaluate(() => (window as unknown as { __r: { read(): ProbeResult } }).__r.read())
    return { csp: response?.headers()['content-security-policy'], result }
  } finally {
    await page.close()
  }
}

async function throughProxy(
  policy: ((nonce: string) => string) | undefined,
  head = '<title>app</title>',
): Promise<{ csp: string | undefined; result: ProbeResult; warnings: string[]; port: number }> {
  let count = 0
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', ...(policy ? { 'content-security-policy': policy(`n${++count}x`) } : {}) })
    res.end(`<!doctype html><html><head>${head}</head><body>app</body></html>`)
  })
  const proxy = await startProxy(upstream.port, {
    assets: new Map([
      ['hook.js', { body: PROBE, contentType: 'text/javascript' }],
      ['later.js', { body: 'window.__later = true', contentType: 'text/javascript' }],
    ]),
    onWebSocket: (socket) => socket.on('message', (data: RawData) => socket.send(`overlay:${data.toString()}`)),
  })
  const { csp, result } = await probe(proxy.url)
  return { csp, result, warnings: proxy.logs.filter((entry) => entry.level === 'warn').map((entry) => entry.message), port: proxy.port }
}

const WORKING = {
  ws: 'open',
  message: 'overlay:hi',
  laterScript: true,
  deferred: { ws: 'open', script: 'loaded' },
  // What the overlay may use works; what style-src blocks is blocked.
  styles: { constructable: true, insertRule: true, setProperty: true, styleElement: false, styleAttribute: false },
}

describe('6. Content-Security-Policy, in Chromium', () => {
  it("Chromium itself: 'self' covers the same-origin websocket, and CSSOM styling is not subject to style-src", async () => {
    // No proxy here: this pins down the browser behaviour the policy code relies on.
    const server = http.createServer((req, res) => {
      if (req.url === '/__primp/later.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' })
        res.end('window.__later = true')
        return
      }
      res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "default-src 'self'; script-src 'self' 'nonce-abc'; style-src 'none'" })
      res.end(`<!doctype html><html><head><script nonce="abc">${PROBE}</script></head><body>direct</body></html>`)
    })
    const sockets = new WebSocketServer({ server })
    sockets.on('connection', (socket) => socket.on('message', (data: RawData) => socket.send(`overlay:${data.toString()}`)))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    onCleanup(() => {
      for (const client of sockets.clients) client.terminate()
      server.closeAllConnections()
      server.close()
    })
    const { result } = await probe(`http://localhost:${(server.address() as AddressInfo).port}/`)
    expect(result).toMatchObject(WORKING)
    expect(result.violations.sort()).toEqual(['style-src-attr', 'style-src-elem'])
  })

  it('nonce + strict-dynamic (the Next.js shape): the reused nonce lets everything run, without a warning', async () => {
    const run = await throughProxy((nonce) => `default-src 'self'; script-src 'self' 'nonce-${nonce}' 'strict-dynamic'; style-src 'self' 'nonce-${nonce}'`)
    expect(run.csp).toBe(`default-src 'self'; script-src 'self' 'nonce-n1x' 'strict-dynamic'; style-src 'self' 'nonce-n1x'; connect-src 'self' ws://localhost:${run.port}`)
    expect(run.result).toMatchObject({ ...WORKING, nonceSeen: true })
    expect(run.result.violations.filter((directive) => !directive.startsWith('style-src'))).toEqual([])
    expect(run.warnings).toEqual([])
  })

  it("a policy with only 'self': nothing but the websocket source is added", async () => {
    const run = await throughProxy(() => "default-src 'self'")
    expect(run.csp).toBe(`default-src 'self'; connect-src 'self' ws://localhost:${run.port}`)
    expect(run.result).toMatchObject({ ...WORKING, nonceSeen: false })
    expect(run.warnings).toEqual([])
  })

  it('a policy that allows nothing of ours: the rewrite fallback makes it work and warns', async () => {
    const run = await throughProxy(() => "default-src 'none'; script-src https://cdn.example; style-src 'none'")
    expect(run.csp).toBe(`default-src 'none'; script-src https://cdn.example 'self'; style-src 'none'; connect-src ws://localhost:${run.port}`)
    expect(run.result).toMatchObject({ ...WORKING, nonceSeen: false })
    expect(run.warnings).toHaveLength(1)
  })

  it('strict-dynamic with hashes only: the generated nonce makes it work', async () => {
    const run = await throughProxy(() => "script-src 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' 'strict-dynamic'; connect-src 'none'")
    expect(run.csp).toMatch(/^script-src 'sha256-A+=' 'strict-dynamic' 'nonce-[A-Za-z0-9+/]{22}=='; connect-src ws:\/\/localhost:\d+$/)
    // This policy has no style-src, so here inline styles are allowed as well.
    expect(run.result).toMatchObject({ ...WORKING, nonceSeen: true, styles: { ...WORKING.styles, styleElement: true, styleAttribute: true } })
    expect(run.result.violations).toEqual([])
    expect(run.warnings).toHaveLength(1)
  })

  it('a meta CSP: the injected script runs because it precedes the meta, but the policy binds what it does next', async () => {
    const run = await throughProxy(undefined, `<meta http-equiv="Content-Security-Policy" content="script-src 'none'; connect-src 'none'"><title>app</title>`)
    // The hook ran, and so did everything it started synchronously, before the parser reached the meta.
    expect(run.result).toMatchObject({ ws: 'open', message: 'overlay:hi', laterScript: true })
    expect(run.result.styles.constructable).toBe(true)
    // Known limit, stated in csp.ts: the proxy does not edit a meta policy, so later work is bound by it.
    expect(run.result.deferred).toEqual({ ws: 'error', script: 'blocked' })
    expect(run.result.violations.sort()).toEqual(['connect-src', 'script-src-elem'])
  })
})
