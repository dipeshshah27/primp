import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { DevServerDetection, ProbeResult } from '../../server/src/detect.ts'
import { probeHttp } from '../../server/src/detect.ts'
import { removeDir, tempDir } from '../../server/test/session-helpers.ts'
import { portsInOutput, startDevServer, waitForDevServer, type DevServerProcess } from '../src/dev-server.ts'

/**
 * `--exec`: real child processes (a tiny Node server standing in for a dev
 * server), started through the shell exactly as the CLI does it.
 */

let dir: string
let serverScript: string
const started: DevServerProcess[] = []

/** Prints its URL like a dev server, serves a page, and keeps a child of its own alive. */
const SERVER = `
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
const delay = Number(process.env.START_DELAY ?? 0)
console.error('starting...')
// A grandchild, as a package manager would have: it must die with the group.
const idle = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
console.log('helper pid ' + idle.pid)
setTimeout(() => {
  const server = createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<h1>dev</h1>'))
  server.listen(Number(process.env.PORT ?? 0), '::1', () => {
    console.log('  \\u001b[32m➜\\u001b[39m  Local:   \\u001b[36mhttp://localhost:' + server.address().port + '/\\u001b[39m')
  })
}, delay)
`

beforeAll(() => {
  dir = tempDir('exec-test')
  serverScript = join(dir, 'server.mjs')
  writeFileSync(serverScript, SERVER)
})

afterEach(async () => {
  while (started.length > 0) await started.pop()?.stop(500)
})

afterAll(() => removeDir(dir))

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(condition: () => boolean, ms = 5000): Promise<void> {
  for (let waited = 0; waited < ms && !condition(); waited += 20) await new Promise((resolve) => setTimeout(resolve, 20))
  if (!condition()) throw new Error('condition not met in time')
}

function run(command: string, env: Record<string, string> = {}): { child: DevServerProcess; lines: string[] } {
  const lines: string[] = []
  const child = startDevServer(command, { cwd: dir, onLine: (line) => lines.push(line), env })
  started.push(child)
  return { child, lines }
}

describe('portsInOutput', () => {
  it('finds local URLs in dev-server banners, through colour codes, each port once', () => {
    const vite = '  VITE v8.3.0  ready in 212 ms\n\n  \u001b[32m➜\u001b[39m  \u001b[1mLocal\u001b[22m:   \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m\n  ➜  Network: use --host to expose\n'
    expect(portsInOutput(vite)).toEqual([5173])
    expect(portsInOutput('   ▲ Next.js 16.0.1 (Turbopack)\n   - Local:        http://localhost:3000\n   - Network:      http://192.168.1.20:3000\n')).toEqual([3000])
    expect(portsInOutput('listening on http://127.0.0.1:8080 and https://[::1]:8443, also http://0.0.0.0:8080/x')).toEqual([8080, 8443])
    expect(portsInOutput('see https://vite.dev/config and http://example.com:9000')).toEqual([])
    expect(portsInOutput('http://localhost:99999 http://localhost:0')).toEqual([])
  })
})

describe.skipIf(process.platform === 'win32')('startDevServer', () => {
  it('runs the command through the shell in the project directory and passes its output on line by line', async () => {
    const { child, lines } = run(`echo "cwd=$PWD" && echo "browser=$BROWSER" && printf 'no newline at the end'`)
    expect(await child.exited).toEqual({ code: 0, signal: null })
    await until(() => lines.length === 3)
    expect(lines[0]).toMatch(new RegExp(`^cwd=.*${dir.split('/').at(-1)}$`))
    expect(lines.slice(1)).toEqual(['browser=none', 'no newline at the end'])
    expect(child.hasExited()).toBe(true)
    await child.stop()
  })

  it('collects stdout and stderr, strips colours from what it keeps, and reports announced ports', async () => {
    const { child, lines } = run(`"${process.execPath}" "${serverScript}"`)
    await until(() => child.announcedPorts().length === 1)
    const port = child.announcedPorts()[0] as number
    expect(lines).toContain('starting...')
    expect(child.output()).toContain(`Local:   http://localhost:${port}/`)
    expect((await probeHttp(port)).html).toBe(true)
  })

  it('stop() ends the whole process group, the grandchild included, and frees the port', async () => {
    const { child } = run(`"${process.execPath}" "${serverScript}"`)
    await until(() => child.announcedPorts().length === 1 && /helper pid \d+/.test(child.output()))
    const port = child.announcedPorts()[0] as number
    const helper = Number(/helper pid (\d+)/.exec(child.output())?.[1])
    expect(alive(helper)).toBe(true)
    await child.stop(2000)
    await child.stop()
    expect(child.hasExited()).toBe(true)
    await until(() => !alive(helper))
    expect((await probeHttp(port)).answered).toBe(false)
  })

  it('reports a command that does not exist as an exit, with the shell\'s message passed on', async () => {
    const { child, lines } = run('reglet-no-such-command-xyz --flag')
    const exit = await child.exited
    expect(exit.code).toBe(127)
    await until(() => lines.length > 0)
    expect(lines.join('\n')).toMatch(/not found/)
  })
})

describe('waitForDevServer', () => {
  const html: ProbeResult = { html: true, answered: true, detail: 'HTTP 200 text/html' }
  const refused: ProbeResult = { html: false, answered: false, detail: 'ECONNREFUSED' }
  const nothing: DevServerDetection = { others: [], ignored: [], method: 'none' }
  const fakeChild = (ports: number[], exited = false): DevServerProcess => ({
    pid: 1,
    output: () => '',
    announcedPorts: () => ports,
    exited: exited ? Promise.resolve({ code: 3, signal: null }) : new Promise(() => {}),
    hasExited: () => exited,
    stop: async () => {},
  })

  it('without --exec, answers at once from detection, found or not', async () => {
    const found = await waitForDevServer({
      projectRoot: '/p',
      detect: async () => ({ chosen: { port: 5173, url: 'http://localhost:5173', via: 'process', pid: 9 }, others: [], ignored: [], method: 'process' }),
      probe: async () => html,
    })
    expect(found).toMatchObject({ status: 'ready', target: { protocol: 'http', host: 'localhost', port: 5173 }, via: 'process' })
    const started = Date.now()
    expect(await waitForDevServer({ projectRoot: '/p', detect: async () => nothing, probe: async () => refused })).toEqual({ status: 'timeout', detection: nothing })
    expect(Date.now() - started).toBeLessThan(300)
  })

  it('with a target, waits for exactly that port; any HTTP answer counts', async () => {
    const asked: number[] = []
    let calls = 0
    const outcome = await waitForDevServer({
      projectRoot: '/p',
      target: { protocol: 'http', host: 'localhost', port: 4000 },
      child: fakeChild([5173]),
      intervalMs: 5,
      probe: async (port) => {
        asked.push(port)
        return ++calls < 3 ? refused : { html: false, answered: true, detail: 'HTTP 404' }
      },
      detect: async () => {
        throw new Error('detection must not run when a target is given')
      },
    })
    expect(outcome).toEqual({ status: 'ready', target: { protocol: 'http', host: 'localhost', port: 4000 }, via: 'target' })
    expect(asked).toEqual([4000, 4000, 4000])
    // A target without a child that does not answer is reported, not waited for.
    expect(await waitForDevServer({ projectRoot: '/p', target: { protocol: 'http', host: 'localhost', port: 4000 }, probe: async () => refused })).toEqual({ status: 'timeout', detection: undefined })
    // A remote or https target is taken as given.
    expect(await waitForDevServer({ projectRoot: '/p', target: { protocol: 'https', host: 'shop.test', port: 443 }, probe: async () => refused })).toMatchObject({ status: 'ready', via: 'target' })
  })

  it('prefers a port the command announced, once it serves a page, over waiting for detection', async () => {
    let ready = false
    setTimeout(() => (ready = true), 40)
    const outcome = await waitForDevServer({
      projectRoot: '/p',
      child: fakeChild([6001]),
      intervalMs: 5,
      probe: async (port) => (port === 6001 && ready ? html : refused),
      detect: async () => nothing,
    })
    expect(outcome).toMatchObject({ status: 'ready', target: { port: 6001 }, via: 'output' })
    // An announced port that is reglet's own is not taken.
    const excluded = await waitForDevServer({ projectRoot: '/p', child: fakeChild([6001], true), excludePorts: [6001], probe: async () => html, detect: async () => nothing })
    expect(excluded.status).toBe('exited')
  })

  it('gives up when the command exits, or after the timeout', async () => {
    expect(await waitForDevServer({ projectRoot: '/p', child: fakeChild([], true), probe: async () => refused, detect: async () => nothing })).toEqual({ status: 'exited', code: 3, signal: null })
    const started = Date.now()
    const outcome = await waitForDevServer({ projectRoot: '/p', child: fakeChild([]), timeoutMs: 60, intervalMs: 10, probe: async () => refused, detect: async () => nothing })
    expect(outcome).toEqual({ status: 'timeout', detection: nothing })
    expect(Date.now() - started).toBeGreaterThanOrEqual(55)
  })
})
