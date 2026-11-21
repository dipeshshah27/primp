/**
 * Serves the held-out pages in `spikes/s7-assets/heldout/`.
 *
 * Same contract as the corpus server (`fixtures/cls-corpus/server.mjs`):
 * `/<path>` is a static file, `/delay/<ms>/<path>` is the same file with the
 * response held back, everything is `no-store`. `/assets/...` is answered from
 * the corpus's own assets, so the pages reuse its images, font and JSON.
 */

import { createReadStream, existsSync, statSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, normalize, sep } from 'node:path'
import { FIXTURES_ROOT, onCleanup, REPO_ROOT } from '../lib/index.ts'

export const HELDOUT_ROOT = join(REPO_ROOT, 'spikes/s7-assets/heldout')
const CORPUS_ROOT = join(FIXTURES_ROOT, 'cls-corpus')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

function resolveFile(pathname: string): string | undefined {
  const root = pathname.startsWith('/assets/') ? CORPUS_ROOT : HELDOUT_ROOT
  let file = join(root, normalize(decodeURIComponent(pathname)))
  if (file !== root && !file.startsWith(root + sep)) return undefined
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
  return existsSync(file) ? file : undefined
}

export interface HeldoutServer {
  port: number
  url: string
  close(): Promise<void>
}

export async function startHeldoutServer(): Promise<HeldoutServer> {
  const timers = new Set<NodeJS.Timeout>()
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://heldout.invalid')
    const match = /^\/delay\/(\d{1,5})(\/.*)$/.exec(url.pathname)
    const pathname = match?.[2] ?? url.pathname
    const respond = (): void => {
      const file = resolveFile(pathname)
      if (file === undefined) {
        res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
        res.end('not found')
        return
      }
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store', 'content-length': statSync(file).size })
      createReadStream(file).pipe(res)
    }
    const delay = Number(match?.[1] ?? 0)
    if (delay === 0) return respond()
    const timer = setTimeout(() => {
      timers.delete(timer)
      respond()
    }, delay)
    timers.add(timer)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as AddressInfo).port
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    closing ??= new Promise<void>((resolve) => {
      for (const timer of timers) clearTimeout(timer)
      server.close(() => resolve())
      server.closeAllConnections()
    }).then(() => removeCleanup())
    return closing
  }
  const removeCleanup = onCleanup(close)
  return { port, url: `http://127.0.0.1:${port}`, close }
}
