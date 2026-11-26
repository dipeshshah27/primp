import type { FrameDirection, TunnelInfo } from './tunnel.ts'
import { WS_OPCODE, type WsMessage } from './ws-frames.ts'

/**
 * HMR tee: reads the dev server's hot-update socket as it passes through the
 * proxy tunnel and turns what it understands into one small event stream.
 *
 * The tee only ever reads. It is fed the messages `createProxy` hands to
 * `onUpgradeFrame` and never throws, whatever the bytes are: a message it does
 * not understand is counted and dropped.
 *
 * Understood dialects (payloads checked against the installed packages and
 * against frames recorded from the fixtures, see `test/fixtures/hmr-*.json`):
 *
 *   Vite 8 (also SvelteKit, which uses Vite's socket unchanged)
 *     socket    subprotocol `vite-hmr`, path = the configured base
 *     server    connected | update | bundled-dev-update | full-reload | error |
 *               prune | custom | ping          (vite/types/hmrPayload.d.ts)
 *     browser   custom (for example `vite:invalidate`), ping
 *
 *   Next 16.4 with Turbopack (and the webpack dialect's shared message names)
 *     socket    path `/_next/hmr` (older: `/_next/webpack-hmr`)
 *     server    JSON keyed by `type`: building | built | sync | turbopack-message |
 *               serverComponentChanges | reloadPage | serverError | addedPage |
 *               removedPage | staticParamsChanged | serverOnlyChanges | isrManifest |
 *               turbopack-connected | ... (next/dist/server/dev/hot-reloader-types)
 *               and BINARY messages whose first byte is the type:
 *               0 = React debug chunk, 1 = serialized errors for the console
 *     browser   JSON keyed by `event`, not `type`: client-success | client-error |
 *               client-hmr-latency | server-component-reload-page |
 *               client-reload-page | client-full-reload | browser-logs | ping | ...
 *               and JSON keyed by `type`: turbopack-subscribe | turbopack-unsubscribe
 *
 * What the events mean, and what they do not:
 *   building     the dev server started compiling
 *   updated      the server sent an update to the browser (no flag), or the browser
 *                said something about one (Next only): `applied: true` when it reports
 *                a finished hot update (`client-hmr-latency`), `refetch: true` when it
 *                starts refetching the server-rendered tree
 *                (`server-component-reload-page`). Sent is not applied: Vite's browser
 *                still has to fetch the module, and a Next server-component change is
 *                on the page only when that refetch has finished, which no HMR message
 *                reports (measured: `client-hmr-latency` comes before it).
 *   full-reload  the browser was told to reload, or said that it will
 *   error        the build is broken; the tee stays in the error state until a
 *                later message says otherwise
 *   idle         the server reports a finished build with no errors, or a browser
 *                (re)connected
 */

export type HmrFramework = 'vite' | 'next' | 'unknown'
export type HmrEventKind = 'building' | 'updated' | 'full-reload' | 'error' | 'idle'

export interface HmrError {
  /** Error text without ANSI colour codes. */
  message: string
  /** File the error points at, as the dev server names it. */
  file?: string
  line?: number
  column?: number
  /** Code frame, when the dev server sent one separately. */
  frame?: string
  plugin?: string
}

export interface HmrEventDetail {
  /** The message's own name: `type` for server messages, `event` for Next browser messages. */
  message: string
  direction: FrameDirection
  /** Modules or chunks the message names (updated, full-reload). */
  paths?: string[]
  /** The update touches a stylesheet. */
  css?: boolean
  /** Vite: the largest `timestamp` of the updates in the message. The browser fetches `<module>?t=<timestamp>`. */
  timestamp?: number
  /** Next: the server-rendered tree changed; the browser refetches it after this message. */
  server?: boolean
  /** The browser reports that it applied the update (Next `client-hmr-latency`). */
  applied?: boolean
  /** The browser reports that it starts refetching the server-rendered tree (Next `server-component-reload-page`). */
  refetch?: boolean
  /** Present on `error`. */
  errors?: HmrError[]
  /** Free-form note, for example the file that triggered a full reload. */
  reason?: string
}

export interface HmrEvent {
  kind: HmrEventKind
  framework: HmrFramework
  /** Milliseconds since the epoch when the tee saw the message. */
  at: number
  /** Proxy tunnel the message travelled on. */
  tunnelId: number
  detail: HmrEventDetail
}

export interface HmrTeeStatus {
  /**
   * True while the tee has not recognised a single HMR message. A settle
   * detector must then not read anything into the absence of HMR events: the
   * dev server may use a socket the proxy does not carry (another port), a
   * dialect the tee does not know, or no hot reload at all.
   */
  blind: boolean
  /** A recognised HMR socket is open right now, so silence on it means "no update was sent". */
  live: boolean
  /** Framework of the most recent recognised message. */
  framework: HmrFramework
  /** Recognised HMR sockets that have not been closed. */
  openTunnels: number
  /** Every WebSocket message shown to the tee, on any tunnel. */
  messages: number
  /** Messages the tee recognised as part of an HMR dialect (whether or not they produced an event). */
  recognised: number
  /** Messages it did not recognise (unknown sockets, unknown types, unparseable text). */
  unrecognised: number
  /** Epoch ms of the last recognised message. */
  lastMessageAt: number | undefined
  /** The dev server said it is compiling and has not yet said it finished. */
  building: boolean
  /** The current build error, if the last word from the dev server was an error. */
  error: HmrError[] | undefined
  /** Vite only: URL path of the browser's HMR client module, derived from the socket's base. */
  viteClientPath: string | undefined
  /** Count per message label, `framework direction name` (for example `next server built`). */
  types: Record<string, number>
}

export interface HmrTee {
  /** Pass this as `onUpgradeFrame` to `createProxy`. Never throws. */
  onFrame(direction: FrameDirection, tunnel: TunnelInfo, message: WsMessage): void
  /**
   * Tells the tee that a tunnel's connection ended. A socket that closes
   * properly is noticed through its close frame; this is for the ones that
   * just drop (dev server killed, tab crashed), which `onFrame` never sees.
   * The proxy does not call it, so `live` can stay true after such a drop.
   */
  onTunnelClose(tunnelId: number): void
  /** Calls `listener` for every event. Returns the function that removes it. */
  subscribe(listener: (event: HmrEvent) => void): () => void
  status(): HmrTeeStatus
}

export interface HmrTeeOptions {
  /** Clock in epoch milliseconds. Default `epochNow`. */
  now?: () => number
}

/** Milliseconds since the epoch with sub-millisecond resolution; the default clock of the tee and the settle detector. */
export function epochNow(): number {
  return performance.timeOrigin + performance.now()
}

/** What one message means, before the tee adds time and tunnel. */
export interface HmrInterpretation {
  framework: HmrFramework
  /** Message name used for counting, for example `update` or `client-hmr-latency` or `binary:react-debug-chunk`. */
  name: string
  /** Absent when the message is recognised but says nothing about updates. */
  event?: { kind: HmrEventKind; detail: HmrEventDetail }
  /** The HMR socket is closing. */
  closes?: boolean
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const VITE_SERVER_TYPES = new Set([
  'connected',
  'update',
  'bundled-dev-update',
  'full-reload',
  'error',
  'prune',
  'custom',
  'ping',
])

/** Server-to-browser `type` values of Next's hot reloader (HMR_MESSAGE_SENT_TO_BROWSER). */
const NEXT_SERVER_TYPES = new Set([
  'addedPage',
  'removedPage',
  'reloadPage',
  'serverComponentChanges',
  'staticParamsChanged',
  'middlewareChanges',
  'clientChanges',
  'serverOnlyChanges',
  'sync',
  'built',
  'building',
  'devPagesManifestUpdate',
  'turbopack-message',
  'serverError',
  'turbopack-connected',
  'isrManifest',
  'cacheIndicator',
  'devIndicator',
  'devtoolsConfig',
  'vulnerabilityInsight',
  'requestCurrentErrorState',
  'runtimeErrors',
  'requestPageMetadata',
  'requestInsightsUpdate',
])

const NEXT_BINARY_NAMES: Record<number, string> = {
  0: 'binary:react-debug-chunk',
  1: 'binary:errors-to-show-in-browser',
}

/** Which dialect a tunnel speaks, from its handshake alone. */
export function frameworkOfTunnel(tunnel: TunnelInfo): HmrFramework {
  if (tunnel.protocols.includes('vite-hmr')) return 'vite'
  const path = tunnel.path.split('?', 1)[0] ?? ''
  if (/\/_next\/(?:hmr|webpack-hmr)$/.test(path)) return 'next'
  return 'unknown'
}

/** Which dialect a server message belongs to, from its shape. Used when the handshake did not say. */
function frameworkOfServerMessage(payload: Json): HmrFramework {
  const type = asString(payload.type)
  if (type === undefined) return 'unknown'
  // `connected` is Vite's first message; Next's first messages are in NEXT_SERVER_TYPES only.
  if (type === 'connected') return 'vite'
  if (NEXT_SERVER_TYPES.has(type) && !VITE_SERVER_TYPES.has(type)) return 'next'
  return 'unknown'
}

/** `<file>.<ext>:<line>:<column>` inside an error message. */
const VITE_MESSAGE_LOCATION = /(?:^|[\s[(])((?:[A-Za-z]:)?[^\s:[\]()]+\.[A-Za-z0-9]+):(\d+):(\d+)/

function viteError(err: unknown): HmrError {
  if (!isObject(err)) return { message: 'unknown error' }
  const loc = isObject(err.loc) ? err.loc : undefined
  const error: HmrError = { message: stripAnsi(asString(err.message) ?? 'unknown error') }
  const file = asString(loc?.file) ?? asString(err.id)
  if (file !== undefined) error.file = file
  const line = asNumber(loc?.line)
  if (line !== undefined) error.line = line
  const column = asNumber(loc?.column)
  if (column !== undefined) error.column = column
  if (loc === undefined) {
    // Vite 8's own transform (Oxc) sends no `loc`; the position is only in the message, as
    // `[ src/components/Hero.tsx:5:41 ]`. It is taken when it names the same file as `id`.
    const inMessage = VITE_MESSAGE_LOCATION.exec(error.message)
    if (inMessage !== null && (error.file === undefined || error.file.replace(/\\/g, '/').endsWith(inMessage[1] as string))) {
      error.file ??= inMessage[1] as string
      error.line = Number(inMessage[2])
      error.column = Number(inMessage[3])
    }
  }
  const frame = asString(err.frame)
  if (frame !== undefined && frame !== '') error.frame = stripAnsi(frame)
  const plugin = asString(err.plugin)
  if (plugin !== undefined) error.plugin = plugin
  return error
}

function interpretViteServer(payload: Json, direction: FrameDirection): HmrInterpretation {
  const type = asString(payload.type) ?? ''
  const base: HmrInterpretation = { framework: 'vite', name: type }
  switch (type) {
    case 'connected':
      return { ...base, event: { kind: 'idle', detail: { message: type, direction } } }
    case 'update': {
      const updates = Array.isArray(payload.updates) ? payload.updates.filter(isObject) : []
      const paths = updates.map((update) => asString(update.acceptedPath) ?? asString(update.path) ?? '').filter(Boolean)
      const timestamps = updates.map((update) => asNumber(update.timestamp)).filter((value) => value !== undefined)
      const detail: HmrEventDetail = {
        message: type,
        direction,
        paths,
        css: updates.some((update) => update.type === 'css-update' || /\.(?:css|scss|sass|less|styl|pcss)(?:$|\?)/.test(asString(update.path) ?? '')),
      }
      if (timestamps.length > 0) detail.timestamp = Math.max(...timestamps)
      return { ...base, event: { kind: 'updated', detail } }
    }
    case 'bundled-dev-update': {
      const ids = Array.isArray(payload.changedIds) ? payload.changedIds.filter((id) => typeof id === 'string') : []
      return { ...base, event: { kind: 'updated', detail: { message: type, direction, paths: ids } } }
    }
    case 'full-reload': {
      // With `ifFallback` only Vite's own bundling-fallback page reloads; ordinary pages ignore it.
      if (payload.ifFallback === true) return base
      const detail: HmrEventDetail = { message: type, direction }
      const path = asString(payload.path)
      if (path !== undefined) detail.paths = [path]
      const triggeredBy = asString(payload.triggeredBy)
      if (triggeredBy !== undefined) detail.reason = triggeredBy
      return { ...base, event: { kind: 'full-reload', detail } }
    }
    case 'error':
      return { ...base, event: { kind: 'error', detail: { message: type, direction, errors: [viteError(payload.err)] } } }
    case 'custom':
      return { ...base, name: `custom:${asString(payload.event) ?? '?'}` }
    default:
      // prune, ping: part of the dialect, nothing to report.
      return base
  }
}

/** `./app/page.tsx:12:5\nError: ...` is how Turbopack starts a compilation error message. */
const NEXT_ERROR_HEAD = /^(\.{0,2}\/?[^\n:]+):(\d+):(\d+)\n/

function nextCompilationErrors(errors: unknown): HmrError[] {
  if (!Array.isArray(errors)) return []
  const result: HmrError[] = []
  for (const entry of errors) {
    const text = typeof entry === 'string' ? entry : isObject(entry) ? asString(entry.message) : undefined
    if (text === undefined) continue
    const message = stripAnsi(text)
    const error: HmrError = { message }
    const head = NEXT_ERROR_HEAD.exec(message)
    const moduleName = isObject(entry) ? asString(entry.moduleName) : undefined
    if (head !== null) {
      error.file = head[1] as string
      error.line = Number(head[2])
      error.column = Number(head[3])
    } else if (moduleName !== undefined) {
      error.file = moduleName
    }
    result.push(error)
  }
  return result
}

interface TurbopackSummary {
  /** At least one item carries an update instruction for the browser. */
  update: boolean
  /** At least one item tells the browser it cannot patch and must reload. */
  reload: boolean
  paths: string[]
  css: boolean
}

function summariseTurbopack(data: unknown): TurbopackSummary {
  const summary: TurbopackSummary = { update: false, reload: false, paths: [], css: false }
  const items = Array.isArray(data) ? data : [data]
  for (const item of items) {
    if (!isObject(item)) continue
    const type = asString(item.type)
    if (type === 'restart' || type === 'notFound') {
      summary.reload = true
      continue
    }
    if (type !== 'partial' && type !== 'total') continue
    summary.update = true
    const instruction = isObject(item.instruction) ? item.instruction : undefined
    if (instruction === undefined) continue
    if (isObject(instruction.chunks)) {
      for (const chunk of Object.keys(instruction.chunks)) {
        summary.paths.push(chunk)
        if (chunk.endsWith('.css')) summary.css = true
      }
    }
    if (Array.isArray(instruction.merged)) {
      for (const merged of instruction.merged) {
        if (!isObject(merged)) continue
        if (isObject(merged.entries)) summary.paths.push(...Object.keys(merged.entries))
        if (isObject(merged.chunks)) summary.paths.push(...Object.keys(merged.chunks))
      }
    }
  }
  return summary
}

function interpretNextServer(payload: Json, direction: FrameDirection): HmrInterpretation {
  const type = asString(payload.type) ?? ''
  const base: HmrInterpretation = { framework: 'next', name: type }
  switch (type) {
    case 'building':
      return { ...base, event: { kind: 'building', detail: { message: type, direction } } }
    case 'built':
    case 'sync': {
      const errors = nextCompilationErrors(payload.errors)
      if (errors.length > 0) return { ...base, event: { kind: 'error', detail: { message: type, direction, errors } } }
      const detail: HmrEventDetail = { message: type, direction }
      if (Array.isArray(payload.updatedModules)) {
        detail.paths = payload.updatedModules.filter((value) => typeof value === 'string')
      }
      return { ...base, event: { kind: 'idle', detail } }
    }
    case 'turbopack-message': {
      const summary = summariseTurbopack(payload.data)
      if (summary.reload) {
        return { ...base, event: { kind: 'full-reload', detail: { message: type, direction, reason: 'turbopack restart' } } }
      }
      // Items of type `issues` carry diagnostics only; the `built` message that follows has the errors.
      if (!summary.update) return base
      return { ...base, event: { kind: 'updated', detail: { message: type, direction, paths: summary.paths, css: summary.css } } }
    }
    case 'serverComponentChanges':
    case 'staticParamsChanged':
    case 'addedPage':
    case 'removedPage':
    case 'serverOnlyChanges':
      // The browser answers each of these by refetching the server-rendered tree.
      return { ...base, event: { kind: 'updated', detail: { message: type, direction, server: true } } }
    case 'reloadPage':
      return { ...base, event: { kind: 'full-reload', detail: { message: type, direction } } }
    case 'serverError': {
      const parsed = parseJson(asString(payload.errorJSON))
      const message = isObject(parsed) ? asString(parsed.message) : undefined
      const error: HmrError = { message: stripAnsi(message ?? 'server error') }
      return { ...base, event: { kind: 'error', detail: { message: type, direction, errors: [error] } } }
    }
    default:
      // isrManifest, turbopack-connected, devIndicator, middlewareChanges, clientChanges, ...
      return base
  }
}

function interpretNextBrowser(payload: Json, direction: FrameDirection): HmrInterpretation | undefined {
  const event = asString(payload.event)
  if (event === undefined) {
    const type = asString(payload.type)
    // turbopack-subscribe / turbopack-unsubscribe
    return type === undefined ? undefined : { framework: 'next', name: type }
  }
  const base: HmrInterpretation = { framework: 'next', name: event }
  switch (event) {
    case 'client-hmr-latency': {
      const detail: HmrEventDetail = { message: event, direction, applied: true }
      if (Array.isArray(payload.updatedModules)) {
        detail.paths = payload.updatedModules.filter((value) => typeof value === 'string')
      }
      return { ...base, event: { kind: 'updated', detail } }
    }
    case 'server-component-reload-page':
      // Sent just before the router refetches (or, on a page that is in an error state, reloads).
      return { ...base, event: { kind: 'updated', detail: { message: event, direction, server: true, refetch: true } } }
    case 'client-reload-page':
    case 'client-full-reload':
      return { ...base, event: { kind: 'full-reload', detail: { message: event, direction } } }
    default:
      // client-success, client-error, client-warning, browser-logs, ping, ...
      // `client-error` only echoes the `built` message the server just sent; the errors are taken from there.
      return base
  }
}

/**
 * Interprets one WebSocket message of a tunnelled upgrade. Returns `undefined`
 * for anything that is not recognisably HMR traffic. `known` is the dialect
 * already established for this tunnel, if any. Never throws.
 */
export function interpretHmrMessage(
  direction: FrameDirection,
  tunnel: TunnelInfo,
  message: WsMessage,
  known: HmrFramework = 'unknown',
): HmrInterpretation | undefined {
  try {
    let framework = known === 'unknown' ? frameworkOfTunnel(tunnel) : known
    if (message.opcode === WS_OPCODE.close) {
      return framework === 'unknown' ? undefined : { framework, name: 'close', closes: true }
    }
    if (message.opcode === WS_OPCODE.binary) {
      // Only Next sends binary HMR messages; the first byte is the message type.
      if (framework !== 'next' || direction !== 'upstream-to-client') return undefined
      const type = message.data.length > 0 ? message.data[0] : undefined
      const name = (type !== undefined ? NEXT_BINARY_NAMES[type] : undefined) ?? 'binary:unknown'
      return { framework, name }
    }
    if (message.opcode !== WS_OPCODE.text) return undefined
    const payload = parseJson(message.text)
    if (!isObject(payload)) return undefined
    if (framework === 'unknown' && direction === 'upstream-to-client') framework = frameworkOfServerMessage(payload)
    if (framework === 'vite') {
      // The browser side of Vite's socket speaks the same payload shape (custom, ping).
      const type = asString(payload.type)
      if (type === undefined || !VITE_SERVER_TYPES.has(type)) return undefined
      if (direction === 'client-to-upstream') {
        return { framework, name: type === 'custom' ? `custom:${asString(payload.event) ?? '?'}` : type }
      }
      return interpretViteServer(payload, direction)
    }
    if (framework === 'next') {
      if (direction === 'client-to-upstream') return interpretNextBrowser(payload, direction)
      const type = asString(payload.type)
      if (type === undefined || !NEXT_SERVER_TYPES.has(type)) return undefined
      return interpretNextServer(payload, direction)
    }
    return undefined
  } catch {
    return undefined
  }
}

interface TunnelState {
  framework: HmrFramework
  open: boolean
}

/** Tunnels remembered at most; older ones are forgotten (a tunnel is one page load). */
const MAX_TUNNELS = 256

export function createHmrTee(options: HmrTeeOptions = {}): HmrTee {
  const now = options.now ?? epochNow
  const listeners = new Set<(event: HmrEvent) => void>()
  const tunnels = new Map<number, TunnelState>()
  const types: Record<string, number> = {}
  let messages = 0
  let recognised = 0
  let lastMessageAt: number | undefined
  let framework: HmrFramework = 'unknown'
  let building = false
  let error: HmrError[] | undefined
  let viteClientPath: string | undefined

  const emit = (event: HmrEvent): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event)
      } catch {
        // A listener's failure must not reach the proxy's data path.
      }
    }
  }

  const applyToState = (source: HmrFramework, kind: HmrEventKind, detail: HmrEventDetail): void => {
    switch (kind) {
      case 'building':
        building = true
        break
      case 'error':
        building = false
        error = detail.errors ?? [{ message: 'unknown error' }]
        break
      case 'idle':
        building = false
        error = undefined
        break
      case 'full-reload':
        error = undefined
        break
      case 'updated':
        // Vite sends `update` first and the error only after the browser asked for the broken
        // module, so an update clears the error and a failing module sets it again. Next says
        // whether the build is healthy in `built`, which the cases above handle.
        if (source === 'vite' && detail.direction === 'upstream-to-client') error = undefined
        break
    }
  }

  return {
    onFrame(direction, tunnel, message) {
      try {
        messages += 1
        const state = tunnels.get(tunnel.id)
        const interpreted = interpretHmrMessage(direction, tunnel, message, state?.framework)
        if (interpreted === undefined) return
        recognised += 1
        lastMessageAt = now()
        framework = interpreted.framework
        const label = `${interpreted.framework} ${direction === 'upstream-to-client' ? 'server' : 'browser'} ${interpreted.name}`
        types[label] = (types[label] ?? 0) + 1

        if (state === undefined) {
          if (tunnels.size >= MAX_TUNNELS) {
            const oldest = tunnels.keys().next().value
            if (oldest !== undefined) tunnels.delete(oldest)
          }
          tunnels.set(tunnel.id, { framework: interpreted.framework, open: interpreted.closes !== true })
          if (interpreted.framework === 'vite') {
            const base = tunnel.path.split('?', 1)[0] ?? '/'
            viteClientPath = `${base.endsWith('/') ? base : `${base}/`}@vite/client`
          }
        } else if (interpreted.closes === true) {
          state.open = false
        }
        // A build announced on a socket that is gone will never be reported finished on it.
        if (interpreted.closes === true && ![...tunnels.values()].some((entry) => entry.open)) building = false

        if (interpreted.event === undefined) return
        applyToState(interpreted.framework, interpreted.event.kind, interpreted.event.detail)
        emit({
          kind: interpreted.event.kind,
          framework: interpreted.framework,
          at: lastMessageAt,
          tunnelId: tunnel.id,
          detail: interpreted.event.detail,
        })
      } catch {
        // Never let an interpretation problem disturb the tunnel.
      }
    },
    onTunnelClose(tunnelId) {
      const state = tunnels.get(tunnelId)
      if (state === undefined || !state.open) return
      state.open = false
      if (![...tunnels.values()].some((entry) => entry.open)) building = false
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    status() {
      let openTunnels = 0
      for (const state of tunnels.values()) if (state.open) openTunnels += 1
      return {
        blind: recognised === 0,
        live: openTunnels > 0,
        framework,
        openTunnels,
        messages,
        recognised,
        unrecognised: messages - recognised,
        lastMessageAt,
        building,
        error,
        viteClientPath,
        types: { ...types },
      }
    },
  }
}
