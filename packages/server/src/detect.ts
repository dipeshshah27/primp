import { execFile } from 'node:child_process'
import { request as httpsRequest } from 'node:https'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { isIP } from 'node:net'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ProxyTarget } from './headers.ts'

/**
 * Project detection: which framework a directory uses, and where its dev
 * server listens when the user did not say.
 *
 * Finding the dev server, in this order:
 *
 *   1. processes: every listening TCP port whose process has its working
 *      directory inside the project (`lsof`, macOS and Linux). This is what
 *      tells the project's own dev server from another project's on a
 *      well-known port.
 *   2. well-known ports, when 1 found nothing (no `lsof`, a dev server started
 *      from another directory, a container): 3000, 5173, 4321, 8080, 4200,
 *      5000, 8000.
 *
 * Every candidate is then asked for `/` over HTTP and must answer with
 * `text/html`; a port that does not is not a dev server (a debugger port, an
 * HMR-only socket, macOS AirPlay on 5000). If several remain, the choice is
 * deterministic (the framework's default port first, then the lowest number)
 * and the others are reported so the CLI can print them.
 *
 * The host is always `localhost`: dev servers commonly listen on `::1` only,
 * where `127.0.0.1` is refused, and the name reaches both.
 */

// ---------------------------------------------------------------------------
// Framework
// ---------------------------------------------------------------------------

export type DetectedFramework = 'next' | 'vite' | 'sveltekit' | 'astro' | 'nuxt' | 'remix' | 'react-router' | 'static' | 'unknown'

export interface FrameworkInfo {
  framework: DetectedFramework
  /** `name` of package.json, when there is one. */
  packageName?: string
  /** One sentence saying what the answer is based on. */
  reason: string
}

/** The port each framework's dev server uses unless told otherwise. */
export const FRAMEWORK_DEFAULT_PORT: Record<DetectedFramework, number | undefined> = {
  next: 3000,
  vite: 5173,
  sveltekit: 5173,
  astro: 4321,
  nuxt: 3000,
  remix: 5173,
  'react-router': 5173,
  static: undefined,
  unknown: undefined,
}

/** Meta-frameworks first: most of them also depend on vite. */
const FRAMEWORK_PACKAGES: [DetectedFramework, (name: string) => boolean][] = [
  ['next', (name) => name === 'next'],
  ['sveltekit', (name) => name === '@sveltejs/kit'],
  ['astro', (name) => name === 'astro'],
  ['nuxt', (name) => name === 'nuxt' || name === 'nuxt3' || name === 'nuxt-nightly'],
  ['remix', (name) => name.startsWith('@remix-run/')],
  ['react-router', (name) => name === '@react-router/dev'],
  ['vite', (name) => name === 'vite' || name === 'rolldown-vite'],
]

/** Framework from the `dependencies` and `devDependencies` of an already parsed package.json. */
export function frameworkFromPackageJson(pkg: unknown): { framework: DetectedFramework; dependency?: string } {
  if (typeof pkg !== 'object' || pkg === null) return { framework: 'unknown' }
  const names = new Set<string>()
  for (const field of ['dependencies', 'devDependencies']) {
    const deps = (pkg as Record<string, unknown>)[field]
    if (typeof deps === 'object' && deps !== null) for (const name of Object.keys(deps)) names.add(name)
  }
  for (const [framework, matches] of FRAMEWORK_PACKAGES) {
    const dependency = [...names].find(matches)
    if (dependency !== undefined) return { framework, dependency }
  }
  return { framework: 'unknown' }
}

export function detectFramework(projectRoot: string): FrameworkInfo {
  const packagePath = join(projectRoot, 'package.json')
  let pkg: unknown
  let packageError: string | undefined
  if (existsSync(packagePath)) {
    try {
      pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
    } catch (error) {
      packageError = error instanceof Error ? error.message : String(error)
    }
  }
  const info = (framework: DetectedFramework, reason: string): FrameworkInfo => {
    const name = typeof pkg === 'object' && pkg !== null ? (pkg as { name?: unknown }).name : undefined
    return typeof name === 'string' && name !== '' ? { framework, packageName: name, reason } : { framework, reason }
  }
  const found = frameworkFromPackageJson(pkg)
  if (found.dependency !== undefined) return info(found.framework, `package.json depends on ${found.dependency}`)
  for (const file of ['index.html', 'public/index.html']) {
    if (existsSync(join(projectRoot, file))) return info('static', `no known framework in package.json; ${file} exists`)
  }
  if (packageError !== undefined) return info('unknown', `package.json could not be read (${packageError})`)
  return info('unknown', pkg === undefined ? 'no package.json and no index.html' : 'no known framework in package.json')
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0', '::', '[::]', '*'])

/** `localhost` for every spelling of "this machine" (including the wildcard addresses a server binds to). */
export function normalizeHost(host: string): string {
  const lower = host.toLowerCase()
  if (LOOPBACK_HOSTS.has(lower) || lower.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(lower)) return 'localhost'
  return lower
}

export function targetOrigin(target: ProxyTarget): string {
  const host = isIP(target.host) === 6 ? `[${target.host}]` : target.host
  const defaultPort = target.protocol === 'https' ? 443 : 80
  return `${target.protocol}://${host}${target.port === defaultPort ? '' : `:${target.port}`}`
}

/**
 * Reads what a user passes as `--target`: a port (`5173`), a host and port
 * (`localhost:5173`, `[::1]:5173`) or a URL (`http://127.0.0.1:5173/app`; the
 * path is dropped). Loopback hosts become `localhost`. Throws with a message
 * for the user when it is none of these.
 */
export function parseTarget(input: string | number): ProxyTarget {
  const text = String(input).trim()
  const bad = (): Error => new Error(`cannot read "${text}" as a dev server address; use a port (5173) or a URL (http://localhost:5173)`)
  if (/^\d+$/.test(text)) {
    const port = Number(text)
    if (port < 1 || port > 65535) throw bad()
    return { protocol: 'http', host: 'localhost', port }
  }
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`)
  } catch {
    throw bad()
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname === '') throw bad()
  const protocol = url.protocol === 'https:' ? 'https' : 'http'
  const port = url.port === '' ? (protocol === 'https' ? 443 : 80) : Number(url.port)
  return { protocol, host: normalizeHost(url.hostname.replace(/^\[|\]$/g, '')), port }
}

// ---------------------------------------------------------------------------
// lsof
// ---------------------------------------------------------------------------

export interface ListeningSocket {
  command: string
  pid: number
  /** Address as lsof prints it: `*`, `127.0.0.1`, `[::1]`, ... */
  address: string
  port: number
  family: 'IPv4' | 'IPv6'
}

/**
 * Parses `lsof -nP -iTCP -sTCP:LISTEN`:
 *
 *   COMMAND   PID   USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
 *   node    41875 dipesh   23u  IPv6 0x4f3a1d2c9b8e7a61      0t0  TCP [::1]:5173 (LISTEN)
 *
 * Lines that are not listening TCP sockets are skipped. lsof escapes blanks in
 * command names (`Code\x20Helper`), so the columns split on whitespace.
 */
export function parseLsofListen(output: string): ListeningSocket[] {
  const sockets: ListeningSocket[] = []
  for (const line of output.split('\n')) {
    const match = /^(\S+)\s+(\d+)\s+\S+\s+\S+\s+(IPv[46])\s+.*\sTCP\s+(\S+):(\d+)\s+\(LISTEN\)\s*$/.exec(line)
    if (match === null) continue
    const [, command = '', pid = '', family = 'IPv4', address = '', port = ''] = match
    sockets.push({
      command: command.replace(/\\x([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))),
      pid: Number(pid),
      address,
      port: Number(port),
      family: family as 'IPv4' | 'IPv6',
    })
  }
  return sockets
}

/**
 * Parses `lsof -a -p <pid>[,<pid>...] -d cwd -Fn`: a `p<pid>` line starts each
 * process, and the `n<path>` line after its `fcwd` line is the working directory.
 */
export function parseLsofCwd(output: string): Map<number, string> {
  const cwds = new Map<number, string>()
  let pid: number | undefined
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      const value = Number(line.slice(1))
      pid = Number.isInteger(value) && value > 0 ? value : undefined
    } else if (line.startsWith('n') && pid !== undefined && !cwds.has(pid)) {
      // On Linux a directory that was deleted is printed with a marker after the path.
      cwds.set(pid, line.slice(1).replace(/ \(deleted\)$/, ''))
    }
  }
  return cwds
}

/** True when `child` is `parent` or below it. Both absolute. */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function canonical(path: string): string {
  try {
    return realpathSync.native(resolve(path))
  } catch {
    return resolve(path)
  }
}

// ---------------------------------------------------------------------------
// Dev server
// ---------------------------------------------------------------------------

export const WELL_KNOWN_PORTS = [3000, 5173, 4321, 8080, 4200, 5000, 8000] as const

export interface DevServerCandidate {
  port: number
  /** `http://localhost:<port>`, or `https://` for a dev server that speaks TLS. */
  url: string
  /** `process`: a process working in the project listens there. `port`: a well-known port answered. */
  via: 'process' | 'port'
  pid?: number
  command?: string
  /** Working directory of the process. */
  cwd?: string
}

export interface DevServerDetection {
  /** The candidate to use, when there is one. */
  chosen?: DevServerCandidate
  /** Other candidates that also answered with HTML, in the order they would have been chosen. */
  others: DevServerCandidate[]
  /** Ports of project processes that did not answer `/` with HTML (not dev servers, or still starting). */
  ignored: { port: number; reason: string }[]
  /** How the candidates were found. `none`: nothing listens anywhere primp looked. */
  method: 'process' | 'port' | 'none'
  /** Set when the process scan could not run (Windows, no lsof): only well-known ports were probed. */
  processScan?: string
}

export interface ProbeResult {
  /** `/` was answered with an HTML document (or a redirect). */
  html: boolean
  /** It answered over HTTPS (a dev server with a certificate of its own). Absent: plain HTTP. */
  protocol?: 'https'
  /** Something answered HTTP at all. */
  answered: boolean
  /** Why not, or what answered. */
  detail: string
}

export interface DetectDevServerOptions {
  projectRoot: string
  /** Orders several candidates: this framework's default port is preferred. */
  framework?: DetectedFramework
  /** Ports that are primp's own (running proxies) and must not be picked. */
  excludePorts?: readonly number[]
  /** Processes that are primp's own. The current process is always excluded. */
  excludePids?: readonly number[]
  platform?: NodeJS.Platform
  /** Runs a command and resolves with its stdout; rejects when it cannot run. Default: `execFile`. */
  run?: (command: string, args: string[]) => Promise<string>
  /** Asks a port for `/`, giving up after `timeoutMs` or when `abandon` fires. Default: an HTTP GET to `http://localhost:<port>/`. */
  probe?: (port: number, timeoutMs: number, abandon?: AbortSignal) => Promise<ProbeResult>
  /** How long a well-known port, or any port once another answered, gets to answer. Default 1500 ms. */
  probeTimeoutMs?: number
  /**
   * How long a port a project process listens on gets when nothing has answered with a page yet:
   * a dev server compiles `/` on its first request, which takes Next or Nuxt several seconds.
   * Default 20 s.
   */
  firstCompileTimeoutMs?: number
  /** Called once when nothing answered quickly and the project's own ports are being waited for. */
  onWait?: (ports: number[]) => void
}

function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      // lsof exits 1 when some of the requested processes are gone, and still prints the rest.
      if (error !== null && (typeof stdout !== 'string' || stdout === '')) reject(error)
      else resolvePromise(stdout)
    })
  })
}

/** How a plain HTTP request to a port that speaks TLS fails: the reply is not HTTP. */
const looksLikeTls = (detail: string): boolean => /UND_ERR_SOCKET|ECONNRESET|HPE_INVALID|socket hang up|other side closed/i.test(detail)

/** GET `/` over HTTPS, accepting the dev server's own certificate (local only: never a remote host). */
function probeHttps(port: number, timeoutMs: number, abandon?: AbortSignal): Promise<ProbeResult> {
  return new Promise((resolvePromise) => {
    const req = httpsRequest(
      { host: 'localhost', port, path: '/', method: 'GET', rejectUnauthorized: false, headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' }, timeout: timeoutMs, ...(abandon === undefined ? {} : { signal: abandon }) },
      (res) => {
        res.resume()
        const status = res.statusCode ?? 0
        const type = String(res.headers['content-type'] ?? '')
        const html = (status >= 300 && status < 400) || /^\s*text\/html\b/i.test(type)
        resolvePromise({ html, answered: true, protocol: 'https', detail: `HTTPS ${status} ${type === '' ? '(no content type)' : type}` })
      },
    )
    req.on('timeout', () => req.destroy(new Error('TimeoutError')))
    req.on('error', (error) => resolvePromise({ html: false, answered: false, detail: (error as NodeJS.ErrnoException).code ?? error.message }))
    req.end()
  })
}

/**
 * GET `/` on `http://localhost:<port>` as a browser navigation would; HTML only counts when the
 * status is not an error from a proxy that found nothing. A port that does not speak HTTP is asked
 * again over HTTPS (Vite with basic-ssl, Next with --experimental-https).
 */
export async function probeHttp(port: number, timeoutMs = 1500, abandon?: AbortSignal): Promise<ProbeResult> {
  const plain = await probePlain(port, timeoutMs, abandon)
  // Not HTTP at all, or a 400 for speaking plain HTTP to a TLS port (Go, Caddy and nginx based servers answer so).
  const tlsHint = (!plain.answered && looksLikeTls(plain.detail)) || (plain.answered && !plain.html && /^HTTP 400\b/.test(plain.detail))
  if (!tlsHint || abandon?.aborted === true) return plain
  const secure = await probeHttps(port, timeoutMs, abandon)
  // Over HTTPS it is what it says, a timeout included (a first compile): its answer, not the plain one's.
  return secure.answered || !plain.answered ? secure : plain
}

async function probePlain(port: number, timeoutMs: number, abandon?: AbortSignal): Promise<ProbeResult> {
  try {
    const response = await fetch(`http://localhost:${port}/`, {
      headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      redirect: 'manual',
      signal: abandon === undefined ? AbortSignal.timeout(timeoutMs) : AbortSignal.any([AbortSignal.timeout(timeoutMs), abandon]),
    })
    const type = response.headers.get('content-type') ?? ''
    await response.body?.cancel().catch(() => {})
    // A redirect from `/` (to a locale, a login page) is still a site answering.
    if (response.status >= 300 && response.status < 400) return { html: true, answered: true, detail: `HTTP ${response.status} redirect` }
    if (/^\s*text\/html\b/i.test(type)) return { html: true, answered: true, detail: `HTTP ${response.status} ${type}` }
    return { html: false, answered: true, detail: `HTTP ${response.status}, content type ${type === '' ? '(none)' : type}` }
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause
    return { html: false, answered: false, detail: cause?.code ?? (error instanceof Error ? error.message : String(error)) }
  }
}

/** Framework default first, then ascending port number. */
export function orderCandidates<T extends { port: number }>(candidates: readonly T[], framework?: DetectedFramework): T[] {
  const preferred = framework === undefined ? undefined : FRAMEWORK_DEFAULT_PORT[framework]
  return [...candidates].sort((a, b) => Number(b.port === preferred) - Number(a.port === preferred) || a.port - b.port)
}

/** Listening ports of processes whose working directory is inside `projectRoot`, one entry per port. */
export async function listProjectListeners(
  projectRoot: string,
  run: (command: string, args: string[]) => Promise<string> = runCommand,
): Promise<(ListeningSocket & { cwd: string })[]> {
  const root = canonical(projectRoot)
  const sockets = parseLsofListen(await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']))
  const pids = [...new Set(sockets.map((socket) => socket.pid))]
  if (pids.length === 0) return []
  const cwds = parseLsofCwd(await run('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fn']))
  const seen = new Set<number>()
  const inside: (ListeningSocket & { cwd: string })[] = []
  for (const socket of sockets) {
    const cwd = cwds.get(socket.pid)
    if (cwd === undefined || seen.has(socket.port) || !isInside(root, canonical(cwd))) continue
    seen.add(socket.port)
    inside.push({ ...socket, cwd })
  }
  return inside
}

export async function detectDevServer(options: DetectDevServerOptions): Promise<DevServerDetection> {
  const platform = options.platform ?? process.platform
  const probe = options.probe ?? probeHttp
  const quick = options.probeTimeoutMs ?? 1500
  const patient = Math.max(quick, options.firstCompileTimeoutMs ?? 20_000)
  const excludedPorts = new Set(options.excludePorts ?? [])
  const excludedPids = new Set([process.pid, ...(options.excludePids ?? [])])
  const detection: DevServerDetection = { others: [], ignored: [], method: 'none' }

  let candidates: DevServerCandidate[] = []
  if (platform === 'win32') {
    detection.processScan = 'finding the dev server by process is not supported on Windows; pass --target'
  } else {
    try {
      const listeners = await listProjectListeners(options.projectRoot, options.run)
      candidates = listeners
        .filter((socket) => !excludedPids.has(socket.pid) && !excludedPorts.has(socket.port))
        .map((socket) => ({ port: socket.port, url: `http://localhost:${socket.port}`, via: 'process', pid: socket.pid, command: socket.command, cwd: socket.cwd }))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      detection.processScan = code === 'ENOENT' ? 'lsof is not installed; only well-known ports were tried' : `lsof failed (${error instanceof Error ? error.message.split('\n')[0] : String(error)}); only well-known ports were tried`
    }
  }

  let method: DevServerDetection['method'] = 'process'
  if (candidates.length === 0) {
    method = 'port'
    candidates = WELL_KNOWN_PORTS.filter((port) => !excludedPorts.has(port)).map((port) => ({ port, url: `http://localhost:${port}`, via: 'port' }))
  }

  // Every candidate is asked at once. A project's own port may take a first compile to answer;
  // it is waited for only when nothing answered with a page in the quick round, and only until
  // one of them does. Probes no longer needed are abandoned, so nothing keeps the process alive.
  const abandon = new AbortController()
  const results = new Map<DevServerCandidate, ProbeResult>()
  let pageFound: () => void = () => undefined
  const firstPage = new Promise<void>((resolve) => (pageFound = resolve))
  const asked = candidates.map((candidate) =>
    probe(candidate.port, candidate.via === 'process' ? patient : quick, abandon.signal).then((result) => {
      results.set(candidate, result)
      if (result.html) pageFound()
      return result
    }),
  )
  const all = Promise.all(asked).then(() => undefined)
  const quickRound = new Promise<void>((resolve) => setTimeout(resolve, quick + 100).unref?.())
  await Promise.race([all, quickRound])
  const pending = (): DevServerCandidate[] => candidates.filter((candidate) => !results.has(candidate))
  if (pending().length > 0 && ![...results.values()].some((result) => result.html)) {
    options.onWait?.(pending().map((candidate) => candidate.port))
    await Promise.race([all, firstPage])
  }
  const waited = [...results.values()].some((result) => result.html) ? `no answer within ${(quick / 1000).toFixed(1)} s` : 'no answer in time'
  for (const candidate of pending()) results.set(candidate, { html: false, answered: false, detail: waited })
  abandon.abort()
  const answers = candidates.map((candidate) => ({ candidate, result: results.get(candidate)! }))
  const html: DevServerCandidate[] = []
  for (const { candidate, result } of answers) {
    if (result.html) html.push(result.protocol === 'https' ? { ...candidate, url: `https://localhost:${candidate.port}` } : candidate)
    else if (candidate.via === 'process') detection.ignored.push({ port: candidate.port, reason: result.detail === 'TimeoutError' || /aborted due to timeout/.test(result.detail) ? 'no answer in time' : result.detail })
  }
  const [chosen, ...others] = orderCandidates(html, options.framework)
  if (chosen === undefined) return detection
  return { ...detection, chosen, others, method }
}
