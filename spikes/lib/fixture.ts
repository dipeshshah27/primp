import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getFreePort } from '../../packages/server/src/index.ts'
import { onCleanup, onExitSync, spawnGroup, type ManagedProcess } from './proc.ts'
import { since, waitFor } from './wait.ts'

/**
 * Fixture dev servers for spikes and tests.
 *
 * `startFixture` never runs the checked-in fixture directly (unless asked to
 * with `inPlace`). It makes a working copy under `<repo>/.tmp/<run-id>/<name>/`
 * holding the fixture's own files, and links `node_modules` back to the
 * checked-in install with a symlink, so nothing large is copied.
 *
 * What makes the symlinked copy work, per fixture (all measured, see S1):
 *   - vite-react-19: `PRIMP_FIXTURE_CACHE_DIR=.vite` gives the copy its own
 *     dependency cache; otherwise every copy rewrites the shared
 *     `node_modules/.vite`.
 *   - sveltekit-svelte-5: its config already keeps the Vite cache beside the
 *     config and allows the real `node_modules` path to be served.
 *   - next-16-turbopack: Turbopack does not follow a `node_modules` symlink
 *     that leaves its root. The fixture's `next.config.ts` sets
 *     `turbopack.root` to the closest directory holding both the copy and the
 *     real install, which is the repo root for a copy under `.tmp/`. So the
 *     copy MUST live inside the repo; `.tmp/` is the only place the harness
 *     uses.
 *   - static-html, cls-corpus: no dependencies.
 */

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const FIXTURES_ROOT = join(REPO_ROOT, 'fixtures')
export const TMP_ROOT = join(REPO_ROOT, '.tmp')

export type FixtureName = 'vite-react-19' | 'next-16-turbopack' | 'sveltekit-svelte-5' | 'static-html' | 'cls-corpus' | 'cls-heldout' | 'cls-heldout-2'

/** One entry of a fixture's `labels.json`. Fixtures add optional fields of their own. */
export interface FixtureLabel {
  label: string
  /** Path relative to the fixture root. */
  file: string
  /** 1-based line of the `<` of the opening tag. */
  line: number
  /** 1-based column of the `<` of the opening tag. */
  col: number
  tag: string
  kind: string
  /** Route that renders the element. */
  page?: string
  /** Rendered on every page (SvelteKit layout elements). */
  everyPage?: boolean
  /** Number of DOM nodes rendered from this one source element, when more than one. */
  instances?: number
  /** `signed-in` / `signed-out`: only in the DOM in that session state (SvelteKit). */
  when?: string
  /** Present when the element is not in the DOM after a plain GET of `page` (Next). */
  note?: string
}

export interface StartFixtureOptions {
  /** Groups working copies under `.tmp/<runId>/`. Default: one id per process (`defaultRunId()`). */
  runId?: string
  /** Directory name of the copy inside the run directory. Default: the fixture name. Set it to run two copies at once. */
  copyName?: string
  /**
   * Run the checked-in fixture directory instead of a copy. `editFile` then
   * saves each original before the first edit and `stop()`, SIGINT and process
   * exit put them back. Only for a fixture that cannot run from a copy.
   */
  inPlace?: boolean
  /** Port to listen on. Default: a free port. Set it to restart a fixture where the previous one was. */
  port?: number
  /** Extra environment for the dev server. */
  env?: Record<string, string>
  /** Path polled until it answers HTTP 200. Default `/`. */
  readyPath?: string
  /** Default 120 s (a cold Next start compiles the first page). */
  readyTimeoutMs?: number
  /** Copy the dev server's output to stderr as it arrives. */
  echo?: boolean
}

export interface FixtureHandle {
  name: FixtureName
  /** Directory the dev server runs in: the working copy, or the checked-in fixture when `inPlace`. */
  dir: string
  /** The checked-in fixture directory. */
  sourceDir: string
  inPlace: boolean
  port: number
  /** `http://localhost:<port>`. Dev servers here listen on `::1` only, so never use 127.0.0.1. */
  url: string
  /** Process group id of the dev server. */
  pid: number
  /** Parsed `labels.json` (empty when the fixture has none). */
  labels: FixtureLabel[]
  /** Milliseconds from spawn to the first HTTP 200. */
  startupMs: number
  /** The dev server's stdout and stderr so far. */
  output(): string
  /** Output after the first `offset` characters; take `output().length` as a mark before an action. */
  outputSince(offset: number): string
  /** Kills the dev server's process group, restores in-place edits, removes the working copy. Safe to call twice. */
  stop(): Promise<void>
  /** @internal originals of files edited in place, by absolute path */
  originals: Map<string, string>
}

/** Top-level names that are build output or installs, never part of the copy. */
const NOT_COPIED = new Set([
  'node_modules',
  '.next',
  '.svelte-kit',
  '.vite',
  '.turbo',
  'dist',
  'build',
  'next-env.d.ts',
  'test-results',
  '.DS_Store',
])

/** Variables that tell tools they run under a coding agent; a dev server should start as it would from a terminal. */
const AGENT_ENV = /^(CLAUDE|CLAUDECODE|CODEX|CURSOR_AGENT|AI_AGENT)/

const FIXTURE_ENV: Partial<Record<FixtureName, Record<string, string>>> = {
  // A cache of its own beside the copy; see the header comment.
  'vite-react-19': { PRIMP_FIXTURE_CACHE_DIR: '.vite' },
}

let processRunId: string | undefined

/** The run id shared by every `startFixture` call of this process that does not pass its own. */
export function defaultRunId(): string {
  processRunId ??= `run-${Date.now().toString(36)}-${process.pid}`
  return processRunId
}

function assertInside(parent: string, child: string): void {
  const rel = relative(parent, child)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`refusing to touch ${child}: not inside ${parent}`)
  }
}

function removeTree(dir: string): void {
  assertInside(TMP_ROOT, dir)
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  // Remove the run directory too once its last copy is gone.
  const parent = dirname(dir)
  try {
    if (parent !== TMP_ROOT && readdirSync(parent).length === 0) rmdirSync(parent)
  } catch {
    // Another copy appeared, or it is already gone.
  }
}

function makeWorkingCopy(sourceDir: string, dir: string): void {
  assertInside(TMP_ROOT, dir)
  if (existsSync(dir)) throw new Error(`working copy ${dir} already exists; pass a different copyName or runId`)
  mkdirSync(dirname(dir), { recursive: true })
  cpSync(sourceDir, dir, {
    recursive: true,
    filter: (source) => {
      const rel = relative(sourceDir, source)
      const top = rel.split(sep, 1)[0] ?? ''
      return !NOT_COPIED.has(top) && !top.endsWith('.tsbuildinfo')
    },
  })
  const modules = join(sourceDir, 'node_modules')
  if (existsSync(modules)) symlinkSync(realpathSync(modules), join(dir, 'node_modules'), 'dir')
}

function restoreOriginals(originals: Map<string, string>): void {
  for (const [file, content] of originals) writeFileSync(file, content)
  originals.clear()
}

function tail(text: string, lines = 30): string {
  return text.trimEnd().split('\n').slice(-lines).join('\n')
}

/**
 * Starts a fixture's dev server on a free port and waits until it answers
 * HTTP 200. The command is the fixture's own `dev` (or `start`) script, run
 * with `PORT` set, the fixture's `node_modules/.bin` on `PATH`, and telemetry off.
 */
export async function startFixture(name: FixtureName, options: StartFixtureOptions = {}): Promise<FixtureHandle> {
  const sourceDir = join(FIXTURES_ROOT, name)
  const manifest = JSON.parse(readFileSync(join(sourceDir, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>
  }
  const script = manifest.scripts?.dev ?? manifest.scripts?.start
  if (script === undefined) throw new Error(`fixture ${name} has neither a "dev" nor a "start" script`)

  const inPlace = options.inPlace === true
  const dir = inPlace ? sourceDir : join(TMP_ROOT, options.runId ?? defaultRunId(), options.copyName ?? name)
  const originals = new Map<string, string>()
  let removeCopyHook: (() => void) | undefined
  let removeRestoreHook: (() => void) | undefined
  if (inPlace) {
    removeRestoreHook = onExitSync(() => restoreOriginals(originals))
  } else {
    makeWorkingCopy(sourceDir, dir)
    removeCopyHook = onExitSync(() => removeTree(dir))
  }

  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) if (!AGENT_ENV.test(key)) env[key] = value
  const port = options.port ?? (await getFreePort())
  Object.assign(env, {
    PORT: String(port),
    PATH: `${join(dir, 'node_modules', '.bin')}${delimiter}${process.env.PATH ?? ''}`,
    // No outbound telemetry from test runs.
    NEXT_TELEMETRY_DISABLED: '1',
    DO_NOT_TRACK: '1',
    NO_UPDATE_NOTIFIER: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    ...FIXTURE_ENV[name],
    ...options.env,
  })
  delete env.NODE_OPTIONS

  const started = performance.now()
  let child: ManagedProcess | undefined
  let stopping: Promise<void> | undefined
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      await child?.stop()
      if (inPlace) {
        restoreOriginals(originals)
        removeRestoreHook?.()
      } else {
        removeTree(dir)
        removeCopyHook?.()
      }
      removeCleanup()
    })()
    return stopping
  }
  const removeCleanup = onCleanup(stop)

  try {
    // `exec` so the dev server takes the shell's place as group leader.
    child = spawnGroup(`exec ${script}`, { cwd: dir, env, echo: options.echo ? name : undefined })
    const running = child
    const url = `http://localhost:${port}`
    const readyUrl = url + (options.readyPath ?? '/')
    await waitFor(
      async () => {
        if (running.exit !== undefined) return true
        const response = await fetch(readyUrl, { redirect: 'manual', signal: AbortSignal.timeout(60_000) })
        await response.arrayBuffer()
        return response.status === 200
      },
      { timeoutMs: options.readyTimeoutMs ?? 120_000, intervalMs: 100, what: `${name} to answer 200 at ${readyUrl}` },
    )
    if (running.exit !== undefined) {
      throw new Error(`${name} dev server exited (code ${running.exit.code}, signal ${running.exit.signal})`)
    }
    const labelsFile = join(dir, 'labels.json')
    return {
      name,
      dir,
      sourceDir,
      inPlace,
      port,
      url,
      pid: running.pid,
      labels: existsSync(labelsFile) ? (JSON.parse(readFileSync(labelsFile, 'utf8')) as FixtureLabel[]) : [],
      startupMs: since(started),
      output: running.output,
      outputSince: running.outputSince,
      stop,
      originals,
    }
  } catch (error) {
    const output = child?.output() ?? ''
    await stop()
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${message}\n--- last output of ${name} ---\n${tail(output)}`)
  }
}

export interface FileEdit {
  /** Absolute path of the edited file. */
  file: string
  before: string
  after: string
  /** `performance.now()` right after the write returned. */
  writtenAt: number
  /** Writes `before` back. */
  revert(): void
}

function resolveInside(handle: FixtureHandle, relPath: string): string {
  const file = resolve(handle.dir, relPath)
  assertInside(handle.dir, file)
  return file
}

/** Reads a file of the fixture the dev server is running from. */
export function readFixtureFile(handle: FixtureHandle, relPath: string): string {
  return readFileSync(resolveInside(handle, relPath), 'utf8')
}

/**
 * Rewrites one source file of the running fixture: `transform` receives the
 * current text and returns the new text. Throws when the transform changes
 * nothing, so an edit whose search string no longer matches is noticed.
 *
 * The file is always the one under `handle.dir`. For a working copy the
 * checked-in fixture is never touched. For an `inPlace` handle the original is
 * remembered and restored by `handle.stop()`, on SIGINT and at process exit.
 */
export function editFile(handle: FixtureHandle, relPath: string, transform: (source: string) => string): FileEdit {
  const file = resolveInside(handle, relPath)
  if (!handle.inPlace) assertInside(TMP_ROOT, file)
  const before = readFileSync(file, 'utf8')
  const after = transform(before)
  if (after === before) throw new Error(`editFile(${relPath}): the transform did not change the file`)
  if (handle.inPlace && !handle.originals.has(file)) handle.originals.set(file, before)
  writeFileSync(file, after)
  return {
    file,
    before,
    after,
    writtenAt: performance.now(),
    revert: () => writeFileSync(file, before),
  }
}

/** A `transform` for `editFile` that replaces exactly one occurrence of `search` and throws otherwise. */
export function replaceOnce(search: string, replacement: string): (source: string) => string {
  return (source) => {
    const first = source.indexOf(search)
    if (first === -1) throw new Error(`replaceOnce: ${JSON.stringify(search)} not found`)
    if (source.indexOf(search, first + search.length) !== -1) {
      throw new Error(`replaceOnce: ${JSON.stringify(search)} occurs more than once`)
    }
    return source.slice(0, first) + replacement + source.slice(first + search.length)
  }
}

/** Labels a plain GET of `page` puts in the DOM for a signed-out visitor. */
export function labelsOnPage(handle: FixtureHandle, page: string): FixtureLabel[] {
  return handle.labels.filter(
    (entry) => (entry.page === page || entry.everyPage === true) && entry.note === undefined && entry.when !== 'signed-in',
  )
}
