import { afterEach, describe, expect, it } from 'vitest'
import { NAVIGATE, rawValues, runCleanups, send, startProxy, startUpstream } from './helpers.ts'

afterEach(runCleanups)

/** Headers a browser sends for an image; without them the proxy takes a bare request for a navigation. */
const IMAGE = { accept: 'image/avif,image/webp,*/*;q=0.8', 'sec-fetch-dest': 'image' }

/** An ordinary cacheable dev server: validators on everything, 304 when they match. */
const cacheable = () =>
  startUpstream((req, res) => {
    res.sendDate = false
    const html = req.url === '/' || req.url === '/page'
    if (req.headers['if-none-match'] === '"v1"') {
      res.writeHead(304, { ETag: '"v1"', 'Cache-Control': 'public, max-age=3600' })
      res.end()
      return
    }
    res.writeHead(200, {
      'Content-Type': html ? 'text/html; charset=utf-8' : 'image/png',
      'Cache-Control': 'public, max-age=3600',
      ETag: '"v1"',
      'Last-Modified': 'Wed, 21 Oct 2026 07:28:00 GMT',
      Expires: 'Thu, 22 Oct 2026 07:28:00 GMT',
      Age: '12',
    })
    res.end(html ? '<!doctype html><html><head><title>t</title></head><body>hi</body></html>' : 'PNGDATA')
  })

describe('cold mode (the browser cache kept out of the picture)', () => {
  it('changes nothing while it is off', async () => {
    const upstream = await cacheable()
    const proxy = await startProxy(upstream.port, { cold: () => false })
    const asset = await send(proxy.port, { path: '/hero.png', headers: { ...IMAGE, 'if-none-match': '"v1"' } })
    expect(asset.status).toBe(304)
    expect(upstream.seen[0]?.headers['if-none-match']).toBe('"v1"')
    const fresh = await send(proxy.port, { path: '/hero.png', headers: IMAGE })
    expect(fresh.headers['cache-control']).toBe('public, max-age=3600')
    expect(fresh.headers.etag).toBe('"v1"')
    expect(fresh.headers['clear-site-data']).toBeUndefined()
  })

  it('does not forward conditional headers, so the dev server cannot answer 304', async () => {
    const upstream = await cacheable()
    const proxy = await startProxy(upstream.port, { cold: () => true })
    const response = await send(proxy.port, {
      path: '/hero.png',
      headers: { ...IMAGE, 'if-none-match': '"v1"', 'if-modified-since': 'Wed, 21 Oct 2026 07:28:00 GMT', 'if-range': '"v1"', 'x-keep': 'yes' },
    })
    expect(response.status).toBe(200)
    expect(response.text).toBe('PNGDATA')
    const seen = upstream.seen[0]?.headers ?? {}
    expect(seen['if-none-match']).toBeUndefined()
    expect(seen['if-modified-since']).toBeUndefined()
    expect(seen['if-range']).toBeUndefined()
    expect(seen['x-keep']).toBe('yes')
  })

  it('sends every response no-store and without validators', async () => {
    const upstream = await cacheable()
    const proxy = await startProxy(upstream.port, { cold: () => true })
    const response = await send(proxy.port, { path: '/hero.png', headers: IMAGE })
    expect(rawValues(response.rawHeaders, 'cache-control')).toEqual(['no-store'])
    for (const name of ['etag', 'last-modified', 'expires', 'age']) expect(response.headers[name], name).toBeUndefined()
    // A subresource cannot clear the cache, and must not try.
    expect(response.headers['clear-site-data']).toBeUndefined()
    expect(response.headers['content-type']).toBe('image/png')
  })

  it('adds Clear-Site-Data: "cache" to documents only when asked to, and still injects the hook', async () => {
    const upstream = await cacheable()
    let clear = true
    const proxy = await startProxy(upstream.port, { cold: () => true, clearCache: () => clear })
    const page = await send(proxy.port, { path: '/page', headers: NAVIGATE })
    expect(page.status).toBe(200)
    expect(page.headers['clear-site-data']).toBe('"cache"')
    expect(rawValues(page.rawHeaders, 'cache-control')).toEqual(['no-store'])
    expect(page.text).toContain('/__primp/hook.js')
    // A subresource cannot clear the cache, and must not try.
    expect((await send(proxy.port, { path: '/hero.png', headers: IMAGE })).headers['clear-site-data']).toBeUndefined()
    clear = false
    const later = await send(proxy.port, { path: '/page', headers: NAVIGATE })
    expect(later.headers['clear-site-data']).toBeUndefined()
    expect(rawValues(later.rawHeaders, 'cache-control')).toEqual(['no-store'])
  })

  it('is asked per request, so it can be switched on for a replay and off again', async () => {
    const upstream = await cacheable()
    let cold = false
    const proxy = await startProxy(upstream.port, { cold: () => cold })
    expect((await send(proxy.port, { path: '/hero.png', headers: IMAGE })).headers['cache-control']).toBe('public, max-age=3600')
    cold = true
    expect((await send(proxy.port, { path: '/hero.png', headers: IMAGE })).headers['cache-control']).toBe('no-store')
    cold = false
    expect((await send(proxy.port, { path: '/hero.png', headers: IMAGE })).headers['cache-control']).toBe('public, max-age=3600')
  })
})
