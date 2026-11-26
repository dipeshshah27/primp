import { spawn } from 'node:child_process'

/**
 * Child processes and cleanup.
 *
 * Every dev server the harness starts is the leader of its own process group
 * (`detached: true`), so stopping it means signalling the whole group: a dev
 * script is usually a shell or a package-manager shim with the real server
 * below it, and killing only the first process would leave the server running.
 *
 * Cleanup has two layers:
 *   - `onCleanup` callbacks run in reverse order on normal completion
 *     (`runCleanups`), on SIGINT / SIGTERM / SIGHUP and on an uncaught error.
 *   - `onExitSync` callbacks run inside the process `exit` event, where only
 *     synchronous work is possible. They are the last resort that kills
 *     process groups and removes working copies if the orderly path was cut
 *     short (for example by `process.exit()` in the middle of a spike).
 *
 * Two things that would defeat this:
 *   - Playwright installs its own SIGINT/SIGTERM/SIGHUP handlers at launch and
 *     calls `process.exit(130)` from them; `launchBrowser` turns them off.
 *   - tsx SIGKILLs a child that does not return to its event loop right after
 *     a relayed signal (see `installHandlers`), so the signal handlers only
 *     start asynchronous work.
 */

export type Cleanup = () => Promise<void> | void

const cleanups: Cleanup[] = []
const exitHooks = new Set<() => void>()
let handlersInstalled = false
let cleaning: Promise<void> | undefined

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Registers work to undo something. Returns a function that unregisters it (call it once the work is done). */
export function onCleanup(cleanup: Cleanup): () => void {
  installHandlers()
  cleanups.push(cleanup)
  return () => {
    const index = cleanups.lastIndexOf(cleanup)
    if (index !== -1) cleanups.splice(index, 1)
  }
}

/** Registers synchronous last-resort work for the `exit` event. Returns the unregister function. */
export function onExitSync(hook: () => void): () => void {
  installHandlers()
  exitHooks.add(hook)
  return () => exitHooks.delete(hook)
}

/** Runs and removes every registered cleanup, newest first. Errors are printed, never thrown. */
export function runCleanups(): Promise<void> {
  if (cleaning !== undefined) return cleaning
  const run = (async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop()
      try {
        await cleanup?.()
      } catch (error) {
        console.error('cleanup failed:', error)
      }
    }
  })()
  cleaning = run
  // Cleared only after the assignment above: with nothing to clean, the function finishes before
  // `cleaning` is assigned, and a finished promise left in place would swallow later cleanups.
  void run.finally(() => {
    if (cleaning === run) cleaning = undefined
  })
  return run
}

/** Repeats of a signal this soon after the first are the same Ctrl-C arriving twice, not impatience. */
const SIGNAL_ECHO_MS = 2000

function installHandlers(): void {
  if (handlersInstalled) return
  handlersInstalled = true
  let signalledAt: number | undefined
  // The listeners stay registered for the life of the process. Under `tsx` (and `pnpm`) one
  // Ctrl-C reaches this process two or three times: once from the terminal and again relayed
  // by each wrapper. tsx also SIGKILLs its child 30 ms after a relayed signal unless the
  // child's signal handler returns to the event loop, so a handler here must never exit
  // synchronously and never go away.
  const onSignal = (signal: NodeJS.Signals, code: number): void => {
    if (signalledAt !== undefined) {
      if (Date.now() - signalledAt > SIGNAL_ECHO_MS) setImmediate(() => process.exit(code))
      return
    }
    signalledAt = Date.now()
    console.error(`\n${signal} received: stopping servers and removing working copies`)
    void Promise.race([runCleanups(), sleep(15_000)]).then(() => process.exit(code))
  }
  process.on('SIGINT', () => onSignal('SIGINT', 130))
  process.on('SIGTERM', () => onSignal('SIGTERM', 143))
  process.on('SIGHUP', () => onSignal('SIGHUP', 129))
  const onFatal = (kind: string, error: unknown): void => {
    console.error(`${kind}:`, error)
    void Promise.race([runCleanups(), sleep(15_000)]).then(() => process.exit(1))
  }
  process.once('uncaughtException', (error) => onFatal('uncaught exception', error))
  process.once('unhandledRejection', (error) => onFatal('unhandled rejection', error))
  process.on('exit', () => {
    // Newest first, like the orderly path: a dev server is killed before its directory is removed.
    for (const hook of [...exitHooks].reverse()) {
      try {
        hook()
      } catch {
        // Nothing useful can be done with an error this late.
      }
    }
  })
}

/** Blocks the thread; only for the `exit` event, where nothing asynchronous runs any more. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** SIGKILL to the whole group, then a blocking wait (at most `waitMs`) until it is gone. For exit hooks. */
export function killGroupSync(pgid: number, waitMs = 2000): void {
  signalGroup(pgid, 'SIGKILL')
  const deadline = Date.now() + waitMs
  while (groupAlive(pgid) && Date.now() < deadline) sleepSync(10)
}

export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    // EPERM means "exists, but not ours to signal"; only ESRCH means gone.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal)
  } catch {
    // Already gone.
  }
}

/** SIGTERM to the whole group, then SIGKILL if anything is left after `graceMs`. */
export async function killGroup(pgid: number, graceMs = 3000): Promise<void> {
  if (!groupAlive(pgid)) return
  signalGroup(pgid, 'SIGTERM')
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline) {
    if (!groupAlive(pgid)) return
    await sleep(25)
  }
  signalGroup(pgid, 'SIGKILL')
  const hardDeadline = Date.now() + 2000
  while (Date.now() < hardDeadline && groupAlive(pgid)) await sleep(25)
}

export interface ManagedProcess {
  /** Process id of the group leader; also the process group id. */
  pid: number
  /** Everything written to stdout and stderr so far, interleaved as it arrived. */
  output(): string
  /** Output written after the first `offset` characters; use `output().length` as a mark. */
  outputSince(offset: number): string
  /** Set once the leader has exited. */
  exit: { code: number | null; signal: NodeJS.Signals | null } | undefined
  /** Resolves when the leader exits. */
  exited: Promise<void>
  /** Kills the whole process group and waits until it is gone. Safe to call twice. */
  stop(): Promise<void>
}

export interface SpawnGroupOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  /** Copies each output chunk to this process's stderr, prefixed. */
  echo?: string
}

/** Starts `sh -c <command>` as the leader of a new process group, with its output captured. */
export function spawnGroup(command: string, options: SpawnGroupOptions): ManagedProcess {
  const child = spawn('/bin/sh', ['-c', command], {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const pid = child.pid
  if (pid === undefined) throw new Error(`could not start: ${command}`)

  let output = ''
  const collect = (chunk: Buffer): void => {
    const text = chunk.toString('utf8')
    output += text
    if (options.echo !== undefined) process.stderr.write(text.replace(/^(?=.)/gm, `[${options.echo}] `))
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)

  const removeExitHook = onExitSync(() => killGroupSync(pid))
  let stopping: Promise<void> | undefined
  const managed: ManagedProcess = {
    pid,
    output: () => output,
    outputSince: (offset) => output.slice(offset),
    exit: undefined,
    exited: new Promise<void>((resolve) => {
      child.once('exit', (code, signal) => {
        managed.exit = { code, signal }
        resolve()
      })
      child.once('error', (error) => {
        output += `\n[spawn error] ${String(error)}\n`
        managed.exit = { code: null, signal: null }
        resolve()
      })
    }),
    stop() {
      stopping ??= (async () => {
        await killGroup(pid)
        removeExitHook()
        removeCleanup()
      })()
      return stopping
    },
  }
  const removeCleanup = onCleanup(() => managed.stop())
  return managed
}
