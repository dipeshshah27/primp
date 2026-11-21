import http, { type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http'
import net, { type AddressInfo } from 'node:net'
import { onCleanup } from '../lib/index.ts'

/**
 * A plain streaming HTTP relay with hooks on the headers, for the spikes.
 *
 * It stands where the product will later have options on the reglet proxy
 * itself (the spikes may not change `packages/server`):
 *
 *   browser -> reglet proxy (injects the hook) -> relay -> dev server
 *
 * WebSocket upgrades are tunnelled byte for byte, so a dev server's HMR socket
 * keeps working through it.
 *
 * Used as
 *   - a request log: every request that really reached the origin side;
 *   - a "cacheable origin": rewrites the corpus server's `no-store` into the
 *     headers an ordinary dev server sends, so that there is a cache to defeat;
 *   - the cold-replay policy under test (`coldPolicy`);
 *   - a way to turn on cross-origin isolation, which gives the page a 5 µs clock.
 */

export interface RelayRequest {
  /** `performance.now()` of the relay process when the request arrived. */
  t: number
  method: string
  /** Path and query as received. */
  url: string
  headers: IncomingHttpHeaders
  /** Whatever the test attached with `tag()`: for example the load number. */
  tag: string
  /** The request carried `If-None-Match` / `If-Modified-Since` when it arrived here. */
  conditional: boolean
  /** It still carried one when it was sent on, after the policies: the origin could have answered 304. */
  conditionalUpstream: boolean
}

export interface RelayPolicy {
  /** Changes the headers sent upstream. Mutate and return. */
  request?(headers: IncomingHttpHeaders, request: { method: string; url: string }): IncomingHttpHeaders
  /** Changes the headers sent back. Mutate and return. */
  response?(headers: OutgoingHttpHeaders, context: { status: number; method: string; url: string; isDocument: boolean }): OutgoingHttpHeaders
}

export interface Relay {
  port: number
  url: string
  /** Every request received, in arrival order. */
  log: RelayRequest[]
  /** Label attached to the requests that arrive from now on. */
  tag(label: string): void
  /** Replaces the policies; takes effect for the next request. */
  setPolicies(policies: RelayPolicy[]): void
  close(): Promise<void>
}

/** A navigation, as opposed to a subresource or an iframe. */
function isDocumentRequest(headers: IncomingHttpHeaders): boolean {
  const dest = headers['sec-fetch-dest']
  if (typeof dest === 'string') return dest === 'document'
  return String(headers.accept ?? '').includes('text/html')
}

export async function startRelay(target: { port: number; host?: string }, initial: RelayPolicy[] = []): Promise<Relay> {
  const log: RelayRequest[] = []
  let policies = initial
  let currentTag = ''
  const agent = new http.Agent({ keepAlive: true })
  // The corpus server listens on 127.0.0.1; the framework dev servers on `localhost` (::1 on this machine).
  const host = target.host ?? '127.0.0.1'

  const server = http.createServer((req, res) => {
    const method = req.method ?? 'GET'
    const url = req.url ?? '/'
    const isConditional = (h: IncomingHttpHeaders): boolean => h['if-none-match'] !== undefined || h['if-modified-since'] !== undefined
    const entry: RelayRequest = { t: performance.now(), method, url, headers: { ...req.headers }, tag: currentTag, conditional: isConditional(req.headers), conditionalUpstream: false }
    log.push(entry)
    const isDocument = isDocumentRequest(req.headers)
    let headers: IncomingHttpHeaders = { ...req.headers }
    for (const policy of policies) headers = policy.request?.(headers, { method, url }) ?? headers
    entry.conditionalUpstream = isConditional(headers)
    const upstream = http.request(
      { host, port: target.port, method, path: url, headers, agent },
      (upstreamRes) => {
        let out: OutgoingHttpHeaders = { ...upstreamRes.headers }
        const status = upstreamRes.statusCode ?? 502
        for (const policy of policies) out = policy.response?.(out, { status, method, url, isDocument }) ?? out
        res.writeHead(status, out)
        upstreamRes.pipe(res)
      },
    )
    upstream.on('error', (error) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
      res.end(`relay: ${error.message}`)
    })
    res.on('close', () => upstream.destroy())
    req.pipe(upstream)
  })
  const sockets = new Set<net.Socket>()
  server.on('upgrade', (req, socket, head) => {
    const upstream = net.connect({ host, port: target.port }, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`]
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
      upstream.write(lines.join('\r\n') + '\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    for (const end of [upstream, socket as net.Socket]) {
      sockets.add(end)
      end.on('error', () => {})
      end.on('close', () => {
        sockets.delete(end)
        upstream.destroy()
        socket.destroy()
      })
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as AddressInfo).port

  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    closing ??= new Promise<void>((resolve) => {
      agent.destroy()
      for (const socket of sockets) socket.destroy()
      server.close(() => resolve())
      server.closeAllConnections()
    }).then(() => removeCleanup())
    return closing
  }
  const removeCleanup = onCleanup(close)

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    log,
    tag(label) {
      currentTag = label
    },
    setPolicies(next) {
      policies = next
    },
    close,
  }
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

/**
 * Makes the origin behave like an ordinary dev or static server: responses are
 * cacheable for an hour and carry validators. Without this the corpus server's
 * own `Cache-Control: no-store` would make every load cold by itself and a
 * cold-replay mechanism could not be told from no mechanism at all.
 */
export function cacheableOrigin(options: { documentsToo?: boolean } = {}): RelayPolicy {
  return {
    response(headers, { url, isDocument }) {
      if (isDocument && options.documentsToo !== true) {
        // Dev servers send documents as `no-cache`: stored, but revalidated on every use.
        headers['cache-control'] = 'no-cache'
      } else {
        headers['cache-control'] = 'public, max-age=3600'
      }
      headers.etag = `"fixed-${Buffer.from(url.replace(/^\/delay\/\d+/, '')).toString('base64url').slice(0, 24)}"`
      headers['last-modified'] = 'Mon, 02 Nov 2026 10:00:00 GMT'
      return headers
    },
    request(headers) {
      return headers
    },
  }
}

export interface ColdPolicyOptions {
  /** `Cache-Control: no-store` on every response, validators removed. */
  noStore?: boolean
  /** Remove `If-None-Match` / `If-Modified-Since` from requests, so the origin cannot answer 304. */
  stripConditionals?: boolean
  /** `Clear-Site-Data: "cache"` on document responses. */
  clearSiteData?: boolean
}

/**
 * The cold-replay policy under test: what the reglet proxy would do to every
 * proxied response while a replay is running. It works on headers only, so it
 * needs nothing from the browser but an ordinary reload.
 */
export function coldPolicy(options: ColdPolicyOptions): RelayPolicy {
  return {
    request(headers) {
      if (options.stripConditionals === true) {
        delete headers['if-none-match']
        delete headers['if-modified-since']
        delete headers['if-range']
      }
      return headers
    },
    response(headers, { isDocument }) {
      if (options.noStore === true) {
        headers['cache-control'] = 'no-store'
        delete headers.etag
        delete headers['last-modified']
        delete headers.expires
        delete headers.age
      }
      if (options.clearSiteData === true && isDocument) headers['clear-site-data'] = '"cache"'
      return headers
    },
  }
}

/** Cross-origin isolation: `performance.now()` then has 5 µs steps instead of 100 µs. */
export function isolated(): RelayPolicy {
  return {
    response(headers) {
      headers['cross-origin-opener-policy'] = 'same-origin'
      headers['cross-origin-embedder-policy'] = 'require-corp'
      headers['cross-origin-resource-policy'] = 'same-origin'
      return headers
    },
  }
}
