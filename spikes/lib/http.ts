import { request, type IncomingHttpHeaders } from 'node:http'

/**
 * A raw HTTP/1.1 client that records WHEN bytes arrive. Used to check that a
 * streamed document is still streamed after it passed through the proxy, and
 * to look at redirects and headers without a browser following or hiding them.
 *
 * Every request uses a new connection, never follows redirects and never
 * decompresses. All times are milliseconds since the request was started.
 */

export interface RawChunk {
  /** Arrival time. */
  ms: number
  bytes: number
}

export interface RawResponse {
  status: number
  headers: IncomingHttpHeaders
  /** `[name, value, name, value, ...]` as received. */
  rawHeaders: string[]
  body: Buffer
  text: string
  chunks: RawChunk[]
  /** Response headers received. */
  headersMs: number
  /** First body byte received (equals `endMs` for an empty body). */
  firstByteMs: number
  /** Response complete. */
  endMs: number
  /** Arrival time of the chunk that completed the first occurrence of `needle` in the body, or undefined. */
  arrivalOf(needle: string): number | undefined
}

export interface RawRequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: string | Buffer
  /** Default 30 s. */
  timeoutMs?: number
}

/** The headers Chromium sends for a top-level navigation, so servers and the proxy treat the request as one. */
export const NAVIGATION_HEADERS: Readonly<Record<string, string>> = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1',
}

export function rawRequest(url: string, options: RawRequestOptions = {}): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const started = performance.now()
    const elapsed = (): number => Math.round((performance.now() - started) * 100) / 100
    const body = options.body === undefined ? undefined : Buffer.from(options.body)
    const headers: Record<string, string> = { ...options.headers }
    if (body !== undefined && !Object.keys(headers).some((name) => name.toLowerCase() === 'content-length')) {
      headers['Content-Length'] = String(body.length)
    }
    const req = request(url, { method: options.method ?? 'GET', headers, agent: false }, (res) => {
      const headersMs = elapsed()
      const parts: Buffer[] = []
      const chunks: RawChunk[] = []
      res.on('data', (chunk: Buffer) => {
        parts.push(chunk)
        chunks.push({ ms: elapsed(), bytes: chunk.length })
      })
      res.on('error', reject)
      res.on('end', () => {
        const endMs = elapsed()
        const whole = Buffer.concat(parts)
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          rawHeaders: res.rawHeaders,
          body: whole,
          text: whole.toString('utf8'),
          chunks,
          headersMs,
          firstByteMs: chunks[0]?.ms ?? endMs,
          endMs,
          arrivalOf(needle) {
            const bytes = Buffer.from(needle)
            const at = whole.indexOf(bytes)
            if (at === -1) return undefined
            let received = 0
            for (let i = 0; i < chunks.length; i++) {
              received += parts[i]?.length ?? 0
              if (received >= at + bytes.length) return chunks[i]?.ms
            }
            return undefined
          },
        })
      })
    })
    req.setTimeout(options.timeoutMs ?? 30_000, () => req.destroy(new Error(`request to ${url} timed out`)))
    req.on('error', reject)
    req.end(body)
  })
}

/** A document navigation as Chromium would send it. */
export function rawNavigate(url: string, options: RawRequestOptions = {}): Promise<RawResponse> {
  return rawRequest(url, { ...options, headers: { ...NAVIGATION_HEADERS, ...options.headers } })
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 0) return NaN
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? (sorted[mid] ?? NaN) : ((sorted[mid - 1] ?? NaN) + (sorted[mid] ?? NaN)) / 2
}

export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? NaN
}
