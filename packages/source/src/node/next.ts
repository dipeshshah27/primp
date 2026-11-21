import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Client for Next's dev endpoint `POST /__nextjs_original-stack-frames` (the one its error
 * overlay uses). Shapes read from next@16.4.6 `dist/server/dev/middleware-turbopack.js`:
 *
 *   request   { frames: [{ file, methodName, line1, column1, arguments }], isServer,
 *               isEdgeServer, isAppDirectory }
 *   response  [{ status: 'fulfilled', value: { originalStackFrame: { file, line1, column1,
 *               ignored, methodName, arguments }, originalCodeFrame } }
 *              | { status: 'rejected', reason }]          one entry per frame, same order
 *
 * `file` in the answer is relative to the project for sources inside it. What the endpoint
 * accepts as `file` (measured, see spike S2):
 *   - `about://React/Server/file:///...js?12`   as printed in a replayed Server Component frame
 *   - `file:///<project>/.next/dev/server/chunks/ssr/x.js`
 *   - `file:///<distDir>/static/chunks/x.js`    for a browser chunk; Next's own overlay rewrites
 *                                               `http://host/_next/static/...` to this form
 * After a hot update Turbopack evaluates the changed module on its own and names it
 * `<chunk url>?id=<module id>`; positions are then relative to that module, and the endpoint
 * maps them correctly only when the query string is passed along (as Next's overlay does).
 * The matching source map is served by `GET /__nextjs_source-map?filename=<that file URL>`.
 * An `http://` URL is rejected ("Unknown url scheme"), and a bare `/_next/static/...` path is
 * echoed back unmapped with status `fulfilled`, so an unchanged answer counts as a failure here.
 */

export interface NextFrameRequest {
  file: string
  methodName: string
  line1: number
  column1: number
}

export interface NextOriginalFrame {
  /** Project-relative for project files; other spellings for everything else. */
  file: string
  line: number
  col: number
  ignored: boolean
}

export type NextFrameOutcome =
  | { status: 'mapped'; frame: NextOriginalFrame }
  | { status: 'unmapped'; reason: string }
  /** The endpoint does not exist or did not answer JSON: not a Next dev server (or a future shape). */
  | { status: 'unavailable'; reason: string }

interface EndpointEntry {
  status?: unknown
  reason?: unknown
  value?: { originalStackFrame?: { file?: unknown; line1?: unknown; column1?: unknown; ignored?: unknown } | null }
}

/**
 * The `file` to send for a browser chunk: `http://host/_next/static/chunks/x.js` becomes
 * `file://<distDir>/static/chunks/x.js`. distDir is `.next/dev` under Turbopack dev in Next 16
 * and `.next` before; whichever holds the chunk on disk is used.
 */
export function nextClientChunkFile(scriptUrl: string, projectRoot: string): string | undefined {
  let url: URL
  let pathname: string
  try {
    url = new URL(scriptUrl)
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return undefined
  }
  const match = /\/_next(\/static\/.+)$/.exec(pathname)
  if (!match?.[1]) return undefined
  for (const dist of ['.next/dev', '.next']) {
    const path = join(projectRoot, dist, match[1])
    // The query must survive: after a hot update Turbopack names one module of the chunk with
    // `?id=<module id>`, and line and column are then relative to that module.
    if (existsSync(path)) return pathToFileURL(path).href + url.search
  }
  return undefined
}

export async function nextOriginalFrame(
  post: (path: string, body: string) => Promise<{ status: number; text: string }>,
  frame: NextFrameRequest,
  isServer: boolean,
): Promise<NextFrameOutcome> {
  let response: { status: number; text: string }
  try {
    response = await post(
      '/__nextjs_original-stack-frames',
      JSON.stringify({ frames: [{ ...frame, arguments: [] }], isServer, isEdgeServer: false, isAppDirectory: true }),
    )
  } catch (error) {
    return { status: 'unavailable', reason: error instanceof Error ? error.message : String(error) }
  }
  if (response.status !== 200) return { status: 'unavailable', reason: `HTTP ${response.status}` }
  let entries: unknown
  try {
    entries = JSON.parse(response.text)
  } catch {
    return { status: 'unavailable', reason: 'answer is not JSON' }
  }
  const entry = Array.isArray(entries) ? (entries[0] as EndpointEntry | undefined) : undefined
  if (!entry || typeof entry !== 'object') return { status: 'unavailable', reason: 'answer is not an array of results' }
  if (entry.status !== 'fulfilled') return { status: 'unmapped', reason: typeof entry.reason === 'string' ? entry.reason : 'rejected' }
  const original = entry.value?.originalStackFrame
  if (!original || typeof original.file !== 'string' || typeof original.line1 !== 'number') {
    return { status: 'unmapped', reason: 'no original frame in the answer' }
  }
  const col = typeof original.column1 === 'number' ? original.column1 : 1
  if (original.file === frame.file || (original.line1 === frame.line1 && col === frame.column1 && /\/_next\/|\/\.next\//.test(original.file))) {
    return { status: 'unmapped', reason: 'the endpoint returned the generated position unchanged' }
  }
  return { status: 'mapped', frame: { file: original.file, line: original.line1, col, ignored: original.ignored === true } }
}

/** True for a browser chunk URL that names a single hot-updated module of the chunk. */
export function isTurbopackModuleUrl(scriptUrl: string): boolean {
  try {
    const url = new URL(scriptUrl)
    return /\/_next\/static\//.test(url.pathname) && url.searchParams.has('id')
  } catch {
    return false
  }
}

/** Path and query of Next's source-map endpoint for `file` (a `file://` URL as built by `nextClientChunkFile`). */
export function nextSourceMapPath(file: string): string {
  return `/__nextjs_source-map?filename=${encodeURIComponent(file)}`
}
