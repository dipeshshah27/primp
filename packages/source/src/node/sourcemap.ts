import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { AnyMap, isIgnored, originalPositionFor, type TraceMap } from '@jridgewell/trace-mapping'

/**
 * Source-map symbolication: generated `url:line:col` to original `source:line:col`.
 *
 * Scripts come from two places: the dev server (`http://`, fetched through the `fetchText`
 * the resolver provides, which pins requests to the dev server's origin) and the project
 * directory (`file://`, the server chunks Next writes under `.next/`).
 *
 * The map is found the way a browser finds it: the last `sourceMappingURL` comment of the
 * script, else the `SourceMap` response header. Inline `data:` maps, external maps and
 * sectioned (index) maps are all handled; trace-mapping's `AnyMap` flattens sections.
 */

export interface FetchedText {
  status: number
  text: string
  /** Value of the `SourceMap` (or legacy `X-SourceMap`) response header. */
  sourceMapHeader?: string
}

export interface SourceMapStoreOptions {
  /** Fetches a dev-server URL. Must refuse origins other than the dev server. */
  fetchText(url: string): Promise<FetchedText>
  /** Whether a `file://` script may be read (the resolver allows the project directory only). */
  allowFile(path: string): boolean
  /**
   * How long a fetched map is reused. Dev servers rebuild modules under the same URL, so this
   * is a burst cache (many elements resolved together), not a long-lived one. Default 2000 ms.
   */
  ttlMs?: number
}

export interface OriginalPosition {
  /** As resolved by the map against its own URL: usually an absolute URL or path. */
  source: string
  /** 1-based. */
  line: number
  /** 1-based. */
  col: number
  /** True when the map's ignore list names this source (dependencies, framework internals). */
  ignored: boolean
}

export type TraceOutcome =
  | { status: 'mapped'; position: OriginalPosition }
  /** The script has no source map: it is served as written, so the generated position is the original. */
  | { status: 'no-map' }
  /** There is a map, but nothing maps to this position. */
  | { status: 'unmapped' }
  | { status: 'error'; reason: string }

interface LoadedMap {
  at: number
  /** File scripts: modification time of script and map, for revalidation. */
  stamp?: string
  map: Promise<TraceMap | 'no-map'>
}

/** The last `sourceMappingURL` comment of a script: a `//#` or `//@` line comment, or a `#` block comment. */
export function findSourceMappingUrl(script: string): string | undefined {
  const key = 'sourceMappingURL='
  const at = script.lastIndexOf(key)
  if (at === -1) return undefined
  if (!/(?:\/\/|\/\*)[#@][ \t]*$/.test(script.slice(Math.max(0, at - 8), at))) return undefined
  // A data: URL can be megabytes long; it ends at the first whitespace, quote or comment end.
  const rest = script.slice(at + key.length)
  const end = rest.search(/[\s'"*]/)
  const url = end === -1 ? rest : rest.slice(0, end)
  return url === '' ? undefined : url
}

/** Decodes a `data:application/json[;charset=...][;base64],...` URL. */
export function decodeDataUrl(url: string): string | undefined {
  const comma = url.indexOf(',')
  if (!url.startsWith('data:') || comma === -1) return undefined
  const meta = url.slice(5, comma)
  const payload = url.slice(comma + 1)
  try {
    return /;base64$/i.test(meta) ? Buffer.from(payload, 'base64').toString('utf8') : decodeURIComponent(payload)
  } catch {
    return undefined
  }
}

function parseMap(json: string, mapUrl: string): TraceMap {
  // Some servers prefix JSON with an XSSI guard.
  const text = json.startsWith(")]}'") ? json.slice(json.indexOf('\n') + 1) : json
  return new AnyMap(JSON.parse(text) as never, mapUrl)
}

export class SourceMapStore {
  private readonly maps = new Map<string, LoadedMap>()
  private readonly ttlMs: number

  constructor(private readonly options: SourceMapStoreOptions) {
    this.ttlMs = options.ttlMs ?? 2000
  }

  /** Drop every cached map (call when the file watcher or the HMR socket reports a rebuild). */
  invalidate(): void {
    this.maps.clear()
  }

  /**
   * Maps a generated position (1-based line and column, as printed in a stack frame).
   * `fresh` bypasses the cache; the resolver uses it when a cached map gave a position that
   * failed verification on disk.
   */
  async trace(scriptUrl: string, line: number, col: number, fresh = false, mapUrl?: string): Promise<TraceOutcome> {
    let map: TraceMap | 'no-map'
    try {
      map = await this.load(scriptUrl, fresh, mapUrl)
    } catch (error) {
      this.maps.delete(scriptUrl)
      return { status: 'error', reason: error instanceof Error ? error.message : String(error) }
    }
    if (map === 'no-map') return { status: 'no-map' }
    const found = originalPositionFor(map, { line, column: Math.max(0, col - 1) })
    if (found.source === null || found.line === null) return { status: 'unmapped' }
    let ignored = false
    try {
      ignored = isIgnored(map, found.source)
    } catch {
      // Maps without an ignore list.
    }
    return { status: 'mapped', position: { source: found.source, line: found.line, col: (found.column ?? 0) + 1, ignored } }
  }

  /** `mapUrl`: fetch the map from there instead of reading the script for a `sourceMappingURL`. */
  private load(scriptUrl: string, fresh: boolean, mapUrl?: string): Promise<TraceMap | 'no-map'> {
    const isFile = scriptUrl.startsWith('file://')
    const stamp = isFile ? fileStamp(scriptUrl) : undefined
    const cached = this.maps.get(scriptUrl)
    if (cached && !fresh) {
      const valid = isFile ? cached.stamp === stamp : Date.now() - cached.at < this.ttlMs
      if (valid) return cached.map
    }
    const map = mapUrl !== undefined ? this.loadMapUrl(mapUrl) : isFile ? this.loadFile(scriptUrl) : this.loadHttp(scriptUrl)
    this.maps.set(scriptUrl, { at: Date.now(), stamp, map })
    return map
  }

  private async loadMapUrl(mapUrl: string): Promise<TraceMap | 'no-map'> {
    const map = await this.options.fetchText(mapUrl)
    // Next's source-map endpoint answers 204 when it has no map for the file.
    if (map.status === 204 || (map.status === 200 && map.text === '')) return 'no-map'
    if (map.status !== 200) throw new Error(`GET ${mapUrl} answered ${map.status}`)
    return parseMap(map.text, mapUrl)
  }

  private async loadHttp(scriptUrl: string): Promise<TraceMap | 'no-map'> {
    const script = await this.options.fetchText(scriptUrl)
    if (script.status !== 200) throw new Error(`GET ${scriptUrl} answered ${script.status}`)
    const reference = findSourceMappingUrl(script.text) ?? script.sourceMapHeader
    if (reference === undefined) return 'no-map'
    if (reference.startsWith('data:')) {
      const json = decodeDataUrl(reference)
      if (json === undefined) throw new Error(`undecodable inline source map in ${scriptUrl}`)
      return parseMap(json, scriptUrl)
    }
    const mapUrl = new URL(reference, scriptUrl).href
    const map = await this.options.fetchText(mapUrl)
    if (map.status !== 200) throw new Error(`GET ${mapUrl} answered ${map.status}`)
    return parseMap(map.text, mapUrl)
  }

  private async loadFile(scriptUrl: string): Promise<TraceMap | 'no-map'> {
    const scriptPath = fileURLToPath(scriptUrl)
    if (!this.options.allowFile(scriptPath)) throw new Error(`${scriptPath} is outside the project`)
    const script = readFileSync(scriptPath, 'utf8')
    const reference = findSourceMappingUrl(script)
    if (reference === undefined) return 'no-map'
    if (reference.startsWith('data:')) {
      const json = decodeDataUrl(reference)
      if (json === undefined) throw new Error(`undecodable inline source map in ${scriptPath}`)
      return parseMap(json, scriptUrl)
    }
    const mapUrl = new URL(reference, scriptUrl).href
    if (!mapUrl.startsWith('file://')) throw new Error(`source map of ${scriptPath} is not a local file`)
    const mapPath = fileURLToPath(mapUrl)
    if (!this.options.allowFile(mapPath)) throw new Error(`${mapPath} is outside the project`)
    return parseMap(readFileSync(mapPath, 'utf8'), mapUrl)
  }
}

function fileStamp(scriptUrl: string): string | undefined {
  try {
    const path = fileURLToPath(scriptUrl)
    const script = statSync(path)
    let stamp = `${script.mtimeMs}:${script.size}`
    try {
      const map = statSync(`${path}.map`)
      stamp += `:${map.mtimeMs}:${map.size}`
    } catch {
      // Inline map or none.
    }
    return stamp
  } catch {
    return undefined
  }
}
