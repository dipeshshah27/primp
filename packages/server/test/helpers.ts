import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { createProxy, type ProxyLogLevel, type ProxyOptions, type ProxyServer } from '../src/index.ts'

/** Things to stop after each test, newest first. */
const cleanups: (() => Promise<void> | void)[] = []

export function onCleanup(cleanup: () => Promise<void> | void): void {
  cleanups.push(cleanup)
}

export async function runCleanups(): Promise<void> {
  while (cleanups.length > 0) await cleanups.pop()?.()
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export interface TestUpstream {
  port: number
  server: http.Server
  /** Every request the upstream received, in order. */
  seen: http.IncomingMessage[]
}

export interface UpstreamOptions {
  host?: string
  tls?: { key: string; cert: string }
}

/** A scripted dev server on an OS-chosen port. */
export async function startUpstream(handler: http.RequestListener, options: UpstreamOptions = {}): Promise<TestUpstream> {
  const seen: http.IncomingMessage[] = []
  const listener: http.RequestListener = (req, res) => {
    seen.push(req)
    handler(req, res)
  }
  const server = options.tls ? https.createServer(options.tls, listener) : http.createServer(listener)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, options.host ?? '127.0.0.1', () => resolve())
  })
  onCleanup(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  )
  return { port: (server.address() as AddressInfo).port, server, seen }
}

export interface LogEntry {
  level: ProxyLogLevel
  message: string
}

export interface TestProxy extends ProxyServer {
  logs: LogEntry[]
}

export const HOOK = 'window.__primpHook = true'
export const HOOK_TAG = '<script src="/__primp/hook.js" data-primp></script>'

export async function startProxy(targetPort: number, overrides: Partial<ProxyOptions> = {}): Promise<TestProxy> {
  const logs: LogEntry[] = []
  const proxy = await createProxy({
    target: { protocol: 'http', host: '127.0.0.1', port: targetPort },
    assets: new Map([['hook.js', { body: HOOK, contentType: 'text/javascript; charset=utf-8' }]]),
    headScripts: ['hook.js'],
    log: (level, message) => logs.push({ level, message }),
    ...overrides,
  })
  onCleanup(() => proxy.close())
  return Object.assign(proxy, { logs })
}

export interface ClientChunk {
  /** `performance.now()` when the chunk reached the client. */
  at: number
  data: Buffer
}

export interface ClientResponse {
  status: number
  statusMessage: string
  headers: http.IncomingHttpHeaders
  rawHeaders: string[]
  chunks: ClientChunk[]
  body: Buffer
  text: string
}

export interface SendOptions {
  method?: string
  path?: string
  /** Sent as given; `Host` defaults to `localhost:<port>`. */
  headers?: Record<string, string | string[]>
  body?: string | Buffer
  /** Address to connect to. Default 127.0.0.1. */
  address?: string
  /** Called with the request once it is created, for tests that write or abort by hand. */
  onRequest?: (request: http.ClientRequest) => void
}

/** A plain HTTP/1.1 client that does not decode, follow or retry anything. */
export function send(port: number, options: SendOptions = {}): Promise<ClientResponse> {
  return new Promise<ClientResponse>((resolve, reject) => {
    const headers: Record<string, string | string[]> = { host: `localhost:${port}`, ...options.headers }
    const request = http.request(
      { host: options.address ?? '127.0.0.1', port, path: options.path ?? '/', method: options.method ?? 'GET', headers, agent: false },
      (response) => {
        const chunks: ClientChunk[] = []
        response.on('data', (data: Buffer) => chunks.push({ at: performance.now(), data }))
        response.on('error', reject)
        response.on('end', () => {
          const body = Buffer.concat(chunks.map((chunk) => chunk.data))
          resolve({
            status: response.statusCode ?? 0,
            statusMessage: response.statusMessage ?? '',
            headers: response.headers,
            rawHeaders: response.rawHeaders,
            chunks,
            body,
            text: body.toString('utf8'),
          })
        })
      },
    )
    request.on('error', reject)
    if (options.onRequest) options.onRequest(request)
    else request.end(options.body)
  })
}

/** Headers a browser sends when it navigates to a page. */
export const NAVIGATE = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-encoding': 'gzip, deflate, br, zstd',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
}

/** Raw header value(s) by case-insensitive name, in order. */
export function rawValues(rawHeaders: string[], name: string): string[] {
  const values: string[] = []
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    if (rawHeaders[i]?.toLowerCase() === name.toLowerCase()) values.push(rawHeaders[i + 1] ?? '')
  }
  return values
}

/** A self-signed certificate for `localhost`, made with the system's openssl. */
export function selfSignedCertificate(): { key: string; cert: string } {
  const root = fileURLToPath(new URL('../../../.tmp/', import.meta.url))
  mkdirSync(root, { recursive: true })
  const dir = mkdtempSync(`${root}server-test-cert-`)
  try {
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
        '-subj', '/CN=localhost',
        '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1',
        '-keyout', `${dir}/key.pem`,
        '-out', `${dir}/cert.pem`,
      ],
      { stdio: 'pipe' },
    )
    return { key: readFileSync(`${dir}/key.pem`, 'utf8'), cert: readFileSync(`${dir}/cert.pem`, 'utf8') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
