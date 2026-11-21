import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { detectDevServer, probeHttp, type DetectedFramework, type DevServerDetection, type ProbeResult } from '../../server/src/detect.ts'
import type { ProxyTarget } from '../../server/src/headers.ts'

/**
 * `--exec "<command>"`: reglet starts the dev server itself.
 *
 * The command runs through the shell in the project directory, in a process
 * group of its own (package managers start the real server as a grandchild;
 * killing only the child would leave it running). Its output is passed on
 * line by line with a prefix, and the whole group is stopped when reglet exits.
 */

export interface DevServerProcess {
  pid: number | undefined
  /** Everything printed so far, ANSI colour codes removed. */
  output(): string
  /** Ports of `http://localhost:<port>` style URLs the command has printed, in order of appearance. */
  announcedPorts(): number[]
  /** Resolves when the command ends. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  hasExited(): boolean
  /** Stops the whole process group: SIGTERM, then SIGKILL after `graceMs`. Safe to call twice. */
  stop(graceMs?: number): Promise<void>
}

export interface StartDevServerOptions {
  cwd: string
  /** Receives each complete output line, without the newline. Default: stderr with a `[dev] ` prefix. */
  onLine?: (line: string) => void
  env?: NodeJS.ProcessEnv
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})/g

/** Ports named in local URLs in `text`, each once, in order. */
export function portsInOutput(text: string): number[] {
  const ports: number[] = []
  for (const match of text.replace(ANSI, '').matchAll(LOCAL_URL)) {
    const port = Number(match[1])
    if (port > 0 && port <= 65535 && !ports.includes(port)) ports.push(port)
  }
  return ports
}

export function startDevServer(command: string, options: StartDevServerOptions): DevServerProcess {
  const onLine = options.onLine ?? ((line: string) => process.stderr.write(`[dev] ${line}\n`))
  const windows = process.platform === 'win32'
  const child: ChildProcess = spawn(command, {
    cwd: options.cwd,
    shell: true,
    // POSIX: a new process group, so the group can be signalled as one.
    detached: !windows,
    stdio: ['ignore', 'pipe', 'pipe'],
    // The page is opened through the proxy by reglet; dev servers that honour BROWSER must not open their own port.
    env: { ...process.env, BROWSER: 'none', ...options.env },
  })

  let output = ''
  let exited = false
  const pipe = (stream: NodeJS.ReadableStream | null): void => {
    let pending = ''
    stream?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      output += text.replace(ANSI, '')
      if (output.length > 400_000) output = output.slice(-200_000)
      pending += text
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) onLine(line.replace(/\r$/, ''))
    })
    stream?.on('end', () => {
      if (pending !== '') onLine(pending)
    })
  }
  pipe(child.stdout)
  pipe(child.stderr)

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('error', (error) => {
      exited = true
      onLine(`could not start: ${error.message}`)
      resolve({ code: 127, signal: null })
    })
    child.once('exit', (code, signal) => {
      exited = true
      resolve({ code, signal })
    })
  })

  const signalGroup = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return
    try {
      if (windows) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      else process.kill(-child.pid, signal)
    } catch {
      // Already gone.
    }
  }
  // Last resort when the process ends without `stop()` having run.
  const onProcessExit = (): void => {
    if (!exited) signalGroup('SIGTERM')
  }
  process.on('exit', onProcessExit)
  void exit.then(() => process.off('exit', onProcessExit))

  let stopping: Promise<void> | undefined
  return {
    pid: child.pid,
    output: () => output,
    announcedPorts: () => portsInOutput(output),
    exited: exit,
    hasExited: () => exited,
    stop(graceMs = 3000) {
      stopping ??= (async () => {
        if (exited) return
        signalGroup('SIGTERM')
        const timer = setTimeout(() => signalGroup('SIGKILL'), graceMs)
        await exit
        clearTimeout(timer)
        // The shell may be gone while a grandchild still holds the port.
        signalGroup('SIGKILL')
      })()
      return stopping
    },
  }
}

export interface WaitForDevServerOptions {
  projectRoot: string
  /** Given with `--target`: wait for exactly this address. */
  target?: ProxyTarget
  framework?: DetectedFramework
  /** The command reglet started, when it did. Waiting stops when it exits. */
  child?: DevServerProcess
  excludePorts?: readonly number[]
  excludePids?: readonly number[]
  timeoutMs?: number
  intervalMs?: number
  probe?: (port: number) => Promise<ProbeResult>
  detect?: typeof detectDevServer
}

export type WaitOutcome =
  | { status: 'ready'; target: ProxyTarget; detection?: DevServerDetection; via: 'target' | 'output' | 'process' | 'port' }
  | { status: 'exited'; code: number | null; signal: NodeJS.Signals | null }
  | { status: 'timeout'; detection?: DevServerDetection }

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Waits until the dev server answers: the given target, or else a URL the
 * started command printed, or else whatever detection finds for the project.
 */
export async function waitForDevServer(options: WaitForDevServerOptions): Promise<WaitOutcome> {
  const probe = options.probe ?? probeHttp
  const detect = options.detect ?? detectDevServer
  const deadline = Date.now() + (options.timeoutMs ?? 60_000)
  const local = (port: number): ProxyTarget => ({ protocol: 'http', host: 'localhost', port })
  let detection: DevServerDetection | undefined

  for (;;) {
    if (options.target !== undefined) {
      // An https or remote target cannot be probed with the plain localhost probe; it is taken as given.
      if (options.target.protocol !== 'http' || options.target.host !== 'localhost') return { status: 'ready', target: options.target, via: 'target' }
      if ((await probe(options.target.port)).answered) return { status: 'ready', target: options.target, via: 'target' }
    } else {
      for (const port of options.child?.announcedPorts() ?? []) {
        if (options.excludePorts?.includes(port) !== true && (await probe(port)).html) return { status: 'ready', target: local(port), via: 'output' }
      }
      detection = await detect({
        projectRoot: options.projectRoot,
        framework: options.framework,
        excludePorts: options.excludePorts,
        excludePids: options.excludePids,
        probe,
      })
      if (detection.chosen !== undefined) return { status: 'ready', target: local(detection.chosen.port), detection, via: detection.chosen.via }
    }
    if (options.child === undefined) return { status: 'timeout', detection }
    if (options.child.hasExited()) return { status: 'exited', ...(await options.child.exited) }
    if (Date.now() >= deadline) return { status: 'timeout', detection }
    await Promise.race([sleep(options.intervalMs ?? 400), options.child.exited])
  }
}
