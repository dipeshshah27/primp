import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { probeHttp } from '../../server/src/detect.ts'
import { freeLowPort, removeDir, tempDir } from '../../server/test/session-helpers.ts'
import { CliError, openInBrowser, runPrimp, type RunHandle, type RunOptions } from '../src/run.ts'

/**
 * The default command: in-process through `runPrimp` (what it prints, what it
 * starts and stops), and as the real binary for argument parsing and signals.
 * Stub bundles stand in for the dock.
 */

const CLI = fileURLToPath(new URL('../src/index.ts', import.meta.url))
const PAGE = '<!doctype html><html><head><title>dev</title></head><body><h1>dev</h1></body></html>'

/** A dev server that prints its URL the way Vite does and listens on ::1 only. */
const DEV_SERVER = `
import { createServer } from 'node:http'
const server = createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(${JSON.stringify(PAGE)}))
server.listen(Number(process.env.PORT ?? 0), '::1', () => console.log('  Local:   http://localhost:' + server.address().port + '/'))
`

let work: string
let project: string
let sessionDir: string
let hookEntry: string
let overlayEntry: string
const handles: RunHandle[] = []
const servers: http.Server[] = []
const children: ChildProcess[] = []

beforeAll(() => {
  work = tempDir('run-test')
  project = join(work, 'shop')
  sessionDir = join(work, 'sessions')
  mkdirSync(project)
  writeFileSync(join(project, 'package.json'), '{"name":"shop","devDependencies":{"vite":"8"}}')
  writeFileSync(join(project, 'dev.mjs'), DEV_SERVER)
  hookEntry = join(work, 'hook.ts')
  overlayEntry = join(work, 'overlay.ts')
  writeFileSync(hookEntry, 'console.log("stub hook")\n')
  writeFileSync(overlayEntry, 'console.log("stub overlay")\n')
})

afterEach(async () => {
  while (handles.length > 0) await handles.pop()?.close()
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  for (const server of servers.splice(0)) {
    server.close()
    server.closeAllConnections()
  }
})

afterAll(() => removeDir(work))

async function devServer(): Promise<number> {
  const server = http.createServer((_, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE))
  servers.push(server)
  // Not an OS-assigned port: primp takes the port after it (see freeLowPort).
  const port = await freeLowPort()
  await new Promise<void>((resolve) => server.listen(port, '::1', () => resolve()))
  return (server.address() as AddressInfo).port
}

async function run(options: Partial<RunOptions>): Promise<RunHandle & { printed: string[]; opened: string[] }> {
  const printed: string[] = []
  const opened: string[] = []
  const handle = await runPrimp({
    project,
    version: '1.2.3',
    assets: { hookEntry, overlayEntry },
    sessionDir,
    interactive: false,
    print: (line) => printed.push(line),
    openBrowser: (url) => opened.push(url),
    ...options,
  })
  handles.push(handle)
  return Object.assign(handle, { printed, opened })
}

const sessionFiles = (): string[] => (existsSync(sessionDir) ? readdirSync(sessionDir).filter((name) => name.endsWith('.json')) : [])

async function until<T>(read: () => T | undefined | false | Promise<T | undefined | false>, ms = 15_000, what = 'condition'): Promise<T> {
  for (let waited = 0; waited < ms; waited += 25) {
    const value = await read()
    if (value !== undefined && value !== false) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`${what} not met within ${ms} ms`)
}

describe('runPrimp', () => {
  it('with --target: starts the proxy on the next port and prints the URL, the target and the three registrations', async () => {
    const target = await devServer()
    const running = await run({ target: String(target) })
    expect(running.primp.target).toBe(`http://localhost:${target}`)
    expect(running.primp.port).toBeGreaterThan(target)
    expect(running.primp.framework).toBe('vite')
    const out = running.printed.join('\n')
    expect(out).toContain('primp 1.2.3')
    expect(out).toContain(`open      ${running.primp.url}`)
    expect(out).toContain(`target    http://localhost:${target}    (vite)`)
    expect(out).toMatch(/Claude Code {3}claude mcp add --scope user primp -- /)
    expect(out).toMatch(/Codex {9}codex mcp add primp -- /)
    expect(out).toContain('.cursor/mcp.json')
    expect(out).toContain('"--project"')
    expect(out).toContain('Press Ctrl+C to stop.')
    // The app answers through the proxy, with the hook injected.
    const page = await (await fetch(`${running.primp.url}/`, { headers: { accept: 'text/html', 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' } })).text()
    expect(page).toContain('<h1>dev</h1>')
    expect(page).toContain('/__primp/hook.js?v=')
    expect(sessionFiles()).toHaveLength(1)
    await running.close()
    await running.close()
    expect(sessionFiles()).toEqual([])
  })

  it('opens the browser on the proxy URL only for a person, and not with --no-open', async () => {
    const target = await devServer()
    const piped = await run({ target: String(target) })
    expect(piped.opened).toEqual([])
    await piped.close()
    const person = await run({ target: String(target), interactive: true })
    expect(person.opened).toEqual([person.primp.url])
    await person.close()
    const declined = await run({ target: String(target), interactive: true, open: false })
    expect(declined.opened).toEqual([])
  })

  it('honours --port and accepts a URL as --target', async () => {
    const target = await devServer()
    const free = await freeLowPort()
    const running = await run({ target: `http://127.0.0.1:${target}/some/path`, port: String(free) })
    expect(running.primp.port).toBe(free)
    expect(running.primp.target).toBe(`http://localhost:${target}`)
  })

  it.skipIf(process.platform === 'win32')('with --exec: starts the dev server, finds its port, and stops it again on close', async () => {
    const devPort = await freeLowPort()
    const running = await run({ exec: `PORT=${devPort} "${process.execPath}" dev.mjs` })
    const port = running.target.port
    expect(port).toBe(devPort)
    expect(running.devServer?.announcedPorts()).toEqual([port])
    expect(running.printed[0]).toContain('starting the dev server')
    expect(running.printed.join('\n')).toMatch(/target {4}http:\/\/localhost:\d+ {4}\(vite; (announced by the dev server|found: node pid \d+ listens there)\)/)
    expect((await probeHttp(port)).html).toBe(true)
    expect((await probeHttp(running.primp.port)).html).toBe(true)
    await running.close()
    expect((await probeHttp(port)).answered).toBe(false)
    expect((await probeHttp(running.primp.port)).answered).toBe(false)
    expect(sessionFiles()).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('with --exec: reports the exit code when the dev server ends by itself', async () => {
    writeFileSync(join(project, 'short.mjs'), `${DEV_SERVER}\nsetTimeout(() => process.exit(7), 700)\n`)
    const running = await run({ exec: `PORT=${await freeLowPort()} "${process.execPath}" short.mjs` })
    expect(await running.devServerExit).toBe(7)
    expect(running.printed.at(-1)).toBe('primp: the dev server ended (exit code 7)')
  })

  it.skipIf(process.platform === 'win32')('without --target or --exec: finds the dev server of this project by its process', async (context) => {
    // A dev server somebody started in the project directory, in a terminal of their own.
    const devPort = await freeLowPort()
    const dev = spawn(process.execPath, ['dev.mjs'], { cwd: project, env: { ...process.env, PORT: String(devPort) }, stdio: 'ignore' })
    children.push(dev)
    await until(async () => (await probeHttp(devPort)).html, 10_000, 'the dev server')
    let running
    try {
      running = await run({})
    } catch (error) {
      // No lsof on this machine: detection can only try well-known ports, which this server is not on.
      if (error instanceof CliError && /lsof is not installed/.test(error.message)) return context.skip('lsof is not installed')
      throw error
    }
    expect(running.target).toEqual({ protocol: 'http', host: 'localhost', port: devPort })
    expect(running.printed.join('\n')).toContain(`target    http://localhost:${devPort}    (vite; found: node pid ${dev.pid} listens there)`)
    expect(running.devServer).toBeUndefined()
    await running.close()
    // Not primp's to stop.
    expect((await probeHttp(devPort)).html).toBe(true)
  })

  it('starts anyway, with a warning, when a named target does not answer yet', async () => {
    const target = await freeLowPort()
    const running = await run({ target: String(target) })
    expect(running.printed[0]).toBe(`primp: nothing answers at http://localhost:${target} yet; starting anyway, the page retries until the dev server is up`)
    const page = await fetch(`${running.primp.url}/`, { headers: { accept: 'text/html' } })
    expect(page.status).toBe(502)
  })

  it('explains what is wrong instead of starting', async () => {
    const target = await devServer()
    const failing: [Partial<RunOptions>, RegExp][] = [
      [{ project: join(work, 'nope'), target: String(target) }, /is not a directory/],
      [{ target: String(target), port: 'eighty' }, /--port must be a number from 1 to 65535, not "eighty"/],
      [{ target: String(target), port: '70000' }, /--port must be a number/],
      [{ target: 'ftp://x' }, /--target: cannot read "ftp:\/\/x" as a dev server address/],
      [{ target: String(target), assets: { hookEntry: join(work, 'missing.ts'), overlayEntry } }, /primp could not start: could not build hook\.js/],
    ]
    for (const [options, message] of failing) {
      const error = await run(options).catch((caught: unknown) => caught)
      expect(error, String(message)).toBeInstanceOf(CliError)
      expect((error as Error).message).toMatch(message)
    }
    expect(sessionFiles()).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('with --exec: fails with the exit code when the command ends before serving, and leaves nothing running', async () => {
    const error = await run({ exec: 'echo "about to fail" && exit 3' }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CliError)
    expect((error as Error).message).toBe('The command "echo "about to fail" && exit 3" ended (exit code 3) before a dev server answered.')
    writeFileSync(join(project, 'mute.mjs'), 'setInterval(() => {}, 1000)\n')
    const slow = await run({ exec: `"${process.execPath}" mute.mjs`, target: '1', startTimeoutMs: 600 }).catch((caught: unknown) => caught)
    expect((slow as Error).message).toMatch(/is running, but no dev server answered within 1 s at http:\/\/localhost:1\./)
    expect(sessionFiles()).toEqual([])
  })
})

describe('openInBrowser', () => {
  it('does not throw when there is nothing to open with', () => {
    expect(() => openInBrowser('http://localhost:1', 'aix')).not.toThrow()
  })
})

describe.skipIf(process.platform === 'win32')('the primp binary', () => {
  function cli(args: string[]): { child: ChildProcess; out: () => string; err: () => string; exit: Promise<number | null> } {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      env: { ...process.env, PRIMP_SESSION_DIR: sessionDir, PRIMP_HOOK_ENTRY: hookEntry, PRIMP_OVERLAY_ENTRY: overlayEntry, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    let out = ''
    let err = ''
    child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => (err += chunk.toString()))
    const exit = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
    return { child, out: () => out, err: () => err, exit }
  }

  it('runs until SIGINT, then removes its session file and exits 130', async () => {
    const target = await devServer()
    const running = cli(['--target', String(target), '--project', project, '--no-open'])
    await until(() => running.out().includes('Press Ctrl+C to stop.'), 20_000, `start-up (stderr: ${running.err()})`)
    const proxy = Number(/open {6}http:\/\/localhost:(\d+)/.exec(running.out())?.[1])
    expect((await probeHttp(proxy)).html).toBe(true)
    const files = sessionFiles()
    expect(files).toHaveLength(1)
    const session = JSON.parse(readFileSync(join(sessionDir, files[0] as string), 'utf8')) as { pid: number; proxyUrl: string }
    expect(session).toMatchObject({ pid: running.child.pid, proxyUrl: `http://localhost:${proxy}` })

    running.child.kill('SIGINT')
    expect(await running.exit).toBe(130)
    expect(sessionFiles()).toEqual([])
    expect((await probeHttp(proxy)).answered).toBe(false)
  }, 30_000)

  it('with --exec, SIGTERM stops the dev server too and exits 143', async () => {
    const running = cli(['--exec', `PORT=${await freeLowPort()} "${process.execPath}" dev.mjs`, '--project', project, '--no-open'])
    await until(() => running.out().includes('Press Ctrl+C to stop.'), 20_000, `start-up (stderr: ${running.err()})`)
    const devPort = Number(/target {4}http:\/\/localhost:(\d+)/.exec(running.out())?.[1])
    expect((await probeHttp(devPort)).html).toBe(true)
    // The dev server's own output is passed on with a prefix.
    expect(running.err()).toMatch(/\[dev\] {3}Local: {3}http:\/\/localhost:\d+\//)
    running.child.kill('SIGTERM')
    expect(await running.exit).toBe(143)
    expect((await probeHttp(devPort)).answered).toBe(false)
    expect(sessionFiles()).toEqual([])
  }, 30_000)

  it('interrupted while --exec is still starting: exits 130 and takes the dev server process down with it', async () => {
    writeFileSync(join(project, 'slow.mjs'), "console.log('slow pid ' + process.pid)\nsetInterval(() => {}, 1000)\n")
    const running = cli(['--exec', `"${process.execPath}" slow.mjs`, '--project', project, '--no-open'])
    const pid = await until(() => Number(/\[dev\] slow pid (\d+)/.exec(running.err())?.[1]) || undefined, 20_000, `the dev command to start (stderr: ${running.err()})`)
    expect(() => process.kill(pid, 0)).not.toThrow()
    running.child.kill('SIGINT')
    expect(await running.exit).toBe(130)
    await until(() => {
      try {
        process.kill(pid, 0)
        return false
      } catch {
        return true
      }
    }, 5000, 'the dev command to be gone')
    expect(sessionFiles()).toEqual([])
  }, 30_000)

  it('prints the problem and exits 1 when no dev server is found, and runs subcommands without starting the proxy', async () => {
    const empty = join(work, 'empty-project')
    mkdirSync(empty, { recursive: true })
    // A port nobody listens on, so the well-known-port fallback cannot find another project's server either.
    const none = cli(['--project', empty, '--no-open', '--port', 'x'])
    expect(await none.exit).toBe(1)
    expect(none.err()).toContain('--port must be a number from 1 to 65535, not "x"')

    const doctor = cli(['doctor', '--project', project])
    expect(await doctor.exit).toBe(0)
    expect(doctor.out()).toMatch(/ok {4}Framework +vite \(package\.json depends on vite\)/)
    expect(doctor.out()).toMatch(/ok {4}Overlay bundles +hook\.js .* \(esbuild\), overlay\.js .* \(esbuild\)/)
    // The parent command's run did not start a proxy after the subcommand returned.
    expect(doctor.out()).not.toContain('Press Ctrl+C')
    expect(sessionFiles()).toEqual([])
  }, 30_000)
})
