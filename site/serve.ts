/**
 * A tiny static server for site/out (the static export of `cd site && pnpm build`), behaving like a plain static host: `/dir/` serves
 * `dir/index.html`, `/dir` redirects to `/dir/`, anything else missing is a 404 with `404.html`.
 * Used by spikes/site-check.ts and for a local preview:
 *
 *   pnpm exec tsx site/serve.ts [port]
 *
 * Every page is served `no-cache`, like a host that revalidates, so a rebuilt site shows at once.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
}

export interface StaticServer {
  url: string
  port: number
  /** Every request path served, with its status. */
  log: { path: string; status: number }[]
  close(): Promise<void>
}

export function startStaticServer(root: string, port = 0): Promise<StaticServer> {
  const base = resolve(root)
  const log: StaticServer['log'] = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    let path: string
    try {
      path = decodeURIComponent(url.pathname)
    } catch {
      path = url.pathname
    }
    const send = (status: number, file: string | undefined, headers: Record<string, string> = {}): void => {
      log.push({ path: url.pathname + url.search, status })
      if (file === undefined) {
        res.writeHead(status, headers)
        res.end()
        return
      }
      const body = readFileSync(file)
      res.writeHead(status, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'content-length': body.length, 'cache-control': 'no-cache', ...headers })
      res.end(req.method === 'HEAD' ? undefined : body)
    }
    let file = normalize(join(base, path))
    if (file !== base && !file.startsWith(base + sep)) return send(403, undefined)
    if (existsSync(file) && statSync(file).isDirectory()) {
      if (!path.endsWith('/')) return send(301, undefined, { location: `${url.pathname}/${url.search}` })
      file = join(file, 'index.html')
    }
    if (existsSync(file) && statSync(file).isFile()) return send(200, file)
    const notFound = join(base, '404.html')
    return send(404, existsSync(notFound) ? notFound : undefined)
  })
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(port, 'localhost', () => {
      const address = server.address() as AddressInfo
      resolvePromise({
        url: `http://localhost:${address.port}`,
        port: address.port,
        log,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections()
            server.close(() => done())
          }),
      })
    })
  })
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = join(dirname(fileURLToPath(import.meta.url)), 'out')
  const served = await startStaticServer(out, Number(process.argv[2] ?? 0) || 0)
  console.log(`site/out at ${served.url} (Ctrl+C to stop)`)
}
