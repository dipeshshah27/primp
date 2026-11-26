import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { startPrimp, type PrimpHandle, type PrimpLogger } from '../../server/src/app.ts'
import type { OverlayAssetsOptions } from '../../server/src/assets.ts'
import { detectFramework, parseTarget, targetOrigin, type DevServerDetection } from '../../server/src/detect.ts'
import type { ProxyTarget } from '../../server/src/headers.ts'
import { startDevServer, waitForDevServer, type DevServerProcess } from './dev-server.ts'
import { ownProcesses } from './doctor.ts'
import { registrationText, SELF, shimCommand } from './registration.ts'

/**
 * The default command: `primp [--target <url|port>] [--port <n>] [--exec "<command>"] [--project <dir>] [--no-open]`.
 *
 *   1. the project directory is the working directory, or `--project`;
 *   2. with `--exec` the dev server is started first and stopped again on exit;
 *   3. the dev server is `--target`, or found by looking at which processes of
 *      this project listen on a port (see packages/server/src/detect.ts);
 *   4. the proxy starts on the target's port + 1 (or `--port`), the browser is
 *      opened on it, and the commands that connect a coding agent are printed.
 *
 * It then runs until interrupted.
 */

/** A problem to show the user as it is, without a stack. */
export class CliError extends Error {}

export interface RunOptions {
  project?: string
  target?: string
  port?: string | number
  exec?: string
  /** False with `--no-open`. */
  open?: boolean
  version: string
  /** Where lines for the user go. Default: stdout. */
  print?: (line: string) => void
  /** Whether a person is watching; the browser is only opened for one. Default: stdout is a TTY. */
  interactive?: boolean
  openBrowser?: (url: string) => void
  /** Browser bundle sources; default from `PRIMP_HOOK_ENTRY` / `PRIMP_OVERLAY_ENTRY` (development), else the built-in ones. */
  assets?: OverlayAssetsOptions
  sessionDir?: string
  /** How long `--exec` may take until the dev server answers. Default 60 s. */
  startTimeoutMs?: number
}

export interface RunHandle {
  primp: PrimpHandle
  target: ProxyTarget
  devServer: DevServerProcess | undefined
  /** Resolves with an exit code when the command started with `--exec` ends by itself. Never resolves without `--exec`. */
  devServerExit: Promise<number>
  /** Stops primp and the dev server it started. Safe to call twice. */
  close(): Promise<void>
}

/** Opens `url` in the default browser. Failure is not an error: the URL is printed anyway. */
export function openInBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
  const [command, args]: [string, string[]] =
    platform === 'darwin' ? ['open', [url]] : platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]]
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.once('error', () => {})
    child.unref()
  } catch {
    // Nothing to open with.
  }
}

function parsePort(value: string | number | undefined): number | undefined {
  if (value === undefined || value === '') return undefined
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CliError(`--port must be a number from 1 to 65535, not "${value}"`)
  return port
}

function notFoundMessage(projectRoot: string, detection: DevServerDetection | undefined): string {
  const lines = [`No dev server found for ${projectRoot}.`]
  if (detection !== undefined && detection.ignored.length > 0) {
    lines.push(`Ports opened by this project that did not answer with a page: ${detection.ignored.map((entry) => `${entry.port} (${entry.reason})`).join(', ')}.`)
  }
  if (detection?.processScan !== undefined) lines.push(`Note: ${detection.processScan}.`)
  lines.push(`Start your dev server and run primp again, or name it: ${SELF} --target 5173, or let primp start it: ${SELF} --exec "npm run dev".`)
  return lines.join('\n')
}

export async function runPrimp(options: RunOptions): Promise<RunHandle> {
  const print = options.print ?? ((line: string) => process.stdout.write(`${line}\n`))
  const projectRoot = resolve(options.project !== undefined && options.project !== '' ? options.project : process.cwd())
  let isDirectory = false
  try {
    isDirectory = statSync(projectRoot).isDirectory()
  } catch {
    // Reported below.
  }
  if (!isDirectory) throw new CliError(`${projectRoot} is not a directory`)

  const port = parsePort(options.port)
  let given: ProxyTarget | undefined
  if (options.target !== undefined && options.target !== '') {
    try {
      given = parseTarget(options.target)
    } catch (error) {
      throw new CliError(`--target: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const framework = detectFramework(projectRoot)
  const own = ownProcesses(options.sessionDir)

  const exec = options.exec !== undefined && options.exec.trim() !== '' ? options.exec : undefined
  const devServer = exec === undefined ? undefined : startDevServer(exec, { cwd: projectRoot })
  if (exec !== undefined) print(`primp: starting the dev server: ${exec}`)

  let primp: PrimpHandle | undefined
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    closing ??= (async () => {
      await primp?.close()
      await devServer?.stop()
    })()
    return closing
  }

  try {
    const waited = await waitForDevServer({
      projectRoot,
      target: given,
      framework: framework.framework,
      child: devServer,
      excludePorts: own.ports,
      excludePids: own.pids,
      timeoutMs: options.startTimeoutMs,
      onWait: (() => {
        let said = false
        return (ports: number[]) => {
          if (said) return
          said = true
          // Next, Nuxt and others compile the page on its first request: that is worth a wait, and worth saying.
          print(`primp: waiting for ${ports.map((port) => `http://localhost:${port}`).join(', ')} to answer (a dev server compiles the first page it is asked for)...`)
        }
      })(),
    })
    let target: ProxyTarget
    let foundHow = ''
    if (waited.status === 'ready') {
      target = waited.target
      const chosen = waited.detection?.chosen
      if (waited.via === 'process' && chosen !== undefined) foundHow = `found: ${chosen.command ?? 'process'} pid ${chosen.pid} listens there`
      else if (waited.via === 'port') foundHow = 'found on a well-known port; pass --target if this is another project'
      else if (waited.via === 'output') foundHow = 'announced by the dev server'
      const others = waited.detection?.others ?? []
      if (others.length > 0) print(`primp: other servers of this project also answer: ${others.map((other) => other.url).join(', ')} (pick one with --target)`)
    } else if (waited.status === 'exited') {
      throw new CliError(`The command "${exec}" ended (${waited.signal ?? `exit code ${waited.code}`}) before a dev server answered.`)
    } else if (given !== undefined && devServer === undefined) {
      // The user named the address; the proxy's own page says "not reachable" and retries until it is.
      target = given
      print(`primp: nothing answers at ${targetOrigin(given)} yet; starting anyway, the page retries until the dev server is up`)
    } else if (devServer !== undefined) {
      throw new CliError(`The command "${exec}" is running, but no dev server answered within ${Math.round((options.startTimeoutMs ?? 60_000) / 1000)} s${given === undefined ? '' : ` at ${targetOrigin(given)}`}. Pass --target if it listens somewhere unusual.`)
    } else {
      throw new CliError(notFoundMessage(projectRoot, waited.detection))
    }

    const debug = process.env.PRIMP_DEBUG !== undefined && process.env.PRIMP_DEBUG !== ''
    const log: PrimpLogger = (level, message, detail) => {
      if ((level === 'debug' || level === 'info') && !debug) return
      const extra = detail === undefined ? '' : `: ${detail instanceof Error ? detail.message : typeof detail === 'string' ? detail : JSON.stringify(detail)}`
      process.stderr.write(`primp ${level}: ${message}${extra}\n`)
    }
    const assets: OverlayAssetsOptions | undefined =
      options.assets ??
      (process.env.PRIMP_HOOK_ENTRY !== undefined || process.env.PRIMP_OVERLAY_ENTRY !== undefined
        ? { hookEntry: process.env.PRIMP_HOOK_ENTRY, overlayEntry: process.env.PRIMP_OVERLAY_ENTRY }
        : undefined)

    try {
      primp = await startPrimp({
        projectRoot,
        target,
        port,
        log,
        framework: framework.framework,
        version: options.version,
        assets,
        sessionDir: options.sessionDir,
        // This command owns the signals: it also has a dev server to stop.
        handleSignals: false,
      })
    } catch (error) {
      throw new CliError(`primp could not start: ${error instanceof Error ? error.message : String(error)}`)
    }

    print('')
    print(`  primp ${options.version}`)
    print(`  open      ${primp.url}    (your app with the primp dock)`)
    print(`  target    ${primp.target}    (${framework.framework}${foundHow === '' ? '' : `; ${foundHow}`})`)
    print(`  project   ${primp.projectRoot}`)
    print('')
    print(registrationText(shimCommand()))
    print('')
    print('Press Ctrl+C to stop.')

    const interactive = options.interactive ?? process.stdout.isTTY === true
    if (options.open !== false && interactive) (options.openBrowser ?? openInBrowser)(primp.url)

    const devServerExit =
      devServer === undefined
        ? new Promise<number>(() => {})
        : devServer.exited.then(({ code, signal }) => {
            print(`primp: the dev server ended (${signal ?? `exit code ${code}`})`)
            return code ?? 1
          })
    return { primp, target, devServer, devServerExit, close }
  } catch (error) {
    await close()
    throw error
  }
}
