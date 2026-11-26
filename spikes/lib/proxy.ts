import type { IncomingMessage } from 'node:http'
import { build } from 'esbuild'
import type { WebSocket } from 'ws'
import {
  createProxy,
  WS_OPCODE,
  type CspMode,
  type FrameDirection,
  type ProxyAsset,
  type ProxyLogLevel,
  type ProxyOptions,
  type ProxyServer,
} from '../../packages/server/src/index.ts'
import { onCleanup } from './proc.ts'
import { waitFor, type WaitOptions } from './wait.ts'

/**
 * The primp proxy in front of a fixture, with everything it observes recorded:
 * every WebSocket message of every tunnelled upgrade (the dev server's HMR
 * socket) and every log line of the proxy.
 */

export interface BundleOptions {
  minify?: boolean
  /** esbuild `define` replacements, for build-time constants. */
  define?: Record<string, string>
}

/** Bundles a TypeScript (or JavaScript) browser entry file into one IIFE script. */
export async function bundleBrowser(entryFile: string, options: BundleOptions = {}): Promise<string> {
  const result = await build({
    entryPoints: [entryFile],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    minify: options.minify ?? false,
    define: options.define,
    write: false,
    logLevel: 'silent',
  })
  const output = result.outputFiles[0]
  if (output === undefined) throw new Error(`esbuild produced no output for ${entryFile}`)
  return output.text
}

/** A script injected at the start of `<head>`: give either a TypeScript `entry` to bundle or ready `code`. */
export interface HeadScript {
  /** File name below `/__primp/`, for example `hook.js`. */
  name: string
  entry?: string
  code?: string
  minify?: boolean
  define?: Record<string, string>
}

export type FrameKind = 'text' | 'binary' | 'close' | 'ping' | 'pong' | 'other'

export interface RecordedFrame {
  /** `performance.now()` when the proxy saw the whole message. */
  t: number
  direction: FrameDirection
  /** Unique per upgrade tunnel. */
  tunnelId: number
  /** Request target of the upgrade, with query string. */
  path: string
  opcode: number
  kind: FrameKind
  /** Payload size in bytes. */
  bytes: number
  /** Text payload, cut to `maxFrameText` characters. */
  text?: string
  /** The `type` field when the text payload is a JSON object that has one (a string). */
  jsonType?: string
  /** The `event` field when the text payload is a JSON object that has one (Next's browser-to-server messages). */
  jsonEvent?: string
  /** Whether the whole text payload parsed as JSON. Undefined for non-text messages. */
  isJson?: boolean
}

export interface FrameSummary {
  total: number
  tunnels: { id: number; path: string }[]
  byDirection: Record<FrameDirection, number>
  byKind: Partial<Record<FrameKind, number>>
  /** Count per JSON `type`, upstream to client. */
  serverTypes: Record<string, number>
  /** Count per JSON `type`, client to upstream. */
  clientTypes: Record<string, number>
  /** Count per JSON `event`, client to upstream. */
  clientEvents: Record<string, number>
  /** Text messages that were not JSON. */
  nonJsonText: number
}

export interface ProxyLogEntry {
  level: ProxyLogLevel
  message: string
  detail?: unknown
}

export interface StartProxyOptions {
  headScripts?: HeadScript[]
  /** More assets below `/__primp/`, by path. */
  assets?: Record<string, ProxyAsset>
  cspMode?: CspMode
  /** Receives the overlay's own WebSocket connections (upgrades under `/__primp/`). */
  onWebSocket?: (socket: WebSocket, request: IncomingMessage) => void
  /** Characters of each text frame kept in `frames[].text`. Default 4000. */
  maxFrameText?: number
  /** Anything else for `createProxy`; wins over what the harness sets. */
  proxy?: Partial<ProxyOptions>
}

export interface ProxyHandle {
  port: number
  /** `http://localhost:<port>` */
  url: string
  /** Every WebSocket message seen on tunnelled upgrades, in arrival order. Grows while the proxy runs. */
  frames: RecordedFrame[]
  /** The proxy's own log lines (warnings about CSP, upstream errors, ...). */
  logs: ProxyLogEntry[]
  /** Counts of `frames` from index `from` on (default: all). */
  frameSummary(from?: number): FrameSummary
  /** Resolves with the first frame at index `from` or later that matches. */
  waitForFrame(match: (frame: RecordedFrame) => boolean, options?: WaitOptions & { from?: number }): Promise<RecordedFrame>
  server: ProxyServer
  close(): Promise<void>
}

const KIND_BY_OPCODE = new Map<number, FrameKind>([
  [WS_OPCODE.text, 'text'],
  [WS_OPCODE.binary, 'binary'],
  [WS_OPCODE.close, 'close'],
  [WS_OPCODE.ping, 'ping'],
  [WS_OPCODE.pong, 'pong'],
])

function summarise(frames: RecordedFrame[]): FrameSummary {
  const summary: FrameSummary = {
    total: frames.length,
    tunnels: [],
    byDirection: { 'client-to-upstream': 0, 'upstream-to-client': 0 },
    byKind: {},
    serverTypes: {},
    clientTypes: {},
    clientEvents: {},
    nonJsonText: 0,
  }
  const seen = new Set<number>()
  for (const frame of frames) {
    if (!seen.has(frame.tunnelId)) {
      seen.add(frame.tunnelId)
      summary.tunnels.push({ id: frame.tunnelId, path: frame.path })
    }
    summary.byDirection[frame.direction] += 1
    summary.byKind[frame.kind] = (summary.byKind[frame.kind] ?? 0) + 1
    if (frame.kind !== 'text') continue
    if (frame.isJson !== true) summary.nonJsonText += 1
    if (frame.jsonEvent !== undefined && frame.direction === 'client-to-upstream') {
      summary.clientEvents[frame.jsonEvent] = (summary.clientEvents[frame.jsonEvent] ?? 0) + 1
    }
    if (frame.jsonType === undefined) continue
    const types = frame.direction === 'upstream-to-client' ? summary.serverTypes : summary.clientTypes
    types[frame.jsonType] = (types[frame.jsonType] ?? 0) + 1
  }
  return summary
}

/** Starts the proxy in front of `target` (a fixture handle, or anything with a `port` on localhost). */
export async function startProxy(target: { port: number }, options: StartProxyOptions = {}): Promise<ProxyHandle> {
  const assets = new Map<string, ProxyAsset>(Object.entries(options.assets ?? {}))
  const headScripts: string[] = []
  for (const script of options.headScripts ?? []) {
    let body = script.code
    if (body === undefined) {
      if (script.entry === undefined) throw new Error(`head script ${script.name} needs "entry" or "code"`)
      body = await bundleBrowser(script.entry, { minify: script.minify, define: script.define })
    }
    assets.set(script.name, { body, contentType: 'text/javascript; charset=utf-8' })
    headScripts.push(script.name)
  }

  const frames: RecordedFrame[] = []
  const logs: ProxyLogEntry[] = []
  const maxFrameText = options.maxFrameText ?? 4000
  const server = await createProxy({
    target: { protocol: 'http', host: 'localhost', port: target.port },
    listen: { host: 'localhost', port: 0 },
    assets,
    headScripts,
    cspMode: options.cspMode,
    onWebSocket: options.onWebSocket,
    onUpgradeFrame(direction, info, message) {
      const frame: RecordedFrame = {
        t: performance.now(),
        direction,
        tunnelId: info.id,
        path: info.path,
        opcode: message.opcode,
        kind: KIND_BY_OPCODE.get(message.opcode) ?? 'other',
        bytes: message.data.length,
      }
      if (message.text !== undefined) {
        frame.text = message.text.length > maxFrameText ? message.text.slice(0, maxFrameText) : message.text
        try {
          const parsed: unknown = JSON.parse(message.text)
          frame.isJson = true
          const fields = typeof parsed === 'object' && parsed !== null ? (parsed as { type?: unknown; event?: unknown }) : {}
          if (typeof fields.type === 'string') frame.jsonType = fields.type
          if (typeof fields.event === 'string') frame.jsonEvent = fields.event
        } catch {
          frame.isJson = false
        }
      }
      frames.push(frame)
    },
    log: (level, message, detail) => logs.push({ level, message, detail }),
    ...options.proxy,
  })

  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    closing ??= server.close().then(() => {
      removeCleanup()
    })
    return closing
  }
  const removeCleanup = onCleanup(close)

  return {
    port: server.port,
    url: server.url,
    frames,
    logs,
    frameSummary: (from = 0) => summarise(frames.slice(from)),
    waitForFrame(match, waitOptions = {}) {
      const from = waitOptions.from ?? 0
      return waitFor(() => frames.slice(from).find(match), { what: 'a matching WebSocket frame', ...waitOptions })
    },
    server,
    close,
  }
}
