import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { Socket } from 'node:net'
import { pipeline, type Duplex, type Transform } from 'node:stream'
import { constants as zlib, createBrotliDecompress, createGunzip, createInflate, createZstdDecompress } from 'node:zlib'
import { WebSocketServer, type WebSocket } from 'ws'
import { planCsp, type CspMode } from './csp.ts'
import { closeServer, errorCode, listenOn, listenOnLoopback } from './free-port.ts'
import {
  buildUpstreamHeaders,
  connectionTokens,
  isAllowedHost,
  isHopByHop,
  isNavigation,
  requestHasBody,
  rewriteLocation,
  rewriteSetCookie,
  type ProxyTarget,
  type RawHeaders,
} from './headers.ts'
import { createHeadInjectStream } from './html-inject.ts'
import { refuseUpgrade, tunnelUpgrade, type UpgradeFrameHandler } from './tunnel.ts'
import { Upstream } from './upstream.ts'

/**
 * The primp proxy: a reverse proxy in front of the developer's dev server.
 *
 *   - Everything under `reservedPrefix` is answered by primp itself (overlay
 *     assets, the overlay WebSocket) and never reaches the dev server.
 *   - Document navigations get the `headScripts` injected as the first thing
 *     in `<head>`, while the document keeps streaming (`html-inject.ts`).
 *   - Every other response is piped through byte for byte.
 *   - Upgrade requests are tunnelled over raw sockets and their WebSocket
 *     frames are shown to `onUpgradeFrame` (`tunnel.ts`).
 *
 * The header policy is described in `headers.ts`, the CSP policy in `csp.ts`.
 */

export interface ProxyAsset {
  body: string | Buffer
  contentType: string
}

/** Assets by path below the reserved prefix (`hook.js` for `/__primp/hook.js`). */
export type ProxyAssets =
  | ReadonlyMap<string, ProxyAsset>
  | ((path: string) => ProxyAsset | undefined | Promise<ProxyAsset | undefined>)

export type ProxyLogLevel = 'debug' | 'info' | 'warn' | 'error'
export type ProxyLogger = (level: ProxyLogLevel, message: string, detail?: unknown) => void

export interface ProxyOptions {
  /** The dev server. */
  target: ProxyTarget
  /**
   * Where to listen. `localhost` (the default) binds both `127.0.0.1` and
   * `::1`; port 0 (the default) lets the OS choose.
   */
  listen?: { host?: string; port?: number }
  /** Path prefix owned by primp. Default `/__primp/`. */
  reservedPrefix?: string
  assets?: ProxyAssets
  /**
   * Asset paths below the reserved prefix, injected in this order as
   * synchronous `<script src>` tags at the start of `<head>`.
   */
  headScripts?: string[]
  /** How to deal with the page's Content-Security-Policy. Default `nonce`. */
  cspMode?: CspMode
  /**
   * Asked for every request. While it returns true the browser cache is kept out of the picture:
   * conditional request headers are not forwarded, and every response is sent
   * `Cache-Control: no-store` without validators.
   *
   * primp runs with this on all the time. A page load is then always a first visit, which is the
   * load whose layout shifts matter, and a reload after a source edit never shows a stale stylesheet
   * or image. Switching it on only for a replay is not enough: what the browser cached before stays
   * fresh, and `location.reload()` does not revalidate fresh subresources (spike S7, and the demo
   * check, which found replays that were "cold" in name only). Resources from other origins never
   * pass through here and stay cached.
   */
  cold?: () => boolean
  /**
   * Asked for every document response. While it returns true the response also carries
   * `Clear-Site-Data: "cache"`, which empties what an earlier, cacheable session left behind for
   * this origin. Only a document response can do that.
   */
  clearCache?: () => boolean
  /** Sees every WebSocket message of every tunnelled upgrade. Read-only. */
  onUpgradeFrame?: UpgradeFrameHandler
  /** Receives the overlay's own WebSocket connections (upgrades under the reserved prefix). */
  onWebSocket?: (socket: WebSocket, request: IncomingMessage) => void
  log?: ProxyLogger
}

export interface ProxyServer {
  port: number
  /** `http://localhost:<port>` */
  url: string
  close(): Promise<void>
}

const CSP_HEADERS = new Set(['content-security-policy', 'content-security-policy-report-only'])
/** These describe the dev server's bytes, not the injected document. */
const DOCUMENT_STRIP = new Set(['etag', 'last-modified', 'content-length', 'accept-ranges', 'content-md5', 'digest'])
const MAX_LOGGED_WARNINGS = 50
/** Request headers that let the dev server answer 304. */
const CONDITIONAL_REQUEST = new Set(['if-none-match', 'if-modified-since', 'if-range'])
/** Response headers that let the browser keep or revalidate a copy. */
const CACHE_RESPONSE = new Set(['cache-control', 'etag', 'last-modified', 'expires', 'age', 'pragma'])

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)
}

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? ''
}

function pathOf(url: string | undefined): string {
  const value = url ?? '/'
  const path = /^[a-z][a-z0-9+.-]*:\/\/[^/]*(.*)$/i.exec(value)?.[1] ?? value
  return path.split(/[?#]/, 1)[0] ?? '/'
}

/** `text/html` in a single-byte-compatible encoding; the scanner looks for ASCII bytes. */
function isInjectableHtml(contentType: string): boolean {
  if (!/^\s*text\/html\s*(;|$)/i.test(contentType)) return false
  return !/charset\s*=\s*"?\s*(utf-16|utf-32|ucs-2)/i.test(contentType)
}

/** A stream that undoes `Content-Encoding` chunk by chunk, or undefined if it is not understood. */
function createDecoder(encoding: string): Transform | undefined {
  // Sync flush on both ends: emit what each chunk decodes to at once, and
  // tolerate a stream that is cut short.
  const flush = { flush: zlib.Z_SYNC_FLUSH, finishFlush: zlib.Z_SYNC_FLUSH }
  switch (encoding) {
    case 'gzip':
    case 'x-gzip':
      return createGunzip(flush)
    case 'deflate':
      return createInflate(flush)
    case 'br':
      return createBrotliDecompress({
        flush: zlib.BROTLI_OPERATION_FLUSH,
        finishFlush: zlib.BROTLI_OPERATION_FLUSH,
      })
    case 'zstd':
      return createZstdDecompress()
    default:
      return undefined
  }
}

export async function createProxy(options: ProxyOptions): Promise<ProxyServer> {
  const reservedPrefix = options.reservedPrefix ?? '/__primp/'
  if (!reservedPrefix.startsWith('/') || !reservedPrefix.endsWith('/')) {
    throw new TypeError('reservedPrefix must start and end with "/"')
  }
  const headScripts = options.headScripts ?? []
  const cspMode = options.cspMode ?? 'nonce'
  const assets = options.assets
  const log: ProxyLogger = options.log ?? (() => {})
  const upstream = new Upstream(options.target)
  const overlaySockets = new WebSocketServer({ noServer: true })
  const tunnelSockets = new Set<Duplex>()
  const warned = new Set<string>()
  let port = 0

  /** Logs a warning once per distinct message, so a policy problem is not repeated on every page load. */
  function warnOnce(message: string): void {
    if (warned.has(message) || warned.size >= MAX_LOGGED_WARNINGS) return
    warned.add(message)
    log('warn', message)
  }

  function isReserved(url: string | undefined): boolean {
    const path = pathOf(url)
    return path.startsWith(reservedPrefix) || path === reservedPrefix.slice(0, -1)
  }

  function scriptTags(nonce: string | undefined): string {
    const attribute = nonce === undefined ? '' : ` nonce="${escapeHtml(nonce)}"`
    return headScripts
      .map((path) => {
        const src = path.startsWith('/') ? path : reservedPrefix + path
        return `<script src="${escapeHtml(src)}"${attribute} data-primp></script>`
      })
      .join('')
  }

  function sendText(res: ServerResponse, status: number, body: string): void {
    res.writeHead(status, {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    res.end(body)
  }

  async function serveAsset(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method not allowed\n')
    const path = pathOf(req.url).slice(reservedPrefix.length)
    // The path is handed to the resolver undecoded; anything that could walk out of a directory is refused here.
    if (path === '' || /(^|\/)\.\.?(\/|$)|[\\\0]|%2e|%2f|%5c/i.test(path)) return sendText(res, 404, 'Not found\n')
    try {
      const asset = typeof assets === 'function' ? await assets(path) : assets?.get(path)
      if (asset === undefined) return sendText(res, 404, 'Not found\n')
      const body = typeof asset.body === 'string' ? Buffer.from(asset.body, 'utf8') : asset.body
      res.writeHead(200, {
        'content-type': asset.contentType,
        'content-length': body.length,
        // Overlay builds change under the same URL during development.
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      res.end(req.method === 'HEAD' ? undefined : body)
    } catch (error) {
      log('error', `asset ${path} could not be served`, error)
      if (res.headersSent) res.destroy()
      else sendText(res, 500, 'Asset could not be served\n')
    }
  }

  /** Answer for an unreachable dev server. Pages get the overlay too, so it can report and reconnect. */
  function sendBadGateway(req: IncomingMessage, res: ServerResponse, error: unknown): void {
    const reason = errorCode(error) ?? (error instanceof Error ? error.message : String(error))
    const wantsPage =
      first(req.headers['sec-fetch-dest']) === 'document' || /text\/html/i.test(first(req.headers.accept))
    if (!wantsPage) {
      return sendText(res, 502, `primp could not reach the dev server at ${upstream.origin} (${reason})\n`)
    }
    const body =
      `<!doctype html><html lang="en"><head>${scriptTags(undefined)}<meta charset="utf-8">` +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<meta http-equiv="refresh" content="2"><title>Dev server not reachable</title>' +
      '<style>body{font:16px/1.5 system-ui,sans-serif;margin:15vh auto;max-width:34rem;padding:0 1.5rem;' +
      'color:#1c1c1c;background:#fafafa}code{font-family:ui-monospace,monospace}' +
      '@media(prefers-color-scheme:dark){body{color:#e8e8e8;background:#161616}}</style></head>' +
      '<body><h1>Dev server not reachable</h1>' +
      `<p>primp could not reach <code>${escapeHtml(upstream.origin)}</code> (<code>${escapeHtml(reason)}</code>).</p>` +
      '<p>Start or restart your dev server. This page retries every 2 seconds.</p></body></html>\n'
    res.writeHead(502, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    })
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  function forward(req: IncomingMessage, res: ServerResponse): void {
    const navigation = isNavigation(req)
    const hasBody = requestHasBody(req)
    const cold = options.cold?.() === true
    const built = buildUpstreamHeaders(req, { navigation, upgrade: false, proxyPort: port })
    let headers = built
    if (cold) {
      headers = []
      for (let i = 0; i + 1 < built.length; i += 2) {
        if (!CONDITIONAL_REQUEST.has((built[i] ?? '').toLowerCase())) headers.push(built[i] ?? '', built[i + 1] ?? '')
      }
    }
    let current: ReturnType<typeof httpRequest> | undefined
    let clientGone = false

    // The browser went away: stop the dev server's work for it.
    res.on('close', () => {
      if (res.writableFinished) return
      clientGone = true
      current?.destroy()
    })
    req.on('error', () => current?.destroy())

    const send = (retried: boolean): void => {
      let responded = false
      const proxyReq = httpRequest({
        agent: hasBody ? upstream.freshAgent : upstream.keepAliveAgent,
        method: req.method,
        path: req.url,
        headers,
        host: upstream.target.host,
        port: upstream.target.port,
        setHost: false,
      })
      current = proxyReq
      proxyReq.on('response', (proxyRes) => {
        responded = true
        respond(req, res, proxyRes, navigation, cold)
      })
      proxyReq.on('error', (error) => {
        if (clientGone || responded) return
        // An idle connection the dev server closed in the meantime. Requests
        // without a body are safe to send once more on a new connection.
        if (!retried && !hasBody && proxyReq.reusedSocket && errorCode(error) === 'ECONNRESET') return send(true)
        log('debug', `${req.method} ${req.url} failed upstream`, error)
        // Let the browser finish sending, so it reads the answer instead of seeing a reset.
        req.unpipe(proxyReq)
        req.resume()
        if (res.headersSent) res.destroy()
        else sendBadGateway(req, res, error)
      })
      if (hasBody) req.pipe(proxyReq)
      else proxyReq.end()
    }
    send(false)
  }

  function respond(req: IncomingMessage, res: ServerResponse, proxyRes: IncomingMessage, navigation: boolean, cold = false): void {
    const status = proxyRes.statusCode ?? 502
    const publicHost = first(req.headers.host)
    const document =
      navigation &&
      isInjectableHtml(first(proxyRes.headers['content-type'])) &&
      // A download is saved, not shown.
      !/^\s*attachment/i.test(first(proxyRes.headers['content-disposition']))
    const hasBody = req.method !== 'HEAD' && status >= 200 && status !== 204 && status !== 304

    let decoder: Transform | undefined
    let inject = document && hasBody && headScripts.length > 0
    // A HEAD for a page describes the injected page, not the dev server's bytes.
    const mirrorsInjected = document && req.method === 'HEAD' && headScripts.length > 0 && status !== 304
    const encoding = first(proxyRes.headers['content-encoding']).trim().toLowerCase()
    if (inject && encoding !== '' && encoding !== 'identity') {
      decoder = createDecoder(encoding)
      if (decoder === undefined) {
        inject = false
        warnOnce(`cannot inject into a document with Content-Encoding "${encoding}"; passing it through`)
      }
    }

    const rewritten = inject || mirrorsInjected
    const cspValues: string[] = []
    if (rewritten) {
      const raw = proxyRes.rawHeaders
      for (let i = 0; i + 1 < raw.length; i += 2) {
        if (CSP_HEADERS.has((raw[i] ?? '').toLowerCase())) cspValues.push(raw[i + 1] ?? '')
      }
    }
    const csp = cspValues.length > 0 ? planCsp(cspMode, cspValues, { publicHost }) : undefined
    if (csp?.warning !== undefined) warnOnce(csp.warning)

    const out: RawHeaders = []
    const raw = proxyRes.rawHeaders
    const nominated = connectionTokens(raw)
    let cspIndex = 0
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const name = raw[i] ?? ''
      const lower = name.toLowerCase()
      let value: string | undefined = raw[i + 1] ?? ''
      if (isHopByHop(lower) || nominated.has(lower)) continue
      if (lower === 'location') value = rewriteLocation(value, upstream.target, publicHost)
      else if (lower === 'set-cookie') value = rewriteSetCookie(value, upstream.target)
      else if (csp !== undefined && CSP_HEADERS.has(lower)) value = csp.values[cspIndex++]
      // A document's validators belong to the page before injection. Without
      // them the browser cannot revalidate its way to an uninjected copy.
      else if (rewritten && DOCUMENT_STRIP.has(lower)) continue
      else if (decoder !== undefined && lower === 'content-encoding') continue
      else if (cold && CACHE_RESPONSE.has(lower)) continue
      if (value !== undefined) out.push(name, value)
    }
    if (cold) out.push('Cache-Control', 'no-store')
    if (document && options.clearCache?.() === true) out.push('Clear-Site-Data', '"cache"')

    // Pass the dev server's headers as they are; do not add a Date of our own.
    res.sendDate = false
    try {
      res.writeHead(status, proxyRes.statusMessage, out)
    } catch (error) {
      log('warn', `${req.method} ${req.url}: response headers were rejected`, error)
      proxyRes.destroy()
      if (!res.headersSent) sendText(res, 502, 'primp could not relay the response headers\n')
      return
    }
    // Send the headers now: a streamed page or an event stream may not produce a body for a while.
    res.flushHeaders()

    const done = (error: NodeJS.ErrnoException | null): void => {
      if (error && !res.destroyed) res.destroy()
    }
    if (!inject) {
      pipeline(proxyRes, res, done)
      return
    }
    const injector = createHeadInjectStream(scriptTags(csp?.nonce), (placement) => {
      if (placement !== 'head') log('debug', `${req.url}: no <head> tag, scripts placed at "${placement}"`)
    })
    if (decoder !== undefined) pipeline(proxyRes, decoder, injector, res, done)
    else pipeline(proxyRes, injector, res, done)
  }

  function onRequest(req: IncomingMessage, res: ServerResponse): void {
    req.on('error', () => {})
    res.on('error', () => {})
    if (!isAllowedHost(req.headers.host, port)) {
      res.setHeader('connection', 'close')
      // Said for a person who typed another name (a LAN address, a *.localhost name, a phone): what to open instead.
      return sendText(
        res,
        403,
        `Forbidden host\n\nprimp answers only on this machine, as http://localhost:${port} (also 127.0.0.1 and [::1]), so that no other device or web page can reach your dev server through it. Open http://localhost:${port}/ here instead.\n`,
      )
    }
    if (isReserved(req.url)) {
      void serveAsset(req, res)
      return
    }
    try {
      forward(req, res)
    } catch (error) {
      // http.request refuses request targets and header values it considers malformed.
      log('warn', `${req.method} ${req.url} could not be forwarded`, error)
      if (!res.headersSent) sendText(res, 400, 'Bad request\n')
      else res.destroy()
    }
  }

  function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => {})
    tunnelSockets.add(socket)
    socket.once('close', () => tunnelSockets.delete(socket))
    if (!isAllowedHost(req.headers.host, port)) return refuseUpgrade(socket, 403, 'Forbidden host')
    if (!isReserved(req.url)) {
      tunnelUpgrade(req, socket, head, {
        upstream,
        proxyPort: port,
        onFrame: options.onUpgradeFrame,
        track(upstreamSocket) {
          tunnelSockets.add(upstreamSocket)
          upstreamSocket.once('close', () => tunnelSockets.delete(upstreamSocket))
        },
        warn: (message, detail) => log('warn', message, detail),
      })
      return
    }
    // The overlay's socket is for pages served by this proxy only. The Host
    // check above stops rebinding; this stops other sites.
    if (req.headers.origin !== `http://${first(req.headers.host)}`) return refuseUpgrade(socket, 403, 'Forbidden origin')
    const onWebSocket = options.onWebSocket
    if (onWebSocket === undefined) return refuseUpgrade(socket, 404, 'Not Found')
    overlaySockets.handleUpgrade(req, socket, head, (webSocket) => {
      webSocket.on('error', (error) => log('debug', 'overlay socket error', error))
      try {
        onWebSocket(webSocket, req)
      } catch (error) {
        log('error', 'onWebSocket handler threw', error)
        webSocket.terminate()
      }
    })
  }

  function makeServer(): Server {
    const server = createServer(onRequest)
    // Uploads and long-lived responses are the dev server's business to time out.
    server.requestTimeout = 0
    server.on('upgrade', onUpgrade)
    server.on('clientError', (error: NodeJS.ErrnoException, socket: Socket) => {
      if (error.code === 'ECONNRESET' || !socket.writable) socket.destroy()
      else socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    })
    return server
  }

  const listenHost = options.listen?.host ?? 'localhost'
  const listenPort = options.listen?.port ?? 0
  let servers: Server[]
  if (listenHost === 'localhost') {
    const bound = await listenOnLoopback(makeServer, listenPort)
    servers = bound.servers
    port = bound.port
  } else {
    const server = makeServer()
    port = await listenOn(server, listenPort, listenHost)
    servers = [server]
  }
  // Errors after startup (for example EMFILE on accept) must not take the process down.
  for (const server of servers) server.on('error', (error) => log('error', 'proxy listener error', error))

  let closing: Promise<void> | undefined
  return {
    port,
    url: `http://localhost:${port}`,
    close() {
      closing ??= (async () => {
        const closed = servers.map((server) => closeServer(server))
        for (const client of overlaySockets.clients) client.terminate()
        overlaySockets.close()
        for (const socket of tunnelSockets) socket.destroy()
        for (const server of servers) server.closeAllConnections()
        upstream.destroy()
        await Promise.all(closed)
      })()
      return closing
    },
  }
}
