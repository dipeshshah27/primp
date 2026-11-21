import { describe, expect, it } from 'vitest'
import {
  decide,
  DEFAULT_SETTLE_TIMINGS,
  isIgnoredPath,
  type SettleBrowserView,
  type SettleClientState,
  type SettleDecision,
  type SettleProbeAnswer,
  type SettleView,
} from '../src/settle.ts'

/**
 * `decide` is the whole policy of settle detection as a pure function. These
 * tests build the view by hand: times are milliseconds after T0, the start of
 * the window, with a 5 s deadline.
 */

const T0 = 1_700_000_000_000
const DEADLINE = T0 + 5000
const T = DEFAULT_SETTLE_TIMINGS

type HmrView = SettleView['hmr']

const QUIET_HMR: HmrView = {
  live: true,
  building: false,
  error: undefined,
  errorInWindow: false,
  firstUpdateAt: undefined,
  lastUpdate: undefined,
  lastServerUpdateAt: undefined,
  lastRefetchAt: undefined,
  lastAppliedReportAt: undefined,
  lastEventAt: undefined,
}

function pageState(partial: Partial<SettleClientState> = {}): SettleClientState {
  return {
    receivedAt: 0,
    now: 0,
    mutations: 0,
    lastMutationAt: null,
    pendingSheets: 0,
    readyState: 'complete',
    loadedAt: null,
    visibility: 'visible',
    overlay: null,
    ...partial,
  }
}

/** A drained probe answer, asked at `sentAt` (ms after T0); the page last mutated `quietFor` ms before answering. */
function probe(sentAt: number, quietFor: number | null, partial: Partial<SettleProbeAnswer> = {}, state: Partial<SettleClientState> = {}): SettleProbeAnswer {
  const pageNow = 50_000 + sentAt + 40
  return {
    sentAt: T0 + sentAt,
    receivedAt: T0 + sentAt + 40,
    drainMs: T.drainMs,
    lateMs: 0,
    state: pageState({ receivedAt: pageNow - 35, now: pageNow, lastMutationAt: quietFor === null ? null : pageNow - quietFor, ...state }),
    ...partial,
  }
}

function page(partial: Partial<SettleBrowserView> = {}): SettleBrowserView {
  return {
    navigatedAtMin: T0 - 60_000,
    lastChangeAtMin: Number.NEGATIVE_INFINITY,
    viteApplied: undefined,
    rscFetchStartedAtMin: Number.NEGATIVE_INFINITY,
    probe: undefined,
    unresponsiveSince: undefined,
    ...partial,
  }
}

function view(at: number, partial: Omit<Partial<SettleView>, 'hmr'> & { hmr?: Partial<HmrView> } = {}): SettleView {
  const { hmr, ...rest } = partial
  return {
    now: T0 + at,
    since: T0,
    deadline: DEADLINE,
    lastEntryAt: T0,
    fs: undefined,
    browser: page(),
    browserLeftAt: undefined,
    ...rest,
    hmr: { ...QUIET_HMR, ...hmr },
  }
}

const viteUpdate = (at: number, timestamp = 777): HmrView['lastUpdate'] => ({ at: T0 + at, fullReload: false, timestamp, framework: 'vite', server: false })
const nextUpdate = (at: number, server = false): HmrView['lastUpdate'] => ({ at: T0 + at, fullReload: false, timestamp: undefined, framework: 'next', server })

function resolved(decision: SettleDecision) {
  if (decision.action !== 'resolve') throw new Error(`expected a result, got ${JSON.stringify(decision)}`)
  return decision.result
}

describe('decide: nothing happened', () => {
  it('waits until the deadline, then reports no_update_observed', () => {
    expect(decide(view(100))).toEqual({ action: 'wait', until: DEADLINE })
    expect(decide(view(4999))).toEqual({ action: 'wait', until: DEADLINE })
    expect(resolved(decide(view(5000)))).toMatchObject({ status: 'no_update_observed', signal: 'timeout', domChanged: false })
  })

  it('does not take page mutations alone for an update', () => {
    const browser = page({ lastChangeAtMin: T0 + 200, probe: probe(300, 500) })
    expect(decide(view(1000, { browser, lastEntryAt: T0 + 200 }))).toEqual({ action: 'wait', until: DEADLINE })
    expect(resolved(decide(view(5000, { browser, lastEntryAt: T0 + 200 }))).status).toBe('no_update_observed')
  })
})

describe('decide: build errors', () => {
  const error = [{ message: 'Expression expected', file: './app/page.tsx', line: 3, column: 9 }]

  it('reports an HMR error of the window at once, with its location', () => {
    const result = resolved(decide(view(80, { hmr: { error, errorInWindow: true, lastEventAt: T0 + 70 } })))
    expect(result).toMatchObject({
      status: 'build_error',
      signal: 'hmr',
      error: { source: 'hmr', message: 'Expression expected', file: './app/page.tsx', line: 3, column: 9 },
    })
  })

  it('keeps waiting on a build that was already broken, and says so at the deadline', () => {
    const hmr = { error, errorInWindow: false, lastUpdate: viteUpdate(100), firstUpdateAt: T0 + 100, lastEventAt: T0 + 100 }
    expect(decide(view(3000, { hmr, browser: page({ viteApplied: 777, probe: probe(200, 900) }) }))).toEqual({ action: 'wait', until: DEADLINE })
    expect(resolved(decide(view(5000, { hmr })))).toMatchObject({ status: 'build_error', signal: 'timeout' })
  })

  it('reports the error overlay seen in a probe answer, with the file it names', () => {
    const overlay = { framework: 'next' as const, kind: 'Build Error', message: 'Expression expected', file: './components/Counter.tsx', line: 6, column: 16 }
    const browser = page({ lastChangeAtMin: T0 + 120, probe: probe(400, 400, {}, { overlay }) })
    const result = resolved(decide(view(900, { fs: { firstAt: T0 + 10, lastAt: T0 + 10 }, hmr: { live: false }, browser, lastEntryAt: T0 + 120 })))
    expect(result).toMatchObject({
      status: 'build_error',
      signal: 'mutation-quiet',
      error: { source: 'overlay', message: 'Build Error: Expression expected', file: './components/Counter.tsx', line: 6, column: 16 },
    })
  })

  it('waits while the dev server is building and times out if it never finishes', () => {
    const hmr = { building: true, lastEventAt: T0 + 50 }
    expect(decide(view(60, { hmr }))).toEqual({ action: 'wait', until: DEADLINE })
    expect(resolved(decide(view(5000, { hmr })))).toMatchObject({ status: 'timeout', reason: 'the dev server was still building' })
  })
})

describe('decide: Vite update', () => {
  const hmr = { lastUpdate: viteUpdate(100), firstUpdateAt: T0 + 100, lastEventAt: T0 + 100 }
  const fs = { firstAt: T0 + 10, lastAt: T0 + 10 }

  it("waits for Vite's client to report the update's timestamp, not for a mutation", () => {
    const browser = page({ viteApplied: 700, lastChangeAtMin: T0 + 150 })
    expect(decide(view(200, { hmr, fs, browser, lastEntryAt: T0 + 150 }))).toEqual({ action: 'wait', until: T0 + 100 + T.applyGraceMs })
  })

  it('asks the page once the update is applied, and again when the answer is older than the journal', () => {
    const applied = page({ viteApplied: 777 })
    expect(decide(view(260, { hmr, fs, browser: applied, lastEntryAt: T0 + 250 }))).toEqual({ action: 'probe' })
    const stale = page({ viteApplied: 777, probe: probe(240, 500) })
    expect(decide(view(300, { hmr, fs, browser: stale, lastEntryAt: T0 + 250 }))).toEqual({ action: 'probe' })
  })

  it('does not accept an answer that did not queue behind the page timers', () => {
    const browser = page({ viteApplied: 777, probe: probe(260, 500, { drainMs: 0 }) })
    expect(decide(view(300, { hmr, fs, browser, lastEntryAt: T0 + 250 }))).toEqual({ action: 'probe' })
  })

  it('settles when the page has been quiet for quietMs', () => {
    const browser = page({ viteApplied: 777, lastChangeAtMin: T0 + 180, probe: probe(260, T.quietMs) })
    const result = resolved(decide(view(300, { hmr, fs, browser, lastEntryAt: T0 + 250 })))
    expect(result).toMatchObject({ status: 'settled', signal: 'hmr', domChanged: true })
    expect(result.reason).toContain("Vite's client reported the update applied")
  })

  it('waits out the rest of the quiet period after a recent mutation, then asks again', () => {
    const browser = page({ viteApplied: 777, probe: probe(260, 40) })
    // Answer received at +300, 40 ms after the last mutation: 60 ms to go, less the drain the next probe adds.
    expect(decide(view(300, { hmr, fs, browser, lastEntryAt: T0 + 250 }))).toEqual({ action: 'wait', until: T0 + 300 + 60 - T.drainMs })
    expect(decide(view(330, { hmr, fs, browser, lastEntryAt: T0 + 250 }))).toEqual({ action: 'probe' })
  })

  it('is not settled while a stylesheet is loading, an update is pending or the document is loading', () => {
    for (const state of [{ pendingSheets: 1 }, { vite: { pending: 1, applied: 777 } }, { readyState: 'interactive' as const }]) {
      const browser = page({ viteApplied: 777, probe: probe(260, 500, {}, state) })
      const decision = decide(view(301, { hmr, fs, browser, lastEntryAt: T0 + 250 }))
      expect(decision.action, JSON.stringify(state)).toBe('wait')
    }
  })

  it('an applied update with the error overlay on the page is a build_error, not settled', () => {
    const overlay = { framework: 'vite' as const, message: 'Failed to resolve import "./missing"', file: '/project/src/App.tsx', line: 2, column: 20 }
    const browser = page({ viteApplied: 777, probe: probe(260, 500, {}, { overlay }) })
    expect(resolved(decide(view(300, { hmr, fs, browser, lastEntryAt: T0 + 250 })))).toMatchObject({
      status: 'build_error',
      signal: 'mutation-quiet',
      error: { source: 'overlay', file: '/project/src/App.tsx', line: 2, column: 20 },
    })
  })

  it('times out when the page never goes quiet', () => {
    const browser = page({ viteApplied: 777, probe: probe(4900, 10) })
    expect(resolved(decide(view(5000, { hmr, fs, browser, lastEntryAt: T0 + 4890 })))).toMatchObject({
      status: 'timeout',
      reason: 'the page did not become quiet',
    })
  })

  it('gives a file written after the last HMR message time for its own message', () => {
    const browser = page({ viteApplied: 777, probe: probe(900, 500) })
    const late = { firstAt: T0 + 10, lastAt: T0 + 800 }
    expect(decide(view(950, { hmr, fs: late, browser, lastEntryAt: T0 + 800 }))).toEqual({ action: 'wait', until: T0 + 800 + T.hmrExpectMs })
  })
})

describe('decide: update without a sign from the page', () => {
  const hmr = { lastUpdate: viteUpdate(100), firstUpdateAt: T0 + 100, lastEventAt: T0 + 100 }
  const afterGrace = 100 + T.applyGraceMs

  it('waits for the grace period', () => {
    expect(decide(view(400, { hmr, browser: page({ viteApplied: 0 }) }))).toEqual({ action: 'wait', until: T0 + afterGrace })
  })

  it('needs an answer asked for after the grace period', () => {
    const browser = page({ viteApplied: 0, probe: probe(afterGrace - 200, 900) })
    expect(decide(view(afterGrace + 10, { hmr, browser, lastEntryAt: T0 + 100 }))).toEqual({ action: 'probe' })
  })

  it('settles on a prompt answer, and says that nothing was seen', () => {
    const browser = page({ viteApplied: 0, probe: probe(afterGrace + 5, 900) })
    const result = resolved(decide(view(afterGrace + 50, { hmr, browser, lastEntryAt: T0 + 100 })))
    expect(result).toMatchObject({ status: 'settled', signal: 'hmr', domChanged: false })
    expect(result.reason).toContain('showed no sign')
  })

  it('does not conclude anything from an answer that reached the page late (busy or suspended page)', () => {
    const late = probe(afterGrace + 5, 900, { lateMs: 2400, receivedAt: T0 + afterGrace + 2450 })
    const browser = page({ viteApplied: 0, probe: late })
    expect(decide(view(afterGrace + 2460, { hmr, browser, lastEntryAt: T0 + 100 }))).toEqual({
      action: 'wait',
      until: T0 + afterGrace + 2450 + T.lateProbeMs,
    })
    expect(decide(view(afterGrace + 2450 + T.lateProbeMs, { hmr, browser, lastEntryAt: T0 + 100 }))).toEqual({ action: 'probe', fresh: true })
  })

  it('reports a page that stopped answering as a timeout', () => {
    const browser = page({ viteApplied: 0, unresponsiveSince: T0 + 2600 })
    expect(resolved(decide(view(5000, { hmr, browser })))).toMatchObject({ status: 'timeout', signal: 'timeout' })
    expect(resolved(decide(view(5000, { hmr, browser }))).reason).toContain('stopped answering')
  })

  it('without a page, settles after the grace period and says no page confirmed it', () => {
    expect(decide(view(400, { hmr, browser: undefined }))).toEqual({ action: 'wait', until: T0 + afterGrace })
    expect(resolved(decide(view(afterGrace, { hmr, browser: undefined })))).toMatchObject({ status: 'settled', signal: 'hmr', domChanged: false })
  })
})

describe('decide: Next updates', () => {
  it('client component: a mutation is not enough, the browser must report the update applied', () => {
    const hmr = { lastUpdate: nextUpdate(33), firstUpdateAt: T0 + 33, lastEventAt: T0 + 33 }
    const mutated = page({ lastChangeAtMin: T0 + 36, probe: probe(40, 500) })
    expect(decide(view(80, { hmr, browser: mutated, lastEntryAt: T0 + 36 }))).toEqual({ action: 'wait', until: T0 + 33 + T.applyGraceMs })

    const reported = { ...hmr, lastAppliedReportAt: T0 + 63, lastEventAt: T0 + 63 }
    const browser = page({ lastChangeAtMin: T0 + 36, probe: probe(64, 130) })
    const result = resolved(decide(view(170, { hmr: reported, browser, lastEntryAt: T0 + 63 })))
    expect(result.status).toBe('settled')
    expect(result.reason).toContain("Next's client reported the update applied")
  })

  it('server component: `client-hmr-latency` does not count, the refetch must have ended', () => {
    const hmr = {
      lastUpdate: nextUpdate(60, true),
      firstUpdateAt: T0 + 60,
      lastServerUpdateAt: T0 + 60,
      lastRefetchAt: T0 + 61,
      lastAppliedReportAt: T0 + 62,
      lastEventAt: T0 + 62,
    }
    // 1.2 s in: the server is still rendering. Not the grace period, the deadline, is what it waits for.
    const waiting = page({ probe: probe(1000, 2000) })
    expect(decide(view(1200, { hmr, browser: waiting, lastEntryAt: T0 + 62 }))).toEqual({ action: 'wait', until: DEADLINE })
    expect(decide(view(2500, { hmr, browser: waiting, lastEntryAt: T0 + 62 }))).toEqual({ action: 'wait', until: DEADLINE })
    expect(resolved(decide(view(5000, { hmr, browser: waiting, lastEntryAt: T0 + 62 })))).toMatchObject({
      status: 'timeout',
      reason: 'the page was still refetching the server-rendered tree',
    })
  })

  it('server component: a refetch that began before the message is the old tree', () => {
    const hmr = { lastUpdate: nextUpdate(60, true), firstUpdateAt: T0 + 60, lastServerUpdateAt: T0 + 60, lastRefetchAt: T0 + 61, lastEventAt: T0 + 61 }
    const stale = page({ rscFetchStartedAtMin: T0 + 40, lastChangeAtMin: T0 + 300, probe: probe(310, 200) })
    expect(decide(view(600, { hmr, browser: stale, lastEntryAt: T0 + 300 }))).toEqual({ action: 'wait', until: DEADLINE })
  })

  it('server component: settles once a refetch begun after the message has ended and the page is quiet', () => {
    const hmr = { lastUpdate: nextUpdate(60, true), firstUpdateAt: T0 + 60, lastServerUpdateAt: T0 + 60, lastRefetchAt: T0 + 61, lastEventAt: T0 + 61 }
    const fetched = page({ rscFetchStartedAtMin: T0 + 66, lastChangeAtMin: T0 + 1600 })
    expect(decide(view(1601, { hmr, browser: fetched, lastEntryAt: T0 + 1600 }))).toEqual({ action: 'probe' })
    const result = resolved(decide(view(1750, { hmr, browser: { ...fetched, probe: probe(1700, 130) }, lastEntryAt: T0 + 1600 })))
    expect(result.status).toBe('settled')
    expect(result.reason).toContain('refetched the server-rendered tree')
  })

  it('a server change followed by a client update still waits for the refetch', () => {
    const hmr = {
      lastUpdate: nextUpdate(90),
      firstUpdateAt: T0 + 60,
      lastServerUpdateAt: T0 + 60,
      lastRefetchAt: T0 + 61,
      lastAppliedReportAt: T0 + 120,
      lastEventAt: T0 + 120,
    }
    expect(decide(view(400, { hmr, browser: page({ probe: probe(300, 500) }), lastEntryAt: T0 + 120 }))).toEqual({ action: 'wait', until: DEADLINE })
  })

  it('a server change the browser never said it refetches falls back to the grace period', () => {
    const hmr = { lastUpdate: nextUpdate(60, true), firstUpdateAt: T0 + 60, lastServerUpdateAt: T0 + 60, lastEventAt: T0 + 60 }
    expect(decide(view(400, { hmr }))).toEqual({ action: 'wait', until: T0 + 60 + T.applyGraceMs })
    const browser = page({ probe: probe(60 + T.applyGraceMs + 5, 900) })
    expect(resolved(decide(view(60 + T.applyGraceMs + 60, { hmr, browser, lastEntryAt: T0 + 60 }))).status).toBe('settled')
  })
})

describe('decide: full reload', () => {
  const hmr = { lastUpdate: { at: T0 + 100, fullReload: true, timestamp: undefined, framework: 'vite' as const, server: false }, firstUpdateAt: T0 + 100, lastEventAt: T0 + 100 }

  it('waits for the next document while none is connected', () => {
    expect(decide(view(300, { hmr, browser: undefined, browserLeftAt: T0 + 120 }))).toEqual({ action: 'wait', until: DEADLINE })
    expect(resolved(decide(view(5000, { hmr, browser: undefined, browserLeftAt: T0 + 120 })))).toMatchObject({
      status: 'timeout',
      reason: 'the page disconnected and did not come back',
    })
  })

  it('settles when a document that started after the reload message has loaded and is quiet', () => {
    const loading = page({ navigatedAtMin: T0 + 150, probe: probe(300, 20, {}, { readyState: 'interactive' }) })
    expect(decide(view(345, { hmr, browser: loading, lastEntryAt: T0 + 290 })).action).toBe('wait')
    const loaded = page({ navigatedAtMin: T0 + 150, lastChangeAtMin: T0 + 420, probe: probe(600, 150) })
    const result = resolved(decide(view(645, { hmr, browser: loaded, lastEntryAt: T0 + 590 })))
    expect(result.status).toBe('settled')
    expect(result.reason).toContain('the document loaded again')
  })
})

describe('decide: file changes without an HMR message', () => {
  const fs = { firstAt: T0 + 10, lastAt: T0 + 10 }

  it('with a silent live HMR socket: no_update_observed after fsGraceMs, after one last look at the page', () => {
    expect(decide(view(200, { fs }))).toEqual({ action: 'wait', until: T0 + 10 + T.hmrExpectMs })
    expect(decide(view(1000, { fs }))).toEqual({ action: 'wait', until: T0 + 10 + T.fsGraceMs })
    expect(decide(view(10 + T.fsGraceMs, { fs }))).toEqual({ action: 'probe' })
    const browser = page({ probe: probe(10 + T.fsGraceMs + 1, null) })
    expect(resolved(decide(view(10 + T.fsGraceMs + 50, { fs, browser })))).toMatchObject({
      status: 'no_update_observed',
      signal: 'fs',
      domChanged: false,
    })
  })

  it('without HMR: the page changing after the file, then baselineQuietMs of quiet, is mutation-quiet', () => {
    const hmr = { live: false }
    expect(decide(view(600, { fs, hmr }))).toEqual({ action: 'wait', until: DEADLINE })
    const changed = page({ lastChangeAtMin: T0 + 150, probe: probe(200, 150) })
    expect(decide(view(245, { fs, hmr, browser: changed, lastEntryAt: T0 + 150 })).action).toBe('wait')
    const quiet = page({ lastChangeAtMin: T0 + 150, probe: probe(420, T.baselineQuietMs) })
    expect(resolved(decide(view(470, { fs, hmr, browser: quiet, lastEntryAt: T0 + 150 })))).toMatchObject({
      status: 'settled',
      signal: 'mutation-quiet',
      domChanged: true,
    })
  })

  it('without HMR: a page change from before the file change does not count', () => {
    const hmr = { live: false }
    const browser = page({ lastChangeAtMin: T0 + 5, probe: probe(400, 900) })
    expect(decide(view(900, { fs, hmr, browser, lastEntryAt: T0 + 10 }))).toEqual({ action: 'wait', until: DEADLINE })
    expect(resolved(decide(view(5000, { fs, hmr, browser, lastEntryAt: T0 + 10 })))).toMatchObject({
      status: 'no_update_observed',
      signal: 'timeout',
      reason: 'files changed but the page did not update',
    })
  })

  it('with no page connected: settled by fs after fsGraceMs, and it says nothing was observed', () => {
    expect(decide(view(500, { fs, browser: undefined }))).toEqual({ action: 'wait', until: T0 + 10 + T.fsGraceMs })
    expect(resolved(decide(view(10 + T.fsGraceMs, { fs, browser: undefined })))).toMatchObject({ status: 'settled', signal: 'fs', domChanged: false })
  })
})

describe('isIgnoredPath', () => {
  it.each([
    ['node_modules/react/index.js', true],
    ['packages/app/node_modules/x/y.js', true],
    ['.git/HEAD', true],
    ['.next/server/app/page.js', true],
    ['.svelte-kit/generated/root.js', true],
    ['.vite/deps/react.js', true],
    ['dist/index.js', true],
    ['build', true],
    ['src\\node_modules\\x.js', true],
    ['next-env.d.ts', true],
    ['.DS_Store', true],
    ['src/App.tsx~', true],
    ['src/.App.tsx.swp', true],
    ['tsconfig.tsbuildinfo', true],
    ['src/App.tsx', false],
    ['app/page.module.css', false],
    ['src/build-info.ts', false],
    ['src/distribution/index.ts', false],
    ['README.md', false],
    ['', false],
  ])('%s -> %s', (path, ignored) => {
    expect(isIgnoredPath(path)).toBe(ignored)
  })
})
