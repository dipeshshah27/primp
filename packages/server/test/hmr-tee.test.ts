import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  createHmrTee,
  frameworkOfTunnel,
  interpretHmrMessage,
  stripAnsi,
  type HmrEvent,
  type HmrTee,
} from '../src/hmr-tee.ts'
import type { FrameDirection, TunnelInfo } from '../src/tunnel.ts'
import { WS_OPCODE, type WsMessage } from '../src/ws-frames.ts'

/**
 * The recordings under `fixtures/` are real: `pnpm spike:s4 -- --record` wrote
 * them from the Vite 8.3.8, SvelteKit 3.4 and Next 16.4.6 fixture dev servers
 * through the proxy tunnel. Long strings inside the JSON are cut and binary
 * payloads are cut to 96 bytes; nothing else is changed.
 */

interface RecordedFrame {
  step: string
  direction: FrameDirection
  tunnel: TunnelInfo
  opcode: number
  bytes: number
  text?: string
  base64?: string
}

function recording(name: string): RecordedFrame[] {
  const file = new URL(`./fixtures/hmr-${name}.json`, import.meta.url)
  return (JSON.parse(readFileSync(file, 'utf8')) as { frames: RecordedFrame[] }).frames
}

function toMessage(frame: RecordedFrame): WsMessage {
  if (frame.text !== undefined) return { opcode: frame.opcode, data: Buffer.from(frame.text), text: frame.text }
  return { opcode: frame.opcode, data: Buffer.from(frame.base64 ?? '', 'base64') }
}

interface Replay {
  tee: HmrTee
  events: (HmrEvent & { step: string })[]
  /** Events of one step, as `kind:message` with `!` for browser messages. */
  of(step: string): string[]
}

/** Feeds frames to a tee whose clock advances 10 ms per frame. */
function replay(frames: RecordedFrame[], onFrame?: (frame: RecordedFrame, tee: HmrTee) => void): Replay {
  let clock = 1_000
  const tee = createHmrTee({ now: () => clock })
  const events: Replay['events'] = []
  let step = ''
  tee.subscribe((event) => events.push({ ...event, step }))
  for (const frame of frames) {
    clock += 10
    step = frame.step
    tee.onFrame(frame.direction, frame.tunnel, toMessage(frame))
    onFrame?.(frame, tee)
  }
  return {
    tee,
    events,
    of: (name) =>
      events
        .filter((event) => event.step === name)
        .map((event) => `${event.kind}:${event.detail.message}${event.detail.direction === 'client-to-upstream' ? '!' : ''}`),
  }
}

const VITE_TUNNEL: TunnelInfo = { id: 1, path: '/?token=abc', protocols: ['vite-hmr'] }
const NEXT_TUNNEL: TunnelInfo = { id: 2, path: '/_next/hmr?id=abc', protocols: [] }
const OTHER_TUNNEL: TunnelInfo = { id: 3, path: '/socket', protocols: [] }

const text = (value: unknown): WsMessage => {
  const body = typeof value === 'string' ? value : JSON.stringify(value)
  return { opcode: WS_OPCODE.text, data: Buffer.from(body), text: body }
}
const binary = (...bytes: number[]): WsMessage => ({ opcode: WS_OPCODE.binary, data: Buffer.from(bytes) })
const close = (): WsMessage => ({ opcode: WS_OPCODE.close, data: Buffer.from([0x03, 0xe9]) })
const SERVER: FrameDirection = 'upstream-to-client'
const BROWSER: FrameDirection = 'client-to-upstream'

describe('recorded Vite 8 frames (vite-react-19)', () => {
  const frames = recording('vite')

  it('recognises every message and is not blind', () => {
    const { tee } = replay(frames)
    const status = tee.status()
    expect(status).toMatchObject({ blind: false, live: true, framework: 'vite', openTunnels: 1, unrecognised: 0, viteClientPath: '/@vite/client' })
    expect(status.messages).toBe(frames.length)
    // Counted independently of the tee, from the JSON of the recording.
    const expected: Record<string, number> = {}
    for (const frame of frames) {
      const label = `vite server ${(JSON.parse(frame.text ?? '{}') as { type: string }).type}`
      expected[label] = (expected[label] ?? 0) + 1
    }
    expect(Object.keys(expected).sort()).toEqual(['vite server connected', 'vite server error', 'vite server update'])
    expect(status.types).toEqual(expected)
  })

  it('reports the connection as idle and each edit as one update', () => {
    const run = replay(frames)
    expect(run.of('initial')).toEqual(['idle:connected'])
    const edits = [...new Set(frames.map((frame) => frame.step))].filter((step) => step.startsWith('edit '))
    expect(edits).toHaveLength(10)
    for (const step of edits) expect(run.of(step), step).toEqual(['updated:update'])
  })

  it('carries the modules, the stylesheet flag and the timestamp the browser will fetch with', () => {
    const run = replay(frames)
    const event = run.events.find((entry) => entry.step === 'edit (text): hero title text')
    expect(event).toMatchObject({ kind: 'updated', framework: 'vite', tunnelId: 1 })
    expect(event?.detail).toMatchObject({
      message: 'update',
      direction: 'upstream-to-client',
      // Tailwind rebuilds index.css whenever a scanned file changes.
      paths: ['/src/index.css', '/src/components/Hero.tsx'],
      css: true,
    })
    const recorded = JSON.parse(frames.find((frame) => frame.step === 'edit (text): hero title text')?.text ?? '{}') as {
      updates: { timestamp: number }[]
    }
    expect(event?.detail.timestamp).toBe(recorded.updates[0]?.timestamp)
    expect(event?.at).toBeGreaterThan(1_000)
  })

  it('reports the syntax error with file, line and column, holds the error state, and clears it on the next update', () => {
    const errorStates: boolean[] = []
    const run = replay(
      frames.filter((frame) => frame.step === 'initial' || frame.step === 'syntax-error'),
      (_frame, tee) => errorStates.push(tee.status().error !== undefined),
    )
    expect(run.of('syntax-error')).toEqual(['updated:update', 'error:error', 'updated:update', 'updated:update'])
    const error = run.events.find((event) => event.kind === 'error')?.detail.errors?.[0]
    expect(error?.message).toContain('Unexpected token')
    // The fixture's machine paths were replaced by /project when it was recorded.
    expect(error).toMatchObject({ file: '/project/src/components/Hero.tsx', line: 5, column: 41, plugin: 'vite:oxc' })
    // connected, update (broken file announced), error, update (fix), update
    expect(errorStates).toEqual([false, false, true, false, false])
  })
})

describe('recorded SvelteKit frames (Vite socket)', () => {
  const frames = recording('sveltekit')

  it('is the Vite dialect: updates for component and scoped-style edits, an error with a location', () => {
    const run = replay(frames)
    expect(run.tee.status()).toMatchObject({ blind: false, framework: 'vite', unrecognised: 0 })
    expect(run.of('edit (Svelte component text): hero call-to-action text')).toEqual(['updated:update'])
    const style = run.events.find((event) => event.step === 'edit (Svelte scoped style): hero lede font size')
    expect(style?.detail).toMatchObject({ css: true, paths: ['/src/lib/components/Hero.svelte?svelte&type=style&lang.css'] })
    expect(run.of('syntax-error')).toEqual(['error:error', 'updated:update', 'updated:update'])
    const error = run.events.find((event) => event.kind === 'error')?.detail.errors?.[0]
    expect(error).toMatchObject({ file: 'Hero.svelte', line: 9, column: 0, plugin: 'vite-plugin-svelte:compile' })
    expect(error?.message).toContain('attempted to close an element that was not open')
    expect(error?.frame).toContain('</sectio>')
  })
})

describe('recorded Next 16.4 Turbopack frames (next-16-turbopack)', () => {
  const frames = recording('next')

  it('recognises every message, JSON and binary, in both directions', () => {
    const { tee } = replay(frames)
    const status = tee.status()
    expect(status).toMatchObject({ blind: false, live: true, framework: 'next', unrecognised: 0, viteClientPath: undefined })
    expect(status.messages).toBe(frames.length)
    const binaries = frames.filter((frame) => frame.opcode === WS_OPCODE.binary).length
    expect(binaries).toBeGreaterThan(10)
    expect(status.types['next server binary:react-debug-chunk']).toBe(binaries)
    for (const label of [
      'next server building',
      'next server built',
      'next server sync',
      'next server turbopack-message',
      'next server serverComponentChanges',
      'next server isrManifest',
      'next server turbopack-connected',
      'next browser client-success',
      'next browser client-hmr-latency',
      'next browser server-component-reload-page',
      'next browser turbopack-subscribe',
      'next browser browser-logs',
      'next browser client-error',
    ]) {
      expect(status.types[label], label).toBeGreaterThan(0)
    }
  })

  it('binary frames and bookkeeping messages produce no event', () => {
    const run = replay(frames)
    expect(run.of('initial')).toEqual(['idle:built', 'idle:sync'])
    expect(run.events.every((event) => event.framework === 'next')).toBe(true)
  })

  it('client component edit: building, update with the module, built, then the browser reports it applied', () => {
    const run = replay(frames)
    const step = 'edit (client component text): counter reset text'
    expect(run.of(step)).toEqual(['building:building', 'updated:turbopack-message', 'idle:built', 'updated:client-hmr-latency!'])
    const [, sent, , applied] = run.events.filter((event) => event.step === step)
    expect(sent?.detail.paths?.[0]).toContain('components/client/Counter.tsx')
    expect(sent?.detail).toMatchObject({ direction: 'upstream-to-client', css: false })
    expect(sent?.detail.applied).toBeUndefined()
    expect(applied?.detail).toMatchObject({ direction: 'client-to-upstream', applied: true })
    expect(applied?.detail.paths?.[0]).toContain('components/client/Counter.tsx')
  })

  it('stylesheet edit: the update names a .css chunk', () => {
    const run = replay(frames)
    const sent = run.events.find((event) => event.step === 'edit (CSS file): radius variable in globals.css' && event.detail.message === 'turbopack-message')
    expect(sent?.detail.css).toBe(true)
    expect(sent?.detail.paths?.[0]).toMatch(/globals.*\.css$/)
  })

  it('server component edit: a server update, then the browser announces its refetch', () => {
    const run = replay(frames)
    const step = 'edit (server component text): page title text'
    expect(run.of(step)).toEqual(['updated:serverComponentChanges', 'idle:built', 'updated:server-component-reload-page!', 'idle:built'])
    const events = run.events.filter((event) => event.step === step)
    expect(events[0]?.detail).toMatchObject({ server: true, direction: 'upstream-to-client' })
    expect(events[0]?.detail.refetch).toBeUndefined()
    expect(events[2]?.detail).toMatchObject({ server: true, refetch: true, direction: 'client-to-upstream' })
  })

  it('syntax errors: `built` with errors is an error with file, line and column and no colour codes; the next clean `built` clears it', () => {
    const states: (string | undefined)[] = []
    const run = replay(frames, (frame, tee) => {
      if (frame.step === 'syntax-error') states.push(tee.status().error?.[0]?.file)
    })
    const errors = run.events.filter((event) => event.kind === 'error')
    expect(errors.length).toBeGreaterThanOrEqual(2)
    const client = errors[0]?.detail.errors?.[0]
    expect(client).toMatchObject({ file: './.tmp/run/next-16-turbopack/components/client/Counter.tsx', line: 6, column: 16 })
    expect(client?.message).toContain('Expression expected')
    // eslint-disable-next-line no-control-regex
    expect(client?.message).not.toMatch(/\u001b\[/)
    const server = errors.find((event) => event.detail.errors?.[0]?.file?.endsWith('StatsPanel.tsx'))?.detail.errors?.[0]
    expect(server).toMatchObject({ line: 4, column: 16 })
    // Error state while broken, none at the end of the episode.
    expect(states).toContain('./.tmp/run/next-16-turbopack/components/client/Counter.tsx')
    expect(states.at(-1)).toBeUndefined()
    expect(run.tee.status()).toMatchObject({ error: undefined, building: false })
  })

  it('is building between `building` and `built`', () => {
    const building: boolean[] = []
    replay(
      frames.filter((frame) => frame.step === 'initial' || frame.step === 'edit (client component text): counter reset text'),
      (frame, tee) => {
        if (frame.step !== 'initial') building.push(tee.status().building)
      },
    )
    // building, turbopack-message, built, client-success, client-hmr-latency
    expect(building).toEqual([true, true, false, false, false])
  })
})

describe('blind detection', () => {
  it('is blind before any traffic and stays blind on sockets it does not know', () => {
    const tee = createHmrTee()
    expect(tee.status()).toMatchObject({ blind: true, live: false, framework: 'unknown', messages: 0, recognised: 0 })
    const events: HmrEvent[] = []
    tee.subscribe((event) => events.push(event))
    tee.onFrame(SERVER, OTHER_TUNNEL, text({ op: 'hello' }))
    tee.onFrame(SERVER, OTHER_TUNNEL, text('ping'))
    tee.onFrame(BROWSER, OTHER_TUNNEL, text({ type: 'subscribe', channel: 'prices' }))
    tee.onFrame(SERVER, OTHER_TUNNEL, binary(1, 2, 3))
    tee.onFrame(SERVER, OTHER_TUNNEL, close())
    expect(tee.status()).toMatchObject({ blind: true, live: false, messages: 5, recognised: 0, unrecognised: 5, lastMessageAt: undefined })
    expect(events).toEqual([])
  })

  it('stops being blind with the first recognised message, and is live until the socket closes', () => {
    const tee = createHmrTee()
    tee.onFrame(SERVER, VITE_TUNNEL, text({ type: 'connected' }))
    expect(tee.status()).toMatchObject({ blind: false, live: true, openTunnels: 1 })
    tee.onFrame(BROWSER, VITE_TUNNEL, close())
    expect(tee.status()).toMatchObject({ blind: false, live: false, openTunnels: 0 })
  })

  it('counts each page load as a tunnel of its own', () => {
    const tee = createHmrTee()
    tee.onFrame(SERVER, { ...NEXT_TUNNEL, id: 10 }, text({ type: 'sync', errors: [], warnings: [], hash: '' }))
    tee.onFrame(SERVER, { ...NEXT_TUNNEL, id: 11 }, text({ type: 'sync', errors: [], warnings: [], hash: '' }))
    expect(tee.status().openTunnels).toBe(2)
    tee.onFrame(BROWSER, { ...NEXT_TUNNEL, id: 10 }, close())
    expect(tee.status()).toMatchObject({ openTunnels: 1, live: true })
  })

  it('a tunnel reported as dropped (no close frame) is no longer live; unknown ids are ignored', () => {
    const tee = createHmrTee()
    tee.onFrame(SERVER, NEXT_TUNNEL, text({ type: 'building' }))
    tee.onTunnelClose(999)
    expect(tee.status()).toMatchObject({ live: true, building: true, openTunnels: 1 })
    tee.onTunnelClose(NEXT_TUNNEL.id)
    tee.onTunnelClose(NEXT_TUNNEL.id)
    expect(tee.status()).toMatchObject({ live: false, building: false, openTunnels: 0, blind: false })
  })

  it('forgets a build that was announced on a socket that then closed', () => {
    const tee = createHmrTee()
    tee.onFrame(SERVER, NEXT_TUNNEL, text({ type: 'building' }))
    expect(tee.status().building).toBe(true)
    tee.onFrame(BROWSER, NEXT_TUNNEL, close())
    expect(tee.status().building).toBe(false)
  })
})

describe('dialect recognition', () => {
  it('goes by the handshake: subprotocol for Vite, path for Next', () => {
    expect(frameworkOfTunnel(VITE_TUNNEL)).toBe('vite')
    expect(frameworkOfTunnel({ id: 1, path: '/app/', protocols: ['vite-hmr'] })).toBe('vite')
    expect(frameworkOfTunnel(NEXT_TUNNEL)).toBe('next')
    expect(frameworkOfTunnel({ id: 1, path: '/base/_next/webpack-hmr', protocols: [] })).toBe('next')
    expect(frameworkOfTunnel({ id: 1, path: '/_next/hmr-other', protocols: [] })).toBe('unknown')
    expect(frameworkOfTunnel(OTHER_TUNNEL)).toBe('unknown')
  })

  it("derives the URL of Vite's client module from the socket's base path", () => {
    const tee = createHmrTee()
    tee.onFrame(SERVER, { id: 1, path: '/app/?token=t', protocols: ['vite-hmr'] }, text({ type: 'connected' }))
    expect(tee.status().viteClientPath).toBe('/app/@vite/client')
  })

  it('falls back to the shape of the first server message when the handshake says nothing', () => {
    const vite = interpretHmrMessage(SERVER, OTHER_TUNNEL, text({ type: 'connected' }))
    expect(vite).toMatchObject({ framework: 'vite', name: 'connected' })
    const next = interpretHmrMessage(SERVER, OTHER_TUNNEL, text({ type: 'turbopack-connected', data: {} }))
    expect(next).toMatchObject({ framework: 'next', name: 'turbopack-connected' })
    // `error` and `update` alone could be anybody's.
    expect(interpretHmrMessage(SERVER, OTHER_TUNNEL, text({ type: 'error', err: { message: 'x' } }))).toBeUndefined()
  })

  it('keeps the dialect of a tunnel once it is known', () => {
    const tee = createHmrTee()
    const events: HmrEvent[] = []
    tee.subscribe((event) => events.push(event))
    tee.onFrame(SERVER, OTHER_TUNNEL, text({ type: 'connected' }))
    tee.onFrame(SERVER, OTHER_TUNNEL, text({ type: 'update', updates: [{ type: 'js-update', path: '/a.ts', acceptedPath: '/a.ts', timestamp: 5 }] }))
    expect(events.map((event) => `${event.framework} ${event.kind}`)).toEqual(['vite idle', 'vite updated'])
  })
})

describe('Vite messages', () => {
  const interpret = (payload: unknown) => interpretHmrMessage(SERVER, VITE_TUNNEL, text(payload))

  it('update: accepted paths, largest timestamp, css-update', () => {
    const result = interpret({
      type: 'update',
      updates: [
        { type: 'js-update', path: '/src/App.tsx', acceptedPath: '/src/App.tsx', timestamp: 100 },
        { type: 'css-update', path: '/src/site.css', acceptedPath: '/src/site.css', timestamp: 250 },
      ],
    })
    expect(result?.event).toEqual({
      kind: 'updated',
      detail: { message: 'update', direction: SERVER, paths: ['/src/App.tsx', '/src/site.css'], css: true, timestamp: 250 },
    })
  })

  it('update with nothing usable in it is still an update, with no timestamp', () => {
    expect(interpret({ type: 'update' })?.event).toEqual({ kind: 'updated', detail: { message: 'update', direction: SERVER, paths: [], css: false } })
    expect(interpret({ type: 'update', updates: [null, 3, 'x'] })?.event?.kind).toBe('updated')
  })

  it('bundled-dev-update (full-bundle mode): changed ids', () => {
    expect(interpret({ type: 'bundled-dev-update', changedIds: ['/src/a.ts', 7], url: '/@vite/hmr/1.js', seq: 1 })?.event).toEqual({
      kind: 'updated',
      detail: { message: 'bundled-dev-update', direction: SERVER, paths: ['/src/a.ts'] },
    })
  })

  it('full-reload: with path and trigger; ignored when only the fallback page should act', () => {
    expect(interpret({ type: 'full-reload', path: '/index.html', triggeredBy: '/project/vite.config.ts' })?.event).toEqual({
      kind: 'full-reload',
      detail: { message: 'full-reload', direction: SERVER, paths: ['/index.html'], reason: '/project/vite.config.ts' },
    })
    expect(interpret({ type: 'full-reload' })?.event?.kind).toBe('full-reload')
    const fallback = interpret({ type: 'full-reload', ifFallback: true })
    expect(fallback).toEqual({ framework: 'vite', name: 'full-reload' })
  })

  it('error: location from `loc`, else from the message when it names the same file as `id`', () => {
    const withLoc = interpret({
      type: 'error',
      err: { message: '\u001b[31mboom\u001b[0m', stack: '', id: '/p/src/a.ts', loc: { file: '/p/src/a.ts', line: 3, column: 7 }, frame: '> 3 | x', plugin: 'vite:esbuild' },
    })
    expect(withLoc?.event?.detail.errors).toEqual([{ message: 'boom', file: '/p/src/a.ts', line: 3, column: 7, frame: '> 3 | x', plugin: 'vite:esbuild' }])
    const fromMessage = interpret({ type: 'error', err: { message: 'Unexpected token\n   [ src/a.ts:12:4 ]', stack: '', id: '/p/src/a.ts' } })
    expect(fromMessage?.event?.detail.errors?.[0]).toMatchObject({ file: '/p/src/a.ts', line: 12, column: 4 })
    const otherFile = interpret({ type: 'error', err: { message: 'see node_modules/x/y.js:1:2', stack: '', id: '/p/src/a.ts' } })
    expect(otherFile?.event?.detail.errors?.[0]).toEqual({ message: 'see node_modules/x/y.js:1:2', file: '/p/src/a.ts' })
    expect(interpret({ type: 'error' })?.event?.detail.errors).toEqual([{ message: 'unknown error' }])
  })

  it('custom, prune and ping are part of the dialect but say nothing about updates', () => {
    expect(interpret({ type: 'custom', event: 'vite:beforeFullReload', data: {} })).toEqual({ framework: 'vite', name: 'custom:vite:beforeFullReload' })
    expect(interpret({ type: 'prune', paths: ['/src/old.css'] })).toEqual({ framework: 'vite', name: 'prune' })
    expect(interpret({ type: 'ping' })).toEqual({ framework: 'vite', name: 'ping' })
    expect(interpretHmrMessage(BROWSER, VITE_TUNNEL, text({ type: 'custom', event: 'vite:invalidate', data: {} }))).toEqual({
      framework: 'vite',
      name: 'custom:vite:invalidate',
    })
    expect(interpretHmrMessage(BROWSER, VITE_TUNNEL, text({ type: 'ping' }))).toEqual({ framework: 'vite', name: 'ping' })
  })

  it('an update clears the error state; the error returns when the module fails again', () => {
    const tee = createHmrTee()
    tee.onFrame(SERVER, VITE_TUNNEL, text({ type: 'connected' }))
    tee.onFrame(SERVER, VITE_TUNNEL, text({ type: 'error', err: { message: 'bad', stack: '' } }))
    expect(tee.status().error).toEqual([{ message: 'bad' }])
    tee.onFrame(SERVER, VITE_TUNNEL, text({ type: 'update', updates: [] }))
    expect(tee.status().error).toBeUndefined()
    tee.onFrame(SERVER, VITE_TUNNEL, text({ type: 'error', err: { message: 'still bad', stack: '' } }))
    expect(tee.status().error).toEqual([{ message: 'still bad' }])
    tee.onFrame(SERVER, VITE_TUNNEL, text({ type: 'full-reload' }))
    expect(tee.status().error).toBeUndefined()
  })
})

describe('Next messages', () => {
  const server = (payload: unknown) => interpretHmrMessage(SERVER, NEXT_TUNNEL, text(payload))
  const browser = (payload: unknown) => interpretHmrMessage(BROWSER, NEXT_TUNNEL, text(payload))

  it('sync with errors (page loaded while the build is broken) is an error', () => {
    const result = server({ type: 'sync', hash: '', warnings: [], errors: [{ message: './app/page.tsx:3:9\nError: Expression expected' }] })
    expect(result?.event).toEqual({
      kind: 'error',
      detail: { message: 'sync', direction: SERVER, errors: [{ message: './app/page.tsx:3:9\nError: Expression expected', file: './app/page.tsx', line: 3, column: 9 }] },
    })
  })

  it('errors as strings or with a module name (webpack dialect) are understood', () => {
    expect(server({ type: 'built', errors: ['plain text error'] })?.event?.detail.errors).toEqual([{ message: 'plain text error' }])
    expect(server({ type: 'built', errors: [{ message: 'Module not found', moduleName: './app/x.tsx' }] })?.event?.detail.errors).toEqual([
      { message: 'Module not found', file: './app/x.tsx' },
    ])
    expect(server({ type: 'built', errors: [42, null, {}] })?.event?.kind).toBe('idle')
  })

  it('turbopack-message: issues only is no event; restart and notFound mean a reload', () => {
    expect(server({ type: 'turbopack-message', data: [{ type: 'issues', issues: [] }] })).toEqual({ framework: 'next', name: 'turbopack-message' })
    expect(server({ type: 'turbopack-message', data: { type: 'restart' } })?.event?.kind).toBe('full-reload')
    expect(server({ type: 'turbopack-message', data: [{ type: 'notFound' }] })?.event?.kind).toBe('full-reload')
    expect(server({ type: 'turbopack-message', data: [{ type: 'partial' }] })?.event).toEqual({
      kind: 'updated',
      detail: { message: 'turbopack-message', direction: SERVER, paths: [], css: false },
    })
    expect(server({ type: 'turbopack-message' })).toEqual({ framework: 'next', name: 'turbopack-message' })
  })

  it('reloadPage and the browser saying it reloads are full reloads', () => {
    expect(server({ type: 'reloadPage', data: 'x' })?.event).toEqual({ kind: 'full-reload', detail: { message: 'reloadPage', direction: SERVER } })
    expect(browser({ event: 'client-full-reload', stackTrace: '', hadRuntimeError: false })?.event?.kind).toBe('full-reload')
    expect(browser({ event: 'client-reload-page', clientId: 1 })?.event?.kind).toBe('full-reload')
  })

  it('serverError carries the message of its JSON', () => {
    expect(server({ type: 'serverError', errorJSON: JSON.stringify({ message: 'boom', stack: 's' }) })?.event?.detail.errors).toEqual([{ message: 'boom' }])
    expect(server({ type: 'serverError', errorJSON: 'not json' })?.event?.detail.errors).toEqual([{ message: 'server error' }])
  })

  it('pages-router server changes are server updates', () => {
    for (const type of ['serverOnlyChanges', 'addedPage', 'removedPage', 'staticParamsChanged']) {
      expect(server({ type })?.event, type).toEqual({ kind: 'updated', detail: { message: type, direction: SERVER, server: true } })
    }
  })

  it('browser messages are keyed by `event`; those without meaning for settle produce no event', () => {
    expect(browser({ event: 'client-success', clientId: 1 })).toEqual({ framework: 'next', name: 'client-success' })
    expect(browser({ event: 'ping', tree: {} })).toEqual({ framework: 'next', name: 'ping' })
    expect(browser({ event: 'some-future-event' })).toEqual({ framework: 'next', name: 'some-future-event' })
    expect(browser({ type: 'turbopack-subscribe', path: 'x' })).toEqual({ framework: 'next', name: 'turbopack-subscribe' })
    expect(browser({ neither: true })).toBeUndefined()
  })

  it('binary: type from the first byte, never an event; binary from the browser is not HMR', () => {
    expect(interpretHmrMessage(SERVER, NEXT_TUNNEL, binary(0, 1, 2))).toEqual({ framework: 'next', name: 'binary:react-debug-chunk' })
    expect(interpretHmrMessage(SERVER, NEXT_TUNNEL, binary(1, 9))).toEqual({ framework: 'next', name: 'binary:errors-to-show-in-browser' })
    expect(interpretHmrMessage(SERVER, NEXT_TUNNEL, binary(77))).toEqual({ framework: 'next', name: 'binary:unknown' })
    expect(interpretHmrMessage(SERVER, NEXT_TUNNEL, binary())).toEqual({ framework: 'next', name: 'binary:unknown' })
    expect(interpretHmrMessage(BROWSER, NEXT_TUNNEL, binary(0))).toBeUndefined()
    expect(interpretHmrMessage(SERVER, VITE_TUNNEL, binary(0))).toBeUndefined()
  })

  it('unknown server types are not recognised (so a future message cannot be mistaken for a known one)', () => {
    expect(server({ type: 'somethingNew' })).toBeUndefined()
    expect(server({ type: 42 })).toBeUndefined()
  })
})

describe('robustness', () => {
  const garbage: WsMessage[] = [
    text(''),
    text('not json'),
    text('{"type":'),
    text('null'),
    text('[]'),
    text('[{"type":"update"}]'),
    text('"update"'),
    text('12'),
    text({ type: null }),
    text({ type: { nested: true } }),
    text({ type: 'update', updates: 'nope' }),
    text({ type: 'update', updates: [{ timestamp: 'soon', path: 5 }] }),
    text({ type: 'error', err: 'a string' }),
    text({ type: 'error', err: { message: 5, loc: 'here' } }),
    text({ type: 'built', errors: 'none' }),
    text({ type: 'built', errors: [{ message: { deep: 1 } }] }),
    text({ type: 'turbopack-message', data: [null, 1, 'x', { type: 'partial', instruction: { chunks: 3, merged: [null, { entries: 9 }] } }] }),
    text({ event: 'client-hmr-latency', updatedModules: 'x' }),
    text({ event: 5 }),
    { opcode: WS_OPCODE.text, data: Buffer.from('no text field') },
    { opcode: WS_OPCODE.binary, data: Buffer.alloc(0) },
    { opcode: WS_OPCODE.ping, data: Buffer.alloc(0) },
    { opcode: WS_OPCODE.pong, data: Buffer.from('x') },
    { opcode: 0x7, data: Buffer.from('reserved opcode') },
    { opcode: WS_OPCODE.close, data: Buffer.alloc(0) },
  ]

  it('never throws, whatever the message, tunnel or direction', () => {
    const tee = createHmrTee()
    for (const tunnel of [VITE_TUNNEL, NEXT_TUNNEL, OTHER_TUNNEL, { id: 9, path: '', protocols: [] }]) {
      for (const direction of [SERVER, BROWSER]) {
        for (const message of garbage) {
          expect(() => tee.onFrame(direction, tunnel, message)).not.toThrow()
          expect(() => interpretHmrMessage(direction, tunnel, message)).not.toThrow()
        }
      }
    }
    expect(tee.status().messages).toBe(garbage.length * 8)
  })

  it('never throws on random bytes', () => {
    const tee = createHmrTee()
    let seed = 42
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 0x1_0000_0000
    }
    for (let round = 0; round < 500; round += 1) {
      const data = Buffer.from(Array.from({ length: Math.floor(random() * 64) }, () => Math.floor(random() * 256)))
      const asText = data.toString('utf8')
      const message: WsMessage = random() < 0.5 ? { opcode: WS_OPCODE.binary, data } : { opcode: WS_OPCODE.text, data, text: asText }
      const tunnel = [VITE_TUNNEL, NEXT_TUNNEL, OTHER_TUNNEL][round % 3] as TunnelInfo
      expect(() => tee.onFrame(round % 2 === 0 ? SERVER : BROWSER, tunnel, message)).not.toThrow()
    }
    expect(tee.status().messages).toBe(500)
  })

  it('a listener that throws does not stop the tee or the other listeners', () => {
    const tee = createHmrTee()
    const seen: string[] = []
    tee.subscribe(() => {
      throw new Error('listener bug')
    })
    const unsubscribe = tee.subscribe((event) => seen.push(event.kind))
    expect(() => tee.onFrame(SERVER, VITE_TUNNEL, text({ type: 'connected' }))).not.toThrow()
    tee.onFrame(SERVER, VITE_TUNNEL, text({ type: 'full-reload' }))
    expect(seen).toEqual(['idle', 'full-reload'])
    unsubscribe()
    tee.onFrame(SERVER, VITE_TUNNEL, text({ type: 'full-reload' }))
    expect(seen).toHaveLength(2)
  })

  it('stamps events with the clock it was given', () => {
    let clock = 5_000
    const tee = createHmrTee({ now: () => clock })
    const events: HmrEvent[] = []
    tee.subscribe((event) => events.push(event))
    tee.onFrame(SERVER, NEXT_TUNNEL, text({ type: 'building' }))
    clock = 5_250
    tee.onFrame(SERVER, NEXT_TUNNEL, text({ type: 'built', errors: [], warnings: [], hash: '1' }))
    expect(events.map((event) => event.at)).toEqual([5_000, 5_250])
    expect(tee.status().lastMessageAt).toBe(5_250)
  })

  it('strips ANSI colour codes', () => {
    expect(stripAnsi('\u001b[31m\u001b[1m>\u001b[0m 6 | const')).toBe('> 6 | const')
  })
})
