import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import type { ClientMessage, ServerMessage } from '../../protocol/src/messages.ts'
import type { RpcResponse } from '../../protocol/src/rpc.ts'
import { SessionFileSchema, type PendingChanges, type SessionFile, type SessionSummary } from '../../protocol/src/session.ts'
import { isPortAnswering, startPrimp, type PrimpHandle, type StartPrimpOptions } from '../src/app.ts'
import { NAVIGATE, send, sleep } from './helpers.ts'
import { freeLowPort, hello, removeDir, structureItem, styleItem, tempDir } from './session-helpers.ts'

/**
 * `startPrimp` end to end without a browser: a scripted dev server, stub
 * bundles, a WebSocket client playing the page, and the control endpoint
 * called the way the MCP shim calls it.
 */

const PAGE = `<!doctype html>
<html>
  <head><title>App</title></head>
  <body>
    <h1 id="title">Hello</h1>
    <p>World</p>
  </body>
</html>
`

let work: string
let projectRoot: string
let sessionDir: string
let hookEntry: string
let overlayEntry: string
const running: PrimpHandle[] = []
const servers: (http.Server | net.Server)[] = []

beforeAll(() => {
  work = tempDir('app-test')
  projectRoot = join(work, 'shop')
  sessionDir = join(work, 'sessions')
  // A static project: the page the dev server serves is this file.
  mkdirSync(projectRoot, { recursive: true })
  writeFileSync(join(projectRoot, 'index.html'), PAGE)
  hookEntry = join(work, 'hook.ts')
  overlayEntry = join(work, 'overlay.ts')
  writeFileSync(hookEntry, 'window.__stubHook = true\ndeclare global { interface Window { __stubHook?: boolean } }\nexport {}\n')
  writeFileSync(overlayEntry, 'console.log("stub overlay")\n')
})

afterEach(async () => {
  while (running.length > 0) await running.pop()?.close()
  while (servers.length > 0) {
    const server = servers.pop()
    await new Promise<void>((resolve) => {
      server?.close(() => resolve())
      if (server instanceof http.Server) server.closeAllConnections()
    })
  }
})

afterAll(() => removeDir(work))

/** The dev server: serves the project's index.html on `/`. Listens on `::1` only, as Vite does, unless told otherwise. */
async function devServer(host = '::1', fixedPort?: number): Promise<number> {
  const port = fixedPort ?? (await freeLowPort())
  const server = http.createServer((req, res) => {
    if (req.url === '/') res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE)
    else res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve())
  })
  return (server.address() as net.AddressInfo).port
}

async function start(target: number, overrides: Partial<StartPrimpOptions> = {}): Promise<PrimpHandle & { logs: string[] }> {
  const logs: string[] = []
  const handle = await startPrimp({
    projectRoot,
    target,
    assets: { hookEntry, overlayEntry },
    sessionDir,
    handleSignals: false,
    version: '9.9.9',
    log: (level, message) => logs.push(`${level}: ${message}`),
    ...overrides,
  })
  running.push(handle)
  return Object.assign(handle, { logs })
}

/** The page's end of the overlay socket. */
class Page {
  readonly received: (ServerMessage | { type: string; [key: string]: unknown })[] = []
  closed: { code: number } | undefined
  private constructor(readonly socket: WebSocket) {}

  static open(handle: PrimpHandle, path = '/__primp/ws', origin = handle.url): Promise<Page> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://localhost:${handle.port}${path}`, { origin })
      const page = new Page(socket)
      socket.on('message', (data) => page.received.push(JSON.parse(String(data)) as ServerMessage))
      socket.on('close', (code) => (page.closed = { code }))
      socket.once('open', () => resolve(page))
      socket.once('error', reject)
      socket.once('unexpected-response', (_, response) => reject(new Error(`upgrade refused: ${response.statusCode}`)))
    })
  }

  send(message: ClientMessage | Record<string, unknown>): void {
    this.socket.send(JSON.stringify(message))
  }

  async next<T extends ServerMessage['type']>(type: T, after = 0): Promise<Extract<ServerMessage, { type: T }>> {
    for (let waited = 0; waited < 3000; waited += 10) {
      const found = this.received.filter((message) => message.type === type)[after]
      if (found !== undefined) return found as Extract<ServerMessage, { type: T }>
      await sleep(10)
    }
    throw new Error(`no ${type} message #${after}; got ${this.received.map((message) => message.type).join(', ')}`)
  }

  count(type: string): number {
    return this.received.filter((message) => message.type === type).length
  }
}

function readSessionFile(): SessionFile {
  const files = readdirSync(sessionDir).filter((name) => name.endsWith('.json'))
  expect(files).toHaveLength(1)
  return SessionFileSchema.parse(JSON.parse(readFileSync(join(sessionDir, files[0] as string), 'utf8')))
}

async function rpc<T>(file: SessionFile, method: string, params: unknown = {}, token = file.token): Promise<{ status: number; body: RpcResponse; result: T }> {
  const response = await fetch(`http://127.0.0.1:${file.controlPort}/rpc`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ method, params }),
  })
  const body = (await response.json()) as RpcResponse
  return { status: response.status, body, result: (body.ok ? body.result : undefined) as T }
}

describe('startPrimp', () => {
  it('serves the app through the proxy with the hook as the first script, and both bundles uncached', async () => {
    const target = await devServer()
    const primp = await start(target)
    expect(primp.target).toBe(`http://localhost:${target}`)
    expect(primp.url).toBe(`http://localhost:${primp.port}`)
    expect(primp.framework).toBe('static')

    const page = await send(primp.port, { headers: NAVIGATE })
    expect(page.status).toBe(200)
    const tag = `<script src="/__primp/hook.js?v=${primp.assets.hook.hash}" data-primp></script>`
    expect(page.text).toContain(`<head>${tag}<title>App</title>`)
    expect(page.text.match(/<script/g)).toHaveLength(1)

    for (const [path, asset] of [
      [`/__primp/hook.js?v=${primp.assets.hook.hash}`, primp.assets.hook],
      ['/__primp/overlay.js', primp.assets.overlay],
    ] as const) {
      const response = await send(primp.port, { path })
      expect(response.status, path).toBe(200)
      expect(response.headers['cache-control']).toBe('no-store')
      expect(response.headers['content-type']).toBe('text/javascript; charset=utf-8')
      expect(response.text).toBe(asset.code)
    }
    expect(primp.assets.hook.code).toContain('__stubHook')
    expect((await send(primp.port, { path: '/__primp/nothing.js' })).status).toBe(404)
    // The app fetching its own HTML is not a navigation: passed through untouched.
    expect((await send(primp.port, { path: '/', headers: { 'sec-fetch-dest': 'empty', accept: '*/*' } })).text).toBe(PAGE)
  })

  it('hands the one overlay socket to the settle detector and to the session', async () => {
    const primp = await start(await devServer())
    const page = await Page.open(primp)
    page.send({ type: 'settle:hello', doc: 'doc-1', url: `${primp.url}/`, timeOrigin: Date.now() - 50, at: Date.now() })
    page.send(hello('doc-1'))
    const state = await page.next('session:state')
    expect(state.info).toEqual({ target: primp.target, framework: 'static', projectName: 'shop', version: '9.9.9' })
    expect(state.items).toEqual([])
    // The detector calibrates its clock with a probe as soon as a document says hello.
    for (let waited = 0; waited < 2000 && page.count('settle:probe') === 0; waited += 10) await sleep(10)
    expect(page.count('settle:probe')).toBeGreaterThan(0)
    expect(primp.detector.status().browsers).toBe(1)
    expect(primp.session.documents().map((document) => document.doc)).toEqual(['doc-1'])

    page.socket.close()
    for (let waited = 0; waited < 2000 && primp.session.documents().length > 0; waited += 10) await sleep(10)
    expect(primp.session.documents()).toEqual([])
    expect(primp.detector.status().browsers).toBe(0)
  })

  it('refuses overlay sockets from other origins and closes sockets on unknown primp paths', async () => {
    const primp = await start(await devServer())
    await expect(Page.open(primp, '/__primp/ws', 'http://evil.example')).rejects.toThrow(/upgrade refused: 403/)
    const stray = await Page.open(primp, '/__primp/other')
    for (let waited = 0; waited < 2000 && stray.closed === undefined; waited += 10) await sleep(10)
    expect(stray.closed).toEqual({ code: 1008 })
    expect(primp.session.documents()).toEqual([])
  })

  it('resolves an element of the project over the socket with the real resolver', async () => {
    const primp = await start(await devServer())
    const page = await Page.open(primp)
    page.send(hello('doc-1'))
    await page.next('session:state')
    page.send({
      type: 'session:resolve',
      reqId: 'r1',
      evidence: {
        context: {
          tag: 'h1',
          id: 'title',
          classes: [],
          attrs: {},
          ownText: 'Hello',
          text: 'Hello',
          path: [
            { tag: 'html', index: 0, ofType: 0, ofTypeCount: 1 },
            { tag: 'body', index: 1, ofType: 0, ofTypeCount: 1 },
            { tag: 'h1', index: 0, ofType: 0, ofTypeCount: 1, id: 'title' },
          ],
          pagePath: '/',
          pageOrigin: primp.url,
          pageLoadedAt: Date.now(),
        },
        hints: [],
        collectMs: 0.1,
      },
    })
    const resolved = await page.next('session:resolved')
    expect(resolved).toMatchObject({ reqId: 'r1', source: { file: 'index.html', line: 5, col: 5, framework: 'html', level: 'exact', verifiedOnDisk: true, via: 'html-path' } })
    expect(resolved.source).not.toHaveProperty('resolveMs')
  })

  it('writes a session file the shim can use, and answers the three control methods', async () => {
    const primp = await start(await devServer())
    const file = readSessionFile()
    expect(file).toMatchObject({ pid: process.pid, controlPort: primp.controlPort, proxyUrl: primp.url, projectRoot: primp.projectRoot })
    expect(primp.sessionFile.startsWith(sessionDir)).toBe(true)

    expect((await rpc<SessionSummary>(file, 'get_session')).result).toEqual({ target: primp.target, framework: 'static', browserConnected: false, counts: {} })
    expect((await rpc(file, 'get_session', {}, 'x'.repeat(43))).status).toBe(401)
    expect((await rpc<PendingChanges>(file, 'get_pending_changes')).result).toEqual({ batchIds: [], count: 0, files: [], prompt: '', claimedAt: null })

    const page = await Page.open(primp)
    page.send(hello('doc-1'))
    page.send({ type: 'session:upsert', item: styleItem('one', 'index.html') })
    page.send({ type: 'session:upsert', item: structureItem('two', 'index.html') })
    page.send({ type: 'session:send', reqId: 's1', ids: ['one', 'two'] })
    const sent = await page.next('session:sent')
    expect(sent.batch.items.map((item) => item.status)).toEqual(['queued', 'queued'])
    expect((await rpc<SessionSummary>(file, 'get_session')).result).toMatchObject({ browserConnected: true, counts: { queued: 2 } })

    const journalBefore = primp.detector.mark().seq
    const pending = (await rpc<PendingChanges>(file, 'get_pending_changes')).result
    expect(pending.count).toBe(2)
    expect(pending.batchIds).toEqual([sent.batch.batchId])
    expect(pending.files).toHaveLength(1)
    expect(pending.files[0]?.file).toBe('index.html')
    expect(pending.files[0]?.items.map((item) => [item.id, item.status])).toEqual([
      ['one', 'claimed'],
      ['two', 'claimed'],
    ])
    expect(pending.prompt.length).toBeGreaterThan(0)
    // The batch is anchored at the settle detector's journal position of that moment.
    const batch = primp.session.batch(sent.batch.batchId)
    expect(batch?.claimedAt).toBe(pending.claimedAt)
    expect(batch?.claimMark?.seq).toBeGreaterThanOrEqual(journalBefore)
    expect(batch?.claimMark?.seq).toBeLessThanOrEqual(primp.detector.mark().seq)

    const bad = await rpc(file, 'dismiss_change', { id: 'one' })
    expect([bad.status, bad.body.ok]).toEqual([422, false])
    const dismissed = await rpc<{ dismissed: boolean; status: string }>(file, 'dismiss_change', { id: 'one', reason: 'not ours to change' })
    expect(dismissed.result).toMatchObject({ id: 'one', dismissed: true, status: 'dismissed' })
    const missing = await rpc<{ dismissed: boolean }>(file, 'dismiss_change', { id: 'nope', reason: 'x' })
    expect([missing.status, missing.result.dismissed]).toEqual([200, false])

    // The page saw every change of state: draft x2 (after hello), queued, claimed, dismissed.
    for (let waited = 0; waited < 2000 && page.count('session:state') < 6; waited += 10) await sleep(10)
    const last = page.received.filter((message) => message.type === 'session:state').at(-1) as Extract<ServerMessage, { type: 'session:state' }>
    expect(last.items.map((item) => [item.id, item.status, item.dismissReason])).toEqual([
      ['one', 'dismissed', 'not ours to change'],
      ['two', 'claimed', undefined],
    ])
  })

  it('takes the port after the dev server, skips ports that are taken, and refuses a taken --port', async () => {
    const target = await devServer('127.0.0.1')

    const first = await start(target)
    expect(first.port).toBe(target + 1)
    // While the first proxy holds target + 1, a second primp moves on.
    const second = await start(target)
    expect(second.port).toBeGreaterThan(target + 1)
    expect(second.port).toBeLessThanOrEqual(target + 20)

    await expect(start(target, { port: first.port })).rejects.toThrow(`port ${first.port} is already in use`)
    // A failed start leaves no session file behind: two running, two files.
    expect(readdirSync(sessionDir).filter((name) => name.endsWith('.json'))).toHaveLength(2)

    const free = await freeLowPort()
    const third = await start(target, { port: free })
    expect(third.port).toBe(free)
  })

  it('does not take a port another program holds on the wildcard address, although binding loopback there would succeed', async () => {
    const target = await devServer('127.0.0.1')
    // An API server next to the dev server, listening the way Node servers usually do: on every address.
    const api = http.createServer((_, res) => res.end('api'))
    servers.push(api)
    await new Promise<void>((resolve) => api.listen(target + 1, () => resolve()))
    expect(await isPortAnswering(target + 1)).toBe(true)
    expect(await isPortAnswering(target + 2)).toBe(false)

    const primp = await start(target)
    expect(primp.port).toBe(target + 2)
    // The API server still answers on its port, on both loopback families.
    for (const host of ['127.0.0.1', '[::1]']) expect(await (await fetch(`http://${host}:${target + 1}/`)).text()).toBe('api')
    await expect(start(target, { port: target + 1 })).rejects.toThrow(`port ${target + 1} is already in use`)
    expect(await (await fetch(`http://localhost:${target + 1}/`)).text()).toBe('api')
  })

  it('close() removes the session file, frees both ports, drops sockets and is safe to repeat', async () => {
    const primp = await start(await devServer())
    const page = await Page.open(primp)
    page.send(hello('doc-1'))
    await page.next('session:state')
    const pending = primp.session.measure([], 10_000)
    expect(existsSync(primp.sessionFile)).toBe(true)

    await Promise.all([primp.close(), primp.close()])
    expect(existsSync(primp.sessionFile)).toBe(false)
    expect(await pending).toEqual({ status: 'disconnected', doc: 'doc-1' })
    for (let waited = 0; waited < 2000 && page.closed === undefined; waited += 10) await sleep(10)
    expect(page.closed).toBeDefined()
    await expect(send(primp.port)).rejects.toThrow(/ECONNREFUSED/)
    await expect(fetch(`http://127.0.0.1:${primp.controlPort}/rpc`, { method: 'POST' })).rejects.toThrow()
    expect(primp.detector.status().journal).toBeGreaterThanOrEqual(0)
    await primp.close()
  })

  it('installs signal handlers only when asked, and removes them on close', async () => {
    const before = { int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') }
    const quiet = await start(await devServer())
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual([before.int, before.term])
    await quiet.close()
    const handled = await start(await devServer(), { handleSignals: true })
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual([before.int + 1, before.term + 1])
    await handled.close()
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual([before.int, before.term])
  })

  it('rejects, leaving nothing running, when the project or a bundle is missing', async () => {
    const target = await devServer()
    await expect(startPrimp({ projectRoot: join(work, 'no-such-dir'), target, assets: { hookEntry, overlayEntry }, sessionDir, handleSignals: false })).rejects.toThrow(/project directory not found/)
    await expect(startPrimp({ projectRoot, target, assets: { hookEntry: join(work, 'missing.ts'), overlayEntry }, sessionDir, handleSignals: false })).rejects.toThrow(/could not build hook\.js/)
    await expect(startPrimp({ projectRoot, target: 'nonsense://x', assets: { hookEntry, overlayEntry }, sessionDir, handleSignals: false })).rejects.toThrow(/cannot read/)
    expect(existsSync(sessionDir) ? readdirSync(sessionDir).filter((name) => name.endsWith('.json')) : []).toEqual([])
  })

  it('shows the "not reachable" page, with the hook, while the dev server is down', async () => {
    const free = await freeLowPort()
    const primp = await start(free)
    const page = await send(primp.port, { headers: NAVIGATE })
    expect(page.status).toBe(502)
    expect(page.text).toContain('Dev server not reachable')
    expect(page.text).toContain(`/__primp/hook.js?v=${primp.assets.hook.hash}`)
  })
})
