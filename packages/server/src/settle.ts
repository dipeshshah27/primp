import { readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { watch, type FSWatcher } from 'chokidar'
import { epochNow, type HmrError, type HmrEvent, type HmrFramework, type HmrTee } from './hmr-tee.ts'

/**
 * Settle detection: after source files change, decide when the running page
 * has finished updating (so it can be measured), or that nothing updated, or
 * that the build broke.
 *
 * Three sources are written to one journal, each entry stamped with the
 * server's clock:
 *
 *   fs       chokidar on the project directory (not node_modules, .git or build output); if the
 *            native watcher fails it is replaced by stat polling, and `status()` says so
 *   hmr      the tee's event stream, when the dev server's socket passes through the proxy
 *   browser  the settle client in the page (`packages/overlay/src/probe/settle-client.ts`):
 *            mutation notices, document loads, and answers to probes
 *
 * `waitForSettle({ since })` judges the window that starts at `since`, which is
 * normally the moment the agent claimed the batch. It reads the journal first,
 * so an edit whose hot update already landed before the call is answered at
 * once (after one probe to make sure the page is quiet now) instead of waiting
 * for an event that will not come again.
 *
 * What counts as evidence (see `decide`):
 *
 *   build_error         the tee's last word is an error that arrived in the window, or
 *                       the page shows the framework's error overlay
 *   settled / hmr       an update or reload was sent in the window, the page then showed
 *                       it took the update, and the page was quiet afterwards. What shows
 *                       it (see `appliedHow`):
 *                         Vite            its HMR client reported the update's timestamp applied
 *                         Next, client    the browser sent `client-hmr-latency` after the update
 *                         Next, server    a refetch of the server-rendered tree that began after
 *                                         the message has ended (however long the server takes)
 *                         any             the document loaded again
 *                         none of these   a DOM mutation after the message, where the dialect has
 *                                         no sign of its own; else nothing within a grace period,
 *                                         on a page that was demonstrably running
 *   settled / mutation-quiet
 *                       no HMR message, but files changed and afterwards the DOM mutated
 *                       or the document loaded again, then went quiet (the baseline for
 *                       dev servers whose socket the tee cannot read)
 *   settled / fs        files changed and no browser is connected: nothing else can be known
 *   no_update_observed  nothing changed at all (answered at the timeout), or files changed
 *                       but the live HMR socket stayed silent and the page did not change
 *                       (answered after `fsGraceMs`, signal `fs`)
 *   timeout             something started and did not finish: a build that never ended, a
 *                       refetch of the server-rendered tree still running, a page that
 *                       never went quiet or stopped answering
 *
 * DOM mutations alone are never evidence of an update: pages mutate on their own.
 *
 * Timing is driven from here. The page has no timers of its own for this: it
 * reports mutations as they happen and answers probes. A probe answer is sent
 * after a short timer in the page (`drainMs`), so it queues behind timers the
 * page already had pending (React Refresh debounces with one), also when a
 * background tab runs timers late. Quiet time is computed from two readings of
 * the page's own clock, so the two clocks never need to agree; where a page
 * time is compared with a server time, a lower bound of the clock offset is
 * used, so "after" is never claimed wrongly.
 */

// ---------------------------------------------------------------------------
// Wire protocol with the settle client (JSON text messages on the overlay socket)
// ---------------------------------------------------------------------------

export interface SettleOverlayReport {
  framework: 'vite' | 'next'
  /** The overlay's own heading, for example `Build Error`. */
  kind?: string
  message: string
  /** File the overlay points at, as it prints it. */
  file?: string
  line?: number
  column?: number
}

export interface SettleClientState {
  /** Page clock (`performance.timeOrigin + performance.now()`) when the probe arrived. */
  receivedAt: number
  /** Page clock when this answer was sent, after the drain. */
  now: number
  /** Mutation batches seen since the document started. */
  mutations: number
  /** Page clock of the last mutation batch or stylesheet load, if any. */
  lastMutationAt: number | null
  /** Stylesheet links added to the document that have not finished loading. */
  pendingSheets: number
  readyState: DocumentReadyState
  /** Page clock of the `load` event, if it has fired. */
  loadedAt: number | null
  visibility: DocumentVisibilityState
  /** The framework's error overlay, when it is showing. */
  overlay: SettleOverlayReport | null
  /** Present once the client has hooked Vite's HMR client. */
  vite?: {
    /** Updates received and not yet applied. */
    pending: number
    /** Largest update timestamp fully applied (or failed) so far; 0 when none. */
    applied: number
  }
}

export type SettleClientMessage =
  | {
      type: 'settle:hello'
      /** Random id of the document. */
      doc: string
      url: string
      /** `performance.timeOrigin`: page clock of the navigation start. */
      timeOrigin: number
      at: number
    }
  | { type: 'settle:mutation'; doc: string; seq: number; at: number }
  | {
      type: 'settle:event'
      doc: string
      /**
       * `vite-applied`: `detail` is the update's timestamp. `rsc-fetched`: a fetch of Next's
       * server-rendered tree ended at `at`; `detail` is the page clock of its start.
       */
      name: 'load' | 'pagehide' | 'visibilitychange' | 'sheet-loaded' | 'vite-applied' | 'vite-hooked' | 'vite-hook-failed' | 'rsc-fetched'
      at: number
      detail?: string | number
    }
  | { type: 'settle:state'; doc: string; id: number; state: SettleClientState }

export type SettleServerMessage =
  | { type: 'settle:probe'; id: number; drainMs: number }
  /** While `on`, the client reports every mutation batch instead of at most one per 50 ms. */
  | { type: 'settle:watch'; on: boolean }
  /** Tells the client where Vite's HMR client module lives, so it can listen for applied updates. */
  | { type: 'settle:vite'; clientPath: string }

/** The part of a WebSocket (the `ws` package's, or a test double) the detector uses. */
export interface SettleSocket {
  send(data: string): void
  on(event: 'message', listener: (data: unknown) => void): unknown
  on(event: 'close', listener: () => void): unknown
  on(event: 'error', listener: (error: unknown) => void): unknown
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type SettleStatus = 'settled' | 'no_update_observed' | 'build_error' | 'timeout'
export type SettleSignal = 'hmr' | 'fs' | 'mutation-quiet' | 'timeout'

export interface SettleError {
  /** Where the error was seen. */
  source: 'hmr' | 'overlay'
  message: string
  file?: string
  line?: number
  column?: number
}

export interface SettleResult {
  status: SettleStatus
  /** The signal that decided the result. */
  signal: SettleSignal
  /** How long `waitForSettle` took. */
  ms: number
  /** Project-relative paths that changed in the window, each once, in order of first change. */
  filesChanged: string[]
  error?: SettleError
  /** One sentence saying why this result was reached. */
  reason: string
  /** Server clock when the result was decided. */
  at: number
  /** Whether the page was seen to change in the window (a mutation, a load, or an applied update). */
  domChanged: boolean
  /** Whether a browser was connected when the result was decided. */
  browser: boolean
  /** `visibilityState` of the page in the last probe answer, when there was one. */
  visibility?: DocumentVisibilityState
}

/** A place in the journal. Take one with `mark()` before an action and pass it as `since`. */
export interface JournalPosition {
  seq: number
  at: number
}

export type JournalEntry =
  | { seq: number; at: number; source: 'fs'; event: string; path: string; mtimeMs?: number }
  | { seq: number; at: number; source: 'hmr'; event: HmrEvent }
  | { seq: number; at: number; source: 'browser'; doc: string; name: string; pageAt?: number; detail?: string | number }

export interface WaitForSettleOptions {
  /** Start of the window: epoch milliseconds, or a `mark()`. Default: now. */
  since?: number | JournalPosition
  timeoutMs: number
}

export interface SettleTimings {
  /** The page must have been without mutations for this long. Default 100. */
  quietMs: number
  /** Quiet time required when there is no HMR message to rely on. Default 300. */
  baselineQuietMs: number
  /** Timer the page runs before answering a probe. Default 32 (two frames; React Refresh debounces 16 ms). */
  drainMs: number
  /** How long to wait for the page to show an update after it was sent, before settling without that. Default 1500. */
  applyGraceMs: number
  /** How long after a file change a live HMR socket may stay silent before the change is taken to have had no effect. Default 3000. */
  fsGraceMs: number
  /** How long a file change waits for its HMR message before other evidence is considered. Default 400. */
  hmrExpectMs: number
  /** A probe unanswered for this long is given up (the tab may be frozen). Default 2500. */
  probeTimeoutMs: number
  /**
   * A probe that reached the page's script this much later than usual shows the page was not
   * running; "nothing happened" is then not concluded from that answer. Default 250.
   */
  lateProbeMs: number
}

export const DEFAULT_SETTLE_TIMINGS: SettleTimings = {
  quietMs: 100,
  baselineQuietMs: 300,
  drainMs: 32,
  applyGraceMs: 1500,
  fsGraceMs: 3000,
  hmrExpectMs: 400,
  probeTimeoutMs: 2500,
  lateProbeMs: 250,
}

export interface SettleDetectorOptions {
  /** Directory to watch. Without it there is no file signal. */
  projectDir?: string
  /** Extra paths to ignore, by absolute path. */
  ignored?: (path: string) => boolean
  /** Watch by stat polling from the start (network filesystems). Default: native, with polling as the fallback after a watcher error. */
  polling?: boolean
  /** The tee whose events to journal. Without it there is no HMR signal. */
  hmr?: HmrTee
  timings?: Partial<SettleTimings>
  /** Epoch milliseconds. Default `epochNow`; must be the clock the tee uses. */
  now?: () => number
  /** Journal entries kept. Default 5000. */
  journalLimit?: number
  /** Replaces chokidar, for tests: call `emit` for every change and `fail` for a watcher error. */
  watcher?: (emit: (event: string, absolutePath: string, mtimeMs?: number) => void, fail: (error: unknown) => void) => SettleWatcher
}

export interface SettleWatcher {
  ready: Promise<void>
  close(): Promise<void>
  /** Number of directories being watched, when the watcher can tell. */
  directories?(): number
}

export interface SettleDetectorStatus {
  /** Documents currently connected. */
  browsers: number
  /** A file watcher was started. It may still have failed since: see `watchErrors`. */
  watching: boolean
  /** `polling` from the start when asked for, or after the native watcher failed. */
  watchBackend: WatchBackend | undefined
  /** Directories the watcher holds, when it can tell. */
  watchedDirectories: number | undefined
  /**
   * Errors the file watcher reported (newest last, at most 20), for example
   * `EMFILE: too many open files, watch`. After one, files can change without
   * the journal showing it.
   */
  watchErrors: string[]
  journal: number
  hmr: ReturnType<HmrTee['status']> | undefined
}

export interface SettleDetector {
  /** Resolves when the file watcher has finished its first scan. */
  ready(): Promise<void>
  /** Hands over a settle client's socket (an overlay WebSocket). */
  attachBrowser(socket: SettleSocket): void
  /** The current journal position. */
  mark(): JournalPosition
  waitForSettle(options: WaitForSettleOptions): Promise<SettleResult>
  /** Entries after `since` (default: all that are kept). */
  journal(since?: number | JournalPosition): JournalEntry[]
  status(): SettleDetectorStatus
  close(): Promise<void>
}

// ---------------------------------------------------------------------------
// File watching
// ---------------------------------------------------------------------------

/** Directory names that never hold source: installs, VCS data, build output, caches. */
export const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '.vite',
  '.turbo',
  '.vercel',
  '.cache',
  '.parcel-cache',
  '.astro',
  'dist',
  'build',
  'out',
  'coverage',
  'test-results',
  'playwright-report',
])

/** Files written by tools, not by whoever edits the source. */
const IGNORED_FILE = /(?:^\.DS_Store$|~$|\.sw[a-p]$|\.tmp$|\.log$|\.tsbuildinfo$|^next-env\.d\.ts$|^4913$|^\.#)/

/** Whether a project-relative path is outside what the settle detector watches. */
export function isIgnoredPath(relativePath: string): boolean {
  const parts = relativePath.split(/[\\/]/).filter((part) => part !== '' && part !== '.')
  if (parts.length === 0) return false
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (IGNORED_DIRECTORIES.has(parts[index] as string)) return true
  }
  const last = parts[parts.length - 1] as string
  return IGNORED_DIRECTORIES.has(last) || IGNORED_FILE.test(last)
}

/** Most files a sweep looks at before giving up; a source tree larger than this is left to the watcher alone. */
const SWEEP_FILE_LIMIT = 20_000

/**
 * One look at the source tree for files written at or after `sinceMs`.
 *
 * The safety net for a file event the native watcher never delivered: FSEvents
 * was seen to drop the odd change (about one edit in a hundred in spike S4,
 * mostly the first write after the watcher started), in which case the page
 * updated and settled but `filesChanged` came back empty. Skips what the
 * watcher skips and does not follow symlinks. Paths are project-relative with
 * forward slashes.
 */
export async function sweepChangedFiles(
  projectDir: string,
  sinceMs: number,
  ignored?: (path: string) => boolean,
  limit = SWEEP_FILE_LIMIT,
): Promise<{ path: string; mtimeMs: number }[]> {
  const changed: { path: string; mtimeMs: number }[] = []
  let seen = 0
  const pending: string[] = [projectDir]
  while (pending.length > 0 && seen < limit) {
    const dir = pending.pop() as string
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const absolute = join(dir, entry.name)
      const rel = relative(projectDir, absolute)
      if (entry.isSymbolicLink() || isIgnoredPath(rel) || ignored?.(absolute) === true) continue
      if (entry.isDirectory()) {
        pending.push(absolute)
        continue
      }
      if (!entry.isFile()) continue
      seen += 1
      if (seen > limit) break
      try {
        const { mtimeMs } = await stat(absolute)
        // 1 ms of slack: `sinceMs` may come from a clock with coarser steps than the file system's.
        if (mtimeMs >= sinceMs - 1) changed.push({ path: rel.split(sep).join('/'), mtimeMs })
      } catch {
        // Removed between the listing and the stat.
      }
    }
  }
  return changed.sort((a, b) => a.mtimeMs - b.mtimeMs)
}

function startChokidar(
  projectDir: string,
  ignored: ((path: string) => boolean) | undefined,
  polling: boolean,
  emit: (event: string, absolutePath: string, mtimeMs?: number) => void,
  fail: (error: unknown) => void,
): SettleWatcher {
  const watcher: FSWatcher = watch(projectDir, {
    ignoreInitial: true,
    // A symlinked node_modules is ignored by name; anything else is watched as the link itself.
    followSymlinks: false,
    alwaysStat: true,
    ...(polling ? { backend: 'polling' as const, pollingInterval: POLLING_INTERVAL_MS } : {}),
    ignored: (path) => {
      const rel = relative(projectDir, path)
      if (rel === '' || rel.startsWith('..')) return false
      return isIgnoredPath(rel) || ignored?.(path) === true
    },
  })
  watcher.on('all', (event, path, stats) => {
    if (event === 'addDir' || event === 'unlinkDir') return
    emit(event, path, stats?.mtimeMs)
  })
  watcher.on('error', fail)
  const ready = new Promise<void>((resolve) => watcher.once('ready', () => resolve()))
  return { ready, close: () => watcher.close(), directories: () => Object.keys(watcher.getWatched()).length }
}

/** Poll period of the fallback watcher. Slower than chokidar's default: it stats every source file each time. */
const POLLING_INTERVAL_MS = 150

export type WatchBackend = 'native' | 'polling'

/**
 * Starts a watcher with the native backend and replaces it with a stat-polling
 * one the first time the native one reports an error.
 *
 * The native backend is one recursive `fs.watch` on macOS and Windows (FSEvents
 * on macOS) and one watch per directory elsewhere. When the system runs out of
 * what those need (`EMFILE`, `ENOSPC`), the watcher reports the error once and
 * then delivers nothing, which for settle detection looks exactly like "no file
 * changed". Polling holds no watch handles, so it still works then.
 *
 * `start` is `startChokidar` except in tests. Every error is passed to `fail`.
 */
export function startWatcherWithFallback(
  start: (polling: boolean, fail: (error: unknown) => void) => SettleWatcher,
  fail: (error: unknown) => void,
  polling = false,
): SettleWatcher & { backend(): WatchBackend } {
  let backend: WatchBackend = polling ? 'polling' : 'native'
  let closed = false
  let current: SettleWatcher
  const onError = (error: unknown): void => {
    fail(error)
    if (backend !== 'native' || closed) return
    backend = 'polling'
    const failed = current
    current = start(true, fail)
    void failed.close().catch(() => {})
  }
  current = start(polling, onError)
  const first = current
  return {
    ready: first.ready,
    close: async () => {
      closed = true
      await current.close()
    },
    directories: () => current.directories?.() ?? 0,
    backend: () => backend,
  }
}

// ---------------------------------------------------------------------------
// The decision, as a pure function of what is known
// ---------------------------------------------------------------------------

export interface SettleBrowserView {
  /**
   * Lower bound, on the server clock, of when the document's navigation
   * started. `-Infinity` until the clock offset is known.
   */
  navigatedAtMin: number
  /** Lower bound, on the server clock, of the last mutation or load known. `-Infinity` when none or unknown. */
  lastChangeAtMin: number
  /** Set once the client listens to Vite's HMR client: the largest update timestamp it reported applied. */
  viteApplied: number | undefined
  /**
   * Lower bound, on the server clock, of the start of the newest finished fetch
   * of Next's server-rendered tree. `-Infinity` when there was none.
   */
  rscFetchStartedAtMin: number
  /** The freshest probe answer, if any. `drainMs` is the timer the page ran before answering. */
  probe: SettleProbeAnswer | undefined
  /** Server clock since when probes have gone unanswered; undefined while the page answers. */
  unresponsiveSince: number | undefined
}

export interface SettleProbeAnswer {
  sentAt: number
  receivedAt: number
  drainMs: number
  /**
   * How much later than the fastest probe so far this one reached the page's
   * script. Large when the page's main thread was busy or suspended, in which
   * case messages from the dev server were waiting too.
   */
  lateMs: number
  state: SettleClientState
}

export interface SettleView {
  now: number
  since: number
  deadline: number
  /** Server clock of the newest journal entry of any kind in the window; `since` when there is none. */
  lastEntryAt: number
  fs:
    | {
        /** Time of the first and last change in the window (file mtime when plausible, else when it was seen). */
        firstAt: number
        lastAt: number
      }
    | undefined
  hmr: {
    /** A recognised HMR socket is open. */
    live: boolean
    building: boolean
    /** Current build error. */
    error: HmrError[] | undefined
    /** An error event arrived in the window. */
    errorInWindow: boolean
    /** Time of the first update or reload sent to the browser in the window. */
    firstUpdateAt: number | undefined
    /** Last update or reload sent to the browser in the window. `server`: it changes server-rendered output (Next). */
    lastUpdate: { at: number; fullReload: boolean; timestamp: number | undefined; framework: HmrFramework; server: boolean } | undefined
    /** Time of the last update in the window that changes server-rendered output. */
    lastServerUpdateAt: number | undefined
    /** Last time in the window the browser said it starts refetching the server-rendered tree. */
    lastRefetchAt: number | undefined
    /** Last time in the window the browser reported a finished hot update (Next). */
    lastAppliedReportAt: number | undefined
    /** Time of the last HMR event of any kind in the window. */
    lastEventAt: number | undefined
  }
  /** The document that counts, when one is connected. */
  browser: SettleBrowserView | undefined
  /** No document is connected, and one disconnected in the window at this time (a reload in progress, or a closed tab). */
  browserLeftAt: number | undefined
}

export type SettleOutcome = Pick<SettleResult, 'status' | 'signal' | 'reason' | 'domChanged' | 'error'>

export type SettleDecision =
  | { action: 'resolve'; result: SettleOutcome }
  /** A fresh answer from the page is needed; with `fresh`, one asked for from now on. */
  | { action: 'probe'; fresh?: boolean }
  /** Nothing to do before `until` unless something new is journalled. */
  | { action: 'wait'; until: number }

function toSettleError(errors: HmrError[]): SettleError {
  const first = errors[0] ?? { message: 'unknown error' }
  const error: SettleError = { source: 'hmr', message: first.message }
  if (first.file !== undefined) error.file = first.file
  if (first.line !== undefined) error.line = first.line
  if (first.column !== undefined) error.column = first.column
  return error
}

/** Whether the page was seen to change (mutation, stylesheet load, document load) after server time `after`. */
function changedAfter(browser: SettleBrowserView | undefined, after: number): boolean {
  return browser !== undefined && (browser.lastChangeAtMin > after || browser.navigatedAtMin > after)
}

/**
 * How the page showed that it took the last update, or `undefined` when it has
 * not (yet). Each dialect has its own strongest sign; a DOM mutation counts
 * only where there is nothing better, because pages also mutate on their own.
 */
function appliedHow(
  update: NonNullable<SettleView['hmr']['lastUpdate']>,
  view: SettleView,
  browser: SettleBrowserView,
  reloaded: boolean,
  refetchPending: boolean,
): string | undefined {
  if (reloaded) return 'the document loaded again after the update was sent'
  if (update.fullReload || refetchPending) return undefined
  if (update.server) return 'the page refetched the server-rendered tree after the update was sent'
  if (update.timestamp !== undefined && browser.viteApplied !== undefined) {
    return browser.viteApplied >= update.timestamp ? "Vite's client reported the update applied" : undefined
  }
  if (update.framework === 'next') {
    const reportedAt = view.hmr.lastAppliedReportAt
    return reportedAt !== undefined && reportedAt > update.at ? "Next's client reported the update applied" : undefined
  }
  return browser.lastChangeAtMin > update.at ? 'the page changed after the update was sent' : undefined
}

type QuietCheck =
  /** No answer recent enough to judge: ask the page. */
  | { verdict: 'ask' }
  | { verdict: 'quiet'; overlay: SettleOverlayReport | null }
  /** Not quiet yet; look again in `waitMs`. */
  | { verdict: 'wait'; waitMs: number; overlay: SettleOverlayReport | null }

function checkQuiet(view: SettleView, browser: SettleBrowserView, quietMs: number, timings: SettleTimings): QuietCheck {
  const probe = browser.probe
  // The answer must have been asked for after everything journalled so far, or it describes an older
  // page; and it must have queued behind the page's pending timers, or work may still be on its way.
  if (probe === undefined || probe.sentAt < view.lastEntryAt || probe.drainMs < timings.drainMs) return { verdict: 'ask' }
  const state = probe.state
  const overlay = state.overlay
  const busy = state.pendingSheets > 0 || state.readyState !== 'complete' || (state.vite?.pending ?? 0) > 0
  const quietFor = state.lastMutationAt === null ? Number.POSITIVE_INFINITY : state.now - state.lastMutationAt
  if (!busy && quietFor >= quietMs) return { verdict: 'quiet', overlay }
  const age = view.now - probe.receivedAt
  // Ask again so that the answer arrives about when the page could first be quiet.
  const waitMs = busy ? 25 - age : quietMs - quietFor - age - timings.drainMs
  return waitMs <= 0 ? { verdict: 'ask' } : { verdict: 'wait', waitMs, overlay }
}

/**
 * Decides what `waitForSettle` should do next. Pure: everything it knows is in `view`.
 */
export function decide(view: SettleView, timings: SettleTimings = DEFAULT_SETTLE_TIMINGS): SettleDecision {
  const { now, hmr, fs, browser } = view
  const windowStart = Math.min(fs?.firstAt ?? Number.POSITIVE_INFINITY, hmr.firstUpdateAt ?? Number.POSITIVE_INFINITY)
  const domChanged = changedAfter(browser, Number.isFinite(windowStart) ? windowStart : view.since)
  const resolve = (
    status: SettleStatus,
    signal: SettleSignal,
    reason: string,
    extra: { error?: SettleError; domChanged?: boolean } = {},
  ): SettleDecision => {
    const result: SettleOutcome = { status, signal, reason, domChanged: extra.domChanged ?? domChanged }
    if (extra.error !== undefined) result.error = extra.error
    return { action: 'resolve', result }
  }
  const overlayError = (overlay: SettleOverlayReport): SettleDecision => {
    const error: SettleError = { source: 'overlay', message: overlay.kind !== undefined ? `${overlay.kind}: ${overlay.message}` : overlay.message }
    if (overlay.file !== undefined) error.file = overlay.file
    if (overlay.line !== undefined) error.line = overlay.line
    if (overlay.column !== undefined) error.column = overlay.column
    return resolve('build_error', 'mutation-quiet', `the page shows the ${overlay.framework} error overlay`, { error })
  }

  // What the page has to do for the last update. A Next server-component change is on the page
  // only when a refetch of the server-rendered tree that began after the message has ended.
  const update = hmr.lastUpdate
  const reloaded = update !== undefined && browser !== undefined && browser.navigatedAtMin > update.at
  const serverAt = hmr.lastServerUpdateAt
  const refetchPending = browser !== undefined && serverAt !== undefined && !reloaded && !(browser.rscFetchStartedAtMin > serverAt)
  const refetching = refetchPending && hmr.lastRefetchAt !== undefined && hmr.lastRefetchAt >= serverAt

  // 1. A build error that arrived in the window and still stands.
  if (hmr.error !== undefined && hmr.errorInWindow) {
    return resolve('build_error', 'hmr', 'the dev server reported a build error', { error: toSettleError(hmr.error) })
  }

  // 2. Out of time.
  if (now >= view.deadline) {
    if (hmr.error !== undefined) {
      return resolve('build_error', 'timeout', 'the build was already broken and nothing fixed it', { error: toSettleError(hmr.error) })
    }
    const probe = browser?.probe
    if (probe !== undefined && probe.sentAt >= view.since && probe.state.overlay !== null) return overlayError(probe.state.overlay)
    if (hmr.building) return resolve('timeout', 'timeout', 'the dev server was still building')
    if (refetching) return resolve('timeout', 'timeout', 'the page was still refetching the server-rendered tree')
    if (hmr.lastUpdate === undefined) {
      if (fs === undefined) return resolve('no_update_observed', 'timeout', 'no file changed and the dev server sent no update', { domChanged: false })
      if (!domChanged) return resolve('no_update_observed', 'timeout', 'files changed but the page did not update')
    }
    if (browser === undefined && view.browserLeftAt !== undefined) {
      return resolve('timeout', 'timeout', 'the page disconnected and did not come back')
    }
    if (browser?.unresponsiveSince !== undefined) return resolve('timeout', 'timeout', 'the page stopped answering (frozen or discarded tab?)')
    return resolve('timeout', 'timeout', 'the page did not become quiet')
  }

  // 3. A build in progress: wait for the dev server to say how it ended.
  if (hmr.building) return { action: 'wait', until: view.deadline }

  // 4. The dev server sent an update or a reload in the window.
  if (update !== undefined) {
    // A broken build from before the window stays broken until the dev server says otherwise.
    if (hmr.error !== undefined) return { action: 'wait', until: view.deadline }
    // A file written after the last HMR message: its own message is probably still on the way.
    if (fs !== undefined && fs.lastAt > (hmr.lastEventAt ?? update.at) && now - fs.lastAt < timings.hmrExpectMs) {
      return { action: 'wait', until: fs.lastAt + timings.hmrExpectMs }
    }
    const graceOver = now - update.at >= timings.applyGraceMs
    if (browser === undefined) {
      // A page that was connected and left is reloading (or was closed): wait for the next document.
      if (view.browserLeftAt !== undefined || update.fullReload) return { action: 'wait', until: view.deadline }
      if (graceOver) return resolve('settled', 'hmr', 'an update was sent and no page is connected to confirm it', { domChanged: false })
      return { action: 'wait', until: update.at + timings.applyGraceMs }
    }
    // The browser said it is refetching: however long the server takes, only the end of that fetch counts.
    if (refetching) return { action: 'wait', until: view.deadline }
    const how = appliedHow(update, view, browser, reloaded, refetchPending)
    if (how === undefined) {
      if (!graceOver) return { action: 'wait', until: update.at + timings.applyGraceMs }
      // The page showed nothing. That only counts when it was running: an answer asked for after
      // the grace period that arrived late means the page was busy or suspended, and the update
      // was waiting behind whatever held it up.
      const probe = browser.probe
      if (probe === undefined || probe.sentAt < update.at + timings.applyGraceMs) return { action: 'probe' }
      if (probe.lateMs > timings.lateProbeMs) {
        const retryAt = probe.receivedAt + timings.lateProbeMs
        return now < retryAt ? { action: 'wait', until: retryAt } : { action: 'probe', fresh: true }
      }
    }
    const quiet = checkQuiet(view, browser, timings.quietMs, timings)
    if (quiet.verdict === 'ask') return { action: 'probe' }
    if (quiet.overlay !== null) return overlayError(quiet.overlay)
    if (quiet.verdict === 'wait') return { action: 'wait', until: now + quiet.waitMs }
    return resolve(
      'settled',
      'hmr',
      `${how ?? 'the update was sent and the page showed no sign of it within the grace period'}, and the page is quiet`,
    )
  }

  // 5. No update from the dev server. Files may have changed.
  if (fs === undefined) return { action: 'wait', until: view.deadline }
  if (browser === undefined) {
    if (view.browserLeftAt !== undefined) return { action: 'wait', until: view.deadline }
    if (now - fs.lastAt >= timings.fsGraceMs) {
      return resolve('settled', 'fs', 'files changed and no page is connected; nothing else can be observed', { domChanged: false })
    }
    return { action: 'wait', until: fs.lastAt + timings.fsGraceMs }
  }
  // With a live HMR socket, give the file's own message time to arrive before reading anything into mutations.
  if (hmr.live && now - fs.lastAt < timings.hmrExpectMs) return { action: 'wait', until: fs.lastAt + timings.hmrExpectMs }
  if (changedAfter(browser, fs.firstAt)) {
    const quiet = checkQuiet(view, browser, timings.baselineQuietMs, timings)
    if (quiet.verdict === 'ask') return { action: 'probe' }
    if (quiet.overlay !== null) return overlayError(quiet.overlay)
    if (quiet.verdict === 'wait') return { action: 'wait', until: now + quiet.waitMs }
    const how = browser.navigatedAtMin > fs.firstAt ? 'the document loaded again' : 'the page changed'
    return resolve('settled', 'mutation-quiet', `files changed, then ${how}, and the page is quiet`, { domChanged: true })
  }
  if (hmr.live) {
    const silentSince = Math.max(fs.lastAt, hmr.lastEventAt ?? 0)
    if (now - silentSince < timings.fsGraceMs) return { action: 'wait', until: silentSince + timings.fsGraceMs }
    // Last look at the page: an overlay without an HMR error message still means a broken build.
    const probe = browser.probe
    if ((probe === undefined || probe.sentAt < silentSince) && browser.unresponsiveSince === undefined) return { action: 'probe' }
    if (probe !== undefined && probe.sentAt >= silentSince && probe.state.overlay !== null) return overlayError(probe.state.overlay)
    return resolve('no_update_observed', 'fs', 'files changed, but the dev server sent no update and the page did not change', {
      domChanged: false,
    })
  }
  // HMR is not visible: only the page can tell, so keep watching it until the deadline.
  return { action: 'wait', until: view.deadline }
}

// ---------------------------------------------------------------------------
// The detector
// ---------------------------------------------------------------------------

interface PendingProbe {
  sentAt: number
  drainMs: number
  timer: ReturnType<typeof setTimeout>
}

interface BrowserClient {
  socket: SettleSocket
  doc: string | undefined
  connectedAt: number
  /** Page clock of the navigation start. */
  timeOrigin: number | undefined
  /**
   * Lower bound of (server clock - page clock). A probe sent at server time s
   * arrives at page time p, so the offset is at least s - p. The largest such
   * value seen is the tightest bound.
   */
  offsetMin: number
  /** Page clock of the last mutation or load known for this document. */
  lastChangePageAt: number | undefined
  viteApplied: number | undefined
  /** Page clock of the start of the newest finished fetch of Next's server-rendered tree. */
  rscFetchStartedPageAt: number | undefined
  probe: SettleProbeAnswer | undefined
  pending: Map<number, PendingProbe>
  unresponsiveSince: number | undefined
  watching: boolean
  viteHookSent: boolean
  open: boolean
}

function parseClientMessage(data: unknown): SettleClientMessage | undefined {
  try {
    let text: string | undefined
    if (typeof data === 'string') text = data
    else if (Buffer.isBuffer(data)) text = data.toString('utf8')
    else if (Array.isArray(data)) text = Buffer.concat(data as Buffer[]).toString('utf8')
    else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString('utf8')
    if (text === undefined) return undefined
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const type = (parsed as { type?: unknown }).type
    if (typeof type !== 'string' || !type.startsWith('settle:')) return undefined
    return parsed as SettleClientMessage
  } catch {
    return undefined
  }
}

type NewEntry =
  | { source: 'fs'; event: string; path: string; mtimeMs?: number }
  | { source: 'hmr'; event: HmrEvent }
  | { source: 'browser'; doc: string; name: string; pageAt?: number; detail?: string | number }

export function createSettleDetector(options: SettleDetectorOptions = {}): SettleDetector {
  const now = options.now ?? epochNow
  const timings: SettleTimings = { ...DEFAULT_SETTLE_TIMINGS, ...options.timings }
  const journalLimit = options.journalLimit ?? 5000
  const entries: JournalEntry[] = []
  const clients = new Set<BrowserClient>()
  const wakeups = new Set<() => void>()
  let seq = 0
  let probeId = 0
  let waiters = 0
  let closed = false

  const wake = (): void => {
    for (const wakeup of [...wakeups]) wakeup()
  }

  const append = (entry: NewEntry, at = now()): void => {
    seq += 1
    entries.push({ ...entry, seq, at } as JournalEntry)
    if (entries.length > journalLimit) entries.splice(0, entries.length - journalLimit)
    wake()
  }

  // --- file watching --------------------------------------------------------
  const projectDir = options.projectDir
  const onFsEvent = (event: string, absolutePath: string, mtimeMs?: number): void => {
    if (closed) return
    const rel = projectDir === undefined ? absolutePath : relative(projectDir, absolutePath)
    const entry: NewEntry = { source: 'fs', event, path: rel.split(sep).join('/') }
    if (mtimeMs !== undefined) entry.mtimeMs = mtimeMs
    append(entry)
  }
  const watchErrors: string[] = []
  const onWatchError = (error: unknown): void => {
    const code = (error as { code?: unknown } | null)?.code
    const message = error instanceof Error ? error.message : String(error)
    watchErrors.push(typeof code === 'string' && !message.includes(code) ? `${code}: ${message}` : message)
    if (watchErrors.length > 20) watchErrors.shift()
  }
  const customWatcher = options.watcher?.(onFsEvent, onWatchError)
  const fileWatcher =
    customWatcher === undefined && projectDir !== undefined
      ? startWatcherWithFallback(
          (polling, fail) => startChokidar(projectDir, options.ignored, polling, onFsEvent, fail),
          onWatchError,
          options.polling === true,
        )
      : undefined
  const watcher: SettleWatcher | undefined = customWatcher ?? fileWatcher

  // --- browser --------------------------------------------------------------
  const send = (client: BrowserClient, message: SettleServerMessage): void => {
    try {
      client.socket.send(JSON.stringify(message))
    } catch {
      // The socket is closing; its close handler cleans up.
    }
  }

  /** The document that counts: the one that connected last and is still open. */
  const primary = (): BrowserClient | undefined => {
    let best: BrowserClient | undefined
    for (const client of clients) {
      if (client.open && client.doc !== undefined && (best === undefined || client.connectedAt >= best.connectedAt)) best = client
    }
    return best
  }

  const setWatching = (client: BrowserClient, on: boolean): void => {
    if (client.watching === on || !client.open || client.doc === undefined) return
    client.watching = on
    send(client, { type: 'settle:watch', on })
  }

  /** Asks the page for its state. The answer (or giving up on it) wakes every waiter. */
  const probe = (client: BrowserClient, drainMs: number): void => {
    if (!client.open) return
    probeId += 1
    const id = probeId
    const timer = setTimeout(() => {
      client.pending.delete(id)
      client.unresponsiveSince ??= now()
      wake()
    }, timings.probeTimeoutMs)
    client.pending.set(id, { sentAt: now(), drainMs, timer })
    send(client, { type: 'settle:probe', id, drainMs })
  }

  const notePageChange = (client: BrowserClient, pageAt: number | null | undefined): void => {
    if (pageAt === null || pageAt === undefined) return
    if (client.lastChangePageAt === undefined || pageAt > client.lastChangePageAt) client.lastChangePageAt = pageAt
  }

  // --- HMR ------------------------------------------------------------------
  const hmr = options.hmr
  const sendViteHook = (client: BrowserClient): void => {
    const clientPath = hmr?.status().viteClientPath
    if (clientPath === undefined || client.viteHookSent || !client.open || client.doc === undefined) return
    client.viteHookSent = true
    send(client, { type: 'settle:vite', clientPath })
  }
  const unsubscribe = hmr?.subscribe((event) => {
    append({ source: 'hmr', event }, event.at)
    if (event.framework === 'vite') for (const client of clients) sendViteHook(client)
  })

  const onClientMessage = (client: BrowserClient, message: SettleClientMessage): void => {
    switch (message.type) {
      case 'settle:hello':
        client.doc = message.doc
        client.timeOrigin = message.timeOrigin
        client.connectedAt = now()
        append({ source: 'browser', doc: message.doc, name: 'hello', pageAt: message.at, detail: message.url })
        if (waiters > 0) setWatching(client, true)
        sendViteHook(client)
        // Calibrates the clock offset before anything depends on it.
        probe(client, 0)
        break
      case 'settle:mutation':
        notePageChange(client, message.at)
        append({ source: 'browser', doc: message.doc, name: 'mutation', pageAt: message.at, detail: message.seq })
        break
      case 'settle:event': {
        if (message.name === 'load' || message.name === 'sheet-loaded') notePageChange(client, message.at)
        if (message.name === 'vite-hooked') client.viteApplied ??= 0
        if (message.name === 'vite-applied' && typeof message.detail === 'number') {
          client.viteApplied = Math.max(client.viteApplied ?? 0, message.detail)
        }
        if (message.name === 'rsc-fetched' && typeof message.detail === 'number') {
          client.rscFetchStartedPageAt = Math.max(client.rscFetchStartedPageAt ?? Number.NEGATIVE_INFINITY, message.detail)
        }
        const entry: NewEntry = { source: 'browser', doc: message.doc, name: message.name, pageAt: message.at }
        if (message.detail !== undefined) entry.detail = message.detail
        append(entry)
        break
      }
      case 'settle:state': {
        const pending = client.pending.get(message.id)
        if (pending === undefined) return
        client.pending.delete(message.id)
        clearTimeout(pending.timer)
        const state = message.state
        client.offsetMin = Math.max(client.offsetMin, pending.sentAt - state.receivedAt)
        client.unresponsiveSince = undefined
        notePageChange(client, state.lastMutationAt)
        notePageChange(client, state.loadedAt)
        if (state.vite !== undefined) client.viteApplied = Math.max(client.viteApplied ?? 0, state.vite.applied)
        const answer: SettleProbeAnswer = {
          sentAt: pending.sentAt,
          receivedAt: now(),
          drainMs: pending.drainMs,
          lateMs: client.offsetMin - (pending.sentAt - state.receivedAt),
          state,
        }
        const kept = client.probe
        const drained = answer.drainMs >= timings.drainMs
        const keptDrained = kept !== undefined && kept.drainMs >= timings.drainMs
        // An answer that queued behind the page's timers is worth more than one that did not:
        // an undrained answer only replaces a drained one that it was asked after.
        const replace =
          kept === undefined ||
          (drained === keptDrained ? answer.sentAt >= kept.sentAt : drained ? true : answer.sentAt > kept.receivedAt)
        if (replace) client.probe = answer
        wake()
        break
      }
    }
  }

  const attachBrowser = (socket: SettleSocket): void => {
    const client: BrowserClient = {
      socket,
      doc: undefined,
      connectedAt: now(),
      timeOrigin: undefined,
      offsetMin: Number.NEGATIVE_INFINITY,
      lastChangePageAt: undefined,
      viteApplied: undefined,
      rscFetchStartedPageAt: undefined,
      probe: undefined,
      pending: new Map(),
      unresponsiveSince: undefined,
      watching: false,
      viteHookSent: false,
      open: true,
    }
    clients.add(client)
    socket.on('message', (data) => {
      const message = parseClientMessage(data)
      if (message !== undefined && client.open) onClientMessage(client, message)
    })
    const onClose = (): void => {
      if (!client.open) return
      client.open = false
      clients.delete(client)
      for (const pending of client.pending.values()) clearTimeout(pending.timer)
      client.pending.clear()
      if (client.doc !== undefined) append({ source: 'browser', doc: client.doc, name: 'close' })
      else wake()
    }
    socket.on('close', onClose)
    socket.on('error', onClose)
  }

  // --- views ----------------------------------------------------------------
  const position = (since: number | JournalPosition | undefined): JournalPosition => {
    if (since === undefined) return { seq, at: now() }
    if (typeof since === 'number') return { seq: -1, at: since }
    return since
  }

  /**
   * When a file change happened. The mtime is when the write happened; the
   * journal time is when the watcher got round to reporting it. The mtime is
   * trusted only when it is plausibly this change.
   */
  const fsTime = (entry: Extract<JournalEntry, { source: 'fs' }>): number => {
    const mtime = entry.mtimeMs
    return mtime !== undefined && mtime <= entry.at && entry.at - mtime < 10_000 ? mtime : entry.at
  }

  const inWindow = (entry: JournalEntry, since: JournalPosition): boolean => {
    if (since.seq >= 0) return entry.seq > since.seq
    return (entry.source === 'fs' ? fsTime(entry) : entry.at) >= since.at
  }

  const buildView = (since: JournalPosition, deadline: number): { view: SettleView; files: string[] } => {
    const files: string[] = []
    let fs: SettleView['fs']
    let firstUpdateAt: number | undefined
    let lastUpdate: SettleView['hmr']['lastUpdate']
    let lastEventAt: number | undefined
    let lastServerUpdateAt: number | undefined
    let lastRefetchAt: number | undefined
    let lastAppliedReportAt: number | undefined
    let errorInWindow = false
    let lastEntryAt = since.at
    let lastCloseAt: number | undefined
    for (const entry of entries) {
      if (!inWindow(entry, since)) continue
      if (entry.at > lastEntryAt) lastEntryAt = entry.at
      if (entry.source === 'fs') {
        if (!files.includes(entry.path)) files.push(entry.path)
        // A change that is in the window by journal order belongs to it even if its mtime says earlier.
        const at = Math.max(fsTime(entry), since.at)
        fs = fs === undefined ? { firstAt: at, lastAt: at } : { firstAt: Math.min(fs.firstAt, at), lastAt: Math.max(fs.lastAt, at) }
      } else if (entry.source === 'hmr') {
        const event = entry.event
        lastEventAt = event.at
        if (event.kind === 'error') errorInWindow = true
        const sent = event.detail.direction === 'upstream-to-client'
        if (event.kind === 'updated' && !sent) {
          if (event.detail.refetch === true) lastRefetchAt = event.at
          if (event.detail.applied === true) lastAppliedReportAt = event.at
        }
        if ((event.kind === 'updated' && sent) || event.kind === 'full-reload') {
          firstUpdateAt ??= event.at
          const server = event.kind === 'updated' && event.detail.server === true
          if (server) lastServerUpdateAt = event.at
          lastUpdate = {
            at: event.at,
            fullReload: event.kind === 'full-reload',
            timestamp: event.detail.timestamp,
            framework: event.framework,
            server,
          }
        }
      } else if (entry.name === 'close') {
        lastCloseAt = entry.at
      }
    }
    const status = hmr?.status()
    const client = primary()
    let browser: SettleBrowserView | undefined
    if (client !== undefined) {
      browser = {
        navigatedAtMin: client.timeOrigin === undefined ? Number.NEGATIVE_INFINITY : client.timeOrigin + client.offsetMin,
        lastChangeAtMin: client.lastChangePageAt === undefined ? Number.NEGATIVE_INFINITY : client.lastChangePageAt + client.offsetMin,
        viteApplied: client.viteApplied,
        rscFetchStartedAtMin: client.rscFetchStartedPageAt === undefined ? Number.NEGATIVE_INFINITY : client.rscFetchStartedPageAt + client.offsetMin,
        probe: client.probe,
        unresponsiveSince: client.unresponsiveSince,
      }
    }
    const view: SettleView = {
      now: now(),
      since: since.at,
      deadline,
      lastEntryAt,
      fs,
      hmr: {
        live: status?.live ?? false,
        building: status?.building ?? false,
        error: status?.error,
        errorInWindow,
        firstUpdateAt,
        lastUpdate,
        lastServerUpdateAt,
        lastRefetchAt,
        lastAppliedReportAt,
        lastEventAt,
      },
      browser,
      browserLeftAt: browser === undefined ? lastCloseAt : undefined,
    }
    return { view, files }
  }

  /** Resolves at server time `until`, or earlier when something is journalled or a probe is answered. */
  const nextWake = (until: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        wakeups.delete(done)
        resolve()
      }
      const timer = setTimeout(done, Math.max(0, until - now()))
      wakeups.add(done)
    })

  const waitForSettle = async (waitOptions: WaitForSettleOptions): Promise<SettleResult> => {
    const startedAt = now()
    const since = position(waitOptions.since)
    const deadline = startedAt + waitOptions.timeoutMs
    waiters += 1
    try {
      // An answer straight away tightens the clock offset, which the comparison of page times needs.
      const first = primary()
      if (first !== undefined) probe(first, 0)
      for (;;) {
        // Also reaches documents that connected while waiting (a reload).
        for (const client of clients) setWatching(client, true)
        const { view, files } = buildView(since, deadline)
        const decision: SettleDecision = closed
          ? { action: 'resolve', result: { status: 'timeout', signal: 'timeout', reason: 'the detector was closed', domChanged: false } }
          : decide(view, timings)
        if (decision.action === 'resolve') {
          // The page updated but the watcher named no file: look once, so a dropped file event does not empty the list.
          const updated = decision.result.status === 'settled' || decision.result.status === 'build_error'
          if (updated && files.length === 0 && fileWatcher !== undefined && projectDir !== undefined && !closed) {
            for (const found of await sweepChangedFiles(projectDir, since.at, options.ignored)) {
              files.push(found.path)
              append({ source: 'fs', event: 'sweep', path: found.path, mtimeMs: found.mtimeMs })
            }
          }
          const at = now()
          const result: SettleResult = {
            ...decision.result,
            ms: at - startedAt,
            filesChanged: files,
            at,
            browser: view.browser !== undefined,
          }
          const visibility = view.browser?.probe?.state.visibility
          if (visibility !== undefined) result.visibility = visibility
          return result
        }
        if (decision.action === 'probe') {
          const client = primary()
          // Unless an answer that will be recent enough is already on its way, ask.
          const asked =
            client !== undefined &&
            [...client.pending.values()].some(
              (pending) => pending.drainMs >= timings.drainMs && (decision.fresh === true || pending.sentAt >= view.lastEntryAt),
            )
          if (client !== undefined && !asked) probe(client, timings.drainMs)
          await nextWake(deadline)
          continue
        }
        await nextWake(Math.min(decision.until, deadline))
      }
    } finally {
      waiters -= 1
      if (waiters === 0) for (const client of clients) setWatching(client, false)
    }
  }

  return {
    ready: () => watcher?.ready ?? Promise.resolve(),
    attachBrowser,
    mark: () => ({ seq, at: now() }),
    waitForSettle,
    journal(since) {
      if (since === undefined) return [...entries]
      const from = position(since)
      return entries.filter((entry) => inWindow(entry, from))
    },
    status: () => ({
      browsers: [...clients].filter((client) => client.open && client.doc !== undefined).length,
      watching: watcher !== undefined,
      watchBackend: fileWatcher?.backend(),
      watchedDirectories: watcher?.directories?.(),
      watchErrors: [...watchErrors],
      journal: entries.length,
      hmr: hmr?.status(),
    }),
    async close() {
      if (closed) return
      closed = true
      unsubscribe?.()
      for (const client of clients) {
        for (const pending of client.pending.values()) clearTimeout(pending.timer)
        client.pending.clear()
      }
      wake()
      await watcher?.close()
    },
  }
}
