import type { IncomingMessage } from 'node:http'
import { isIP } from 'node:net'

/**
 * Header policy of the proxy.
 *
 * REQUESTS (browser -> dev server)
 *
 * The dev server must see a request that is same-origin with the address the
 * browser used, because frameworks compare the two:
 *
 *   - Next.js Server Actions compare the host of `Origin` with
 *     `X-Forwarded-Host`, falling back to `Host`.
 *   - SvelteKit form actions compare `Origin` with the origin of the request
 *     URL, which the dev server builds from `Host`.
 *   - Vite and Next check `Host` against their allowed-hosts list, which
 *     accepts `localhost` on any port.
 *
 * So the proxy keeps `Host` exactly as the browser sent it (`localhost:<proxy
 * port>`), leaves `Origin`, `Referer` and `Cookie` untouched, and sets
 * `X-Forwarded-Host`, `X-Forwarded-Port`, `X-Forwarded-Proto` and
 * `X-Forwarded-For` to describe the browser's connection to the proxy. Values
 * a client sent for those four are replaced, never trusted. Absolute URLs the
 * framework generates from `Host` therefore already point at the proxy.
 *
 * Known gap: the proxy speaks plain HTTP. In front of an HTTPS dev server a
 * framework that derives the scheme from its own listener (SvelteKit) computes
 * `https://localhost:<proxy port>` and will not match an `http://` Origin.
 *
 * Only hop-by-hop headers are removed. Document navigations additionally ask
 * for an identity-encoded, unconditional, whole response so the page can be
 * injected while it streams (see `NAVIGATION_STRIP`).
 *
 * RESPONSES (dev server -> browser)
 *
 * Hop-by-hop headers are removed, `Location` values that name the dev server
 * are pointed back at the proxy, and a `Set-Cookie` `Domain` attribute naming
 * the dev server is dropped. Everything else is passed through as received,
 * including header order, casing and repeated headers.
 */

export interface ProxyTarget {
  protocol: 'http' | 'https'
  host: string
  port: number
}

/** Flat `[name, value, name, value, ...]` list, the format of `message.rawHeaders`. */
export type RawHeaders = string[]

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** The proxy states these itself. */
const FORWARDED = new Set(['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-port', 'x-forwarded-proto'])

/**
 * Not forwarded on document navigations: a compressed, partial or `304`
 * response cannot be injected, and a `304` would let the browser reuse a copy
 * of the page that was cached without the injected scripts.
 */
const NAVIGATION_STRIP = new Set(['accept-encoding', 'if-none-match', 'if-modified-since', 'if-range', 'range'])

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

export interface HostPort {
  /** Lower-cased; IPv6 literals keep their brackets. */
  hostname: string
  port: number | undefined
}

export function parseHostHeader(value: string | undefined): HostPort | undefined {
  if (value === undefined) return undefined
  const match = /^(\[[0-9a-f:.]+\]|[^:\s/@\[\]]+)(?::(\d{1,5}))?$/i.exec(value.trim())
  if (!match || match[1] === undefined) return undefined
  return { hostname: match[1].toLowerCase(), port: match[2] === undefined ? undefined : Number(match[2]) }
}

/**
 * DNS-rebinding guard. A hostile page can make its own domain resolve to
 * 127.0.0.1, but the browser then sends that domain in `Host`. Only the three
 * loopback names, with the proxy's own port, are served.
 */
export function isAllowedHost(value: string | undefined, proxyPort: number): boolean {
  const host = parseHostHeader(value)
  if (host === undefined || !LOOPBACK_NAMES.has(host.hostname)) return false
  return (host.port ?? 80) === proxyPort
}

/** Whether a configured target host is this machine. */
export function isLoopbackHost(host: string): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (name === 'localhost' || name.endsWith('.localhost') || name === '::1') return true
  return isIP(name) === 4 && name.startsWith('127.')
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/**
 * Whether the response to this request will be shown as a page.
 *
 * Browsers say so with `Sec-Fetch-Dest: document`. Frames, `fetch()` and XHR
 * are left alone: an HTML partial fetched by the app is the app's data, and a
 * frame is usually third-party content. Clients that send no `Sec-Fetch-Dest`
 * (curl, old browsers) are judged by `Accept`.
 */
export function isNavigation(req: IncomingMessage): boolean {
  const dest = single(req.headers['sec-fetch-dest'])
  if (dest !== undefined) return dest.trim().toLowerCase() === 'document'
  const accept = single(req.headers.accept)
  return accept === undefined || /text\/html|\*\/\*/i.test(accept)
}

export function requestHasBody(req: IncomingMessage): boolean {
  if (req.headers['transfer-encoding'] !== undefined) return true
  const length = Number(single(req.headers['content-length']) ?? 0)
  return Number.isFinite(length) && length > 0
}

/** Header names that a `Connection` header declares hop-by-hop. */
export function connectionTokens(raw: readonly string[]): Set<string> {
  const names = new Set<string>()
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (raw[i]?.toLowerCase() !== 'connection') continue
    for (const token of (raw[i + 1] ?? '').split(',')) names.add(token.trim().toLowerCase())
  }
  return names
}

export interface UpstreamHeaderOptions {
  navigation: boolean
  /** Keep the upgrade handshake headers (for the WebSocket tunnel). */
  upgrade: boolean
  proxyPort: number
}

export function buildUpstreamHeaders(req: IncomingMessage, options: UpstreamHeaderOptions): RawHeaders {
  const raw = req.rawHeaders
  const nominated = connectionTokens(raw)
  const out: RawHeaders = []
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i] ?? ''
    const lower = name.toLowerCase()
    if (HOP_BY_HOP.has(lower) || nominated.has(lower) || FORWARDED.has(lower)) continue
    // Node already answered `100 Continue` on the browser's connection.
    if (lower === 'expect') continue
    if (options.navigation && NAVIGATION_STRIP.has(lower)) continue
    // Without an extension offer the server cannot compress frames, so the
    // tunnel can read them.
    if (options.upgrade && lower === 'sec-websocket-extensions') continue
    out.push(name, raw[i + 1] ?? '')
  }
  if (options.navigation) out.push('Accept-Encoding', 'identity')
  if (options.upgrade) out.push('Connection', 'Upgrade', 'Upgrade', single(req.headers.upgrade) ?? 'websocket')

  const host = single(req.headers.host)
  if (host !== undefined) out.push('X-Forwarded-Host', host)
  out.push('X-Forwarded-Port', String(options.proxyPort))
  out.push('X-Forwarded-Proto', 'http')
  out.push('X-Forwarded-For', (req.socket.remoteAddress ?? '127.0.0.1').replace(/^::ffff:/, ''))
  return out
}

export function isHopByHop(lowerName: string): boolean {
  return HOP_BY_HOP.has(lowerName)
}

/** `host:port` spellings under which a response may name the dev server. */
function targetAuthorities(target: ProxyTarget): Set<string> {
  const bare = target.host.toLowerCase().replace(/^\[|\]$/g, '')
  const hosts = new Set([isIP(bare) === 6 ? `[${bare}]` : bare])
  if (isLoopbackHost(target.host)) for (const name of LOOPBACK_NAMES) hosts.add(name)
  const authorities = new Set<string>()
  const defaultPort = target.protocol === 'https' ? 443 : 80
  for (const host of hosts) {
    authorities.add(`${host}:${target.port}`)
    if (target.port === defaultPort) authorities.add(host)
  }
  return authorities
}

/**
 * Points an absolute redirect at the proxy when it names the dev server, or
 * names the proxy with the dev server's scheme (an HTTPS dev server building
 * a URL from the forwarded `Host`). Relative and foreign URLs are returned
 * unchanged.
 */
export function rewriteLocation(value: string, target: ProxyTarget, publicHost: string): string {
  const match = /^(?:(https?):)?\/\/([^/?#]*)(.*)$/is.exec(value)
  if (!match) return value
  const scheme = match[1]?.toLowerCase()
  const authority = (match[2] ?? '').toLowerCase()
  const rest = match[3] ?? ''
  const namesTarget = (scheme === undefined || scheme === target.protocol) && targetAuthorities(target).has(authority)
  const namesProxyOverTls = scheme === 'https' && target.protocol === 'https' && authority === publicHost.toLowerCase()
  if (!namesTarget && !namesProxyOverTls) return value
  return `http://${publicHost}${rest}`
}

/**
 * Drops a `Domain` attribute that names the dev server, which would make the
 * browser refuse the cookie on the proxy's origin. Cookie domains carry no
 * port, so both `host` and `host:port` spellings are matched.
 */
export function rewriteSetCookie(value: string, target: ProxyTarget): string {
  const host = target.host.toLowerCase().replace(/^\[|\]$/g, '')
  const names = new Set([host, `${host}:${target.port}`])
  const parts = value.split(';')
  const kept = parts.filter((part, index) => {
    if (index === 0) return true
    const match = /^\s*domain\s*=\s*\.?(.*?)\s*$/i.exec(part)
    return !(match && names.has((match[1] ?? '').toLowerCase().replace(/^\[|\]$/g, '')))
  })
  return kept.length === parts.length ? value : kept.join(';')
}
