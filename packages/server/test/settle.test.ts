import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHmrTee, type HmrTee } from '../src/hmr-tee.ts'
import {
  createSettleDetector,
  startWatcherWithFallback,
  type SettleClientMessage,
  type SettleClientState,
  type SettleDetector,
  type SettleOverlayReport,
  type SettleResult,
  type SettleServerMessage,
  type SettleWatcher,
} from '../src/settle.ts'
import type { FrameDirection, TunnelInfo } from '../src/tunnel.ts'
import { WS_OPCODE } from '../src/ws-frames.ts'

/**
 * The detector with its three inputs scripted: a fake file watcher, a real HMR
 * tee fed with messages, and a fake page that speaks the settle client's
 * protocol. Time is vitest's fake clock; the page's clock runs 7.5 s ahead of
 * the server's, which must make no difference.
 */

const START = 1_750_000_000_000
const SKEW = 7_500
const PROJECT = '/project'
const VITE: TunnelInfo = { id: 1, path: '/?token=t', protocols: ['vite-hmr'] }
const NEXT: TunnelInfo = { id: 2, path: '/_next/hmr?id=1', protocols: [] }
const SERVER: FrameDirection = 'upstream-to-client'
const BROWSER: FrameDirection = 'client-to-upstream'

class FakePage {
  readonly sent: SettleServerMessage[] = []
  mutations = 0
  lastMutationAt: number | null = null
  pendingSheets = 0
  readyState: DocumentReadyState = 'complete'
  overlay: SettleOverlayReport | null = null
  vite: { pending: number; applied: number } | undefined
  /** A page that answers nothing (frozen tab, busy main thread). */
  responsive = true
  /** How long a message waits before the page's script sees it. */
  deliveryDelayMs = 0
  /** Extra time before a probe's drain timer fires (background tab). */
  timerDelayMs = 0
  /** Page clock of the `load` event; null while the document is still loading. */
  loadedAt: number | null
  private readonly listeners: { message: ((data: unknown) => void)[]; close: (() => void)[] } = { message: [], close: [] }
  private readonly timeOrigin: number

  /** By default a document that was opened a minute ago and has long finished loading. */
  constructor(
    readonly doc = 'doc-1',
    ageMs = 60_000,
  ) {
    this.timeOrigin = this.now() - ageMs
    this.loadedAt = ageMs > 0 ? this.timeOrigin + 50 : null
  }

  now(): number {
    return Date.now() + SKEW
  }

  // --- the socket as the detector sees it ---
  send(data: string): void {
    const message = JSON.parse(data) as SettleServerMessage
    this.sent.push(message)
    if (message.type !== 'settle:probe' || !this.responsive) return
    setTimeout(() => {
      const receivedAt = this.now()
      const reply = (): void => this.emit({ type: 'settle:state', doc: this.doc, id: message.id, state: this.state(receivedAt) })
      if (message.drainMs <= 0) reply()
      else setTimeout(reply, message.drainMs + this.timerDelayMs)
    }, this.deliveryDelayMs)
  }

  on(event: 'message' | 'close' | 'error', listener: (data?: unknown) => void): void {
    if (event === 'message') this.listeners.message.push(listener)
    if (event === 'close') this.listeners.close.push(listener as () => void)
  }

  // --- what the page does ---
  hello(): this {
    this.emit({ type: 'settle:hello', doc: this.doc, url: 'http://localhost/', timeOrigin: this.timeOrigin, at: this.now() })
    return this
  }

  mutate(): void {
    this.mutations += 1
    this.lastMutationAt = this.now()
    this.emit({ type: 'settle:mutation', doc: this.doc, seq: this.mutations, at: this.lastMutationAt })
  }

  event(name: Extract<SettleClientMessage, { type: 'settle:event' }>['name'], detail?: string | number, at = this.now()): void {
    const message: SettleClientMessage = { type: 'settle:event', doc: this.doc, name, at }
    if (detail !== undefined) message.detail = detail
    this.emit(message)
  }

  viteApplied(timestamp: number): void {
    this.vite = { pending: 0, applied: timestamp }
    this.event('vite-applied', timestamp)
  }

  close(): void {
    for (const listener of this.listeners.close) listener()
  }

  probes(): number {
    return this.sent.filter((message) => message.type === 'settle:probe').length
  }

  private state(receivedAt: number): SettleClientState {
    const state: SettleClientState = {
      receivedAt,
      now: this.now(),
      mutations: this.mutations,
      lastMutationAt: this.lastMutationAt,
      pendingSheets: this.pendingSheets,
      readyState: this.readyState,
      loadedAt: this.loadedAt,
      visibility: 'visible',
      overlay: this.overlay,
    }
    if (this.vite !== undefined) state.vite = { ...this.vite }
    return state
  }

  private emit(message: SettleClientMessage): void {
    const data = JSON.stringify(message)
    for (const listener of this.listeners.message) listener(data)
  }
}

interface Rig {
  detector: SettleDetector
  tee: HmrTee
  /** Reports a file change; its mtime is the current time unless given. */
  write(path: string, mtimeMs?: number): void
  failWatcher(error: unknown): void
  hmr(direction: FrameDirection, tunnel: TunnelInfo, payload: unknown): void
  connect(doc?: string): Promise<FakePage>
}

function createRig(options: { hmr?: boolean; watcher?: boolean } = {}): Rig {
  const tee = createHmrTee({ now: () => Date.now() })
  let emit: ((event: string, path: string, mtimeMs?: number) => void) | undefined
  let fail: ((error: unknown) => void) | undefined
  const detector = createSettleDetector({
    projectDir: PROJECT,
    now: () => Date.now(),
    ...(options.hmr === false ? {} : { hmr: tee }),
    ...(options.watcher === false
      ? { projectDir: undefined }
      : {
          watcher: (onEvent, onError) => {
            emit = onEvent
            fail = onError
            return { ready: Promise.resolve(), close: async () => {} }
          },
        }),
  })
  return {
    detector,
    tee,
    write: (path, mtimeMs) => emit?.('change', `${PROJECT}/${path}`, mtimeMs ?? Date.now()),
    failWatcher: (error) => fail?.(error),
    hmr(direction, tunnel, payload) {
      const body = JSON.stringify(payload)
      tee.onFrame(direction, tunnel, { opcode: WS_OPCODE.text, data: Buffer.from(body), text: body })
    },
    async connect(doc) {
      const page = new FakePage(doc)
      detector.attachBrowser(page)
      page.hello()
      // The calibration probe of the hello.
      await vi.advanceTimersByTimeAsync(5)
      return page
    },
  }
}

/** Runs `script` steps at their times (ms from now) while a wait is pending; returns the result and when it came. */
async function waitWith(
  detector: SettleDetector,
  options: { since?: number; timeoutMs?: number },
  script: [atMs: number, step: () => void][] = [],
): Promise<{ result: SettleResult; afterMs: number }> {
  const began = Date.now()
  for (const [at, step] of script) setTimeout(step, at)
  let result: SettleResult | undefined
  void detector.waitForSettle({ since: options.since ?? began, timeoutMs: options.timeoutMs ?? 5000 }).then((value) => {
    result = value
  })
  for (let elapsed = 0; elapsed < 20_000 && result === undefined; elapsed += 1) await vi.advanceTimersByTimeAsync(1)
  if (result === undefined) throw new Error('waitForSettle did not resolve within 20 s of fake time')
  return { result, afterMs: Date.now() - began }
}

const viteUpdate = (timestamp: number, path = '/src/App.tsx') => ({
  type: 'update',
  updates: [{ type: 'js-update', path, acceptedPath: path, timestamp }],
})

let rig: Rig

beforeEach(() => {
  vi.useFakeTimers({ now: START })
})

afterEach(async () => {
  await rig?.detector.close()
  vi.useRealTimers()
})

describe('no-op', () => {
  it('returns no_update_observed at the timeout, not earlier, and not settled', async () => {
    rig = createRig()
    rig.hmr(SERVER, VITE, { type: 'connected' })
    await rig.connect()
    const { result, afterMs } = await waitWith(rig.detector, { timeoutMs: 1500 })
    expect(result).toMatchObject({ status: 'no_update_observed', signal: 'timeout', filesChanged: [], domChanged: false, browser: true })
    expect(afterMs).toBeGreaterThanOrEqual(1500)
    expect(afterMs).toBeLessThan(1520)
    expect(result.ms).toBeGreaterThanOrEqual(1500)
  })

  it('page mutations and an idle HMR socket do not make it settled', async () => {
    rig = createRig()
    rig.hmr(SERVER, VITE, { type: 'connected' })
    const page = await rig.connect()
    const { result } = await waitWith(rig.detector, { timeoutMs: 1000 }, [
      [100, () => page.mutate()],
      [400, () => page.mutate()],
      [500, () => rig.hmr(SERVER, VITE, { type: 'ping' })],
    ])
    expect(result.status).toBe('no_update_observed')
  })
})

describe('Vite update', () => {
  it("settles after Vite's client reports the update and the page has been quiet, never before", async () => {
    rig = createRig()
    rig.hmr(SERVER, VITE, { type: 'connected' })
    const page = await rig.connect()
    page.vite = { pending: 0, applied: 0 }
    page.event('vite-hooked')
    const { result, afterMs } = await waitWith(rig.detector, {}, [
      [10, () => rig.write('src/App.tsx')],
      [110, () => rig.hmr(SERVER, VITE, viteUpdate(4242))],
      // The browser fetches the module for 600 ms: nothing may be concluded meanwhile.
      [710, () => page.viteApplied(4242)],
      [726, () => page.mutate()],
    ])
    expect(result).toMatchObject({ status: 'settled', signal: 'hmr', filesChanged: ['src/App.tsx'], domChanged: true, browser: true, visibility: 'visible' })
    expect(result.reason).toContain("Vite's client reported the update applied")
    // 100 ms of quiet after the mutation at +726, plus probe round trips.
    expect(afterMs).toBeGreaterThanOrEqual(826)
    expect(afterMs).toBeLessThan(950)
  })

  it('tells the page where Vite client module is, once per document', async () => {
    rig = createRig()
    rig.hmr(SERVER, { ...VITE, path: '/base/?token=t' }, { type: 'connected' })
    const page = await rig.connect()
    rig.hmr(SERVER, { ...VITE, path: '/base/?token=t' }, viteUpdate(1))
    expect(page.sent.filter((message) => message.type === 'settle:vite')).toEqual([{ type: 'settle:vite', clientPath: '/base/@vite/client' }])
  })

  it('reports every file once, in order of first change, with forward slashes', async () => {
    rig = createRig()
    rig.hmr(SERVER, VITE, { type: 'connected' })
    const page = await rig.connect()
    page.vite = { pending: 0, applied: 0 }
    page.event('vite-hooked')
    const { result } = await waitWith(rig.detector, {}, [
      [10, () => rig.write('src/b.css')],
      [12, () => rig.write('src/a.tsx')],
      [14, () => rig.write('src/b.css')],
      [60, () => rig.hmr(SERVER, VITE, viteUpdate(9))],
      [90, () => page.viteApplied(9)],
    ])
    expect(result.filesChanged).toEqual(['src/b.css', 'src/a.tsx'])
  })

  it('is not settled while the page still loads a stylesheet', async () => {
    rig = createRig()
    rig.hmr(SERVER, VITE, { type: 'connected' })
    const page = await rig.connect()
    page.vite = { pending: 0, applied: 0 }
    page.event('vite-hooked')
    const { result, afterMs } = await waitWith(rig.detector, {}, [
      [10, () => rig.write('src/site.css')],
      [50, () => rig.hmr(SERVER, VITE, viteUpdate(7, '/src/site.css'))],
      [
        80,
        () => {
          page.pendingSheets = 1
          page.viteApplied(7)
          page.mutate()
        },
      ],
      [
        900,
        () => {
          page.pendingSheets = 0
          page.event('sheet-loaded')
        },
      ],
    ])
    expect(result.status).toBe('settled')
    expect(afterMs).toBeGreaterThanOrEqual(900)
  })
})

describe('edit before wait', () => {
  it('answers from the journal after one probe when the update landed before the call', async () => {
    rig = createRig()
    rig.hmr(SERVER, VITE, { type: 'connected' })
    const page = await rig.connect()
    page.vite = { pending: 0, applied: 0 }
    page.event('vite-hooked')
    const since = Date.now()
    await vi.advanceTimersByTimeAsync(10)
    rig.write('src/App.tsx')
    await vi.advanceTimersByTimeAsync(100)
    rig.hmr(SERVER, VITE, viteUpdate(11))
    await vi.advanceTimersByTimeAsync(80)
    page.viteApplied(11)
    page.mutate()
    await vi.advanceTimersByTimeAsync(2000)

    const probesBefore = page.probes()
    const { result, afterMs } = await waitWith(rig.detector, { since })
    expect(result).toMatchObject({ status: 'settled', signal: 'hmr', filesChanged: ['src/App.tsx'], domChanged: true })
    expect(afterMs).toBeLessThan(60)
    expect(result.ms).toBeLessThan(60)
    // It did look at the page as it is now before saying so.
    expect(page.probes()).toBeGreaterThan(probesBefore)
  })

  it('a window that starts after the edit does not contain it', async () => {
    rig = createRig()
    rig.hmr(SERVER, VITE, { type: 'connected' })
    const page = await rig.connect()
    rig.write('src/App.tsx')
    rig.hmr(SERVER, VITE, viteUpdate(11))
    page.mutate()
    await vi.advanceTimersByTimeAsync(500)
    const { result } = await waitWith(rig.detector, { timeoutMs: 800 })
    expect(result).toMatchObject({ status: 'no_update_observed', filesChanged: [] })
  })

  it('takes a journal position as `since`, and lists the journal from it', async () => {
    rig = createRig()
    rig.hmr(SERVER, VITE, { type: 'connected' })
    await rig.connect()
    rig.write('src/old.tsx')
    const mark = rig.detector.mark()
    rig.write('src/new.tsx')
    expect(rig.detector.journal(mark).map((entry) => (entry.source === 'fs' ? entry.path : entry.source))).toEqual(['src/new.tsx'])
    expect(rig.detector.journal().length).toBeGreaterThan(1)
  })

  it('a file written before `since` (by its mtime) is outside a time window even when the watcher reports it late', async () => {
    rig = createRig({ hmr: false })
    await rig.connect()
    const writtenAt = Date.now()
    await vi.advanceTimersByTimeAsync(50)
    const since = Date.now()
    const mark = rig.detector.mark()
    await vi.advanceTimersByTimeAsync(20)
    rig.write('src/Earlier.tsx', writtenAt)
    const byTime = await waitWith(rig.detector, { since, timeoutMs: 300 })
    expect(byTime.result).toMatchObject({ status: 'no_update_observed', filesChanged: [] })
    // By journal position the same entry comes after the mark, and is in.
    expect(rig.detector.journal(mark).map((entry) => (entry.source === 'fs' ? entry.path : entry.source))).toContain('src/Earlier.tsx')
  })
})

describe('build errors', () => {
  it('Vite: an error message in the window is build_error at once, with file and position', async () => {
    rig = createRig()
    rig.hmr(SERVER, VITE, { type: 'connected' })
    await rig.connect()
    const { result, afterMs } = await waitWith(rig.detector, {}, [
      [10, () => rig.write('src/Hero.tsx')],
      [100, () => rig.hmr(SERVER, VITE, viteUpdate(5, '/src/Hero.tsx'))],
      [130, () => rig.hmr(SERVER, VITE, { type: 'error', err: { message: 'Unexpected token', stack: '', id: '/project/src/Hero.tsx', loc: { file: '/project/src/Hero.tsx', line: 5, column: 41 } } })],
    ])
    expect(result).toMatchObject({
      status: 'build_error',
      signal: 'hmr',
      filesChanged: ['src/Hero.tsx'],
      error: { source: 'hmr', message: 'Unexpected token', file: '/project/src/Hero.tsx', line: 5, column: 41 },
    })
    expect(afterMs).toBeLessThan(140)
  })

  it('Next: `built` with errors is build_error; after the fix the next wait settles', async () => {
    rig = createRig()
    rig.hmr(SERVER, NEXT, { type: 'sync', errors: [], warnings: [], hash: '' })
    const page = await rig.connect()
    const broken = await waitWith(rig.detector, {}, [
      [10, () => rig.write('components/Counter.tsx')],
      [30, () => rig.hmr(SERVER, NEXT, { type: 'building' })],
      [60, () => rig.hmr(SERVER, NEXT, { type: 'built', hash: '2', warnings: [], errors: [{ message: './components/Counter.tsx:6:16\nError: Expression expected' }] })],
    ])
    expect(broken.result).toMatchObject({ status: 'build_error', error: { source: 'hmr', file: './components/Counter.tsx', line: 6, column: 16 } })
    expect(broken.afterMs).toBeLessThan(70)

    await vi.advanceTimersByTimeAsync(300)
    const fixed = await waitWith(rig.detector, {}, [
      [10, () => rig.write('components/Counter.tsx')],
      [30, () => rig.hmr(SERVER, NEXT, { type: 'building' })],
      [33, () => rig.hmr(SERVER, NEXT, { type: 'turbopack-message', data: [{ type: 'partial', instruction: { type: 'ChunkListUpdate' } }] })],
      [36, () => page.mutate()],
      [60, () => rig.hmr(SERVER, NEXT, { type: 'built', hash: '3', warnings: [], errors: [] })],
      [62, () => rig.hmr(BROWSER, NEXT, { event: 'client-hmr-latency', updatedModules: [] })],
    ])
    expect(fixed.result).toMatchObject({ status: 'settled', signal: 'hmr' })
    expect(fixed.result.error).toBeUndefined()
  })

  it('a build that was already broken before the window is reported at the deadline', async () => {
    rig = createRig()
    rig.hmr(SERVER, NEXT, { type: 'built', hash: '1', warnings: [], errors: [{ message: './app/page.tsx:1:1\nError: nope' }] })
    await rig.connect()
    await vi.advanceTimersByTimeAsync(1000)
    const { result, afterMs } = await waitWith(rig.detector, { timeoutMs: 700 })
    expect(result).toMatchObject({ status: 'build_error', signal: 'timeout', error: { source: 'hmr', file: './app/page.tsx' } })
    expect(afterMs).toBeGreaterThanOrEqual(700)
  })

  it('without HMR: the error overlay in the page is build_error, with the file it names', async () => {
    rig = createRig({ hmr: false })
    const page = await rig.connect()
    const { result } = await waitWith(rig.detector, {}, [
      [10, () => rig.write('src/Hero.tsx')],
      [
        150,
        () => {
          page.overlay = { framework: 'vite', message: 'Transform failed', file: '/project/src/Hero.tsx', line: 5, column: 41 }
          page.mutate()
        },
      ],
    ])
    expect(result).toMatchObject({
      status: 'build_error',
      signal: 'mutation-quiet',
      error: { source: 'overlay', message: 'Transform failed', file: '/project/src/Hero.tsx', line: 5, column: 41 },
    })
  })
})

describe('Next updates', () => {
  it('server component: waits for the refetch to end, however long, and not for the first mutation', async () => {
    rig = createRig()
    rig.hmr(SERVER, NEXT, { type: 'sync', errors: [], warnings: [], hash: '' })
    const page = await rig.connect()
    let fetchStartedAt = 0
    const { result, afterMs } = await waitWith(rig.detector, {}, [
      [10, () => rig.write('components/SlowContent.tsx')],
      [60, () => rig.hmr(SERVER, NEXT, { type: 'serverComponentChanges', hmrVersion: '1' })],
      [61, () => rig.hmr(SERVER, NEXT, { type: 'built', hash: '1', warnings: [], errors: [] })],
      [
        62,
        () => {
          rig.hmr(BROWSER, NEXT, { event: 'server-component-reload-page', clientId: 1 })
          rig.hmr(BROWSER, NEXT, { event: 'client-hmr-latency', updatedModules: [] })
        },
      ],
      [65, () => (fetchStartedAt = page.now())],
      // Something unrelated on the page mutates while the server is still rendering.
      [300, () => page.mutate()],
      [1600, () => page.event('rsc-fetched', fetchStartedAt)],
      [1604, () => page.mutate()],
    ])
    expect(result).toMatchObject({ status: 'settled', signal: 'hmr', filesChanged: ['components/SlowContent.tsx'] })
    expect(result.reason).toContain('refetched the server-rendered tree')
    expect(afterMs).toBeGreaterThanOrEqual(1704)
    expect(afterMs).toBeLessThan(1850)
  })

  it('server component: a refetch that began before the change does not count; the wait ends in a timeout that says why', async () => {
    rig = createRig()
    rig.hmr(SERVER, NEXT, { type: 'sync', errors: [], warnings: [], hash: '' })
    const page = await rig.connect()
    const staleStart = page.now()
    const { result } = await waitWith(rig.detector, { timeoutMs: 2000 }, [
      [50, () => rig.hmr(SERVER, NEXT, { type: 'serverComponentChanges' })],
      [52, () => rig.hmr(BROWSER, NEXT, { event: 'server-component-reload-page' })],
      [200, () => page.event('rsc-fetched', staleStart)],
      [204, () => page.mutate()],
    ])
    expect(result).toMatchObject({ status: 'timeout', signal: 'timeout', reason: 'the page was still refetching the server-rendered tree' })
  })

  it('client component: waits for the browser to report the update, a mutation alone is not enough', async () => {
    rig = createRig()
    rig.hmr(SERVER, NEXT, { type: 'sync', errors: [], warnings: [], hash: '' })
    const page = await rig.connect()
    const { result, afterMs } = await waitWith(rig.detector, {}, [
      [30, () => rig.hmr(SERVER, NEXT, { type: 'building' })],
      [33, () => rig.hmr(SERVER, NEXT, { type: 'turbopack-message', data: [{ type: 'partial' }] })],
      // A clock on the page ticks; the hot chunk is still loading.
      [40, () => page.mutate()],
      [60, () => rig.hmr(SERVER, NEXT, { type: 'built', hash: '2', warnings: [], errors: [] })],
      [700, () => page.mutate()],
      [705, () => rig.hmr(BROWSER, NEXT, { event: 'client-hmr-latency', updatedModules: ['x'] })],
    ])
    expect(result.status).toBe('settled')
    expect(result.reason).toContain("Next's client reported the update applied")
    expect(afterMs).toBeGreaterThanOrEqual(800)
  })
})

describe('full reload', () => {
  it('waits for the new document, its load and its quiet', async () => {
    rig = createRig()
    rig.hmr(SERVER, VITE, { type: 'connected' })
    const old = await rig.connect('doc-old')
    let fresh: FakePage | undefined
    const { result, afterMs } = await waitWith(rig.detector, {}, [
      [10, () => rig.write('vite.config.ts')],
      [100, () => rig.hmr(SERVER, VITE, { type: 'full-reload' })],
      [120, () => old.close()],
      [
        400,
        () => {
          fresh = new FakePage('doc-new', 0)
          fresh.readyState = 'loading'
          rig.detector.attachBrowser(fresh)
          fresh.hello()
        },
      ],
      [
        900,
        () => {
          if (fresh === undefined) return
          fresh.readyState = 'complete'
          fresh.mutate()
          fresh.loadedAt = fresh.now()
          fresh.event('load')
        },
      ],
    ])
    expect(result).toMatchObject({ status: 'settled', signal: 'hmr', browser: true })
    expect(result.reason).toContain('the document loaded again')
    expect(afterMs).toBeGreaterThanOrEqual(1000)
  })

  it('times out when the page left and never came back', async () => {
    rig = createRig()
    rig.hmr(SERVER, VITE, { type: 'connected' })
    const old = await rig.connect()
    const { result } = await waitWith(rig.detector, { timeoutMs: 1200 }, [
      [100, () => rig.hmr(SERVER, VITE, { type: 'full-reload' })],
      [120, () => old.close()],
    ])
    expect(result).toMatchObject({ status: 'timeout', browser: false, reason: 'the page disconnected and did not come back' })
  })
})

describe('without the HMR tee (blind)', () => {
  it('files changed, then the page changed, then baselineQuietMs of quiet: settled by mutation-quiet', async () => {
    rig = createRig({ hmr: false })
    const page = await rig.connect()
    const { result, afterMs } = await waitWith(rig.detector, {}, [
      [10, () => rig.write('src/App.tsx')],
      [150, () => page.mutate()],
      [170, () => page.mutate()],
    ])
    expect(result).toMatchObject({ status: 'settled', signal: 'mutation-quiet', filesChanged: ['src/App.tsx'], domChanged: true })
    expect(afterMs).toBeGreaterThanOrEqual(470)
    expect(afterMs).toBeLessThan(600)
  })

  it('files changed and the page never did: no_update_observed at the timeout, with the files', async () => {
    rig = createRig({ hmr: false })
    await rig.connect()
    const { result, afterMs } = await waitWith(rig.detector, { timeoutMs: 1500 }, [[10, () => rig.write('README.md')]])
    expect(result).toMatchObject({ status: 'no_update_observed', signal: 'timeout', filesChanged: ['README.md'], domChanged: false })
    expect(afterMs).toBeGreaterThanOrEqual(1500)
  })

  it('a page that keeps mutating is a timeout, not settled', async () => {
    rig = createRig({ hmr: false })
    const page = await rig.connect()
    const ticker = setInterval(() => page.mutate(), 40)
    const { result } = await waitWith(rig.detector, { timeoutMs: 1500 }, [[10, () => rig.write('src/App.tsx')]])
    clearInterval(ticker)
    expect(result).toMatchObject({ status: 'timeout', reason: 'the page did not become quiet' })
  })
})

describe('a live HMR socket that stays silent', () => {
  it('files changed, no message, page unchanged: no_update_observed by fs after the grace period, before the timeout', async () => {
    rig = createRig()
    rig.hmr(SERVER, NEXT, { type: 'sync', errors: [], warnings: [], hash: '' })
    await rig.connect()
    const { result, afterMs } = await waitWith(rig.detector, { timeoutMs: 5000 }, [[10, () => rig.write('README.md')]])
    expect(result).toMatchObject({ status: 'no_update_observed', signal: 'fs', filesChanged: ['README.md'], domChanged: false })
    expect(afterMs).toBeGreaterThanOrEqual(3010)
    expect(afterMs).toBeLessThan(3200)
  })
})

describe('no page connected', () => {
  it('files changed: settled by fs after the grace period, saying no page was there', async () => {
    rig = createRig({ hmr: false })
    const { result, afterMs } = await waitWith(rig.detector, {}, [[10, () => rig.write('src/App.tsx')]])
    expect(result).toMatchObject({ status: 'settled', signal: 'fs', browser: false, domChanged: false, filesChanged: ['src/App.tsx'] })
    expect(result.visibility).toBeUndefined()
    expect(afterMs).toBeGreaterThanOrEqual(3010)
  })

  it('nothing at all: no_update_observed at the timeout', async () => {
    rig = createRig({ hmr: false, watcher: false })
    expect(rig.detector.status()).toMatchObject({ watching: false, browsers: 0 })
    const { result } = await waitWith(rig.detector, { timeoutMs: 500 })
    expect(result).toMatchObject({ status: 'no_update_observed', browser: false })
  })
})

describe('a page that does not run', () => {
  it('unanswered probes end in a timeout at the deadline, not in a guess and not in a hang', async () => {
    rig = createRig()
    rig.hmr(SERVER, VITE, { type: 'connected' })
    const page = await rig.connect()
    page.vite = { pending: 0, applied: 0 }
    page.event('vite-hooked')
    page.responsive = false
    const { result, afterMs } = await waitWith(rig.detector, { timeoutMs: 3000 }, [
      [10, () => rig.write('src/App.tsx')],
      [100, () => rig.hmr(SERVER, VITE, viteUpdate(3))],
    ])
    expect(result).toMatchObject({ status: 'timeout', signal: 'timeout' })
    expect(result.reason).toContain('stopped answering')
    expect(afterMs).toBeGreaterThanOrEqual(3000)
    expect(afterMs).toBeLessThan(3020)
  })

  it('a page that was busy for 2 s gets its chance after waking up: no "nothing happened" from a late answer', async () => {
    rig = createRig()
    rig.hmr(SERVER, NEXT, { type: 'sync', errors: [], warnings: [], hash: '' })
    const page = await rig.connect()
    const { result, afterMs } = await waitWith(rig.detector, {}, [
      // The main thread blocks: messages reach the page's script 2 s late.
      [0, () => (page.deliveryDelayMs = 2000)],
      [30, () => rig.hmr(SERVER, NEXT, { type: 'building' })],
      [33, () => rig.hmr(SERVER, NEXT, { type: 'turbopack-message', data: [{ type: 'partial' }] })],
      [60, () => rig.hmr(SERVER, NEXT, { type: 'built', hash: '2', warnings: [], errors: [] })],
      // Awake again at 2.1 s; the update is applied at 2.15 s.
      [2100, () => (page.deliveryDelayMs = 0)],
      [2150, () => page.mutate()],
      [2160, () => rig.hmr(BROWSER, NEXT, { event: 'client-hmr-latency', updatedModules: [] })],
    ])
    expect(result.status).toBe('settled')
    expect(result.reason).toContain("Next's client reported the update applied")
    expect(afterMs).toBeGreaterThanOrEqual(2250)
  })

  it('a background tab that runs timers late still settles, later', async () => {
    rig = createRig()
    rig.hmr(SERVER, VITE, { type: 'connected' })
    const page = await rig.connect()
    page.vite = { pending: 0, applied: 0 }
    page.event('vite-hooked')
    page.timerDelayMs = 900
    const { result, afterMs } = await waitWith(rig.detector, {}, [
      [10, () => rig.write('src/App.tsx')],
      [100, () => rig.hmr(SERVER, VITE, viteUpdate(8))],
      [180, () => page.viteApplied(8)],
      [1000, () => page.mutate()],
    ])
    expect(result.status).toBe('settled')
    expect(afterMs).toBeGreaterThanOrEqual(1100)
    expect(afterMs).toBeLessThan(5000)
  })
})

describe('detector housekeeping', () => {
  it('asks the page to report every mutation only while someone waits', async () => {
    rig = createRig({ hmr: false })
    const page = await rig.connect()
    expect(page.sent.some((message) => message.type === 'settle:watch')).toBe(false)
    await waitWith(rig.detector, { timeoutMs: 100 })
    expect(page.sent.filter((message) => message.type === 'settle:watch')).toEqual([
      { type: 'settle:watch', on: true },
      { type: 'settle:watch', on: false },
    ])
  })

  it('ignores messages that are not the settle client, and survives a closing socket', async () => {
    rig = createRig({ hmr: false })
    const page = new FakePage()
    const listeners: ((data: unknown) => void)[] = []
    rig.detector.attachBrowser({
      send: () => {
        throw new Error('socket is closing')
      },
      on: (event: string, listener: (data?: unknown) => void) => {
        if (event === 'message') listeners.push(listener)
      },
    })
    for (const data of ['garbage', '{"type":"other"}', '[]', 'null', Buffer.from('{"type":"settle:nope"}'), 42, undefined]) {
      expect(() => listeners.forEach((listener) => listener(data))).not.toThrow()
    }
    expect(() => listeners.forEach((listener) => listener(JSON.stringify({ type: 'settle:hello', doc: 'd', url: '', timeOrigin: page.now(), at: page.now() })))).not.toThrow()
    expect(rig.detector.status().browsers).toBe(1)
  })

  it('reports watcher errors in its status', async () => {
    rig = createRig({ hmr: false })
    expect(rig.detector.status()).toMatchObject({ watching: true, watchErrors: [] })
    rig.failWatcher(Object.assign(new Error('too many open files, watch'), { code: 'EMFILE' }))
    expect(rig.detector.status().watchErrors).toEqual(['EMFILE: too many open files, watch'])
  })

  it('a closed detector resolves pending waits', async () => {
    rig = createRig({ hmr: false })
    await rig.connect()
    const { result, afterMs } = await waitWith(rig.detector, { timeoutMs: 5000 }, [[200, () => void rig.detector.close()]])
    expect(result).toMatchObject({ status: 'timeout', reason: 'the detector was closed' })
    expect(afterMs).toBeLessThan(260)
  })
})

describe('startWatcherWithFallback', () => {
  function fakeWatchers() {
    const started: { polling: boolean; closed: boolean; fail: (error: unknown) => void }[] = []
    const start = (polling: boolean, fail: (error: unknown) => void): SettleWatcher => {
      const entry = { polling, closed: false, fail }
      started.push(entry)
      return {
        ready: Promise.resolve(),
        close: async () => {
          entry.closed = true
        },
        directories: () => (polling ? 7 : 3),
      }
    }
    return { started, start }
  }

  it('starts native and switches to polling on the first error, reporting every error', async () => {
    const { started, start } = fakeWatchers()
    const errors: unknown[] = []
    const watcher = startWatcherWithFallback(start, (error) => errors.push(error))
    expect(started.map((entry) => entry.polling)).toEqual([false])
    expect(watcher.backend()).toBe('native')
    expect(watcher.directories?.()).toBe(3)

    started[0]?.fail(new Error('EMFILE'))
    expect(started.map((entry) => entry.polling)).toEqual([false, true])
    expect(started[0]?.closed).toBe(true)
    expect(watcher.backend()).toBe('polling')
    expect(watcher.directories?.()).toBe(7)

    // A second error, from either watcher, starts nothing more.
    started[1]?.fail(new Error('EACCES'))
    started[0]?.fail(new Error('late'))
    expect(started).toHaveLength(2)
    expect(errors).toHaveLength(3)

    await watcher.close()
    expect(started[1]?.closed).toBe(true)
  })

  it('polling from the start when asked for; no fallback after close', async () => {
    const polling = fakeWatchers()
    expect(startWatcherWithFallback(polling.start, () => {}, true).backend()).toBe('polling')
    expect(polling.started.map((entry) => entry.polling)).toEqual([true])

    const closing = fakeWatchers()
    const watcher = startWatcherWithFallback(closing.start, () => {})
    await watcher.close()
    closing.started[0]?.fail(new Error('after close'))
    expect(closing.started).toHaveLength(1)
  })
})

describe('real file watching (chokidar)', () => {
  const TMP = fileURLToPath(new URL('../../../.tmp/', import.meta.url))
  let dir = ''
  let detector: SettleDetector | undefined

  beforeEach(() => {
    vi.useRealTimers()
    mkdirSync(TMP, { recursive: true })
    dir = mkdtempSync(join(TMP, 'settle-test-'))
    for (const sub of ['src', 'node_modules/pkg', '.git', 'dist', '.next/server']) mkdirSync(join(dir, sub), { recursive: true })
    writeFileSync(join(dir, 'src/App.tsx'), 'export const a = 1\n')
  })

  afterEach(async () => {
    await detector?.close()
    detector = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  async function changedPaths(target: SettleDetector, timeoutMs = 3000): Promise<string[]> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const paths = target.journal().flatMap((entry) => (entry.source === 'fs' ? [entry.path] : []))
      if (paths.includes('src/App.tsx') || Date.now() > deadline) return paths
      await sleep(20)
    }
  }

  for (const polling of [false, true]) {
    it(`${polling ? 'polling' : 'native'} backend: journals a source edit and a new file, not node_modules, .git or build output`, async () => {
      detector = createSettleDetector({ projectDir: dir, polling })
      await detector.ready()
      expect(detector.status()).toMatchObject({ watching: true, watchBackend: polling ? 'polling' : 'native', watchErrors: [] })
      await sleep(polling ? 300 : 100)
      const since = detector.mark()
      writeFileSync(join(dir, 'node_modules/pkg/index.js'), 'x')
      writeFileSync(join(dir, '.git/HEAD'), 'x')
      writeFileSync(join(dir, 'dist/out.js'), 'x')
      writeFileSync(join(dir, '.next/server/page.js'), 'x')
      writeFileSync(join(dir, 'next-env.d.ts'), 'x')
      writeFileSync(join(dir, 'src/New.tsx'), 'export const b = 2\n')
      writeFileSync(join(dir, 'src/App.tsx'), 'export const a = 2\n')
      const paths = await changedPaths(detector)
      await sleep(200)
      const all = [...new Set(detector.journal(since).flatMap((entry) => (entry.source === 'fs' ? [entry.path] : [])))].sort()
      expect(paths).toContain('src/App.tsx')
      expect(all).toEqual(['src/App.tsx', 'src/New.tsx'])

      // No page, no HMR: the files are what the result can say.
      const result = await detector.waitForSettle({ since, timeoutMs: 200 })
      expect(result.filesChanged.sort()).toEqual(['src/App.tsx', 'src/New.tsx'])
    })
  }
})
