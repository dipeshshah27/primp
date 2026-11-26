import { randomBytes } from 'node:crypto'
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { SESSION_FILE_VERSION, SessionFileSchema, type SessionFile } from '../../protocol/src/session.ts'

/**
 * Session files: how `primp mcp` finds the running primp process.
 *
 * The long-running process writes `<sessions dir>/<id>.json` with its control
 * port and bearer token, and removes it when it exits. The shim reads every
 * file in that directory, drops the ones whose process is gone, and picks the
 * session that belongs to the directory the agent is working in.
 *
 * Permissions. The file holds a secret, so on POSIX the directory is created
 * 0700 and the file 0600. On Windows Node ignores those mode bits (only the
 * read-only flag is honoured); the file instead inherits the ACL of the user
 * profile directory it lives under, which by default grants access to the
 * owner, SYSTEM and Administrators only. Nothing extra is done there.
 *
 * The location is deliberately not taken from XDG_CACHE_HOME: an agent host
 * started from the desktop often has a different environment from the shell
 * that started primp, and the two must agree on one path.
 */

/** Overrides the sessions directory. Meant for tests; both processes must set it. */
export const SESSION_DIR_ENV = 'PRIMP_SESSION_DIR'

export function defaultSessionDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[SESSION_DIR_ENV]
  if (override) return resolve(override)
  return join(homedir(), '.cache', 'primp', 'sessions')
}

export interface SessionDirOption {
  /** Directory holding the session files. Defaults to {@link defaultSessionDir}. */
  dir?: string
}

export interface WriteSessionInput {
  /** Directory primp was started for. Stored with symlinks resolved. */
  projectRoot: string
  controlPort: number
  token: string
  proxyUrl: string
  /** Defaults to the current process. */
  pid?: number
  /** Defaults to now. */
  startedAt?: Date
}

export interface SessionHandle {
  /** Absolute path of the session file. */
  path: string
  session: SessionFile
  /** Deletes the file. Synchronous and safe to call more than once. */
  remove(): void
}

/** A session file that parsed and whose process is running. */
export interface LiveSession {
  path: string
  session: SessionFile
}

export type SessionLookup =
  /** Exactly one session belongs to the directory. */
  | { kind: 'found'; path: string; session: SessionFile; relation: 'contains-cwd' | 'inside-cwd' }
  /** No running session is related to the directory. */
  | { kind: 'none' }
  /** The directory is above several running projects; the caller must narrow it down. */
  | { kind: 'ambiguous'; projectRoots: string[] }

/**
 * Writes the session file for a running primp process and arranges for it to
 * be removed when the process exits normally. A process killed with SIGKILL
 * leaves the file behind; the next lookup removes it (see {@link listSessions}).
 */
export function writeSessionFile(input: WriteSessionInput, options: SessionDirOption = {}): SessionHandle {
  const dir = options.dir ?? defaultSessionDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })

  const session = SessionFileSchema.parse({
    version: SESSION_FILE_VERSION,
    pid: input.pid ?? process.pid,
    projectRoot: canonical(input.projectRoot),
    controlPort: input.controlPort,
    token: input.token,
    proxyUrl: input.proxyUrl,
    startedAt: (input.startedAt ?? new Date()).toISOString(),
  } satisfies SessionFile)

  const id = randomBytes(8).toString('hex')
  const path = join(dir, `${id}.json`)
  // Written under a dot-name first and renamed, so a reader never sees half a
  // file. 'wx' refuses to follow a path somebody else created in the meantime.
  const partial = join(dir, `.${id}.partial`)
  const fd = openSync(partial, 'wx', 0o600)
  try {
    writeSync(fd, `${JSON.stringify(session, null, 2)}\n`)
  } finally {
    closeSync(fd)
  }
  renameSync(partial, path)

  let removed = false
  const remove = (): void => {
    if (removed) return
    removed = true
    process.off('exit', remove)
    rmSync(path, { force: true })
  }
  // 'exit' also fires after process.exit() called from a signal handler, which
  // is how the CLI shuts down. It does not fire for an unhandled signal.
  process.on('exit', remove)

  return { path, session, remove }
}

/**
 * Reads the sessions directory and returns the sessions whose process is
 * running. Files that name a dead process are deleted on the way.
 *
 * Files this version cannot parse are left alone when their process is alive
 * or unknown: they may belong to a newer primp with a different file format.
 */
export function listSessions(options: SessionDirOption = {}): LiveSession[] {
  const dir = options.dir ?? defaultSessionDir()
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }

  const live: LiveSession[] = []
  for (const name of names) {
    if (name.startsWith('.') || !name.endsWith('.json')) continue
    const path = join(dir, name)
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      continue
    }
    const pid = readPid(raw)
    if (pid !== undefined && !isProcessAlive(pid)) {
      rmSync(path, { force: true })
      continue
    }
    const parsed = SessionFileSchema.safeParse(raw)
    if (parsed.success) live.push({ path, session: parsed.data })
  }
  return live
}

/**
 * Finds the session for the directory an agent is working in.
 *
 * 1. Sessions whose project root is `cwd` or one of its parents win; the
 *    nearest root is chosen. This is the walk up from `cwd`, and it covers an
 *    agent working anywhere inside the project primp was started for.
 * 2. Otherwise sessions started somewhere below `cwd` are considered, which
 *    covers an agent opened at a monorepo root while primp runs in one app,
 *    and agent hosts that start MCP servers in the home directory. One such
 *    project is used; several are reported as ambiguous rather than guessed.
 *
 * Two sessions for the same root (a second `primp` started before the first
 * exited) resolve to the most recently started one.
 */
export function findSession(cwd: string, options: SessionDirOption = {}): SessionLookup {
  const here = canonical(cwd)
  const sessions = listSessions(options).sort(
    (a, b) => Date.parse(b.session.startedAt) - Date.parse(a.session.startedAt),
  )

  let nearest: LiveSession | undefined
  for (const candidate of sessions) {
    if (!isInside(candidate.session.projectRoot, here)) continue
    if (!nearest || candidate.session.projectRoot.length > nearest.session.projectRoot.length) nearest = candidate
  }
  if (nearest) return { kind: 'found', ...nearest, relation: 'contains-cwd' }

  const below = sessions.filter((candidate) => isInside(here, candidate.session.projectRoot))
  const roots = [...new Set(below.map((candidate) => candidate.session.projectRoot))]
  const only = below[0]
  if (only && roots.length === 1) return { kind: 'found', ...only, relation: 'inside-cwd' }
  if (roots.length > 1) return { kind: 'ambiguous', projectRoots: roots.sort() }
  return { kind: 'none' }
}

/** Deletes one session file; used when its control endpoint turns out to be gone. */
export function removeSessionFile(path: string): void {
  rmSync(path, { force: true })
}

/**
 * Whether a process with this id exists. EPERM means it exists but belongs to
 * another user. A recycled pid makes a dead session look alive; the shim
 * handles that case when the control endpoint refuses the connection.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function readPid(raw: unknown): number | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const pid = (raw as { pid?: unknown }).pid
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : undefined
}

/**
 * Absolute path with symlinks resolved and, on case-insensitive volumes, the
 * spelling the file system reports, so that two routes to one directory compare
 * equal (for example /tmp and /private/tmp on macOS).
 */
function canonical(path: string): string {
  const absolute = resolve(path)
  try {
    return realpathSync.native(absolute)
  } catch {
    return absolute
  }
}

/** True when `child` is `parent` itself or lies below it. Both must be canonical. */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}
