import http from 'node:http'
import https from 'node:https'
import net, { type AddressInfo } from 'node:net'
import { networkInterfaces } from 'node:os'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { getFreePort, type FrameDirection } from '../src/index.ts'
import { HOOK_TAG, NAVIGATE, onCleanup, runCleanups, selfSignedCertificate, send, sleep, startProxy, startUpstream } from './helpers.ts'

afterEach(runCleanups)

const PAGE = '<!doctype html><html><head><title>t</title></head><body>secure</body></html>'
const INJECTED = PAGE.replace('<head>', `<head>${HOOK_TAG}`)

async function until(condition: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await sleep(5)
  }
}

/** A raw TCP server; `onConnection` scripts each connection by its index. */
async function startRaw(onConnection: (socket: net.Socket, index: number) => void): Promise<{ port: number; connections: () => number }> {
  let count = 0
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    onConnection(socket, count++)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  onCleanup(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  )
  return { port: (server.address() as AddressInfo).port, connections: () => count }
}

describe('7. HTTPS upstream and loopback address fallback', () => {
  let tls: { key: string; cert: string }
  beforeAll(() => {
    tls = selfSignedCertificate()
  })

  it('proxies an HTTPS upstream on localhost that has a self-signed certificate', async () => {
    const upstream = await startUpstream(
      (req, res) => {
        if (req.url === '/redirect') {
          res.writeHead(302, { location: `https://${req.headers.host}/landing` })
          res.end()
        } else if (req.method === 'POST') {
          const parts: Buffer[] = []
          req.on('data', (chunk: Buffer) => parts.push(chunk))
          req.on('end', () => res.end(`posted:${Buffer.concat(parts).toString()}:${String(req.headers['x-forwarded-proto'])}`))
        } else {
          res.writeHead(200, { 'content-type': 'text/html' })
          res.end(PAGE)
        }
      },
      { tls },
    )
    // Without the proxy, a verifying client refuses this certificate.
    await expect(
      new Promise((resolve, reject) => {
        https.get({ host: '127.0.0.1', port: upstream.port, path: '/', agent: false }, resolve).on('error', reject)
      }),
    ).rejects.toMatchObject({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })

    const proxy = await startProxy(upstream.port, { target: { protocol: 'https', host: 'localhost', port: upstream.port } })
    const page = await send(proxy.port, { headers: NAVIGATE })
    expect(page.status).toBe(200)
    expect(page.text).toBe(INJECTED)
    const posted = await send(proxy.port, { method: 'POST', headers: { 'content-length': '5' }, body: 'hello' })
    expect(posted.text).toBe('posted:hello:http')
    // The upstream built an https URL from the forwarded Host; the browser must stay on the proxy's scheme.
    expect((await send(proxy.port, { path: '/redirect' })).headers.location).toBe(`http://localhost:${proxy.port}/landing`)
    // Several requests reuse the TLS connection.
    for (let i = 0; i < 5; i++) expect((await send(proxy.port, { headers: NAVIGATE })).text).toBe(INJECTED)
  })

  it('tunnels a websocket to an HTTPS upstream', async () => {
    const upstream = await startUpstream((_req, res) => res.end('ok'), { tls })
    const sockets = new WebSocketServer({ server: upstream.server })
    sockets.on('connection', (socket) => socket.on('message', (data: RawData) => socket.send(`secure-echo:${data.toString()}`)))
    onCleanup(() => {
      for (const client of sockets.clients) client.terminate()
      sockets.close()
    })
    const seen: [FrameDirection, string | undefined][] = []
    const proxy = await startProxy(upstream.port, {
      target: { protocol: 'https', host: '127.0.0.1', port: upstream.port },
      onUpgradeFrame: (direction, _info, message) => seen.push([direction, message.text]),
    })
    const socket = new WebSocket(`ws://localhost:${proxy.port}/hmr`)
    onCleanup(() => socket.terminate())
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })
    const reply = new Promise<string>((resolve) => socket.once('message', (data: RawData) => resolve(data.toString())))
    socket.send('over tls')
    expect(await reply).toBe('secure-echo:over tls')
    expect(seen).toEqual([
      ['client-to-upstream', 'over tls'],
      ['upstream-to-client', 'secure-echo:over tls'],
    ])
  })

  const lanAddress = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry !== undefined && !entry.internal && entry.family === 'IPv4')?.address

  // Needs an address of this machine that is not loopback; without a network interface there is none to test with.
  it.skipIf(lanAddress === undefined)('still verifies certificates for targets that are not loopback', async () => {
    const upstream = await startUpstream(
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(PAGE)
      },
      { tls, host: '0.0.0.0' },
    )
    const host = lanAddress ?? ''
    const proxy = await startProxy(upstream.port, { target: { protocol: 'https', host, port: upstream.port } })
    const response = await send(proxy.port, { headers: NAVIGATE })
    expect(response.status).toBe(502)
    expect(response.text).toMatch(/DEPTH_ZERO_SELF_SIGNED_CERT|ERR_TLS_CERT_ALTNAME_INVALID/)
    expect(response.text).not.toContain('secure')
    expect(upstream.seen).toHaveLength(0)
    // The same certificate through the loopback address is accepted.
    const local = await startProxy(upstream.port, { target: { protocol: 'https', host: '127.0.0.1', port: upstream.port } })
    expect((await send(local.port, { headers: NAVIGATE })).text).toBe(INJECTED)
  })

  it('reaches an upstream bound to the other loopback family', async () => {
    const cases: [bound: string, configured: string][] = [
      ['::1', '127.0.0.1'],
      ['127.0.0.1', '::1'],
      ['127.0.0.1', '[::1]'],
      ['::1', 'localhost'],
      ['127.0.0.1', 'localhost'],
    ]
    for (const [bound, configured] of cases) {
      const upstream = await startUpstream((req, res) => res.end(`bound:${bound}:${req.url}`), { host: bound })
      const proxy = await startProxy(upstream.port, { target: { protocol: 'http', host: configured, port: upstream.port } })
      const label = `upstream on ${bound}, target ${configured}`
      expect((await send(proxy.port, { path: '/one' })).text, label).toBe(`bound:${bound}:/one`)
      // Bodies survive the retry on the second address, and so do later requests.
      const posted = await send(proxy.port, { path: '/two', method: 'POST', headers: { 'content-length': '4' }, body: 'data' })
      expect(posted.text, label).toBe(`bound:${bound}:/two`)
      expect((await send(proxy.port, { path: '/three' })).text, label).toBe(`bound:${bound}:/three`)
    }
  })

  it('tunnels a websocket to an upstream bound to the other loopback family', async () => {
    const upstream = await startUpstream((_req, res) => res.end('ok'), { host: '::1' })
    const sockets = new WebSocketServer({ server: upstream.server })
    sockets.on('connection', (socket) => socket.send('hello from ::1'))
    onCleanup(() => {
      for (const client of sockets.clients) client.terminate()
      sockets.close()
    })
    const proxy = await startProxy(upstream.port, { target: { protocol: 'http', host: '127.0.0.1', port: upstream.port } })
    const socket = new WebSocket(`ws://localhost:${proxy.port}/hmr`)
    onCleanup(() => socket.terminate())
    const greeting = await new Promise<string>((resolve, reject) => {
      socket.once('message', (data: RawData) => resolve(data.toString()))
      socket.once('error', reject)
    })
    expect(greeting).toBe('hello from ::1')
  })
})

describe('9. robustness', () => {
  it('answers a navigation with a small 502 page that carries the overlay scripts', async () => {
    const deadPort = await getFreePort()
    const proxy = await startProxy(deadPort)
    const response = await send(proxy.port, { path: '/dashboard', headers: NAVIGATE })
    expect(response.status).toBe(502)
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.text).toContain(`<head>${HOOK_TAG}`)
    expect(response.text).toContain(`http://127.0.0.1:${deadPort}`)
    expect(response.text).toContain('ECONNREFUSED')
    expect(response.text).toContain('http-equiv="refresh"')
    expect(response.body.length).toBeLessThan(2000)
    // The assets the page points at are still served.
    expect((await send(proxy.port, { path: '/__primp/hook.js' })).status).toBe(200)
  })

  it('answers other requests with a plain 502', async () => {
    const proxy = await startProxy(await getFreePort())
    const response = await send(proxy.port, { path: '/api/data', headers: { accept: 'application/json', 'sec-fetch-dest': 'empty' } })
    expect(response.status).toBe(502)
    expect(response.headers['content-type']).toBe('text/plain; charset=utf-8')
    expect(response.text).toMatch(/could not reach the dev server .*ECONNREFUSED/)
    const posted = await send(proxy.port, { method: 'POST', headers: { 'content-length': '3', 'sec-fetch-dest': 'empty' }, body: 'abc' })
    expect(posted.status).toBe(502)
    const head = await send(proxy.port, { method: 'HEAD', headers: NAVIGATE })
    expect(head.status).toBe(502)
    expect(head.body.length).toBe(0)
  })

  it('recovers when the dev server comes up, and when it restarts', async () => {
    const port = await getFreePort()
    const proxy = await startProxy(port)
    expect((await send(proxy.port, { headers: NAVIGATE })).status).toBe(502)

    const start = async (label: string): Promise<http.Server> => {
      const server = http.createServer((_req, res) => res.end(label))
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => resolve())
      })
      return server
    }
    const stop = (server: http.Server): Promise<void> =>
      new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })

    const first = await start('first run')
    expect((await send(proxy.port)).text).toBe('first run')
    await stop(first)
    expect((await send(proxy.port)).status).toBe(502)
    const second = await start('second run')
    onCleanup(() => stop(second))
    expect((await send(proxy.port)).text).toBe('second run')
  })

  it('retries a bodiless request once when a reused connection turns out dead', async () => {
    const answer = 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\nKeep-Alive: timeout=30\r\n\r\nok'
    const raw = await startRaw((socket, index) => {
      let requests = 0
      socket.on('data', () => {
        requests++
        // The first connection serves one request, then dies under the second.
        if (index === 0 && requests > 1) socket.destroy()
        else socket.write(answer)
      })
    })
    const proxy = await startProxy(raw.port)
    expect((await send(proxy.port, { path: '/a' })).text).toBe('ok')
    expect(raw.connections()).toBe(1)
    const second = await send(proxy.port, { path: '/b' })
    expect(second.status).toBe(200)
    expect(second.text).toBe('ok')
    expect(raw.connections()).toBe(2)
  })

  it('never sends a request with a body on a reused connection', async () => {
    const answer = 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nok'
    const raw = await startRaw((socket) => {
      socket.on('data', (chunk) => {
        if (chunk.includes('\r\n\r\n')) socket.write(answer)
      })
    })
    const proxy = await startProxy(raw.port)
    await send(proxy.port, { path: '/warm' })
    await send(proxy.port, { path: '/warm' })
    expect(raw.connections()).toBe(1)
    await send(proxy.port, { method: 'POST', headers: { 'content-length': '4' }, body: 'data' })
    await send(proxy.port, { method: 'POST', headers: { 'content-length': '4' }, body: 'data' })
    expect(raw.connections()).toBe(3)
  })

  it('answers 502 when the upstream closes without answering or answers nonsense', async () => {
    const silent = await startRaw((socket) => socket.on('data', () => socket.destroy()))
    const proxyA = await startProxy(silent.port)
    const first = await send(proxyA.port, { headers: { 'sec-fetch-dest': 'empty' } })
    expect(first.status).toBe(502)

    const nonsense = await startRaw((socket) => socket.on('data', () => socket.end('this is not http\r\n\r\n')))
    const proxyB = await startProxy(nonsense.port)
    const second = await send(proxyB.port, { headers: { 'sec-fetch-dest': 'empty' } })
    expect(second.status).toBe(502)
    expect(second.text).toMatch(/HPE_INVALID_CONSTANT|could not reach/)
  })

  it('propagates a client abort to the upstream, for streamed pages and other responses', async () => {
    for (const type of ['text/html', 'application/octet-stream']) {
      let upstreamClosed = false
      let upstreamFinished = false
      const upstream = await startUpstream((_req, res) => {
        res.writeHead(200, { 'content-type': type })
        res.write('<!doctype html><html><head></head><body>first')
        res.on('close', () => {
          upstreamClosed = true
          upstreamFinished = res.writableFinished
        })
      })
      const proxy = await startProxy(upstream.port)
      await new Promise<void>((resolve, reject) => {
        const request = http.get({ host: '127.0.0.1', port: proxy.port, headers: { host: `localhost:${proxy.port}`, ...NAVIGATE }, agent: false }, (response) => {
          response.on('error', () => {})
          response.once('data', () => {
            request.destroy()
            resolve()
          })
        })
        request.on('error', reject)
      })
      await until(() => upstreamClosed, `upstream to notice the abort (${type})`)
      expect(upstreamFinished, type).toBe(false)
    }
  })

  it('propagates a client abort while the upstream is still thinking', async () => {
    let upstreamClosed = false
    const upstream = await startUpstream((req) => {
      // Never answers.
      req.socket.on('close', () => (upstreamClosed = true))
    })
    const proxy = await startProxy(upstream.port)
    const request = http.get({ host: '127.0.0.1', port: proxy.port, path: '/slow', headers: { host: `localhost:${proxy.port}` }, agent: false })
    request.on('error', () => {})
    await until(() => upstream.seen.length === 1, 'request upstream')
    expect(upstreamClosed).toBe(false)
    request.destroy()
    await until(() => upstreamClosed, 'upstream connection to close')
  })

  it('propagates a client abort during an upload', async () => {
    let received = 0
    let aborted = false
    const upstream = await startUpstream((req, res) => {
      req.on('data', (chunk: Buffer) => (received += chunk.length))
      req.on('error', () => (aborted = true))
      req.on('aborted', () => (aborted = true))
      req.on('end', () => res.end('complete'))
    })
    const proxy = await startProxy(upstream.port)
    const request = http.request({ host: '127.0.0.1', port: proxy.port, method: 'POST', headers: { host: `localhost:${proxy.port}`, 'content-length': '1000000' }, agent: false })
    request.on('error', () => {})
    request.write(Buffer.alloc(1000, 0x61))
    await until(() => received === 1000, 'first part upstream')
    request.destroy()
    await until(() => aborted, 'upstream to notice the abort')
    expect(received).toBe(1000)
  })

  it('cuts the response when the upstream dies midway, and keeps serving', async () => {
    const upstream = await startUpstream((req, res) => {
      if (req.url === '/ok') {
        res.end('fine')
        return
      }
      res.writeHead(200, { 'content-type': req.url === '/page' ? 'text/html' : 'text/plain', 'content-length': '100000' })
      res.write('<!doctype html><html><head></head><body>partial')
      setTimeout(() => res.socket?.destroy(), 50)
    })
    const proxy = await startProxy(upstream.port)
    for (const path of ['/page', '/file']) {
      // The client must see a broken response, not a complete-looking short one.
      await expect(send(proxy.port, { path, headers: NAVIGATE }), path).rejects.toMatchObject({ code: 'ECONNRESET' })
    }
    expect((await send(proxy.port, { path: '/ok' })).text).toBe('fine')
  })

  it('answers a malformed request with 400 and keeps serving', async () => {
    const upstream = await startUpstream((_req, res) => res.end('fine'))
    const proxy = await startProxy(upstream.port)
    const reply = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = []
      const socket = net.connect({ host: '127.0.0.1', port: proxy.port }, () => socket.write('NOT A REQUEST\r\n\r\n'))
      socket.on('data', (chunk) => chunks.push(chunk))
      socket.on('close', () => resolve(Buffer.concat(chunks).toString()))
      socket.on('error', reject)
    })
    expect(reply.startsWith('HTTP/1.1 400 Bad Request')).toBe(true)
    // A connection that is reset right after connecting must not matter either.
    await new Promise<void>((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port: proxy.port }, () => {
        socket.write('GET / HTTP/1.1\r\nHost: localh')
        socket.resetAndDestroy()
        resolve()
      })
      socket.on('error', () => resolve())
    })
    await sleep(20)
    expect((await send(proxy.port)).text).toBe('fine')
  })

  it('close() stops listening, ends idle and active connections, and can be called twice', async () => {
    const upstream = await startUpstream((req, res) => {
      if (req.url === '/hang') res.writeHead(200, { 'content-type': 'text/plain' }).write('started')
      else res.end('ok')
    })
    const proxy = await startProxy(upstream.port)
    expect((await send(proxy.port)).text).toBe('ok')
    const hanging = send(proxy.port, { path: '/hang' })
    hanging.catch(() => {})
    await until(() => upstream.seen.length === 2, 'hanging request upstream')
    const started = performance.now()
    await Promise.all([proxy.close(), proxy.close()])
    expect(performance.now() - started).toBeLessThan(1000)
    await expect(hanging).rejects.toBeDefined()
    await expect(send(proxy.port)).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    await expect(send(proxy.port, { address: '::1' })).rejects.toMatchObject({ code: 'ECONNREFUSED' })
  })
})
