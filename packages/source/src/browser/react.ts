import type { JsxSite, ReactEvidence, ReactOwner, StackState } from '../types.ts'

/**
 * React evidence for one element, read from its fiber. Development builds only.
 *
 * What React 19.3 keeps on a host fiber (measured on Vite 8 and Next 16.4, see spike S2):
 *   _debugStack   an Error created inside jsxDEV at the JSX call that made the element.
 *                 Frame 0 is the JSX factory, frame 1 the call site, and the stack ends at
 *                 `react_stack_bottom_frame`. For an element made by a Server Component the
 *                 frames are replayed on the client under `about://React/<Env>/file:///...`.
 *   _debugOwner   the component that was rendering: a fiber, or for Server Components a plain
 *                 object { name, env, owner, debugStack, debugLocation }.
 *   _debugInfo    null on fibers created on the client. On fibers that came through RSC it is
 *                 an array of timing entries, plus, only on the fiber of a Server Component's
 *                 root output, that component's info object. The same object is the
 *                 `_debugOwner` of every element the component created, so it is read there.
 *   _debugTask    a console task; nothing readable.
 *   _debugSource  gone since React 19 (the key does not exist on the fiber).
 *
 * `_debugStack` is assigned when a fiber is CREATED (createFiberFromElement) and only copied
 * afterwards. When Fast Refresh or an RSC refresh re-renders an existing fiber, React updates
 * `_debugOwner` but keeps the old stack, which then points into a module version that no
 * longer exists. The element React rendered last does carry a current stack, and it is still
 * reachable: the parent fiber keeps its children elements in `memoizedProps`. The collector
 * prefers that element's stack and says which one it used.
 *
 * React captures real stacks for the first 10,000 elements of a render window only. Later
 * elements share one placeholder whose single frame is `UnknownOwner`. `_debugOwner` is
 * still correct for those, so the collector falls back to reading the owner function's text:
 * the dev JSX transform writes `lineNumber` / `columnNumber` literals into every call.
 */

interface FiberLike {
  tag: number
  type: unknown
  elementType?: unknown
  key: unknown
  index: number
  memoizedProps: unknown
  stateNode: unknown
  return: FiberLike | null
  child?: FiberLike | null
  sibling?: FiberLike | null
  alternate?: FiberLike | null
  _debugOwner?: unknown
  _debugStack?: unknown
  _debugSource?: unknown
}

interface ServerComponentInfo {
  name?: unknown
  env?: unknown
  owner?: unknown
  debugStack?: unknown
  debugLocation?: unknown
}

interface RendererLike {
  version?: unknown
  bundleType?: unknown
  findFiberByHostInstance?: (instance: unknown) => unknown
}

const MAX_OWNERS = 8
const MAX_FRAMES = 12
const MAX_SITES = 400
const MAX_FUNCTION_TEXT = 400_000

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const isFiber = (value: unknown): value is FiberLike => isObject(value) && typeof value.tag === 'number' && 'return' in value

function renderers(): RendererLike[] {
  const hook = (globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: { renderers?: unknown } }).__REACT_DEVTOOLS_GLOBAL_HOOK__
  const map = hook?.renderers
  return map instanceof Map ? ([...map.values()] as RendererLike[]) : []
}

/**
 * The fiber React attached to this DOM node. react-dom stores it on the node under a key with
 * a per-load random suffix; renderers before React 19 also expose a lookup through the hook.
 */
export function fiberOf(element: Element): FiberLike | undefined {
  for (const renderer of renderers()) {
    try {
      const fiber = renderer.findFiberByHostInstance?.(element)
      if (isFiber(fiber)) return fiber
    } catch {
      // Not this renderer's node.
    }
  }
  for (const key in element) {
    if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
      const fiber = (element as unknown as Record<string, unknown>)[key]
      if (isFiber(fiber)) return fiber
    }
  }
  return undefined
}

/**
 * React keeps two copies of every fiber and swaps them on each update. The DOM node points
 * at whichever copy existed when the node was created, so after a re-render it can be the
 * retired one, with the props, owner and component function of the previous render. The live
 * copy is the one reachable from the root's `current` tree.
 */
export function currentFiber(fiber: FiberLike, depth = 0): FiberLike {
  const alternate = fiber.alternate
  if (!alternate || depth > 2000) return fiber
  const parent = fiber.return
  if (!parent) {
    // The host root: its stateNode is the FiberRoot, whose `current` names the live copy.
    const root = fiber.stateNode
    return isObject(root) && root.current === alternate ? alternate : fiber
  }
  const liveParent = currentFiber(parent, depth + 1)
  for (let child = liveParent.child; child; child = child.sibling) {
    if (child === fiber) return fiber
    if (child === alternate) return alternate
  }
  return fiber
}

function nameOf(type: unknown, depth = 0): string {
  if (typeof type === 'string') return type
  if (typeof type === 'function') {
    const fn = type as { displayName?: unknown; name?: unknown }
    return (typeof fn.displayName === 'string' && fn.displayName) || (typeof fn.name === 'string' && fn.name) || 'Anonymous'
  }
  if (isObject(type) && depth < 4) {
    if (typeof type.displayName === 'string' && type.displayName) return type.displayName
    // memo() keeps the component in `type`, forwardRef() in `render`.
    return nameOf(type.type ?? type.render, depth + 1)
  }
  return 'Anonymous'
}

function functionOf(type: unknown, depth = 0): ((...args: never[]) => unknown) | undefined {
  if (typeof type === 'function') {
    const render = (type as { prototype?: { render?: unknown } }).prototype?.render
    return (typeof render === 'function' ? render : type) as (...args: never[]) => unknown
  }
  if (isObject(type) && depth < 4) return functionOf(type.type ?? type.render, depth + 1)
  return undefined
}

/** Keeps the message line and the frames above React's bottom marker. */
export function trimStack(stack: unknown): string | undefined {
  if (typeof stack !== 'string' || stack === '') return undefined
  const kept: string[] = []
  for (const line of stack.split('\n')) {
    if (line.includes('react_stack_bottom_frame') || line.includes('react-stack-bottom-frame')) break
    kept.push(line)
    if (kept.length > MAX_FRAMES) break
  }
  return kept.join('\n')
}

function stackOf(error: unknown): string | undefined {
  // `stack` is a lazy accessor on V8 errors; a Proxy or a getter that throws must not break collection.
  try {
    return isObject(error) ? trimStack(error.stack) : undefined
  } catch {
    return undefined
  }
}

export function stackState(stack: string | undefined): StackState {
  if (stack === undefined) return 'missing'
  const frames = stack.split('\n').filter((line) => /^\s*at |@/.test(line))
  if (frames.some((line) => /\bUnknownOwner\b/.test(line))) return 'placeholder'
  // Frame 0 is the JSX factory; without a second frame there is no call site.
  return frames.length < 2 ? 'missing' : 'captured'
}

/**
 * Finds the JSX calls in a component function's text, with the source position the dev
 * transform wrote next to each: `jsxDEV("h1", props, key, isStatic, { fileName, lineNumber,
 * columnNumber }, this)`, or `createElement("h1", { __source: {...} })` with the classic
 * runtime. A call's position object comes after every call nested in its children (automatic
 * runtime) or before any of them (classic), so positions pair with calls last-in, first-out.
 */
export function parseJsxSites(text: string): JsxSite[] {
  const sites: JsxSite[] = []
  const open: { type: string; host: boolean }[] = []
  const token =
    /(?:jsxDEV|\bcreateElement)["'\])\s]*\(\s*(?:"([^"\\]+)"|'([^'\\]+)'|([A-Za-z_$][\w$.]*))|(?:fileName:\s*(?:"((?:[^"\\]|\\.)*)"|[\w$.]+)\s*,\s*)?lineNumber:\s*(\d+)\s*,\s*columnNumber:\s*(\d+)/g
  for (let match = token.exec(text); match && sites.length < MAX_SITES; match = token.exec(text)) {
    if (match[5] === undefined) {
      const literal = match[1] ?? match[2]
      open.push(literal !== undefined ? { type: literal, host: true } : { type: match[3] ?? '', host: false })
      continue
    }
    const call = open.pop()
    if (!call) continue
    const site: JsxSite = { type: call.type, host: call.host, line: Number(match[5]), col: Number(match[6]), top: open.length === 0 }
    if (match[4] !== undefined) site.file = match[4]
    sites.push(site)
  }
  return sites
}

const sitesByFunction = new WeakMap<object, JsxSite[]>()

function jsxSitesOf(type: unknown): JsxSite[] | undefined {
  const fn = functionOf(type)
  if (!fn) return undefined
  const cached = sitesByFunction.get(fn)
  if (cached) return cached
  let sites: JsxSite[] = []
  try {
    const text = Function.prototype.toString.call(fn)
    if (text.length <= MAX_FUNCTION_TEXT) sites = parseJsxSites(text)
  } catch {
    // Bound or native functions have no useful text.
  }
  sitesByFunction.set(fn, sites)
  return sites
}

/** Fiber tags whose children are what a render function returned; React does not keep that element. */
const COMPONENT_TAGS = new Set([0, 1, 2, 11, 14, 15, 16])
const FRAGMENT_TAG = 7
const FRAGMENT_TYPE = Symbol.for('react.fragment')

interface ElementLike {
  type: unknown
  key: unknown
  props?: { children?: unknown }
  _debugStack?: unknown
}

const isElementLike = (value: unknown): value is ElementLike => isObject(value) && typeof value.$$typeof === 'symbol' && 'type' in value

/**
 * The React element this fiber was last rendered from, found in the parent fiber's props.
 * Undefined when the parent is a component (its output is not retained) or the shapes do not
 * line up; the caller then falls back to the fiber's own, possibly older, stack.
 */
function latestElementOf(fiber: FiberLike): ElementLike | undefined {
  const parent = fiber.return
  if (!parent || COMPONENT_TAGS.has(parent.tag)) return undefined
  let children: unknown = parent.tag === FRAGMENT_TAG ? parent.memoizedProps : isObject(parent.memoizedProps) ? parent.memoizedProps.children : undefined
  // A lone keyless fragment is unwrapped by the reconciler.
  if (isElementLike(children) && children.type === FRAGMENT_TYPE && children.key == null) children = children.props?.children
  const candidate: unknown = Array.isArray(children) ? children[fiber.index] : fiber.index === 0 ? children : undefined
  if (!isElementLike(candidate)) return undefined
  const sameType = candidate.type === fiber.elementType || candidate.type === fiber.type
  const sameKey = (candidate.key ?? null) === (fiber.key ?? null)
  return sameType && sameKey ? candidate : undefined
}

function ownersOf(fiber: FiberLike, tag: string, allSites: boolean): ReactOwner[] {
  const owners: ReactOwner[] = []
  let current: unknown = fiber._debugOwner
  while (isObject(current) && owners.length < MAX_OWNERS) {
    if (isFiber(current)) {
      // The owner pointer can name the retired copy; Fast Refresh puts the new function on the live one.
      const live = owners.length === 0 ? currentFiber(current) : current
      const owner: ReactOwner = { name: nameOf(live.type), kind: 'client' }
      const stack = stackOf(current._debugStack)
      if (stack !== undefined) owner.stack = stack
      // Only the nearest owner's function can contain the JSX call that made the element.
      if (owners.length === 0) {
        const sites = jsxSitesOf(live.type)
        const wanted = allSites ? sites : sites?.filter((site) => site.host && site.type === tag)
        if (wanted && wanted.length > 0) owner.jsxSites = wanted
      }
      owners.push(owner)
      current = current._debugOwner
    } else {
      const info = current as ServerComponentInfo
      const owner: ReactOwner = { name: typeof info.name === 'string' ? info.name : 'Anonymous', kind: 'server' }
      if (typeof info.env === 'string') owner.env = info.env
      const stack = stackOf(info.debugStack)
      if (stack !== undefined) owner.stack = stack
      const location = stackOf(info.debugLocation)
      if (location !== undefined) owner.location = location
      owners.push(owner)
      current = info.owner
    }
  }
  return owners
}

export function collectReact(element: Element): ReactEvidence | undefined {
  let fiber = fiberOf(element)
  let hostFiber = fiber !== undefined && fiber.stateNode === element
  // Content React did not create (dangerouslySetInnerHTML, a widget's own DOM): use the
  // nearest element React did create, and say so.
  for (let ancestor = element.parentElement; !fiber && ancestor; ancestor = ancestor.parentElement) {
    fiber = fiberOf(ancestor)
    hostFiber = false
  }
  if (!fiber) return undefined
  fiber = currentFiber(fiber)

  const latest = stackOf(latestElementOf(fiber)?._debugStack)
  const stack = latest ?? stackOf(fiber._debugStack)
  const state = stackState(stack)
  const evidence: ReactEvidence = {
    hostFiber,
    stackState: state,
    ownerRoot: fiber.return !== null && isFiber(fiber._debugOwner) && (fiber.return === fiber._debugOwner || fiber.return === fiber._debugOwner.alternate),
    owners: ownersOf(fiber, element.localName, state !== 'captured'),
  }
  if (stack !== undefined) {
    evidence.stack = stack
    evidence.stackFrom = latest !== undefined ? 'element' : 'fiber'
  }

  const source = fiber._debugSource
  if (isObject(source) && typeof source.fileName === 'string' && typeof source.lineNumber === 'number') {
    evidence.debugSource = { fileName: source.fileName, lineNumber: source.lineNumber }
    if (typeof source.columnNumber === 'number') evidence.debugSource.columnNumber = source.columnNumber
  }

  const renderer = renderers().find((entry) => typeof entry.version === 'string')
  if (renderer) {
    evidence.version = renderer.version as string
    if (typeof renderer.bundleType === 'number') evidence.bundleType = renderer.bundleType
  }
  return evidence
}
