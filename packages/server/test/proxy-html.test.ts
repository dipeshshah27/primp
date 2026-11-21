import type http from 'node:http'
import { brotliCompressSync, constants as zlib, createGzip, deflateSync, gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { HOOK_TAG, NAVIGATE, rawValues, runCleanups, send, sleep, startProxy, startUpstream } from './helpers.ts'

afterEach(runCleanups)

const PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head><body><h1>hi</h1></body></html>'
const INJECTED = PAGE.replace('<head>', `<head>${HOOK_TAG}`)

function html(body: string, headers: http.OutgoingHttpHeaders = {}): http.RequestListener {
  return (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body), ...headers })
    res.end(body)
  }
}

describe('2. HTML injection', () => {
  it('injects the script tags as the first thing in <head> and fixes the framing headers', async () => {
    const upstream = await startUpstream(html(PAGE))
    const proxy = await startProxy(upstream.port)
    const response = await send(proxy.port, { headers: NAVIGATE })
    expect(response.status).toBe(200)
    expect(response.text).toBe(INJECTED)
    expect(response.headers['content-length']).toBeUndefined()
    expect(response.headers['transfer-encoding']).toBe('chunked')
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8')
  })

  it('injects several scripts in the order given', async () => {
    const upstream = await startUpstream(html(PAGE))
    const proxy = await startProxy(upstream.port, { headScripts: ['hook.js', 'probe.js', '/vendor/abs.js'] })
    const response = await send(proxy.port, { headers: NAVIGATE })
    expect(response.text).toContain(
      '<head><script src="/__reglet/hook.js" data-reglet></script><script src="/__reglet/probe.js" data-reglet></script>' +
        '<script src="/vendor/abs.js" data-reglet></script><meta charset="utf-8">',
    )
  })

  it('keeps streaming: the injected first chunk arrives before the second chunk is produced 1 s later', async () => {
    let secondProducedAt = 0
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.write('<!doctype html><html><head><title>streamed</title></head><body><p>shell</p>')
      setTimeout(() => {
        secondProducedAt = performance.now()
        res.end('<p>late content</p></body></html>')
      }, 1000)
    })
    const proxy = await startProxy(upstream.port)
    const response = await send(proxy.port, { headers: NAVIGATE })

    expect(response.text).toBe(
      `<!doctype html><html><head>${HOOK_TAG}<title>streamed</title></head><body><p>shell</p><p>late content</p></body></html>`,
    )
    const early = response.chunks.filter((chunk) => chunk.at < secondProducedAt)
    const earlyText = Buffer.concat(early.map((chunk) => chunk.data)).toString()
    // Everything of the first upstream chunk, script tag included, was delivered before the second existed.
    expect(earlyText).toBe(`<!doctype html><html><head>${HOOK_TAG}<title>streamed</title></head><body><p>shell</p>`)
    const lastEarly = early.at(-1)?.at ?? Infinity
    expect(secondProducedAt - lastEarly).toBeGreaterThan(800)
  })

  it('finds a <head that is split across upstream chunks, forwarding what is settled meanwhile', async () => {
    let secondProducedAt = 0
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.write('<!doctype html><html lang="en"><he')
      setTimeout(() => {
        secondProducedAt = performance.now()
        res.end('ad class="x"><title>t</title></head><body></body></html>')
      }, 400)
    })
    const proxy = await startProxy(upstream.port)
    const response = await send(proxy.port, { headers: NAVIGATE })
    expect(response.text).toBe(`<!doctype html><html lang="en"><head class="x">${HOOK_TAG}<title>t</title></head><body></body></html>`)
    const early = Buffer.concat(response.chunks.filter((chunk) => chunk.at < secondProducedAt).map((chunk) => chunk.data)).toString()
    expect(early).toBe('<!doctype html><html lang="en">')
  })

  it('falls back when the document has no <head>', async () => {
    const cases: [string, string][] = [
      ['<!doctype html><html lang="en"><body><p>x</p></body></html>', `<!doctype html><html lang="en">${HOOK_TAG}<body><p>x</p></body></html>`],
      ['<!doctype html><body><p>x</p></body>', `<!doctype html>${HOOK_TAG}<body><p>x</p></body>`],
      ['<p>bare</p>', `${HOOK_TAG}<p>bare</p>`],
    ]
    for (const [page, expected] of cases) {
      const upstream = await startUpstream(html(page))
      const proxy = await startProxy(upstream.port)
      expect((await send(proxy.port, { headers: NAVIGATE })).text).toBe(expected)
    }
  })

  it('bounds what it holds back: a token still open after 64 kB gets the tags in front of it', async () => {
    const opening = `<!doctype html><!--${'c'.repeat(66_000)}`
    const rest = `${'c'.repeat(4_000)}--><html><head><title>t</title></head><body></body></html>`
    let restProducedAt = 0
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.write(opening)
      setTimeout(() => {
        restProducedAt = performance.now()
        res.end(rest)
      }, 400)
    })
    const proxy = await startProxy(upstream.port)
    const response = await send(proxy.port, { headers: NAVIGATE })
    expect(response.text).toBe(`<!doctype html>${HOOK_TAG}${opening.slice('<!doctype html>'.length)}${rest}`)
    // The 66 kB were not kept waiting for the comment to close.
    const early = Buffer.concat(response.chunks.filter((chunk) => chunk.at < restProducedAt).map((chunk) => chunk.data))
    expect(early.length).toBe(opening.length + HOOK_TAG.length)
  })

  it('still finds a <head> that lies beyond 64 kB of complete leading tokens', async () => {
    const page = `<!doctype html>${`<!--${'c'.repeat(9_990)}-->`.repeat(10)}<html><head><title>t</title></head><body></body></html>`
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      const bytes = Buffer.from(page)
      for (let offset = 0; offset < bytes.length; offset += 1500) res.write(bytes.subarray(offset, offset + 1500))
      res.end()
    })
    const proxy = await startProxy(upstream.port)
    expect((await send(proxy.port, { headers: NAVIGATE })).text).toBe(page.replace('<head>', `<head>${HOOK_TAG}`))
  })

  it('relays a large streamed document intact', async () => {
    const rows = Array.from({ length: 20_000 }, (_, i) => `<tr><td>${i}</td><td>café 日本</td></tr>`).join('')
    const page = `<!doctype html><html><head><title>big</title></head><body><table>${rows}</table></body></html>`
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      const bytes = Buffer.from(page)
      // Odd chunk sizes, so multi-byte characters are cut.
      for (let offset = 0; offset < bytes.length; offset += 4099) res.write(bytes.subarray(offset, offset + 4099))
      res.end()
    })
    const proxy = await startProxy(upstream.port)
    expect((await send(proxy.port, { headers: NAVIGATE })).text).toBe(page.replace('<head>', `<head>${HOOK_TAG}`))
  })

  it('only injects into text/html documents', async () => {
    const types = ['application/json', 'text/plain', 'application/xhtml+xml', 'text/x-component', 'text/html-fragment', 'image/svg+xml']
    for (const type of types) {
      const upstream = await startUpstream((_req, res) => {
        res.writeHead(200, { 'content-type': type, etag: '"e"', 'content-length': Buffer.byteLength(PAGE) })
        res.end(PAGE)
      })
      const proxy = await startProxy(upstream.port)
      const response = await send(proxy.port, { headers: NAVIGATE })
      expect(response.text, type).toBe(PAGE)
      expect(response.headers.etag, type).toBe('"e"')
      expect(response.headers['content-length'], type).toBe(String(Buffer.byteLength(PAGE)))
    }
  })

  it('leaves HTML that the page fetches itself alone', async () => {
    const upstream = await startUpstream(html(PAGE, { etag: '"e"' }))
    const proxy = await startProxy(upstream.port)
    for (const dest of ['empty', 'iframe', 'image']) {
      const response = await send(proxy.port, { headers: { ...NAVIGATE, 'sec-fetch-dest': dest } })
      expect(response.text, dest).toBe(PAGE)
      expect(response.headers.etag, dest).toBe('"e"')
    }
    // No Sec-Fetch-Dest at all: judged by Accept.
    expect((await send(proxy.port, { headers: { accept: 'application/json' } })).text).toBe(PAGE)
    expect((await send(proxy.port, { headers: { accept: 'text/html' } })).text).toBe(INJECTED)
    expect((await send(proxy.port)).text).toBe(INJECTED)
  })

  it('does not inject into a download', async () => {
    const upstream = await startUpstream(html(PAGE, { 'content-disposition': 'attachment; filename="report.html"', etag: '"d"' }))
    const proxy = await startProxy(upstream.port)
    const response = await send(proxy.port, { headers: NAVIGATE })
    expect(response.text).toBe(PAGE)
    expect(response.headers.etag).toBe('"d"')
  })

  it('does not inject into UTF-16 documents', async () => {
    const body = Buffer.from(`﻿${PAGE}`, 'utf16le')
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-16' })
      res.end(body)
    })
    const proxy = await startProxy(upstream.port)
    expect((await send(proxy.port, { headers: NAVIGATE })).body.equals(body)).toBe(true)
  })

  it('asks the upstream for an identity-encoded, unconditional document', async () => {
    const upstream = await startUpstream(html(PAGE))
    const proxy = await startProxy(upstream.port)
    await send(proxy.port, {
      headers: { ...NAVIGATE, 'if-none-match': '"abc"', 'if-modified-since': 'Wed, 21 Oct 2026 07:28:00 GMT', range: 'bytes=0-10', 'if-range': '"abc"' },
    })
    const seen = upstream.seen[0]?.headers ?? {}
    expect(seen['accept-encoding']).toBe('identity')
    expect(seen['if-none-match']).toBeUndefined()
    expect(seen['if-modified-since']).toBeUndefined()
    expect(seen.range).toBeUndefined()
    expect(seen['if-range']).toBeUndefined()
    expect(seen.accept).toBe(NAVIGATE.accept)
  })

  it('never lets a 304 serve an uninjected cached page', async () => {
    const modified = 'Wed, 21 Oct 2026 07:28:00 GMT'
    // A static server that revalidates properly.
    const upstream = await startUpstream((req, res) => {
      if (req.headers['if-none-match'] === '"page-v1"' || req.headers['if-modified-since'] === modified) {
        res.writeHead(304, { etag: '"page-v1"' })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/html', etag: '"page-v1"', 'last-modified': modified, 'accept-ranges': 'bytes', 'cache-control': 'max-age=0' })
      res.end(PAGE)
    })
    const proxy = await startProxy(upstream.port)
    const first = await send(proxy.port, { headers: NAVIGATE })
    expect(first.text).toBe(INJECTED)
    // No validators reach the browser, so it has nothing to revalidate with ...
    expect(first.headers.etag).toBeUndefined()
    expect(first.headers['last-modified']).toBeUndefined()
    expect(first.headers['accept-ranges']).toBeUndefined()
    expect(first.headers['cache-control']).toBe('max-age=0')
    // ... and if it sends validators anyway (a copy cached before reglet ran), it still gets the full page.
    const again = await send(proxy.port, { headers: { ...NAVIGATE, 'if-none-match': '"page-v1"', 'if-modified-since': modified } })
    expect(again.status).toBe(200)
    expect(again.text).toBe(INJECTED)
  })

  it('decodes gzip, brotli and deflate from an upstream that compresses regardless', async () => {
    const encoders: Record<string, (input: Buffer) => Buffer> = {
      gzip: (input) => gzipSync(input),
      br: (input) => brotliCompressSync(input),
      deflate: (input) => deflateSync(input),
    }
    for (const [encoding, encode] of Object.entries(encoders)) {
      const body = encode(Buffer.from(PAGE))
      const upstream = await startUpstream((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': encoding, 'content-length': body.length, vary: 'Accept-Encoding' })
        res.end(body)
      })
      const proxy = await startProxy(upstream.port)
      const response = await send(proxy.port, { headers: NAVIGATE })
      expect(response.text, encoding).toBe(INJECTED)
      expect(response.headers['content-encoding'], encoding).toBeUndefined()
      expect(response.headers['content-length'], encoding).toBeUndefined()
      expect(response.headers.vary, encoding).toBe('Accept-Encoding')
    }
  })

  it('keeps streaming while decoding gzip', async () => {
    let secondProducedAt = 0
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' })
      const gzip = createGzip()
      gzip.pipe(res)
      gzip.write('<!doctype html><html><head><title>z</title></head><body><p>first</p>')
      gzip.flush(zlib.Z_SYNC_FLUSH)
      setTimeout(() => {
        secondProducedAt = performance.now()
        gzip.end('<p>second</p></body></html>')
      }, 700)
    })
    const proxy = await startProxy(upstream.port)
    const response = await send(proxy.port, { headers: NAVIGATE })
    expect(response.text).toBe(`<!doctype html><html><head>${HOOK_TAG}<title>z</title></head><body><p>first</p><p>second</p></body></html>`)
    const early = Buffer.concat(response.chunks.filter((chunk) => chunk.at < secondProducedAt).map((chunk) => chunk.data)).toString()
    expect(early).toBe(`<!doctype html><html><head>${HOOK_TAG}<title>z</title></head><body><p>first</p>`)
  })

  it('passes a document in an encoding it cannot decode through, with a warning', async () => {
    const body = Buffer.from('not really compressed')
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'compress', etag: '"z"' })
      res.end(body)
    })
    const proxy = await startProxy(upstream.port)
    const response = await send(proxy.port, { headers: NAVIGATE })
    expect(response.body.equals(body)).toBe(true)
    expect(response.headers['content-encoding']).toBe('compress')
    expect(response.headers.etag).toBe('"z"')
    expect(proxy.logs.filter((entry) => entry.level === 'warn').map((entry) => entry.message).join()).toMatch(/Content-Encoding "compress"/)
  })

  it('injects into error pages and form-post results', async () => {
    const upstream = await startUpstream((req, res) => {
      res.writeHead(req.method === 'POST' ? 200 : 500, { 'content-type': 'text/html' })
      res.end(PAGE)
    })
    const proxy = await startProxy(upstream.port)
    const error = await send(proxy.port, { headers: NAVIGATE })
    expect(error.status).toBe(500)
    expect(error.text).toBe(INJECTED)
    const posted = await send(proxy.port, { method: 'POST', headers: { ...NAVIGATE, 'content-length': '3' }, body: 'a=1' })
    expect(posted.text).toBe(INJECTED)
  })

  it('answers HEAD for a document without body, length or validators', async () => {
    const upstream = await startUpstream((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-length': Buffer.byteLength(PAGE), etag: '"h"' })
      res.end(req.method === 'HEAD' ? undefined : PAGE)
    })
    const proxy = await startProxy(upstream.port)
    const response = await send(proxy.port, { method: 'HEAD', headers: NAVIGATE })
    expect(response.status).toBe(200)
    expect(response.body.length).toBe(0)
    expect(response.headers['content-length']).toBeUndefined()
    expect(response.headers.etag).toBeUndefined()
  })

  it('leaves an empty HTML body empty and a 204 alone', async () => {
    const upstream = await startUpstream((req, res) => {
      res.writeHead(req.url === '/204' ? 204 : 200, { 'content-type': 'text/html' })
      res.end()
    })
    const proxy = await startProxy(upstream.port)
    expect((await send(proxy.port, { headers: NAVIGATE })).body.length).toBe(0)
    const empty = await send(proxy.port, { path: '/204', headers: NAVIGATE })
    expect(empty.status).toBe(204)
    expect(empty.body.length).toBe(0)
  })

  it('is a pure pass-through when there is nothing to inject', async () => {
    const upstream = await startUpstream(html(PAGE, { etag: '"keep"', 'content-security-policy': "script-src 'none'" }))
    const proxy = await startProxy(upstream.port, { headScripts: [] })
    const response = await send(proxy.port, { headers: NAVIGATE })
    expect(response.text).toBe(PAGE)
    expect(response.headers.etag).toBe('"keep"')
    expect(response.headers['content-length']).toBe(String(Buffer.byteLength(PAGE)))
    expect(response.headers['content-security-policy']).toBe("script-src 'none'")
  })
})

describe('6. Content-Security-Policy', () => {
  const nextStyle = (nonce: string): string =>
    `default-src 'self'; script-src 'self' 'nonce-${nonce}' 'strict-dynamic'; style-src 'self' 'nonce-${nonce}'; connect-src 'self' ws://localhost:*`

  it('nonce mode: reuses the per-request nonce and leaves the header as it was', async () => {
    let counter = 0
    const upstream = await startUpstream((_req, res) => {
      const nonce = `req${++counter}Zm9v`
      res.writeHead(200, { 'content-type': 'text/html', 'Content-Security-Policy': nextStyle(nonce) })
      res.end(`<!doctype html><html><head><script nonce="${nonce}">1</script></head><body></body></html>`)
    })
    const proxy = await startProxy(upstream.port)
    for (const nonce of ['req1Zm9v', 'req2Zm9v']) {
      const response = await send(proxy.port, { headers: NAVIGATE })
      expect(response.text).toBe(
        `<!doctype html><html><head><script src="/__reglet/hook.js" nonce="${nonce}" data-reglet></script><script nonce="${nonce}">1</script></head><body></body></html>`,
      )
      expect(rawValues(response.rawHeaders, 'Content-Security-Policy')).toEqual([nextStyle(nonce)])
    }
    expect(proxy.logs.filter((entry) => entry.level === 'warn')).toEqual([])
  })

  it('nonce mode: adds only the websocket source when the policy restricts connections', async () => {
    const policy = "default-src 'self'; script-src 'self' 'nonce-abc'"
    const upstream = await startUpstream(html(PAGE, { 'content-security-policy': policy }))
    const proxy = await startProxy(upstream.port)
    const response = await send(proxy.port, { headers: NAVIGATE })
    expect(response.headers['content-security-policy']).toBe(`${policy}; connect-src 'self' ws://localhost:${proxy.port}`)
    expect(response.text).toContain('<script src="/__reglet/hook.js" nonce="abc" data-reglet></script>')
  })

  it("nonce mode: uses 'self' when there is no nonce", async () => {
    const policy = "script-src 'self'; object-src 'none'"
    const upstream = await startUpstream(html(PAGE, { 'content-security-policy': policy }))
    const proxy = await startProxy(upstream.port)
    const response = await send(proxy.port, { headers: NAVIGATE })
    expect(response.headers['content-security-policy']).toBe(policy)
    expect(response.text).toBe(INJECTED)
  })

  it('nonce mode: falls back to a rewrite, with one warning, when the policy cannot be satisfied', async () => {
    const upstream = await startUpstream(html(PAGE, { 'content-security-policy': "script-src https://cdn.example; img-src *" }))
    const proxy = await startProxy(upstream.port)
    const response = await send(proxy.port, { headers: NAVIGATE })
    expect(response.headers['content-security-policy']).toBe("script-src https://cdn.example 'self'; img-src *")
    expect(response.text).toBe(INJECTED)
    await send(proxy.port, { headers: NAVIGATE })
    const warnings = proxy.logs.filter((entry) => entry.level === 'warn')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.message).toMatch(/Content-Security-Policy/)
  })

  it('nonce mode: brings its own nonce when strict-dynamic has none to reuse', async () => {
    const upstream = await startUpstream(html(PAGE, { 'content-security-policy': "script-src 'sha256-abc=' 'strict-dynamic'" }))
    const proxy = await startProxy(upstream.port)
    const response = await send(proxy.port, { headers: NAVIGATE })
    const nonce = /<script src="\/__reglet\/hook\.js" nonce="([^"]+)" data-reglet>/.exec(response.text)?.[1]
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/)
    expect(response.headers['content-security-policy']).toBe(`script-src 'sha256-abc=' 'strict-dynamic' 'nonce-${nonce}'`)
    // A fresh nonce per response.
    const second = await send(proxy.port, { headers: NAVIGATE })
    expect(second.text).not.toContain(`nonce="${nonce}"`)
  })

  it('handles report-only and several policy headers together', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, [
        'Content-Type', 'text/html',
        'Content-Security-Policy', "script-src 'nonce-n1' 'strict-dynamic'",
        'Content-Security-Policy-Report-Only', "script-src 'nonce-n1'; report-uri /csp",
        'X-Frame-Options', 'DENY',
      ])
      res.end(PAGE)
    })
    const proxy = await startProxy(upstream.port)
    const response = await send(proxy.port, { headers: NAVIGATE })
    expect(response.text).toContain('<script src="/__reglet/hook.js" nonce="n1" data-reglet></script>')
    expect(response.headers['content-security-policy']).toBe("script-src 'nonce-n1' 'strict-dynamic'")
    expect(response.headers['content-security-policy-report-only']).toBe("script-src 'nonce-n1'; report-uri /csp")
    expect(response.headers['x-frame-options']).toBe('DENY')
  })

  it("rewrite mode: adds 'self' without using the page's nonce", async () => {
    const upstream = await startUpstream(html(PAGE, { 'content-security-policy': "script-src 'nonce-abc' https://cdn.example" }))
    const proxy = await startProxy(upstream.port, { cspMode: 'rewrite' })
    const response = await send(proxy.port, { headers: NAVIGATE })
    expect(response.headers['content-security-policy']).toBe("script-src 'nonce-abc' https://cdn.example 'self'")
    expect(response.text).toBe(INJECTED)
    expect(proxy.logs.filter((entry) => entry.level === 'warn')).toEqual([])
  })

  it('strip mode: removes CSP headers from documents and nothing else', async () => {
    const upstream = await startUpstream((req, res) => {
      res.writeHead(200, {
        'content-type': req.url === '/worker.js' ? 'text/javascript' : 'text/html',
        'content-security-policy': "default-src 'none'",
        'content-security-policy-report-only': "default-src 'none'",
        'x-frame-options': 'SAMEORIGIN',
      })
      res.end(PAGE)
    })
    const proxy = await startProxy(upstream.port, { cspMode: 'strip' })
    const page = await send(proxy.port, { headers: NAVIGATE })
    expect(page.text).toBe(INJECTED)
    expect(page.headers['content-security-policy']).toBeUndefined()
    expect(page.headers['content-security-policy-report-only']).toBeUndefined()
    expect(page.headers['x-frame-options']).toBe('SAMEORIGIN')
    const script = await send(proxy.port, { path: '/worker.js', headers: { 'sec-fetch-dest': 'worker' } })
    expect(script.headers['content-security-policy']).toBe("default-src 'none'")
  })

  it('injects ahead of a meta CSP in the head', async () => {
    const meta = '<meta http-equiv="Content-Security-Policy" content="script-src \'nonce-m\'">'
    const upstream = await startUpstream(html(`<!doctype html><html><head>${meta}<script nonce="m">1</script></head><body></body></html>`))
    const proxy = await startProxy(upstream.port)
    const text = (await send(proxy.port, { headers: NAVIGATE })).text
    expect(text).toBe(`<!doctype html><html><head>${HOOK_TAG}${meta}<script nonce="m">1</script></head><body></body></html>`)
  })

  it('does not touch the CSP of responses it does not inject into', async () => {
    const upstream = await startUpstream(html(PAGE, { 'content-security-policy': "default-src 'none'" }))
    const proxy = await startProxy(upstream.port)
    const response = await send(proxy.port, { headers: { ...NAVIGATE, 'sec-fetch-dest': 'iframe' } })
    expect(response.headers['content-security-policy']).toBe("default-src 'none'")
    await sleep(0)
    expect(proxy.logs.filter((entry) => entry.level === 'warn')).toEqual([])
  })
})
