import type {
  ElementContext,
  Evidence,
  Framework,
  JsxSite,
  ReactEvidence,
  ReactOwner,
  SourceCandidate,
  SourceHint,
  SourceLevel,
  SourceResult,
  SourceVia,
} from '../types.ts'
import { ProjectFiles } from './files.ts'
import { filesDefining, grepCandidates } from './grep.ts'
import { isTurbopackModuleUrl, nextClientChunkFile, nextOriginalFrame, nextSourceMapPath } from './next.ts'
import { locateSource } from './paths.ts'
import { scoreTag } from './score.ts'
import { callSiteFrames, pickProjectFrame } from './select.ts'
import { SourceMapStore, type FetchedText } from './sourcemap.ts'
import { scriptRefOf, type StackFrame } from './stack.ts'
import { htmlFileForPage, locateByPath, searchHtml } from './static-html.ts'
import { findOpeningTag, isJsxFile, openingTagText, textAfterTag } from './verify.ts'

/**
 * Evidence in, `file:line:col` out.
 *
 * Order of strategies, strongest first; the first that yields a verified position wins:
 *   1. a location written into the DOM by the framework or a plugin (hints)
 *   2. Svelte's `__svelte_meta.loc`
 *   3. React: the element's own `_debugStack`, symbolicated
 *   4. React, owner-stack limit reached: JSX calls in the owner function's text
 *   5. React Server Component owner: the component function's location (file only)
 *   6. React: an owner's `_debugStack` (where project code used a dependency's component)
 *   7. static HTML: the element's structural path in the file the page was served from
 *   8. search: every matching tag in the project, ranked
 *
 * Every position is checked against the file on disk before it is called exact.
 */

export type NextStrategy =
  /** Next's `/__nextjs_original-stack-frames` first, source maps if it cannot answer. Default. */
  | 'endpoint-first'
  /** Only Next's endpoint. */
  | 'endpoint-only'
  /** Only source maps: browser chunks from the dev server, server chunks from `.next/` on disk. */
  | 'source-maps-only'

export interface ResolverOptions {
  /** Directory of the project whose dev server is running. */
  projectRoot: string
  /** Origin of the dev server, for example `http://localhost:5173`. */
  target: string
  /** How Next frames are symbolicated. */
  next?: NextStrategy
  /** Replaces global `fetch` (tests). */
  fetch?: typeof fetch
  /** Timeout of one dev-server request. Default 5000 ms. */
  timeoutMs?: number
  /** Reuse window for fetched source maps. Default 2000 ms. */
  sourceMapTtlMs?: number
}

export interface Resolver {
  resolve(evidence: Evidence): Promise<SourceResult>
  /** Drop cached source maps and file listings; call when the file watcher or HMR reports a change. */
  invalidate(): void
  readonly files: ProjectFiles
}

/** A frame mapped back to original source. */
interface Symbolicated {
  frame: StackFrame
  /** Project-relative file. */
  file?: string
  line?: number
  col?: number
  ignored: boolean
  /** `endpoint` or `source-map`, for notes. */
  by?: 'endpoint' | 'source-map' | 'identity'
  problem?: string
}

interface Located {
  file: string
  line: number
  col: number
  level: SourceLevel
  verified: boolean
  notes: string[]
  /** URL of the stack frame the position came from. */
  frameUrl?: string
}

interface SiteChoice {
  located: Located
  candidates?: SourceCandidate[]
  /** True when the position was taken from the owner function's JSX calls rather than a stack. */
  fromSites?: boolean
}

const LOOPBACK = /^(?:localhost|127\.0\.0\.1|\[::1\])$/

export function createResolver(options: ResolverOptions): Resolver {
  const files = new ProjectFiles(options.projectRoot)
  const target = new URL(options.target)
  const doFetch = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? 5000
  const strategy = options.next ?? 'endpoint-first'
  let nextEndpointMissing = false

  /**
   * Dev-server URL for a script the page loaded. The page runs behind the proxy, so its
   * scripts carry the proxy's origin; any loopback origin is treated as the dev server.
   * Everything else is refused: evidence must not make the resolver call other hosts.
   */
  const toTarget = (url: string): string | undefined => {
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
      if (parsed.host !== target.host && !LOOPBACK.test(parsed.hostname)) return undefined
      return target.origin + parsed.pathname + parsed.search
    } catch {
      return undefined
    }
  }

  const fetchText = async (url: string): Promise<FetchedText> => {
    const rewritten = toTarget(url)
    if (rewritten === undefined) throw new Error(`refusing to fetch ${url}: not the dev server`)
    const response = await doFetch(rewritten, {
      // What a browser sends for a module script; Vite serves the transformed module for it.
      headers: { accept: '*/*', 'sec-fetch-dest': 'script' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await response.text()
    const header = response.headers.get('sourcemap') ?? response.headers.get('x-sourcemap') ?? undefined
    return header === undefined ? { status: response.status, text } : { status: response.status, text, sourceMapHeader: header }
  }

  const post = async (path: string, body: string): Promise<{ status: number; text: string }> => {
    const response = await doFetch(target.origin + path, {
      method: 'POST',
      body,
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    return { status: response.status, text: await response.text() }
  }

  const maps = new SourceMapStore({
    fetchText,
    allowFile: (path) => files.relative(path) !== undefined,
    ttlMs: options.sourceMapTtlMs,
  })

  const looksLikeNext = (url: string, serverEnv: string | undefined): boolean =>
    /\/_next\/static\//.test(url) || (serverEnv !== undefined && /\/\.next\//.test(url))

  async function viaNextEndpoint(frame: StackFrame, scriptUrl: string, serverEnv: string | undefined): Promise<Symbolicated | undefined> {
    if (nextEndpointMissing) return undefined
    const file = serverEnv !== undefined ? scriptUrl : nextClientChunkFile(scriptUrl, files.root)
    if (file === undefined) return { frame, ignored: false, problem: 'the browser chunk is not on disk under .next/' }
    const outcome = await nextOriginalFrame(post, { file, methodName: frame.fn ?? '<unknown>', line1: frame.line, column1: frame.col }, serverEnv !== undefined)
    if (outcome.status === 'unavailable') {
      nextEndpointMissing = true
      return { frame, ignored: false, problem: `Next's stack-frame endpoint is unavailable (${outcome.reason})` }
    }
    if (outcome.status === 'unmapped') return { frame, ignored: false, problem: `Next's stack-frame endpoint: ${outcome.reason}` }
    const located = locateSource(outcome.frame.file, files)
    const result: Symbolicated = {
      frame,
      line: outcome.frame.line,
      col: outcome.frame.col,
      ignored: outcome.frame.ignored || located.dependency,
      by: 'endpoint',
    }
    if (located.file !== undefined) result.file = located.file
    return result
  }

  async function viaSourceMap(frame: StackFrame, scriptUrl: string, fresh: boolean): Promise<Symbolicated> {
    let mapUrl: string | undefined
    if (isTurbopackModuleUrl(scriptUrl)) {
      // One hot-updated module of a chunk: the chunk's own map does not describe it. Next
      // serves the module's map from its source-map endpoint.
      const file = nextClientChunkFile(scriptUrl, files.root)
      if (file === undefined) return { frame, ignored: false, problem: 'the hot-updated chunk is not on disk under .next/' }
      mapUrl = target.origin + nextSourceMapPath(file)
    }
    const outcome = await maps.trace(scriptUrl, frame.line, frame.col, fresh, mapUrl)
    if (outcome.status === 'mapped') {
      const located = locateSource(outcome.position.source, files)
      const result: Symbolicated = {
        frame,
        line: outcome.position.line,
        col: outcome.position.col,
        ignored: outcome.position.ignored || located.dependency,
        by: 'source-map',
      }
      if (located.file !== undefined) result.file = located.file
      return result
    }
    if (outcome.status === 'no-map' && mapUrl !== undefined) {
      return { frame, ignored: false, problem: `Next has no source map for the hot-updated module ${frame.url}` }
    }
    if (outcome.status === 'no-map') {
      // Served as written: the script is the source.
      const located = locateSource(scriptUrl, files)
      const result: Symbolicated = { frame, line: frame.line, col: frame.col, ignored: located.dependency, by: 'identity' }
      if (located.file !== undefined) result.file = located.file
      return result
    }
    return { frame, ignored: false, problem: outcome.status === 'unmapped' ? `no mapping for ${frame.url}:${frame.line}:${frame.col}` : outcome.reason }
  }

  async function symbolicate(frame: StackFrame, fresh = false): Promise<Symbolicated> {
    const ref = scriptRefOf(frame.url)
    const next = looksLikeNext(ref.url, ref.serverEnv)
    let problem: string | undefined
    if (next && strategy !== 'source-maps-only') {
      const viaEndpoint = await viaNextEndpoint(frame, ref.url, ref.serverEnv)
      if (viaEndpoint?.line !== undefined) return viaEndpoint
      problem = viaEndpoint?.problem
      if (strategy === 'endpoint-only') return viaEndpoint ?? { frame, ignored: false, problem: "Next's stack-frame endpoint is unavailable" }
    }
    if (!ref.url.startsWith('file://') && toTarget(ref.url) === undefined) {
      return { frame, ignored: false, problem: `${ref.url} is not served by the dev server` }
    }
    const viaMap = await viaSourceMap(frame, ref.url, fresh)
    if (viaMap.problem !== undefined && problem !== undefined) viaMap.problem = `${problem}; ${viaMap.problem}`
    return viaMap
  }

  /** Checks a claimed position against the file and settles the level. */
  function settle(file: string, line: number, col: number | undefined, tag: string | undefined): Located {
    const source = files.read(file)
    if (source === undefined) {
      return { file, line, col: col ?? 1, level: 'file', verified: false, notes: [`${file} could not be read`] }
    }
    const match = findOpeningTag(source, line, col, { tag, jsx: isJsxFile(file) })
    if (!match) {
      const what = tag === undefined ? 'an opening tag' : `<${tag}>`
      return { file, line, col: col ?? 1, level: 'file', verified: false, notes: [`no ${what} at or near ${file}:${line}`] }
    }
    if (match.kind === 'nearby') {
      return {
        file,
        line: match.line,
        col: match.col,
        level: 'file',
        verified: true,
        notes: [`<${tag}> is not on the reported line ${line}; the nearest one is on line ${match.line}`],
      }
    }
    const notes: string[] = []
    if (match.dynamic) notes.push(`the tag is written as <${match.name}>`)
    return { file, line: match.line, col: match.col, level: 'exact', verified: true, notes }
  }

  /**
   * Symbolicates candidate frames in order and returns the first that lands in project code,
   * verified on disk. A cached source map that fails verification is fetched again once: the
   * dev server may have rebuilt the module under the same URL.
   *
   * `inDependency` is true when the frames were symbolicated and every one of them is in a
   * dependency: the JSX call exists, but not in project code.
   */
  async function locateFromStack(stack: string | undefined, tag: string | undefined, notes: string[]): Promise<{ located?: Located; inDependency: boolean }> {
    const { state, frames } = callSiteFrames(stack)
    if (state !== 'captured') return { inDependency: false }
    let inDependency = false
    for (const fresh of [false, true]) {
      const mapped: Symbolicated[] = []
      for (const frame of frames.slice(0, 6)) {
        const symbolicated = await symbolicate(frame, fresh)
        mapped.push(symbolicated)
        if (symbolicated.file !== undefined && !symbolicated.ignored) break
      }
      inDependency = mapped.length > 0 && mapped.every((entry) => entry.ignored && entry.problem === undefined)
      const index = pickProjectFrame(mapped.map((entry) => ({ file: entry.file, ignored: entry.ignored })))
      const chosen = mapped[index]
      if (chosen?.file === undefined || chosen.line === undefined) {
        if (inDependency) break
        if (fresh) for (const entry of mapped) if (entry.problem !== undefined) notes.push(entry.problem)
        continue
      }
      const located = settle(chosen.file, chosen.line, chosen.col, tag)
      located.frameUrl = chosen.frame.url
      if (located.level === 'exact' || fresh || chosen.by !== 'source-map') return { located, inDependency: false }
    }
    return { inDependency }
  }

  /** The JSX calls of `owner` for this tag that really are opening tags in `file`. */
  function sitesIn(file: string, owner: ReactOwner | undefined, tag: string): JsxSite[] {
    const source = files.read(file)
    if (source === undefined || !owner?.jsxSites) return []
    return owner.jsxSites.filter(
      (site) => site.host && site.type === tag && findOpeningTag(source, site.line, site.col, { tag, window: 0, jsx: true })?.kind === 'exact',
    )
  }

  /**
   * Picks among the JSX calls of one component for the same tag.
   *
   * One call: the element's owner is this component and this is its only `<tag>`, so the
   * position is exact, provided something written in the tag (id, a class, an attribute, text)
   * also shows on the element. Without that support the line is still the best answer but only
   * the file is claimed: a helper function called during the owner's render, or a tag held in a
   * variable, creates elements with the same owner from a JSX call this text does not show.
   * Several calls: ranked by attributes and text, never exact.
   */
  function chooseSite(file: string, sites: readonly JsxSite[], owner: ReactOwner, context: ElementContext, ownerRoot: boolean, reason: string): SiteChoice | undefined {
    const source = files.read(file)
    const [only] = sites
    if (source === undefined || !only) return undefined
    if (sites.length === 1) {
      const scored = scoreTag(openingTagText(source, only.line, only.col), textAfterTag(source, only.line, only.col), context)
      const comparable = context.id !== undefined || context.classes.length > 0 || Object.keys(context.attrs).length > 0 || context.ownText.length >= 3
      const supported = scored.why.length > 1 || !comparable
      const notes = [`${reason}; ${owner.name} has exactly one <${context.tag}>`]
      if (!supported) notes.push('nothing written in that tag (id, class, attribute, text) shows on the element, so the line is not confirmed')
      return {
        located: { file, line: only.line, col: only.col, level: supported ? 'exact' : 'file', verified: true, notes },
        fromSites: true,
      }
    }
    // When the element has exactly as many same-tag siblings as the component has calls for the
    // tag, they are most likely those calls written side by side (the cells of a row template),
    // and the n-th sibling is the n-th call. A weak hint: it only breaks ties.
    const step = context.path.at(-1)
    const inOrder = [...sites].sort((a, b) => a.line - b.line || a.col - b.col)
    const byPosition = step !== undefined && step.ofTypeCount === sites.length ? inOrder[step.ofType] : undefined
    const candidates = sites
      .map((site) => {
        const scored = scoreTag(openingTagText(source, site.line, site.col), textAfterTag(source, site.line, site.col), context)
        const why = [...scored.why]
        // The root of what the component returns is not written inside another JSX call.
        let score = scored.score + (site.top === ownerRoot ? 0.5 : 0)
        if (site === byPosition) {
          score += 0.75
          why.push(`sibling ${step?.ofType !== undefined ? step.ofType + 1 : '?'} of ${sites.length}`)
        }
        return { file, line: site.line, col: site.col, score, why }
      })
      .sort((a, b) => b.score - a.score || a.line - b.line)
    const [best, second] = candidates
    if (!best) return undefined
    const clear = second === undefined || best.score > second.score
    return {
      located: {
        file,
        line: best.line,
        col: best.col,
        level: clear ? 'file' : 'candidates',
        verified: true,
        notes: [
          `${reason}; ${owner.name} has ${sites.length} <${context.tag}> tags` +
            (clear ? `, line ${best.line} matches the element best (${best.why.join(', ')})` : ' that match the element equally'),
        ],
      },
      candidates,
      fromSites: true,
    }
  }

  /** Step 4: the owner function's JSX calls, when React kept no stack for the element. */
  function locateFromJsxSites(owner: ReactOwner, context: ElementContext, ownerRoot: boolean, notes: string[]): SiteChoice | undefined {
    const hostSites = (owner.jsxSites ?? []).filter((site) => site.host)
    const wanted = hostSites.filter((site) => site.type === context.tag)
    if (wanted.length === 0) return undefined

    // Which file is the owner function in? The transform may name it; otherwise it is the
    // file that defines the component AND holds a matching tag at every recorded position.
    const fits = (file: string): boolean => {
      const source = files.read(file)
      return source !== undefined && hostSites.every((site) => findOpeningTag(source, site.line, site.col, { tag: site.type, window: 0, jsx: true })?.kind === 'exact')
    }
    let file: string | undefined
    const named = wanted.find((site) => site.file !== undefined)?.file
    if (named !== undefined) file = locateSource(named, files).file
    if (file === undefined) {
      const fitting = filesDefining(files, owner.name).filter(fits)
      if (fitting.length === 1) file = fitting[0]
      else if (fitting.length > 1) notes.push(`${fitting.length} files define ${owner.name} with matching tags`)
    }
    if (file === undefined) {
      notes.push(`could not find the file that defines ${owner.name}`)
      return undefined
    }
    return chooseSite(file, sitesIn(file, owner, context.tag), owner, context, ownerRoot, "React's owner-stack limit was reached for this element")
  }

  /**
   * A position that came from the fiber's own `_debugStack` may describe an older version of
   * the module (see browser/react.ts). The owner function's text is always current, so its
   * JSX calls confirm the position, replace it, or leave it unconfirmed.
   */
  function confirmFiberStack(located: Located, react: ReactEvidence, context: ElementContext): SiteChoice {
    const owner = react.owners[0]
    const sites = sitesIn(located.file, owner, context.tag)
    const modifiedAt = files.modifiedAt(located.file) ?? 0
    // Vite stamps hot-updated modules with ?t=<time of the update>.
    const stamp = Number(/[?&]t=(\d{10,})/.exec(located.frameUrl ?? '')?.[1] ?? 0)
    const loadedAfterEdit = Math.max(context.pageLoadedAt, stamp) >= modifiedAt
    const onSite = sites.some((site) => site.line === located.line && site.col === located.col)
    const stale = 'this element was mounted before the file last changed, and React keeps the stack from mount time'

    if (located.level === 'exact' && (sites.length === 0 || onSite)) {
      if (loadedAfterEdit || (onSite && sites.length === 1)) return { located }
      return {
        located: { ...located, level: 'file', notes: [...located.notes, `${stale}; the line could not be confirmed (reload the page to be sure)`] },
      }
    }
    // Not a JSX call of the component as it is now: trust the function text over the stack.
    if (owner && sites.length > 0) {
      const chosen = chooseSite(located.file, sites, owner, context, react.ownerRoot, stale)
      if (chosen) return chosen
    }
    return { located }
  }

  /** The best-matching tag inside one known file: the file is established, the line is a guess. */
  function bestInFile(file: string, context: ElementContext): { line?: number; col?: number; candidates: SourceCandidate[] } {
    const candidates = grepCandidates(files, context, { files: [file], limit: 3 })
    const best = candidates[0]
    return best ? { line: best.line, col: best.col, candidates } : { candidates }
  }

  async function resolveReact(react: ReactEvidence, context: ElementContext, notes: string[]): Promise<Partial<SourceResult> | undefined> {
    const nearest = react.owners[0]
    const base = { framework: 'react' as Framework, component: nearest?.name }
    if (react.bundleType === 0) notes.push('React is running a production build: it keeps no source information')

    if (!react.hostFiber) {
      // Server-rendered markup React has not hydrated (a Suspense fallback while the response
      // still streams), or DOM that something else put inside a React element. The nearest
      // React ancestor can be in any file, so it is not offered as the answer.
      notes.push('React has no fiber for this element (not hydrated yet, or not created by React)')
      return undefined
    }

    // 3. The element's own stack.
    let createdInDependency = false
    if (react.stackState === 'captured') {
      const own = await locateFromStack(react.stack, context.tag, notes)
      createdInDependency = own.inDependency
      if (own.located) {
        const located = own.located
        if (react.stackFrom === 'element') return { ...base, ...pick(located), via: 'react-stack', target: 'element', notes: located.notes }
        const confirmed = confirmFiberStack(located, react, context)
        return {
          ...base,
          ...pick(confirmed.located),
          via: confirmed.fromSites ? 'react-jsx-sites' : 'react-stack',
          target: 'element',
          notes: confirmed.located.notes,
          candidates: confirmed.candidates,
        }
      }
    } else if (react.stackState === 'placeholder') {
      notes.push("React's owner-stack limit was reached (it captures stacks for the first 10,000 elements of a render)")
    } else if (nearest?.kind === 'server') {
      notes.push('the server sent no stack for this element (the owner-stack limit also applies to Server Components)')
    }

    // React 18 and older with the JSX source transform.
    if (react.debugSource) {
      const file = locateSource(react.debugSource.fileName, files).file
      if (file !== undefined) {
        const located = settle(file, react.debugSource.lineNumber, react.debugSource.columnNumber, context.tag)
        return { ...base, ...pick(located), via: 'react-debug-source', target: 'element', notes: located.notes }
      }
    }

    if (nearest && !createdInDependency) {
      // 4. JSX calls in the nearest owner's function text.
      const fromSites = locateFromJsxSites(nearest, context, react.ownerRoot, notes)
      if (fromSites) {
        return {
          ...base,
          ...pick(fromSites.located),
          via: 'react-jsx-sites',
          target: 'element',
          notes: fromSites.located.notes,
          candidates: fromSites.candidates,
        }
      }

      // 5. A Server Component owner sometimes carries the location of its function: the file, not the tag.
      if (nearest.kind === 'server' && nearest.location !== undefined) {
        const { located } = await locateFromStack(nearest.location, undefined, notes)
        if (located) {
          const inFile = bestInFile(located.file, context)
          return {
            ...base,
            file: located.file,
            line: inFile.line ?? located.line,
            col: inFile.col ?? located.col,
            level: 'file',
            verifiedOnDisk: inFile.line !== undefined,
            via: 'react-server-location',
            target: 'element',
            notes: [`only the location of ${nearest.name} is known; the line is the best-matching <${context.tag}> in that file`],
            candidates: inFile.candidates,
          }
        }
      }

      // The one file that defines the owner component, when its name is unique in the project.
      const defining = filesDefining(files, nearest.name).filter((file) => bestInFile(file, context).line !== undefined)
      if (defining.length === 1 && defining[0] !== undefined) {
        const file = defining[0]
        const inFile = bestInFile(file, context)
        return {
          ...base,
          file,
          line: inFile.line,
          col: inFile.col,
          level: 'file',
          verifiedOnDisk: true,
          via: 'react-owner-file',
          target: 'element',
          notes: [`${file} is the only file that defines ${nearest.name}; the line is the best-matching <${context.tag}> in it`],
          candidates: inFile.candidates,
        }
      }
    }

    // 6. Where project code used the component that created the element.
    for (const owner of react.owners) {
      const { located } = await locateFromStack(owner.stack, undefined, notes)
      if (!located) continue
      if (createdInDependency) {
        return {
          ...base,
          ...pick(located),
          component: owner.name,
          via: 'react-owner-stack',
          target: 'usage',
          notes: [...located.notes, `the element is created inside a dependency; this is where project code uses ${owner.name}`],
        }
      }
      // Without the element's own stack this is only where its component is used: a lead, not an answer.
      return {
        ...base,
        ...pick(located),
        component: owner.name,
        level: 'candidates',
        via: 'react-owner-stack',
        target: 'usage',
        notes: [...located.notes, `the tag that creates this element was not found; this is where ${owner.name} is used`],
      }
    }
    return undefined
  }

  function resolveHint(hint: SourceHint, context: ElementContext): Partial<SourceResult> | undefined {
    const file = locateSource(hint.file, files).file
    if (file === undefined) return undefined
    if (hint.line === undefined) {
      const inFile = grepCandidates(files, context, { files: [file], limit: 3 })
      const best = inFile[0]
      return {
        framework: hint.framework,
        file,
        line: best?.line,
        col: best?.col,
        level: 'file',
        verifiedOnDisk: best !== undefined,
        via: 'hint',
        target: 'element',
        notes: [`${hint.from} names the file only`],
        candidates: inFile,
      }
    }
    const located = settle(file, hint.line, hint.col, context.tag)
    return { framework: hint.framework, ...pick(located), via: 'hint', target: 'element', notes: located.notes }
  }

  function resolveHtml(context: ElementContext): Partial<SourceResult> | undefined {
    const file = htmlFileForPage(files, context.pagePath)
    const html = file === undefined ? undefined : files.read(file)
    if (file === undefined || html === undefined) return undefined
    const byPath = locateByPath(html, context.path, context)
    if (byPath?.exact) {
      return { framework: 'html', file, line: byPath.line, col: byPath.col, level: 'exact', verifiedOnDisk: true, via: 'html-path', target: 'element', notes: [] }
    }
    const candidates = searchHtml(html, file, context)
    const [best, second] = candidates
    // A page whose markup comes from scripts (an SPA shell) has nothing to offer here.
    if (!best || best.score < 3) return undefined
    const clear = second === undefined || best.score > second.score
    return {
      framework: 'html',
      file,
      line: best.line,
      col: best.col,
      level: clear ? 'file' : 'candidates',
      verifiedOnDisk: true,
      via: 'html-search',
      target: 'element',
      notes: [...(byPath?.notes ?? ['the element is not at the same position in the file']), `picked by ${best.why.join(', ')}`],
      candidates,
    }
  }

  async function resolveInner(evidence: Evidence, notes: string[]): Promise<Partial<SourceResult>> {
    const { context } = evidence

    for (const hint of evidence.hints) {
      const result = resolveHint(hint, context)
      if (result) return result
    }

    const svelte = evidence.svelte
    if (svelte?.loc) {
      const file = locateSource(svelte.loc.file, files).file
      if (file !== undefined) {
        const located = settle(file, svelte.loc.line, svelte.loc.column + 1, context.tag)
        return { framework: 'svelte', component: componentName(file), ...pick(located), via: 'svelte-meta', target: 'element', notes: located.notes }
      }
      notes.push(`__svelte_meta names ${svelte.loc.file}, which is not in the project`)
    }

    if (evidence.react) {
      const result = await resolveReact(evidence.react, context, notes)
      if (result) return result
    }

    if (svelte?.ancestorLoc) {
      const file = locateSource(svelte.ancestorLoc.file, files).file
      if (file !== undefined) {
        const inFile = grepCandidates(files, context, { files: [file], limit: 3 })
        const best = inFile[0]
        return {
          framework: 'svelte',
          component: componentName(file),
          file,
          line: best?.line ?? svelte.ancestorLoc.line,
          col: best?.col ?? svelte.ancestorLoc.column + 1,
          level: 'file',
          verifiedOnDisk: best !== undefined,
          via: 'svelte-meta',
          target: 'element',
          notes: ['Svelte did not create this element; the file is its nearest Svelte ancestor'],
          candidates: inFile,
        }
      }
    }

    const html = resolveHtml(context)
    if (html) return html

    const candidates = grepCandidates(files, context)
    const best = candidates[0]
    const framework: Framework = evidence.react ? 'react' : svelte ? 'svelte' : 'unknown'
    if (!best) return { framework, level: 'candidates', via: 'none', candidates: [], notes: [`no <${context.tag}> found in the project's markup files`] }
    return {
      framework: framework === 'unknown' ? frameworkOfFile(best.file) : framework,
      file: best.file,
      line: best.line,
      col: best.col,
      level: 'candidates',
      verifiedOnDisk: true,
      via: 'grep',
      target: 'element',
      candidates,
      notes: [`no framework source information; ranked by ${best.why.join(', ')}`],
    }
  }

  return {
    files,
    invalidate() {
      maps.invalidate()
      files.invalidate()
    },
    async resolve(evidence) {
      const started = performance.now()
      const notes: string[] = []
      let partial: Partial<SourceResult>
      try {
        partial = await resolveInner(evidence, notes)
      } catch (error) {
        partial = { level: 'candidates', via: 'none', candidates: [], notes: [`resolver error: ${error instanceof Error ? error.message : String(error)}`] }
      }
      const result: SourceResult = {
        framework: partial.framework ?? 'unknown',
        level: partial.level ?? 'candidates',
        verifiedOnDisk: partial.verifiedOnDisk ?? false,
        via: partial.via ?? 'none',
        target: partial.target ?? 'element',
        notes: [...(partial.notes ?? []), ...notes.filter((note) => !(partial.notes ?? []).includes(note))],
        resolveMs: performance.now() - started,
      }
      if (partial.file !== undefined) result.file = partial.file
      if (partial.line !== undefined) result.line = partial.line
      if (partial.col !== undefined) result.col = partial.col
      if (partial.component !== undefined) result.component = partial.component
      if (partial.candidates !== undefined) result.candidates = partial.candidates
      return result
    },
  }
}

function pick(located: Located): Pick<SourceResult, 'file' | 'line' | 'col' | 'level' | 'verifiedOnDisk'> {
  return { file: located.file, line: located.line, col: located.col, level: located.level, verifiedOnDisk: located.verified }
}

function componentName(file: string): string | undefined {
  const base = file.split('/').pop() ?? ''
  const name = base.replace(/\.[^.]+$/, '')
  return name === '' ? undefined : name
}

function frameworkOfFile(file: string): Framework {
  if (/\.svelte$/.test(file)) return 'svelte'
  if (/\.vue$/.test(file)) return 'vue'
  if (/\.astro$/.test(file)) return 'astro'
  if (/\.[jt]sx$/.test(file)) return 'react'
  if (/\.html?$/.test(file)) return 'html'
  return 'unknown'
}

export type { SourceVia }
