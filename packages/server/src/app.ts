import { statSync } from 'node:fs'
import { connect } from 'node:net'
import { basename, resolve } from 'node:path'
import { OVERLAY_SOCKET_PATH } from '../../protocol/src/messages.ts'
import { createResolver } from '../../source/src/node/resolve.ts'
import { buildOverlayAssets, type OverlayAssets, type OverlayAssetsOptions } from './assets.ts'
import { createControlServer, type ControlServer } from './control.ts'
import type { CspMode } from './csp.ts'
import { createCulpritResolver } from './culprit-source.ts'
import { detectFramework, parseTarget, targetOrigin } from './detect.ts'
import { errorCode, LOOPBACK_V4, LOOPBACK_V6 } from './free-port.ts'
import type { ProxyTarget } from './headers.ts'
import { createHmrTee, type HmrTee } from './hmr-tee.ts'
import { createProxy, type ProxyLogLevel, type ProxyServer } from './proxy.ts'
import { writeSessionFile, type SessionHandle } from './session-file.ts'
import { createSession, type Session } from './session.ts'
import { createShiftTools } from './shift-tools.ts'
import { createVerifier, startAutoVerify } from './verify.ts'
import { createSettleDetector, type JournalPosition, type SettleDetector, type SettleDetectorOptions } from './settle.ts'

/**
 * The whole long-running primp process as one function: proxy, HMR tee,
 * settle detector, source resolver, session, control endpoint, session file.
 *
 *   browser ── proxy port ──┬─ everything else ────────────► dev server
 *                           ├─ upgrades (HMR socket) ──────► dev server, frames copied to the tee
 *                           ├─ /__primp/hook.js, overlay.js   (assets.ts)
 *                           └─ /__primp/ws   one socket per document, handed to BOTH
 *                                             the settle detector (`settle:*`) and the session (`session:*`)
 *
 *   primp mcp ── control port (loopback, bearer token from the session file) ──► session
 */

export type PrimpLogger = (level: ProxyLogLevel, message: string, detail?: unknown) => void

export interface StartPrimpOptions {
  /** Directory of the project whose dev server is running. Watched for file changes. */
  projectRoot: string
  /** The dev server: a port, `host:port`, a URL, or an already parsed target. Loopback hosts become `localhost`. */
  target: string | number | ProxyTarget
  /**
   * Port for the proxy. Given: that port or an error. Not given: the target's
   * port + 1, or the next free port after it.
   */
  port?: number
  log?: PrimpLogger
  /** Overrides detection from package.json. */
  framework?: string
  /** Reported in `SessionInfo.version`. */
  version?: string
  /** Where the browser bundles come from (entry files or a prebuilt directory), or bundles that are already built. */
  assets?: OverlayAssetsOptions | OverlayAssets
  /** Directory for the session file. Default: `~/.cache/primp/sessions` (or `PRIMP_SESSION_DIR`). */
  sessionDir?: string
  /** Close on SIGINT and SIGTERM, then exit. Default true; pass false when the caller has its own signal handling. */
  handleSignals?: boolean
  cspMode?: CspMode
  /** Passed to the settle detector (timings, polling). */
  settle?: Pick<SettleDetectorOptions, 'timings' | 'polling' | 'ignored'>
}

export interface PrimpHandle {
  /** What the developer opens: `http://localhost:<port>`. */
  url: string
  /** The proxy's port. */
  port: number
  /** Loopback port of the control endpoint (`primp mcp` talks to it). */
  controlPort: number
  /** Origin of the dev server, for example `http://localhost:5173`. */
  target: string
  framework: string
  /** Absolute project directory. */
  projectRoot: string
  /** Path of the session file; removed by `close()`. */
  sessionFile: string
  session: Session
  detector: SettleDetector
  hmr: HmrTee
  assets: OverlayAssets
  /** Removes the session file, closes every socket and listener and stops the file watcher. Safe to call twice. */
  close(): Promise<void>
}

/** How many ports after the preferred one are tried before the OS picks. */
const PORT_ATTEMPTS = 20

/**
 * Whether something accepts connections on `localhost:<port>` right now.
 *
 * Binding is not a sufficient test of "free": the proxy binds the two loopback addresses, and
 * that succeeds on a port another program holds on the wildcard address (how most Node servers
 * listen), after which every `localhost` request meant for that program reaches the proxy
 * instead. A typical victim would be an API server on the port after the dev server's.
 */
export async function isPortAnswering(port: number, timeoutMs = 300): Promise<boolean> {
  const tryHost = (host: string): Promise<boolean> =>
    new Promise((resolvePromise) => {
      const socket = connect({ host, port })
      const done = (answer: boolean): void => {
        socket.destroy()
        resolvePromise(answer)
      }
      socket.setTimeout(timeoutMs, () => done(false))
      socket.once('connect', () => done(true))
      socket.once('error', () => done(false))
    })
  const answers = await Promise.all([tryHost(LOOPBACK_V4), tryHost(LOOPBACK_V6)])
  return answers.includes(true)
}

function isBuilt(assets: OverlayAssetsOptions | OverlayAssets | undefined): assets is OverlayAssets {
  return assets !== undefined && 'headScripts' in assets
}

export async function startPrimp(options: StartPrimpOptions): Promise<PrimpHandle> {
  const log: PrimpLogger = options.log ?? (() => {})
  const projectRoot = resolve(options.projectRoot)
  let isDirectory = false
  try {
    isDirectory = statSync(projectRoot).isDirectory()
  } catch {
    // Reported below.
  }
  if (!isDirectory) throw new Error(`project directory not found: ${projectRoot}`)
  const target: ProxyTarget = typeof options.target === 'object' ? options.target : parseTarget(options.target)
  const origin = targetOrigin(target)
  const framework = options.framework ?? detectFramework(projectRoot).framework

  const assets = isBuilt(options.assets) ? options.assets : await buildOverlayAssets(options.assets)

  /** Things to undo, in order of creation; `close` runs them newest first. */
  const undo: (() => Promise<void> | void)[] = []
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    closing ??= (async () => {
      for (const step of undo.reverse()) {
        try {
          await step()
        } catch (error) {
          log('warn', 'a shutdown step failed', error)
        }
      }
    })()
    return closing
  }

  try {
    const hmr = createHmrTee()
    const detector = createSettleDetector({ projectDir: projectRoot, hmr, ...options.settle })
    undo.push(() => detector.close())

    const resolver = createResolver({ projectRoot, target: origin })
    const culprits = createCulpritResolver({ projectRoot, target: origin, resolver })
    // Source maps and file listings are cached for bursts; anything the watcher or the dev server
    // reported since the last lookup makes them stale.
    let seenUpTo: JournalPosition = detector.mark()
    const refresh = (): void => {
      const changed = detector.journal(seenUpTo).some((entry) => entry.source !== 'browser')
      seenUpTo = detector.mark()
      if (!changed) return
      resolver.invalidate()
      culprits.invalidate()
    }

    const session = createSession({
      info: { target: origin, framework, projectName: basename(projectRoot), version: options.version ?? '0.0.0' },
      projectRoot,
      resolver: {
        resolve(evidence) {
          refresh()
          return resolver.resolve(evidence)
        },
      },
      culprits(issue, recording) {
        refresh()
        return culprits(issue, recording)
      },
      mark: () => detector.mark(),
      log: (level, message, detail) => log(level, `session: ${message}`, detail),
    })
    undo.push(() => session.close())

    // Verification: on an agent's request (verify_changes), on the dock's (session:reverify), and by itself
    // after source edits for batches that were pasted as a prompt.
    const verifier = createVerifier({ session, detector, hotReload: () => hmr.status().live })
    const shiftTools = createShiftTools({ session })
    undo.push(startAutoVerify({ session, detector, verifier, log: (message, error) => log('warn', message, error) }))
    undo.push(
      session.onReverify((ids) => {
        void verifier.verify(ids.length === 0 ? {} : { ids }).catch((error: unknown) => log('warn', 'verification asked for by the dock failed', error))
      }),
    )

    let clearedOnce = false
    const startProxy = (port: number): Promise<ProxyServer> =>
      createProxy({
        target,
        listen: { host: 'localhost', port },
        assets: assets.assets,
        headScripts: assets.headScripts,
        cspMode: options.cspMode,
        // Always: every load through primp is a first visit, and no edit is hidden by a cached copy.
        cold: () => true,
        // During a layout-shift replay, and for the first page of the session (leftovers of an earlier run on this port).
        clearCache: () => {
          if (shiftTools.cold()) return true
          if (clearedOnce) return false
          clearedOnce = true
          return true
        },
        onUpgradeFrame: (direction, tunnel, message) => hmr.onFrame(direction, tunnel, message),
        onWebSocket(socket, request) {
          if ((request.url ?? '').split('?', 1)[0] !== OVERLAY_SOCKET_PATH) {
            socket.close(1008, 'unknown primp socket')
            return
          }
          // One socket, two readers: each takes the messages of its own family.
          detector.attachBrowser(socket)
          session.attach(socket)
        },
        log,
      })

    let proxy: ProxyServer | undefined
    if (options.port !== undefined) {
      const taken = (cause?: unknown): Error => new Error(`port ${options.port} is already in use; pick another with --port or leave it out`, { cause })
      if (await isPortAnswering(options.port)) throw taken()
      try {
        proxy = await startProxy(options.port)
      } catch (error) {
        if (errorCode(error) === 'EADDRINUSE') throw taken(error)
        throw error
      }
    } else {
      for (let port = target.port + 1; port <= Math.min(target.port + PORT_ATTEMPTS, 65535) && proxy === undefined; port += 1) {
        if (await isPortAnswering(port)) continue
        try {
          proxy = await startProxy(port)
        } catch (error) {
          if (errorCode(error) !== 'EADDRINUSE' && errorCode(error) !== 'EACCES') throw error
        }
      }
      proxy ??= await startProxy(0)
    }
    const listening = proxy
    undo.push(() => listening.close())

    const control: ControlServer = await createControlServer({
      handlers: {
        get_session: () => session.getSession(),
        get_pending_changes: (params) => session.getPendingChanges(params),
        wait_for_changes: (params, gone) => session.waitForChanges(params.timeoutMs ?? 50_000, gone),
        dismiss_change: (params) => session.dismissChange(params),
        verify_changes: (params) => verifier.verify(params),
        get_layout_shifts: (params) => shiftTools.getLayoutShifts(params),
        verify_layout_shift: (params) => shiftTools.verifyLayoutShift(params),
      },
      onError: (error, method) => log('error', `control method ${method} failed`, error),
    })
    undo.push(() => control.close())

    const sessionFile: SessionHandle = writeSessionFile(
      { projectRoot, controlPort: control.port, token: control.token, proxyUrl: listening.url },
      options.sessionDir === undefined ? {} : { dir: options.sessionDir },
    )
    // Removed first on the way down, so no shim finds a session that is closing.
    undo.push(() => sessionFile.remove())

    if (options.handleSignals !== false) {
      const onSignal = (signal: NodeJS.Signals): void => {
        void close().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143))
      }
      process.once('SIGINT', onSignal)
      process.once('SIGTERM', onSignal)
      undo.push(() => {
        process.off('SIGINT', onSignal)
        process.off('SIGTERM', onSignal)
      })
    }

    return {
      url: listening.url,
      port: listening.port,
      controlPort: control.port,
      target: origin,
      framework,
      projectRoot: sessionFile.session.projectRoot,
      sessionFile: sessionFile.path,
      session,
      detector,
      hmr,
      assets,
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}
