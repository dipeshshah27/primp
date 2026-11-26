import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { buildOverlayAssets, type OverlayAssets, type OverlayAssetsOptions } from '../../server/src/assets.ts'
import { detectDevServer, detectFramework, type DevServerDetection, type FrameworkInfo } from '../../server/src/detect.ts'
import { findSession, listSessions, type SessionLookup } from '../../server/src/session-file.ts'
import { SELF } from './registration.ts'

/**
 * `primp doctor`: what primp sees on this machine, one line per check.
 * Only two things fail it (exit code 1): a Node version primp does not run
 * on, and browser bundles that cannot be built. Everything else is a report.
 */

export type DoctorStatus = 'ok' | 'warn' | 'fail'

export interface DoctorCheck {
  name: string
  status: DoctorStatus
  detail: string
}

export interface DoctorDeps {
  nodeVersion: string
  platform: NodeJS.Platform
  framework(projectRoot: string): FrameworkInfo
  devServer(projectRoot: string, framework: FrameworkInfo, excludePorts: number[], excludePids: number[]): Promise<DevServerDetection>
  session(projectRoot: string): SessionLookup
  /** Ports and pids of running primp processes, which are not dev servers. */
  ownProcesses(): { ports: number[]; pids: number[] }
  buildAssets(options?: OverlayAssetsOptions): Promise<OverlayAssets>
}

/** Mirrors the `engines` field of package.json. */
export function isSupportedNode(version: string): boolean {
  const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number)
  return (major === 22 && minor >= 22) || (major === 24 && minor >= 11) || major > 24
}

export function ownProcesses(sessionDir?: string): { ports: number[]; pids: number[] } {
  const sessions = listSessions(sessionDir === undefined ? {} : { dir: sessionDir })
  const ports: number[] = []
  for (const { session } of sessions) {
    ports.push(session.controlPort)
    const port = Number(new URL(session.proxyUrl).port)
    if (port > 0) ports.push(port)
  }
  return { ports, pids: sessions.map(({ session }) => session.pid) }
}

export function defaultDoctorDeps(options: { sessionDir?: string; assets?: OverlayAssetsOptions } = {}): DoctorDeps {
  const dir = options.sessionDir === undefined ? {} : { dir: options.sessionDir }
  return {
    nodeVersion: process.versions.node,
    platform: process.platform,
    framework: detectFramework,
    devServer: (projectRoot, framework, excludePorts, excludePids) => detectDevServer({ projectRoot, framework: framework.framework, excludePorts, excludePids }),
    session: (projectRoot) => findSession(projectRoot, dir),
    ownProcesses: () => ownProcesses(options.sessionDir),
    buildAssets: (assets) => buildOverlayAssets(assets ?? options.assets),
  }
}

export async function collectDoctorChecks(projectRoot: string, deps: DoctorDeps): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = []
  const add = (name: string, status: DoctorStatus, detail: string): void => void checks.push({ name, status, detail })

  add(
    'Node',
    isSupportedNode(deps.nodeVersion) ? 'ok' : 'fail',
    isSupportedNode(deps.nodeVersion) ? `${deps.nodeVersion} on ${deps.platform}` : `${deps.nodeVersion}; primp needs ^22.22.0 or >=24.11.0`,
  )

  let isDirectory = false
  try {
    isDirectory = statSync(projectRoot).isDirectory()
  } catch {
    // Reported below.
  }
  if (!isDirectory) {
    add('Project', 'fail', `${projectRoot} is not a directory`)
    return checks
  }
  add('Project', existsSync(join(projectRoot, 'package.json')) ? 'ok' : 'warn', existsSync(join(projectRoot, 'package.json')) ? projectRoot : `${projectRoot} (no package.json here; is this the project directory?)`)

  const framework = deps.framework(projectRoot)
  add('Framework', framework.framework === 'unknown' ? 'warn' : 'ok', `${framework.framework} (${framework.reason})`)

  const session = deps.session(projectRoot)
  const own = deps.ownProcesses()
  try {
    const detection = await deps.devServer(projectRoot, framework, own.ports, own.pids)
    if (detection.chosen !== undefined) {
      const chosen = detection.chosen
      const how = chosen.via === 'process' ? `${chosen.command ?? 'process'} pid ${chosen.pid}, working in ${chosen.cwd}` : 'answered on a well-known port; its process could not be tied to this project'
      const others = detection.others.length > 0 ? `; also answering: ${detection.others.map((other) => other.url).join(', ')}` : ''
      add('Dev server', chosen.via === 'process' ? 'ok' : 'warn', `${chosen.url} (${how})${others}`)
    } else {
      const ignored = detection.ignored.length > 0 ? ` Ports of this project that did not answer with HTML: ${detection.ignored.map((entry) => `${entry.port} (${entry.reason})`).join(', ')}.` : ''
      add('Dev server', 'warn', `none found; start it, or pass --target <url|port> or --exec "<command>".${ignored}`)
    }
    if (detection.processScan !== undefined) add('Process scan', 'warn', detection.processScan)
  } catch (error) {
    add('Dev server', 'warn', `detection failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (session.kind === 'found') add('Session', 'ok', `primp is running for ${session.session.projectRoot} (pid ${session.session.pid}); open ${session.session.proxyUrl}`)
  else if (session.kind === 'ambiguous') add('Session', 'warn', `primp is running for several projects below this directory: ${session.projectRoots.join(', ')}`)
  else add('Session', 'ok', `primp is not running for this project (start it with \`${SELF}\`)`)

  try {
    const assets = await deps.buildAssets()
    const size = (bytes: number): string => `${(bytes / 1024).toFixed(1)} kB`
    add('Overlay bundles', 'ok', `hook.js ${size(assets.hook.bytes)} (${assets.hook.from}), overlay.js ${size(assets.overlay.bytes)} (${assets.overlay.from})`)
  } catch (error) {
    add('Overlay bundles', 'fail', error instanceof Error ? error.message : String(error))
  }
  return checks
}

const MARK: Record<DoctorStatus, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' }

export function formatDoctor(checks: readonly DoctorCheck[]): string {
  const width = Math.max(...checks.map((check) => check.name.length))
  return checks.map((check) => `${MARK[check.status]}  ${check.name.padEnd(width)}  ${check.detail}`).join('\n')
}

/** Prints the report; resolves with the process exit code. */
export async function runDoctor(projectRoot: string, deps: DoctorDeps = defaultDoctorDeps(), print: (text: string) => void = (text) => process.stdout.write(`${text}\n`)): Promise<number> {
  const checks = await collectDoctorChecks(projectRoot, deps)
  print(formatDoctor(checks))
  return checks.some((check) => check.status === 'fail') ? 1 : 0
}
