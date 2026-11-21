import { parse, type DefaultTreeAdapterMap } from 'parse5'
import type { SourceLoc } from '../../protocol/src/change.ts'
import { RESERVED_PREFIX } from '../../protocol/src/messages.ts'
import type { NodeDescriptor, ShiftIssue, ShiftRecording } from '../../protocol/src/shift.ts'
import { ProjectFiles } from '../../source/src/node/files.ts'
import { locateSource } from '../../source/src/node/paths.ts'
import type { Resolver } from '../../source/src/node/resolve.ts'
import { SourceMapStore, type FetchedText } from '../../source/src/node/sourcemap.ts'
import { parseStack, scriptRefOf } from '../../source/src/node/stack.ts'
import { htmlFileForPage } from '../../source/src/node/static-html.ts'
import type { ElementContext, Evidence, PathStep } from '../../source/src/types.ts'
import { toSourceLoc } from './source-loc.ts'

/**
 * From the culprit of a layout-shift issue to a place in the source, using only
 * what the hook recorded (the element may be gone by the time anyone asks).
 *
 * Three routes, the first that answers wins (the first two are the ones spike
 * S7 section E measured):
 *
 *   stack   the hook captured the JavaScript stack of the DOM call that inserted
 *           or changed the culprit: the first frame that maps to a project file
 *           (through the script's source map, or as written when it has none).
 *           The position is the DOM call, not a tag: level `file`.
 *   html    the page is an HTML file of the project and the culprit's child-index
 *           path leads to an element of the same tag in it. `exact` only when id,
 *           classes, src/href and text agree as well; scripts that insert nodes
 *           shift the indexes, and a neighbour must not be reported as exact.
 *   search  the resolver's ranked search with the little the recording knows
 *           (tag, id, up to four classes, the start of the text). Never better
 *           than a guess for a framework app: there the dock can do better by
 *           sending `session:resolve` with real evidence while the element exists.
 */

export interface CulpritResolverOptions {
  projectRoot: string
  /** Origin of the dev server, for example `http://localhost:5173`. */
  target: string
  /** Used for the search route. Without it only the stack and html routes run. */
  resolver?: Pick<Resolver, 'resolve'>
  /** Replaces global `fetch` (tests). */
  fetch?: typeof fetch
  /** Timeout of one dev-server request. Default 3000 ms. */
  timeoutMs?: number
}

export interface CulpritResolver {
  /** Never rejects; `undefined` when the recording does not say enough. */
  (issue: ShiftIssue, recording: ShiftRecording): Promise<SourceLoc | undefined>
  /** Drops cached answers and source maps; call when source files changed. */
  invalidate(): void
}

type Element = DefaultTreeAdapterMap['element']
type ParentNode = DefaultTreeAdapterMap['parentNode']
type Node = DefaultTreeAdapterMap['node']

const isElement = (node: Node): node is Element => 'tagName' in node
const childElements = (node: ParentNode): Element[] => node.childNodes.filter(isElement)
const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim()
const LOOPBACK = /^(?:localhost|127\.0\.0\.1|\[::1\])$/
const MAX_CACHED = 500

function attr(element: Element, name: string): string | undefined {
  return element.attrs.find((entry) => entry.name === name)?.value
}

/** First run of text at or below `element`, as the hook's descriptor takes it. */
function firstText(element: Element): string {
  const pending: Node[] = [...element.childNodes]
  for (let budget = 60; pending.length > 0 && budget > 0; budget -= 1) {
    const node = pending.shift() as Node
    if (node.nodeName === '#text') {
      const value = collapse((node as DefaultTreeAdapterMap['textNode']).value)
      if (value !== '') return value
    } else if (isElement(node) && node.tagName !== 'script' && node.tagName !== 'style') {
      pending.unshift(...node.childNodes)
    }
  }
  return ''
}

export interface IndexPathMatch {
  /** 1-based position of the `<` of the start tag. */
  line: number
  col: number
  /** The node at the end of the path, root (`<html>`) first, as structural steps. */
  steps: PathStep[]
  /** Everything the descriptor knows agrees with the node in the file. */
  agrees: boolean
  notes: string[]
}

/**
 * Follows the hook's index path (index among the parent's element children, starting below
 * `<html>`) through the parsed file. `undefined` when the path leaves the file's tree, ends on
 * another tag, or ends on a node the parser made up.
 */
export function locateByIndexPath(html: string, node: NodeDescriptor): IndexPathMatch | undefined {
  if (node.path.length === 0 || node.tag === '#text') return undefined
  const document = parse(html, { sourceCodeLocationInfo: true })
  const root = childElements(document).find((child) => child.tagName === 'html')
  if (root === undefined) return undefined
  const steps: PathStep[] = [{ tag: 'html', index: 0, ofType: 0, ofTypeCount: 1 }]
  let current = root
  for (const index of node.path) {
    const children = childElements(current)
    const next = children[index]
    if (next === undefined) return undefined
    const sameTag = children.filter((child) => child.tagName === next.tagName)
    const step: PathStep = { tag: next.tagName, index, ofType: sameTag.indexOf(next), ofTypeCount: sameTag.length }
    const id = attr(next, 'id')
    if (id !== undefined && id !== '') step.id = id
    steps.push(step)
    current = next
  }
  const location = current.sourceCodeLocation
  if (current.tagName !== node.tag || location === undefined || location === null) return undefined

  const notes: string[] = []
  if ((attr(current, 'id') ?? '') !== (node.id ?? '')) notes.push('the id in the file differs from the element')
  const written = (attr(current, 'class') ?? '').split(/\s+/).filter(Boolean)
  const live = node.classes ?? []
  // The descriptor keeps four class names at most; with four, the rest of the list is unknown.
  const classesAgree = live.length >= 4 ? written.length === 0 || written.some((token) => live.includes(token)) : written.every((token) => live.includes(token))
  if (!classesAgree) notes.push('the classes in the file differ from the element')
  for (const name of ['src', 'href']) {
    const inFile = attr(current, name)
    const inPage = node.attrs?.[name]
    if (inFile !== undefined && inPage !== undefined && inFile.slice(0, 200) !== inPage) notes.push(`the ${name} in the file differs from the element`)
  }
  const text = firstText(current)
  if (node.text !== undefined && text !== '' && !text.startsWith(node.text) && !node.text.startsWith(text.slice(0, 48))) {
    notes.push('the text in the file differs from the element')
  }
  return { line: location.startLine, col: location.startCol, steps, agrees: notes.length === 0, notes }
}

export function createCulpritResolver(options: CulpritResolverOptions): CulpritResolver {
  const files = new ProjectFiles(options.projectRoot)
  const target = new URL(options.target)
  const doFetch = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? 3000
  const cache = new Map<string, Promise<SourceLoc | undefined>>()

  /** The page runs behind the proxy, so its scripts carry the proxy's origin; only loopback and the dev server are fetched. */
  const fetchText = async (url: string): Promise<FetchedText> => {
    const parsed = new URL(url)
    const allowed = (parsed.protocol === 'http:' || parsed.protocol === 'https:') && (parsed.host === target.host || LOOPBACK.test(parsed.hostname))
    if (!allowed) throw new Error(`refusing to fetch ${url}: not the dev server`)
    const response = await doFetch(target.origin + parsed.pathname + parsed.search, {
      headers: { accept: '*/*', 'sec-fetch-dest': 'script' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await response.text()
    const header = response.headers.get('sourcemap') ?? response.headers.get('x-sourcemap') ?? undefined
    return header === undefined ? { status: response.status, text } : { status: response.status, text, sourceMapHeader: header }
  }
  const maps = new SourceMapStore({ fetchText, allowFile: (path) => files.relative(path) !== undefined })

  /** The project file a URL path of the dev server is served from, when it is served as written. */
  const fileForPath = (pathname: string): string | undefined => {
    let path = pathname
    try {
      path = decodeURIComponent(pathname)
    } catch {
      // Keep the encoded form.
    }
    // An inline script reports the document's URL.
    if (path.endsWith('/') || !/\.[a-z0-9]+$/i.test(path)) return htmlFileForPage(files, path)
    const clean = path.replace(/^\/+/, '')
    for (const base of ['', 'public/', 'static/', 'src/']) {
      if (files.isFile(base + clean)) return base + clean
    }
    const located = locateSource(path, files)
    return located.dependency ? undefined : located.file
  }

  const lineExists = (file: string, line: number): boolean => {
    const text = files.read(file)
    return text !== undefined && line >= 1 && line <= text.split('\n').length
  }

  async function viaStack(stack: string): Promise<SourceLoc | undefined> {
    for (const frame of parseStack(stack)) {
      if (frame.url === '' || frame.line <= 0) continue
      let url: URL
      try {
        url = new URL(scriptRefOf(frame.url).url)
      } catch {
        continue
      }
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.pathname.startsWith(RESERVED_PREFIX)) continue
      let file: string | undefined
      let line = frame.line
      let col = frame.col
      const notes = ['position of the DOM call that inserted or changed the element, not of a tag']
      const trace = await maps.trace(url.href, frame.line, frame.col).catch((error: unknown) => ({ status: 'error' as const, reason: String(error) }))
      if (trace.status === 'mapped') {
        if (trace.position.ignored) continue
        const located = locateSource(trace.position.source, files)
        if (located.dependency || located.file === undefined) continue
        file = located.file
        line = trace.position.line
        col = trace.position.col
      } else if (trace.status === 'no-map') {
        file = fileForPath(url.pathname)
      } else {
        continue
      }
      if (file === undefined) continue
      const verified = lineExists(file, line)
      if (!verified) notes.push('the file on disk has no such line; it may have changed since the page loaded')
      const loc: SourceLoc = { file, framework: 'unknown', level: 'file', verifiedOnDisk: verified, via: 'shift-stack', target: 'element', notes }
      if (line > 0) loc.line = line
      if (col > 0) loc.col = col
      return loc
    }
    return undefined
  }

  function contextOf(node: NodeDescriptor, recording: ShiftRecording, steps: PathStep[]): ElementContext {
    let pagePath = '/'
    let pageOrigin = target.origin
    try {
      const url = new URL(recording.url)
      pagePath = url.pathname
      pageOrigin = url.origin
    } catch {
      // Keep the defaults.
    }
    const context: ElementContext = {
      tag: node.tag,
      classes: [...(node.classes ?? [])],
      attrs: { ...node.attrs },
      ownText: node.text ?? '',
      text: node.text ?? '',
      path: steps,
      pagePath,
      pageOrigin,
      pageLoadedAt: 0,
    }
    if (node.id !== undefined) context.id = node.id
    return context
  }

  async function resolveOne(issue: ShiftIssue, recording: ShiftRecording): Promise<SourceLoc | undefined> {
    const culprit = issue.culprit
    if (culprit === undefined) return undefined
    const stack = issue.trigger?.kind === 'mutation' ? issue.trigger.stack : undefined
    if (stack !== undefined && stack !== '') {
      const loc = await viaStack(stack)
      if (loc !== undefined) return loc
    }

    const node = culprit.node
    const context = contextOf(node, recording, [])
    const file = htmlFileForPage(files, context.pagePath)
    const html = file === undefined ? undefined : files.read(file)
    if (file !== undefined && html !== undefined) {
      const match = locateByIndexPath(html, node)
      if (match !== undefined) {
        return {
          file,
          line: match.line,
          col: match.col,
          framework: 'html',
          level: match.agrees ? 'exact' : 'file',
          verifiedOnDisk: true,
          via: 'html-path',
          target: 'element',
          notes: match.agrees ? [] : [...match.notes, 'found by position in the document; the line is a best guess'],
        }
      }
    }

    if (options.resolver === undefined || node.tag === '#text') return undefined
    const evidence: Evidence = { context, hints: [], collectMs: 0 }
    const loc = toSourceLoc(await options.resolver.resolve(evidence))
    if (loc === null || loc.file === undefined) return undefined
    // A search over tag, classes and the start of the text is a guess, whatever the scorer made of it.
    return { ...loc, level: loc.level === 'exact' ? 'file' : loc.level, notes: [...loc.notes, 'guessed from the shift recording alone (tag, classes, start of the text); no framework evidence'] }
  }

  const resolveCulprit = ((issue, recording) => {
    const node = issue.culprit?.node
    if (node === undefined) return Promise.resolve(undefined)
    const key = [recording.url, node.uid, node.tag, node.path.join('.'), issue.trigger?.stack ?? ''].join('|')
    let answer = cache.get(key)
    if (answer === undefined) {
      answer = resolveOne(issue, recording).catch(() => undefined)
      if (cache.size >= MAX_CACHED) cache.clear()
      cache.set(key, answer)
    }
    return answer
  }) as CulpritResolver
  resolveCulprit.invalidate = () => {
    cache.clear()
    maps.invalidate()
    files.invalidate()
  }
  return resolveCulprit
}
