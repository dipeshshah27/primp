import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import net, { type AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { getFreePort } from '../src/index.ts'
import { HOOK, NAVIGATE, onCleanup, rawValues, runCleanups, send, sleep, startProxy, startUpstream } from './helpers.ts'

afterEach(runCleanups)

describe('1. plain reverse proxy', () => {
  it('relays status, reason, headers and body without changing them', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.sendDate = false
      res.writeHead(201, 'Made It', [
        'Content-Type', 'application/json',
        'X-MiXed-Case', 'one',
        'x-repeat', 'a',
        'x-repeat', 'b',
        'Cache-Control', 'max-age=60',
        'ETag', '"v1"',
        'Content-Length', '11',
      ])
      res.end('{"ok":true}')
    })
    const proxy = await startProxy(upstream.port)
    const response = await send(proxy.port, { path: '/api/thing?x=1' })

    expect(response.status).toBe(201)
    expect(response.statusMessage).toBe('Made It')
    expect(response.text).toBe('{"ok":true}')
    expect(upstream.seen[0]?.url).toBe('/api/thing?x=1')
    // Same names, casing, order and repeats as the upstream sent; only connection management differs.
    const relayed = response.rawHeaders.filter((_, index, all) => {
      const name = (index % 2 === 0 ? all[index] : all[index - 1])?.toLowerCase()
      return name !== 'connection' && name !== 'keep-alive'
    })
    expect(relayed).toEqual([
      'Content-Type', 'application/json',
      'X-MiXed-Case', 'one',
      'x-repeat', 'a',
      'x-repeat', 'b',
      'Cache-Control', 'max-age=60',
      'ETag', '"v1"',
      'Content-Length', '11',
    ])
  })

  it('streams a non-HTML response: the first chunk arrives before the second is produced', async () => {
    let secondProducedAt = 0
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: one\n\n')
      setTimeout(() => {
        secondProducedAt = performance.now()
        res.end('data: two\n\n')
      }, 1000)
    })
    const proxy = await startProxy(upstream.port)
    const response = await send(proxy.port, { path: '/events', headers: { accept: 'text/event-stream' } })

    expect(response.text).toBe('data: one\n\ndata: two\n\n')
    expect(response.chunks.length).toBeGreaterThanOrEqual(2)
    const first = response.chunks[0]
    expect(first?.data.toString()).toBe('data: one\n\n')
    expect(first?.at).toBeLessThan(secondProducedAt)
    expect(secondProducedAt - (first?.at ?? 0)).toBeGreaterThan(800)
  })

  it('sends response headers before any body exists', async () => {
    let release: () => void = () => {}
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.flushHeaders()
      release = () => res.end('data: late\n\n')
    })
    const proxy = await startProxy(upstream.port)
    const gotHeaders = await new Promise<http.IncomingMessage>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port: proxy.port, path: '/events', headers: { host: `localhost:${proxy.port}` }, agent: false }, resolve)
        .on('error', reject)
    })
    // The upstream has not written a single body byte yet.
    expect(gotHeaders.statusCode).toBe(200)
    expect(gotHeaders.headers['content-type']).toBe('text/event-stream')
    release()
    const chunks: Buffer[] = []
    for await (const chunk of gotHeaders) chunks.push(chunk as Buffer)
    expect(Buffer.concat(chunks).toString()).toBe('data: late\n\n')
  })

  it('relays a POST body with a known length', async () => {
    const upstream = await startUpstream((req, res) => {
      const hash = createHash('sha256')
      let size = 0
      req.on('data', (chunk: Buffer) => {
        hash.update(chunk)
        size += chunk.length
      })
      req.on('end', () => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ size, sha: hash.digest('hex'), length: req.headers['content-length'], type: req.headers['content-type'] }))
      })
    })
    const proxy = await startProxy(upstream.port)
    const body = randomBytes(5 * 1024 * 1024)
    const response = await send(proxy.port, {
      method: 'POST',
      path: '/upload',
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(body.length) },
      body,
    })
    expect(JSON.parse(response.text)).toEqual({
      size: body.length,
      sha: createHash('sha256').update(body).digest('hex'),
      length: String(body.length),
      type: 'application/octet-stream',
    })
  })

  it('streams a chunked request body: the upstream has the first part before the second is written', async () => {
    let firstPartSeenAt = 0
    const upstream = await startUpstream((req, res) => {
      const parts: Buffer[] = []
      req.on('data', (chunk: Buffer) => {
        if (firstPartSeenAt === 0) firstPartSeenAt = performance.now()
        parts.push(chunk)
      })
      req.on('end', () => res.end(`${req.headers['transfer-encoding']}|${Buffer.concat(parts).toString()}`))
    })
    const proxy = await startProxy(upstream.port)
    let secondPartWrittenAt = 0
    const response = await send(proxy.port, {
      method: 'POST',
      path: '/stream-up',
      headers: { 'content-type': 'text/plain' },
      onRequest(request) {
        request.write('part-one;')
        setTimeout(() => {
          secondPartWrittenAt = performance.now()
          request.end('part-two')
        }, 600)
      },
    })
    expect(response.text).toBe('chunked|part-one;part-two')
    expect(firstPartSeenAt).toBeGreaterThan(0)
    expect(firstPartSeenAt).toBeLessThan(secondPartWrittenAt)
    expect(secondPartWrittenAt - firstPartSeenAt).toBeGreaterThan(400)
  })

  it('lets the upstream answer while the request body is still open', async () => {
    const upstream = await startUpstream((req, res) => {
      req.once('data', (chunk: Buffer) => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.write(`early:${chunk.toString()}`)
      })
      req.on('end', () => res.end('|done'))
    })
    const proxy = await startProxy(upstream.port)
    let endedAt = 0
    const response = await send(proxy.port, {
      method: 'POST',
      onRequest(request) {
        request.write('ping')
        setTimeout(() => {
          endedAt = performance.now()
          request.end()
        }, 500)
      },
    })
    expect(response.text).toBe('early:ping|done')
    expect(response.chunks[0]?.at).toBeLessThan(endedAt)
  })

  it('passes compressed non-document responses through untouched', async () => {
    const script = 'console.log("<head>")'.repeat(200)
    const compressed = gzipSync(script)
    const upstream = await startUpstream((req, res) => {
      res.writeHead(200, {
        'content-type': 'text/javascript',
        'content-encoding': 'gzip',
        'content-length': compressed.length,
        'x-saw-accept-encoding': String(req.headers['accept-encoding']),
      })
      res.end(compressed)
    })
    const proxy = await startProxy(upstream.port)
    const response = await send(proxy.port, {
      path: '/app.js',
      headers: { 'accept-encoding': 'gzip, br', 'sec-fetch-dest': 'script', accept: '*/*' },
    })
    expect(response.headers['x-saw-accept-encoding']).toBe('gzip, br')
    expect(response.headers['content-encoding']).toBe('gzip')
    expect(response.headers['content-length']).toBe(String(compressed.length))
    expect(response.body.equals(compressed)).toBe(true)
  })

  it('passes conditional requests and 304 through for non-documents', async () => {
    const upstream = await startUpstream((req, res) => {
      if (req.headers['if-none-match'] === '"v7"') {
        res.writeHead(304, { etag: '"v7"' })
        res.end()
        return
      }
      res.writeHead(200, { etag: '"v7"', 'content-type': 'text/css' })
      res.end('body{}')
    })
    const proxy = await startProxy(upstream.port)
    const fresh = await send(proxy.port, { path: '/a.css', headers: { 'sec-fetch-dest': 'style' } })
    expect(fresh.status).toBe(200)
    expect(fresh.headers.etag).toBe('"v7"')
    const cached = await send(proxy.port, { path: '/a.css', headers: { 'sec-fetch-dest': 'style', 'if-none-match': '"v7"' } })
    expect(cached.status).toBe(304)
    expect(cached.headers.etag).toBe('"v7"')
    expect(cached.body.length).toBe(0)
  })

  it('relays HEAD and bodiless statuses', async () => {
    const upstream = await startUpstream((req, res) => {
      if (req.url === '/gone') {
        res.writeHead(204, { 'x-kind': 'empty' })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': '1234' })
      res.end(req.method === 'HEAD' ? undefined : Buffer.alloc(1234))
    })
    const proxy = await startProxy(upstream.port)
    const head = await send(proxy.port, { method: 'HEAD', path: '/logo.png' })
    expect(head.status).toBe(200)
    expect(head.headers['content-length']).toBe('1234')
    expect(head.body.length).toBe(0)
    expect(upstream.seen[0]?.method).toBe('HEAD')
    const empty = await send(proxy.port, { method: 'DELETE', path: '/gone' })
    expect(empty.status).toBe(204)
    expect(empty.headers['x-kind']).toBe('empty')
  })

  it('keeps working across many sequential and concurrent requests', async () => {
    const upstream = await startUpstream((req, res) => res.end(`echo:${req.url}`))
    const proxy = await startProxy(upstream.port)
    for (let i = 0; i < 20; i++) expect((await send(proxy.port, { path: `/s${i}` })).text).toBe(`echo:/s${i}`)
    const all = await Promise.all(Array.from({ length: 50 }, (_, i) => send(proxy.port, { path: `/c${i}` })))
    expect(all.map((response) => response.text)).toEqual(Array.from({ length: 50 }, (_, i) => `echo:/c${i}`))
  })
})

describe('3. request header policy', () => {
  /**
   * Stands in for the two framework checks: Next.js Server Actions compare the
   * Origin host with X-Forwarded-Host or Host; SvelteKit compares Origin with
   * the origin of the request URL, built from Host.
   */
  function frameworkLike(): http.RequestListener {
    return (req, res) => {
      const origin = req.headers.origin
      const forwardedHost = req.headers['x-forwarded-host'] ?? req.headers.host
      if (req.method === 'POST') {
        const originHost = origin === undefined ? undefined : new URL(origin).host
        if (originHost !== forwardedHost) {
          res.writeHead(403, { 'content-type': 'text/plain' })
          res.end(`server action rejected: origin ${originHost} vs host ${String(forwardedHost)}`)
          return
        }
        if (origin !== `http://${req.headers.host}`) {
          res.writeHead(403, { 'content-type': 'text/plain' })
          res.end(`form action rejected: origin ${origin} vs url origin http://${req.headers.host}`)
          return
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(req.headers))
    }
  }

  it('lets a same-origin POST through both framework checks', async () => {
    const upstream = await startUpstream(frameworkLike())
    const proxy = await startProxy(upstream.port)
    const origin = `http://localhost:${proxy.port}`
    const response = await send(proxy.port, {
      method: 'POST',
      path: '/action',
      headers: {
        origin,
        referer: `${origin}/form`,
        cookie: 'session=abc; theme=dark',
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': '3',
        'next-action': 'abc123',
      },
      body: 'a=1',
    })
    expect(response.status, response.text).toBe(200)
    const seen = JSON.parse(response.text) as Record<string, string>
    expect(seen.host).toBe(`localhost:${proxy.port}`)
    expect(seen['x-forwarded-host']).toBe(`localhost:${proxy.port}`)
    expect(seen['x-forwarded-port']).toBe(String(proxy.port))
    expect(seen['x-forwarded-proto']).toBe('http')
    expect(seen['x-forwarded-for']).toBe('127.0.0.1')
    expect(seen.origin).toBe(origin)
    expect(seen.referer).toBe(`${origin}/form`)
    expect(seen.cookie).toBe('session=abc; theme=dark')
    expect(seen['next-action']).toBe('abc123')
  })

  it('works the same when the browser uses 127.0.0.1 or [::1]', async () => {
    const upstream = await startUpstream(frameworkLike())
    const proxy = await startProxy(upstream.port)
    for (const [name, address] of [['127.0.0.1', '127.0.0.1'], ['[::1]', '::1']] as const) {
      const host = `${name}:${proxy.port}`
      const response = await send(proxy.port, {
        method: 'POST',
        address,
        headers: { host, origin: `http://${host}`, 'content-length': '1' },
        body: 'x',
      })
      expect(response.status, response.text).toBe(200)
      expect((JSON.parse(response.text) as Record<string, string>)['x-forwarded-host']).toBe(host)
    }
  })

  it('does not hide a cross-site POST from the upstream check', async () => {
    const upstream = await startUpstream(frameworkLike())
    const proxy = await startProxy(upstream.port)
    const response = await send(proxy.port, {
      method: 'POST',
      headers: { origin: 'http://evil.example', 'content-length': '1' },
      body: 'x',
    })
    expect(response.status).toBe(403)
    expect(response.text).toMatch(/server action rejected/)
  })

  it('replaces forwarding headers a client sent and drops hop-by-hop headers', async () => {
    const upstream = await startUpstream(frameworkLike())
    const proxy = await startProxy(upstream.port)
    const response = await send(proxy.port, {
      headers: {
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'https',
        'x-forwarded-for': '10.9.8.7',
        'x-forwarded-port': '1',
        connection: 'keep-alive, x-private-hop',
        'x-private-hop': 'secret',
        'keep-alive': 'timeout=5',
        'proxy-authorization': 'Basic abc',
        te: 'trailers',
        'x-kept': 'yes',
        'sec-fetch-dest': 'empty',
        'accept-encoding': 'gzip',
      },
    })
    const seen = JSON.parse(response.text) as Record<string, string>
    expect(seen['x-forwarded-host']).toBe(`localhost:${proxy.port}`)
    expect(seen['x-forwarded-proto']).toBe('http')
    expect(seen['x-forwarded-for']).toBe('127.0.0.1')
    expect(seen['x-forwarded-port']).toBe(String(proxy.port))
    expect(seen['x-private-hop']).toBeUndefined()
    expect(seen['keep-alive']).toBeUndefined()
    expect(seen['proxy-authorization']).toBeUndefined()
    expect(seen.te).toBeUndefined()
    expect(seen['x-kept']).toBe('yes')
    expect(seen['accept-encoding']).toBe('gzip')
    // Header names keep the casing the client used.
    expect(rawValues(upstream.seen[0]?.rawHeaders ?? [], 'X-Kept')).toEqual(['yes'])
    expect(upstream.seen[0]?.rawHeaders).toContain('x-kept')
  })
})

describe('4. response rewriting', () => {
  it('points Location at the proxy when it names the upstream', async () => {
    const upstream = await startUpstream((req, res) => {
      const port = (req.socket.localPort ?? 0).toString()
      const locations: Record<string, string> = {
        '/abs': `http://127.0.0.1:${port}/next?from=abs`,
        '/localhost': `http://localhost:${port}/next`,
        '/relative': '/next',
        '/foreign': 'https://accounts.example.com/login?return=http://localhost:1/',
        '/host-based': `http://${req.headers.host}/next`,
      }
      res.writeHead(302, { location: locations[req.url ?? ''] ?? '/', 'x-other': `http://127.0.0.1:${port}/untouched` })
      res.end()
    })
    const proxy = await startProxy(upstream.port)
    const location = async (path: string): Promise<string | undefined> => (await send(proxy.port, { path })).headers.location
    expect(await location('/abs')).toBe(`http://localhost:${proxy.port}/next?from=abs`)
    expect(await location('/localhost')).toBe(`http://localhost:${proxy.port}/next`)
    expect(await location('/relative')).toBe('/next')
    expect(await location('/foreign')).toBe('https://accounts.example.com/login?return=http://localhost:1/')
    // A framework that builds the URL from Host already produces the proxy's address.
    expect(await location('/host-based')).toBe(`http://localhost:${proxy.port}/next`)
    const other = await send(proxy.port, { path: '/abs' })
    expect(other.status).toBe(302)
    expect(other.headers['x-other']).toBe(`http://127.0.0.1:${upstream.port}/untouched`)
  })

  it('does not relay hop-by-hop response headers', async () => {
    const raw = net.createServer((socket) => {
      socket.on('error', () => {})
      socket.once('data', () =>
        socket.end(
          'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close, X-Internal-Hop\r\nX-Internal-Hop: 1\r\n' +
            'Keep-Alive: timeout=99\r\nProxy-Authenticate: Basic\r\nX-End-To-End: yes\r\nTransfer-Encoding: chunked\r\n\r\n' +
            '5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n',
        ),
      )
    })
    await new Promise<void>((resolve) => raw.listen(0, '127.0.0.1', () => resolve()))
    onCleanup(() => new Promise<void>((resolve) => raw.close(() => resolve())))
    const proxy = await startProxy((raw.address() as AddressInfo).port)
    const response = await send(proxy.port)
    expect(response.text).toBe('hello world')
    // One of each, and they are the proxy's own connection management: the
    // test client asked for a one-shot connection, so the proxy says "close".
    expect(rawValues(response.rawHeaders, 'connection')).toEqual(['close'])
    expect(rawValues(response.rawHeaders, 'transfer-encoding')).toEqual(['chunked'])
    expect(rawValues(response.rawHeaders, 'keep-alive').join()).not.toContain('99')
    expect(response.headers['x-internal-hop']).toBeUndefined()
    expect(response.headers['proxy-authenticate']).toBeUndefined()
    expect(response.headers['x-end-to-end']).toBe('yes')
  })

  it('passes Set-Cookie through and drops only a Domain naming the upstream', async () => {
    const upstream = await startUpstream((req, res) => {
      const port = req.socket.localPort
      res.writeHead(200, [
        'Set-Cookie', 'session=s3cr3t; Path=/; HttpOnly; SameSite=Lax',
        'Set-Cookie', `pinned=1; Domain=127.0.0.1:${port}; Path=/`,
        'Set-Cookie', 'bare=1; Domain=127.0.0.1',
        'Set-Cookie', 'other=1; Domain=example.com; Secure',
        'Content-Type', 'text/plain',
      ])
      res.end('ok')
    })
    const proxy = await startProxy(upstream.port)
    const response = await send(proxy.port, { path: '/login', method: 'POST', headers: { 'content-length': '0' } })
    expect(rawValues(response.rawHeaders, 'set-cookie')).toEqual([
      'session=s3cr3t; Path=/; HttpOnly; SameSite=Lax',
      'pinned=1; Path=/',
      'bare=1',
      'other=1; Domain=example.com; Secure',
    ])
  })

  it('round-trips a login: the cookie set through the proxy is sent back through it', async () => {
    const upstream = await startUpstream((req, res) => {
      if (req.url === '/login') {
        res.writeHead(303, { 'set-cookie': 'auth=tok123; Path=/; HttpOnly', location: '/me' })
        res.end()
        return
      }
      res.end(req.headers.cookie === 'auth=tok123' ? 'hello user' : 'anonymous')
    })
    const proxy = await startProxy(upstream.port)
    const login = await send(proxy.port, { path: '/login', method: 'POST', headers: { 'content-length': '0' } })
    const cookie = String(login.headers['set-cookie']?.[0]).split(';')[0] ?? ''
    expect(login.headers.location).toBe('/me')
    expect((await send(proxy.port, { path: '/me', headers: { cookie } })).text).toBe('hello user')
    expect((await send(proxy.port, { path: '/me' })).text).toBe('anonymous')
  })
})

describe('8. host check and reserved prefix', () => {
  it('refuses requests whose Host is not a loopback name on the proxy port', async () => {
    const upstream = await startUpstream((_req, res) => res.end('secret'))
    const proxy = await startProxy(upstream.port)
    for (const host of ['evil.example', `evil.example:${proxy.port}`, `localhost:${proxy.port + 1}`, 'localhost', `127.0.0.1.evil.example:${proxy.port}`]) {
      const response = await send(proxy.port, { headers: { host } })
      expect(response.status, host).toBe(403)
      expect(response.text, host).not.toContain('secret')
    }
    // The same goes for primp's own assets.
    expect((await send(proxy.port, { path: '/__primp/hook.js', headers: { host: 'evil.example' } })).status).toBe(403)
    expect(upstream.seen).toHaveLength(0)
    for (const host of [`localhost:${proxy.port}`, `127.0.0.1:${proxy.port}`, `[::1]:${proxy.port}`]) {
      expect((await send(proxy.port, { headers: { host } })).text, host).toBe('secret')
    }
  })

  it('listens on both loopback families', async () => {
    const upstream = await startUpstream((_req, res) => res.end('ok'))
    const proxy = await startProxy(upstream.port)
    expect(proxy.url).toBe(`http://localhost:${proxy.port}`)
    expect((await send(proxy.port, { address: '127.0.0.1' })).text).toBe('ok')
    expect((await send(proxy.port, { address: '::1' })).text).toBe('ok')
  })

  it('listens on a requested port', async () => {
    const upstream = await startUpstream((_req, res) => res.end('ok'))
    const port = await getFreePort()
    const proxy = await startProxy(upstream.port, { listen: { host: 'localhost', port } })
    expect(proxy.port).toBe(port)
    expect((await send(port)).text).toBe('ok')
  })

  it('serves assets under the reserved prefix itself and never forwards that prefix', async () => {
    const upstream = await startUpstream((_req, res) => res.end('upstream'))
    const calls: string[] = []
    const proxy = await startProxy(upstream.port, {
      assets: async (path) => {
        calls.push(path)
        await sleep(1)
        if (path === 'hook.js') return { body: HOOK, contentType: 'text/javascript; charset=utf-8' }
        if (path === 'fonts/a.bin') return { body: Buffer.from([0, 1, 2, 255]), contentType: 'application/octet-stream' }
        if (path === 'boom') throw new Error('resolver broke')
        return undefined
      },
    })
    const hook = await send(proxy.port, { path: '/__primp/hook.js?v=3' })
    expect(hook.status).toBe(200)
    expect(hook.text).toBe(HOOK)
    expect(hook.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(hook.headers['content-length']).toBe(String(HOOK.length))
    expect(hook.headers['x-content-type-options']).toBe('nosniff')
    expect([...(await send(proxy.port, { path: '/__primp/fonts/a.bin' })).body]).toEqual([0, 1, 2, 255])
    expect((await send(proxy.port, { path: '/__primp/hook.js', method: 'HEAD' })).body.length).toBe(0)
    expect((await send(proxy.port, { path: '/__primp/missing.js' })).status).toBe(404)
    expect((await send(proxy.port, { path: '/__primp/boom' })).status).toBe(500)
    expect((await send(proxy.port, { path: '/__primp/hook.js', method: 'POST', headers: { 'content-length': '0' } })).status).toBe(405)
    expect((await send(proxy.port, { path: '/__primp' })).status).toBe(404)
    expect(calls).toContain('missing.js')
    // Paths that could climb out of a directory never reach the resolver.
    for (const path of ['/__primp/../secret', '/__primp/a/../../secret', '/__primp/%2e%2e/secret', '/__primp/a%2fb', '/__primp/a\\b', '/__primp/./hook.js', '/__primp/']) {
      const before = calls.length
      expect((await send(proxy.port, { path })).status, path).toBe(404)
      expect(calls.length, path).toBe(before)
    }
    expect(upstream.seen).toHaveLength(0)
    // A path that merely resembles the prefix belongs to the app.
    expect((await send(proxy.port, { path: '/__primp-app/x' })).text).toBe('upstream')
  })

  it('honours a custom reserved prefix', async () => {
    const upstream = await startUpstream((req, res) => res.end(`upstream:${req.url}`))
    const proxy = await startProxy(upstream.port, { reservedPrefix: '/_tool/' })
    expect((await send(proxy.port, { path: '/_tool/hook.js' })).text).toBe(HOOK)
    expect((await send(proxy.port, { path: '/__primp/hook.js' })).text).toBe('upstream:/__primp/hook.js')
    const page = await startUpstream((_req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end('<head></head>')
    })
    const second = await startProxy(page.port, { reservedPrefix: '/_tool/' })
    expect((await send(second.port, { headers: NAVIGATE })).text).toBe('<head><script src="/_tool/hook.js" data-primp></script></head>')
  })
})
