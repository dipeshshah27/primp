/**
 * Shared shapes for element-to-source mapping.
 *
 * The browser half (`browser/*`) turns an Element into `Evidence`: plain JSON,
 * small enough to send over the overlay socket. The node half (`node/*`) turns
 * `Evidence` into a `SourceResult` by symbolicating, reading the project on
 * disk and checking that the claimed position really holds an opening tag.
 *
 * Nothing in this file touches the DOM or Node.
 */

/** One step of an element's structural path, root first. */
export interface PathStep {
  /** Lower-case tag name. */
  tag: string
  /** Index among the parent's element children. */
  index: number
  /** Index among the parent's element children with the same tag. */
  ofType: number
  /** How many element children with the same tag the parent has. */
  ofTypeCount: number
  id?: string
}

/** Framework-independent facts about the element. */
export interface ElementContext {
  /** Lower-case tag name. */
  tag: string
  id?: string
  classes: string[]
  /** A fixed allowlist of identifying attributes (see `browser/context.ts`); never `data-label`. */
  attrs: Record<string, string>
  /** Text of the element's own text nodes, whitespace collapsed, at most 160 characters. */
  ownText: string
  /** Text of the whole subtree, whitespace collapsed, at most 160 characters. */
  text: string
  /** Path from `<html>` (first step) to the element (last step). */
  path: PathStep[]
  /** `location.pathname` of the document. */
  pagePath: string
  /** `location.origin` of the document. */
  pageOrigin: string
  /** `performance.timeOrigin`: when this document started loading, in epoch milliseconds. */
  pageLoadedAt: number
}

/** A JSX call found in the text of a component function: `jsxDEV("h1", ..., { lineNumber, columnNumber })`. */
export interface JsxSite {
  /** Host tag (`h1`) or component identifier (`Card`, `motion.div`). */
  type: string
  /** True when the first argument was a string literal, so `type` is a host tag. */
  host: boolean
  /** 1-based line in the original source, as written by the dev JSX transform. */
  line: number
  /** 1-based column in the original source. */
  col: number
  /** `fileName` literal when the transform inlines it (SWC / Turbopack do, Babel and oxc use a variable). */
  file?: string
  /** True when the call is not written inside another JSX call of the same function. */
  top: boolean
}

/** One component in the owner chain: the component whose render created the element (or the previous owner). */
export interface ReactOwner {
  name: string
  /** `client`: a fiber. `server`: a Server Component described by RSC debug info. */
  kind: 'client' | 'server'
  /** RSC environment name (`Server`, `Prerender`, ...). */
  env?: string
  /** Trimmed stack of the JSX call that created this component's element. */
  stack?: string
  /** Trimmed stack pointing into the component function itself (Server Components only). */
  location?: string
  /**
   * JSX calls found in the text of the component function as it is NOW (Fast Refresh swaps the
   * function in place). Nearest client owner only: every call when the element has no usable
   * stack, otherwise just the calls for the element's own tag.
   */
  jsxSites?: JsxSite[]
}

export type StackState =
  /** A stack captured at the JSX call. */
  | 'captured'
  /** React's shared placeholder: the per-window owner-stack limit was reached. */
  | 'placeholder'
  /**
   * No call-site frame: no `_debugStack` at all (production build, React older than 19), or a
   * stack holding nothing but the JSX factory. The latter is what an element made by a Server
   * Component looks like once the server-side limit was reached: the server sends no frames.
   */
  | 'missing'

export interface ReactEvidence {
  /** Renderer version from the DevTools hook, when the hook saw the renderer register. */
  version?: string
  /** 1 = development build, 0 = production, as reported by the renderer. */
  bundleType?: number
  /** True when the fiber is the host fiber of exactly this element. */
  hostFiber: boolean
  stackState: StackState
  /** Trimmed stack of the JSX call that created the element. */
  stack?: string
  /**
   * Where `stack` was read.
   * `element`: from the React element the parent fiber rendered last, so it reflects the latest render.
   * `fiber`: from the fiber's `_debugStack`, which React sets when the fiber is created and does
   * not refresh when Fast Refresh or an RSC update re-renders it; it can describe an older
   * version of the module.
   */
  stackFrom?: 'element' | 'fiber'
  /** True when the element is the root of what its owner component returned. */
  ownerRoot: boolean
  /** `_debugSource` (React 18 and older with the JSX source transform). */
  debugSource?: { fileName: string; lineNumber: number; columnNumber?: number }
  /** Nearest owner first. */
  owners: ReactOwner[]
}

export interface SvelteEvidence {
  /** `element.__svelte_meta.loc` (Svelte 5 dev): project-relative file, 1-based line, 0-based column. */
  loc?: { file: string; line: number; column: number }
  /** The same, taken from the nearest ancestor that has one, when the element itself has none (`{@html}` content). */
  ancestorLoc?: { file: string; line: number; column: number }
  /** Files of the components wrapping the element, nearest first (from `__svelte_meta.parent`). */
  parents: string[]
}

/** A location some framework or plugin wrote straight into the DOM. */
export interface SourceHint {
  /** Where it came from, for example `data-astro-source-file`. */
  from: string
  file: string
  line?: number
  /** 1-based. */
  col?: number
  framework: Framework
}

export type Framework = 'react' | 'svelte' | 'vue' | 'astro' | 'solid' | 'qwik' | 'html' | 'unknown'

export interface Evidence {
  context: ElementContext
  react?: ReactEvidence
  svelte?: SvelteEvidence
  hints: SourceHint[]
  /** Milliseconds the collector spent on this element. */
  collectMs: number
}

export type SourceLevel =
  /**
   * The framework named this position and the file holds a matching opening tag exactly there.
   * Also used when React kept no stack but the owner component has exactly one tag of that
   * name and the tag's own attributes or text show on the element (see `node/resolve.ts`).
   */
  | 'exact'
  /** The file is known; the line is a best guess (or absent). */
  | 'file'
  /** Ranked guesses only. `file`/`line` repeat the first candidate when there is one. */
  | 'candidates'

export interface SourceCandidate {
  file: string
  line: number
  col: number
  score: number
  /** What matched, for the UI and for debugging. */
  why: string[]
}

/** Which strategy produced the result. */
export type SourceVia =
  | 'react-stack'
  | 'react-owner-stack'
  | 'react-jsx-sites'
  | 'react-debug-source'
  | 'react-server-location'
  | 'react-owner-file'
  | 'svelte-meta'
  | 'hint'
  | 'html-path'
  | 'html-search'
  | 'grep'
  | 'none'

export interface SourceResult {
  /** Project-relative path with forward slashes. */
  file?: string
  /** 1-based. */
  line?: number
  /** 1-based column of the `<` of the opening tag. */
  col?: number
  /** Nearest component that rendered the element, when known. */
  component?: string
  framework: Framework
  level: SourceLevel
  /** True when the file was read and an opening tag was found at `line`/`col`. */
  verifiedOnDisk: boolean
  via: SourceVia
  /**
   * `element`: the position is the tag that produced this DOM element.
   * `usage`: the element was created inside a dependency; the position is where project code used that component.
   */
  target: 'element' | 'usage'
  candidates?: SourceCandidate[]
  /** Why the result is not better than it is; one short sentence each. */
  notes: string[]
  /** Milliseconds spent resolving. */
  resolveMs: number
}
