import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `primp demo`: a small static site with one seeded layout shift, served by a
 * tiny server of its own, so the first run shows what primp is for without
 * touching a real project.
 *
 * The site is copied into a directory of the user's choosing (default
 * `./primp-demo`), because a coding agent has to be able to edit it.
 */

export class DemoError extends Error {}

const HERE = dirname(fileURLToPath(import.meta.url))

/** The template: `demo/` next to the bundled cli.js, or `demo-site/` in a checkout. */
export function demoTemplateDir(): string {
  for (const candidate of [join(HERE, 'demo'), join(HERE, '../demo-site')]) {
    if (existsSync(join(candidate, 'index.html'))) return candidate
  }
  throw new DemoError('The demo site is missing from this installation of primp.')
}

/** Copies the demo site to `dir`. An existing demo (same index.html marker) is reused; any other non-empty directory is refused. */
export function prepareDemo(dir: string, template: string = demoTemplateDir()): { dir: string; created: boolean } {
  const target = resolve(dir)
  if (existsSync(target)) {
    if (!statSync(target).isDirectory()) throw new DemoError(`${target} exists and is not a directory.`)
    const entries = readdirSync(target).filter((name) => name !== '.DS_Store')
    if (entries.length > 0) {
      const index = join(target, 'index.html')
      const isDemo = existsSync(index) && readFileSync(index, 'utf8').includes('<title>Tidewater Coffee</title>')
      if (isDemo) return { dir: target, created: false }
      throw new DemoError(`${target} is not empty. Pass another directory: primp demo --dir <directory>.`)
    }
  }
  mkdirSync(target, { recursive: true })
  cpSync(template, target, { recursive: true })
  return { dir: target, created: true }
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown; charset=utf-8',
}

export interface DemoServer {
  port: number
  url: string
  close(): Promise<void>
}

/**
 * Serves `root` as an ordinary cacheable static site (ETag, `max-age` on everything but pages),
 * with one extra: `?delay=<ms>` holds a response back, which is what makes the picture arrive late.
 */
export function startDemoServer(root: string, port = 0): Promise<DemoServer> {
  const base = resolve(root)
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    let path = decodeURIComponent(url.pathname)
    if (path.endsWith('/')) path += 'index.html'
    const file = normalize(join(base, path))
    const inside = file === base || file.startsWith(base + sep)
    if (!inside || !existsSync(file) || !statSync(file).isFile() || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(inside ? 404 : 403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end('Not found\n')
      return
    }
    const body = readFileSync(file)
    const etag = `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`
    const page = extname(file) === '.html'
    const headers = {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': page ? 'no-cache' : 'public, max-age=3600',
      etag,
    }
    const delay = Math.min(Math.max(Number(url.searchParams.get('delay') ?? 0) || 0, 0), 5000)
    setTimeout(() => {
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers)
        res.end()
        return
      }
      res.writeHead(200, { ...headers, 'content-length': body.length })
      res.end(req.method === 'HEAD' ? undefined : body)
    }, delay)
  })
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    // `localhost`: the name primp's proxy uses for its target.
    server.listen(port, 'localhost', () => {
      const address = server.address() as AddressInfo
      resolvePromise({
        port: address.port,
        url: `http://localhost:${address.port}`,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections()
            server.close(() => done())
          }),
      })
    })
  })
}

/** What to do next, printed after primp's own start-up lines. */
export function demoGuide(dir: string, cwd: string = process.cwd()): string {
  const shown = dir.startsWith(cwd + sep) ? `./${dir.slice(cwd.length + 1)}` : dir
  return [
    'This is the primp demo: a one-page site with one seeded layout shift.',
    '',
    `  1. In the page, open the dock's Shifts tab: the picture under the headline has no reserved`,
    '     space, so everything below it jumps when it loads. primp names the element and its line.',
    `  2. In your coding agent, in ${shown}, say:`,
    '       "Fix the layout shift primp found, then verify it."',
    '     It reads the shift (get_layout_shifts), edits index.html, and has primp reload the page',
    '     three times to confirm the jump is gone (verify_layout_shift).',
    '  3. Try an edit: in the Edits tab pick the "Start a subscription" button, change its padding',
    '     or colour, press Send, and tell your agent: "Implement the primp changes and verify them."',
    '',
    'No agent registered yet? Run `npx primp setup` in another terminal, or paste the prompt that Send copies.',
  ].join('\n')
}
