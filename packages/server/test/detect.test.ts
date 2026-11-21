import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  detectDevServer,
  detectFramework,
  frameworkFromPackageJson,
  normalizeHost,
  orderCandidates,
  parseLsofCwd,
  parseLsofListen,
  parseTarget,
  targetOrigin,
  type ProbeResult,
} from '../src/detect.ts'
import { removeDir, tempDir } from './session-helpers.ts'

/**
 * Where the `lsof` samples come from:
 *
 *   macOS   recorded on macOS 26.6 with lsof 4.91: `lsof -nP -iTCP -sTCP:LISTEN` and
 *           `lsof -a -p <pids> -d cwd -Fn`, with Node processes listening on `*`, `[::1]` and
 *           `127.0.0.1`. The system lines are verbatim apart from the user name. The node lines
 *           keep the recorded layout (including the narrower DEVICE value of one IPv4 line);
 *           their pids, ports and directories were rewritten into one scenario: a project
 *           /Users/sam/code/shop with a Vite server (5173), a Next server in apps/admin (3000
 *           plus a second port), a reglet proxy (5174) and another project's server on 8080.
 *   Linux   NOT recorded: written by hand after lsof's documented column layout (numeric
 *           DEVICE, long user names). It checks that the parser does not depend on the macOS
 *           column widths, nothing more.
 */

const LSOF_LISTEN_MACOS = `COMMAND     PID   USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
rapportd    434 sam   11u  IPv4 0x2f9720a4515987d2      0t0  TCP *:58921 (LISTEN)
rapportd    434 sam   12u  IPv6 0x77ffe0f73dd4d4a0      0t0  TCP *:58921 (LISTEN)
Spotify     481 sam   79u  IPv4 0xa52d0a624e88abf4      0t0  TCP 127.0.0.1:7768 (LISTEN)
ControlCe   487 sam    9u  IPv4 0x427d96945fdd2d0e      0t0  TCP *:7000 (LISTEN)
ControlCe   487 sam   11u  IPv4 0x75e1cd57e7058626      0t0  TCP *:5000 (LISTEN)
ControlCe   487 sam   12u  IPv6 0xaa01a54191f3e78d      0t0  TCP *:5000 (LISTEN)
Code\\x20H  1944 sam   42u  IPv4 0x22cf709dd281e754      0t0  TCP 127.0.0.1:49208 (LISTEN)
node      41875 sam   23u  IPv6 0x4f3a1d2c9b8e7a61      0t0  TCP [::1]:5173 (LISTEN)
node      41990 sam   18u  IPv6 0x1b0d7e5a3c2f4e90      0t0  TCP [::1]:3000 (LISTEN)
node      41990 sam   26u  IPv6 0x6e2a9c4b8d1f3a57      0t0  TCP *:52044 (LISTEN)
node      42107 sam   19u  IPv4  0xda05206f8ecbd25      0t0  TCP 127.0.0.1:8080 (LISTEN)
node      42311 sam   21u  IPv6 0x3c8b5d2e7a9f1b64      0t0  TCP [::1]:5174 (LISTEN)
node      42311 sam   22u  IPv4 0x5a7e3c9d1b4f2a86      0t0  TCP 127.0.0.1:5174 (LISTEN)
node      42311 sam   24u  IPv4 0x8f1b6d4a2c7e9d35      0t0  TCP 127.0.0.1:61402 (LISTEN)
node      42400 sam   12u  IPv4 0x8f1b6d4a2c7e9d77      0t0  TCP 10.0.0.12:9229 (LISTEN)
`

const LSOF_CWD_MACOS = `p434
fcwd
n/
p481
fcwd
n/
p487
fcwd
n/
p1944
fcwd
n/
p41875
fcwd
n/Users/sam/code/shop
p41990
fcwd
n/Users/sam/code/shop/apps/admin
p42107
fcwd
n/Users/sam/code/other-site
p42311
fcwd
n/Users/sam/code/shop
`

const LSOF_LISTEN_LINUX = `COMMAND    PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
systemd-r  612 systemd-resolve   15u  IPv4  21431      0t0  TCP 127.0.0.53:53 (LISTEN)
sshd       901 root    3u  IPv4  24210      0t0  TCP *:22 (LISTEN)
sshd       901 root    4u  IPv6  24212      0t0  TCP *:22 (LISTEN)
node     15220 dev    22u  IPv4 118236      0t0  TCP 127.0.0.1:5173 (LISTEN)
node     15377 dev    21u  IPv6 120114      0t0  TCP *:4321 (LISTEN)
python3  15502 dev     3u  IPv4 121877      0t0  TCP *:8000 (LISTEN)
`

describe('parseLsofListen', () => {
  it('reads command, pid, family, address and port of every listening socket (macOS)', () => {
    const sockets = parseLsofListen(LSOF_LISTEN_MACOS)
    expect(sockets).toHaveLength(15)
    expect(sockets[0]).toEqual({ command: 'rapportd', pid: 434, address: '*', port: 58921, family: 'IPv4' })
    expect(sockets.find((socket) => socket.port === 5173)).toEqual({ command: 'node', pid: 41875, address: '[::1]', port: 5173, family: 'IPv6' })
    expect(sockets.find((socket) => socket.port === 9229)).toMatchObject({ address: '10.0.0.12', pid: 42400 })
    // lsof escapes the blank in "Code Helper" (and truncates the name).
    expect(sockets.find((socket) => socket.pid === 1944)?.command).toBe('Code H')
  })

  it('reads the Linux layout, where the device column is a number and the user name is long', () => {
    const sockets = parseLsofListen(LSOF_LISTEN_LINUX)
    expect(sockets.map((socket) => `${socket.command}:${socket.pid}:${socket.address}:${socket.port}`)).toEqual([
      'systemd-r:612:127.0.0.53:53',
      'sshd:901:*:22',
      'sshd:901:*:22',
      'node:15220:127.0.0.1:5173',
      'node:15377:*:4321',
      'python3:15502:*:8000',
    ])
  })

  it('skips the header, blank lines, sockets that are not listening and anything it cannot read', () => {
    const noise = [
      'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME',
      '',
      'node 1 sam 20u IPv4 0x1 0t0 TCP 127.0.0.1:5173->127.0.0.1:60000 (ESTABLISHED)',
      'node 2 sam 20u IPv4 0x1 0t0 UDP *:5353',
      'lsof: WARNING: can\'t stat() something',
      'node 3 sam 20u IPv4 0x1 0t0 TCP *:http-alt (LISTEN)',
    ].join('\n')
    expect(parseLsofListen(noise)).toEqual([])
    expect(parseLsofListen('')).toEqual([])
  })
})

describe('parseLsofCwd', () => {
  it('maps each pid to its working directory', () => {
    const cwds = parseLsofCwd(LSOF_CWD_MACOS)
    expect(cwds.size).toBe(8)
    expect(cwds.get(41875)).toBe('/Users/sam/code/shop')
    expect(cwds.get(41990)).toBe('/Users/sam/code/shop/apps/admin')
    expect(cwds.get(434)).toBe('/')
  })

  it('copes with processes that have no cwd line, paths with spaces, and deleted directories', () => {
    const cwds = parseLsofCwd('p10\np11\nfcwd\nn/home/dev/my project\np12\nfcwd\nn/home/dev/gone (deleted)\n')
    expect([...cwds]).toEqual([
      [11, '/home/dev/my project'],
      [12, '/home/dev/gone'],
    ])
    expect(parseLsofCwd('').size).toBe(0)
  })
})

describe('framework detection', () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ['next', { dependencies: { next: '16.0.0', react: '19.0.0' } }, 'next'],
    ['vite', { devDependencies: { vite: '^8.0.0', '@vitejs/plugin-react': '6' } }, 'vite'],
    ['sveltekit over vite', { devDependencies: { '@sveltejs/kit': '2', vite: '8', svelte: '5' } }, 'sveltekit'],
    ['astro', { dependencies: { astro: '6' } }, 'astro'],
    ['nuxt', { devDependencies: { nuxt: '4' } }, 'nuxt'],
    ['remix over vite', { dependencies: { '@remix-run/react': '2' }, devDependencies: { vite: '6' } }, 'remix'],
    ['react-router framework mode over vite', { dependencies: { 'react-router': '7' }, devDependencies: { '@react-router/dev': '7', vite: '6' } }, 'react-router'],
    ['react-router as a library in a Vite app', { dependencies: { 'react-router': '7' }, devDependencies: { vite: '6' } }, 'vite'],
    ['nothing known', { dependencies: { express: '5' } }, 'unknown'],
    ['no dependency fields', { name: 'x' }, 'unknown'],
  ]
  for (const [name, pkg, expected] of cases) {
    it(`package.json: ${name}`, () => expect(frameworkFromPackageJson(pkg).framework).toBe(expected))
  }

  it('is not thrown off by a package.json that is not an object', () => {
    for (const value of [null, 'text', 3, []]) expect(frameworkFromPackageJson(value).framework).toBe('unknown')
  })

  describe('on disk', () => {
    let dir: string
    beforeAll(() => {
      dir = tempDir('detect-test')
    })
    afterAll(() => removeDir(dir))
    const project = (name: string, files: Record<string, string>): string => {
      const root = join(dir, name)
      mkdirSync(root, { recursive: true })
      for (const [file, text] of Object.entries(files)) {
        mkdirSync(join(root, file, '..'), { recursive: true })
        writeFileSync(join(root, file), text)
      }
      return root
    }

    it('reads package.json and reports the package name and the reason', () => {
      const root = project('next-app', { 'package.json': JSON.stringify({ name: 'shop', dependencies: { next: '16' } }) })
      expect(detectFramework(root)).toEqual({ framework: 'next', packageName: 'shop', reason: 'package.json depends on next' })
    })

    it('calls a directory with an index.html and no framework static', () => {
      expect(detectFramework(project('plain', { 'index.html': '<h1>hi</h1>' })).framework).toBe('static')
      expect(detectFramework(project('plain-pkg', { 'index.html': '<h1>hi</h1>', 'package.json': '{"name":"site","scripts":{"dev":"node server.mjs"}}' }))).toMatchObject({ framework: 'static', packageName: 'site' })
      expect(detectFramework(project('public-only', { 'public/index.html': '<h1>hi</h1>' })).framework).toBe('static')
    })

    it('says unknown, with the reason, for an empty directory or an unreadable package.json', () => {
      expect(detectFramework(project('empty', {}))).toEqual({ framework: 'unknown', reason: 'no package.json and no index.html' })
      const broken = detectFramework(project('broken', { 'package.json': '{ not json' }))
      expect(broken.framework).toBe('unknown')
      expect(broken.reason).toMatch(/package\.json could not be read/)
    })
  })
})

describe('targets', () => {
  it('reads ports, host:port pairs and URLs, and always says localhost for this machine', () => {
    expect(parseTarget('5173')).toEqual({ protocol: 'http', host: 'localhost', port: 5173 })
    expect(parseTarget(3000)).toEqual({ protocol: 'http', host: 'localhost', port: 3000 })
    expect(parseTarget('localhost:4321')).toEqual({ protocol: 'http', host: 'localhost', port: 4321 })
    expect(parseTarget('127.0.0.1:8080')).toEqual({ protocol: 'http', host: 'localhost', port: 8080 })
    expect(parseTarget('http://[::1]:5173/app?x=1')).toEqual({ protocol: 'http', host: 'localhost', port: 5173 })
    expect(parseTarget('[::1]:5173')).toEqual({ protocol: 'http', host: 'localhost', port: 5173 })
    expect(parseTarget('http://0.0.0.0:3000')).toEqual({ protocol: 'http', host: 'localhost', port: 3000 })
    expect(parseTarget(' https://localhost:3443/ ')).toEqual({ protocol: 'https', host: 'localhost', port: 3443 })
    expect(parseTarget('http://localhost')).toEqual({ protocol: 'http', host: 'localhost', port: 80 })
    expect(parseTarget('https://shop.test')).toEqual({ protocol: 'https', host: 'shop.test', port: 443 })
    expect(parseTarget('http://192.168.1.20:5173')).toEqual({ protocol: 'http', host: '192.168.1.20', port: 5173 })
  })

  it('refuses what is not an address, with a message for the user', () => {
    for (const bad of ['', '0', '70000', 'ftp://localhost:21', 'not a url', 'http://']) {
      expect(() => parseTarget(bad), bad).toThrow(/cannot read ".*" as a dev server address/)
    }
  })

  it('normalises hosts and prints origins', () => {
    expect(['LOCALHOST', '127.0.0.1', '127.1.2.3', '::1', '[::1]', '0.0.0.0', '::', 'app.localhost'].map(normalizeHost)).toEqual(Array(8).fill('localhost'))
    expect(normalizeHost('Shop.Test')).toBe('shop.test')
    expect(targetOrigin({ protocol: 'http', host: 'localhost', port: 5173 })).toBe('http://localhost:5173')
    expect(targetOrigin({ protocol: 'https', host: 'shop.test', port: 443 })).toBe('https://shop.test')
    expect(targetOrigin({ protocol: 'http', host: 'fe80::1', port: 80 })).toBe('http://[fe80::1]')
  })
})

describe('detectDevServer', () => {
  const html: ProbeResult = { html: true, answered: true, detail: 'HTTP 200 text/html' }
  const refused: ProbeResult = { html: false, answered: false, detail: 'ECONNREFUSED' }
  const notHtml: ProbeResult = { html: false, answered: true, detail: 'HTTP 426, content type (none)' }

  /** `lsof` scripted with the recorded output; records what was asked. */
  function lsof(listen = LSOF_LISTEN_MACOS, cwd = LSOF_CWD_MACOS): { run: (command: string, args: string[]) => Promise<string>; calls: string[][] } {
    const calls: string[][] = []
    return {
      calls,
      run: async (command, args) => {
        calls.push([command, ...args])
        return args.includes('-iTCP') ? listen : cwd
      },
    }
  }
  const probeWith = (answers: Record<number, ProbeResult>): { probe: (port: number) => Promise<ProbeResult>; asked: number[] } => {
    const asked: number[] = []
    return {
      asked,
      probe: async (port) => {
        asked.push(port)
        return answers[port] ?? refused
      },
    }
  }

  it('finds the ports of processes working inside the project and asks only those', async () => {
    const { run, calls } = lsof()
    const { probe, asked } = probeWith({ 5173: html, 3000: html, 5174: html, 52044: notHtml, 61402: refused })
    const detection = await detectDevServer({ projectRoot: '/Users/sam/code/shop', framework: 'vite', run, probe, platform: 'darwin' })
    expect(calls).toEqual([
      ['lsof', '-nP', '-iTCP', '-sTCP:LISTEN'],
      ['lsof', '-a', '-p', '434,481,487,1944,41875,41990,42107,42311,42400', '-d', 'cwd', '-Fn'],
    ])
    // Not 8080 (another project), not 5000/7000 (system), not 9229 (no cwd known).
    expect(asked.sort((a, b) => a - b)).toEqual([3000, 5173, 5174, 52044, 61402])
    expect(detection.method).toBe('process')
    expect(detection.chosen).toEqual({ port: 5173, url: 'http://localhost:5173', via: 'process', pid: 41875, command: 'node', cwd: '/Users/sam/code/shop' })
    expect(detection.others.map((other) => other.port)).toEqual([3000, 5174])
    expect(detection.ignored).toEqual([
      { port: 52044, reason: 'HTTP 426, content type (none)' },
      { port: 61402, reason: 'ECONNREFUSED' },
    ])
    expect(detection.processScan).toBeUndefined()
  })

  it('prefers the framework default port, then the lowest port, whatever order lsof lists them in', async () => {
    const { probe } = probeWith({ 5173: html, 3000: html, 5174: html })
    const forNext = await detectDevServer({ projectRoot: '/Users/sam/code/shop', framework: 'next', run: lsof().run, probe, platform: 'darwin' })
    expect(forNext.chosen?.port).toBe(3000)
    expect(forNext.others.map((other) => other.port)).toEqual([5173, 5174])
    const forUnknown = await detectDevServer({ projectRoot: '/Users/sam/code/shop', run: lsof().run, probe, platform: 'darwin' })
    expect(forUnknown.chosen?.port).toBe(3000)
    const reversed = LSOF_LISTEN_MACOS.split('\n').reverse().join('\n')
    const again = await detectDevServer({ projectRoot: '/Users/sam/code/shop', framework: 'vite', run: lsof(reversed).run, probe, platform: 'darwin' })
    expect([again.chosen?.port, ...again.others.map((other) => other.port)]).toEqual([5173, 3000, 5174])
    expect(orderCandidates([{ port: 9 }, { port: 4321 }, { port: 3 }], 'astro').map((candidate) => candidate.port)).toEqual([4321, 3, 9])
  })

  it('narrows to a sub-project, and leaves out ports and processes that are reglet itself', async () => {
    const { probe } = probeWith({ 5173: html, 3000: html, 5174: html })
    const admin = await detectDevServer({ projectRoot: '/Users/sam/code/shop/apps/admin', run: lsof().run, probe, platform: 'darwin' })
    expect([admin.chosen?.port, admin.others.length]).toEqual([3000, 0])
    const withoutProxy = await detectDevServer({ projectRoot: '/Users/sam/code/shop', framework: 'vite', run: lsof().run, probe, platform: 'darwin', excludePids: [42311], excludePorts: [3000] })
    expect([withoutProxy.chosen?.port, withoutProxy.others.length]).toEqual([5173, 0])
    // A directory whose name merely starts the same is not inside the project.
    const sibling = await detectDevServer({ projectRoot: '/Users/sam/code/sho', run: lsof().run, probe: probeWith({}).probe, platform: 'darwin' })
    expect(sibling.method).toBe('none')
  })

  it('reports project ports that answer without HTML and does not fall back to other ports then', async () => {
    const { probe, asked } = probeWith({ 5173: notHtml, 8080: html })
    const detection = await detectDevServer({
      projectRoot: '/Users/sam/code/shop',
      run: lsof('COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nnode 41875 sam 23u IPv6 0x4f 0t0 TCP [::1]:5173 (LISTEN)\n').run,
      probe,
      platform: 'darwin',
    })
    expect(detection.chosen).toBeUndefined()
    expect(detection.method).toBe('none')
    expect(detection.ignored).toEqual([{ port: 5173, reason: 'HTTP 426, content type (none)' }])
    expect(asked).toEqual([5173])
  })

  it('falls back to the well-known ports when no process of the project listens', async () => {
    const { probe, asked } = probeWith({ 8080: html, 4321: html, 5000: notHtml })
    const detection = await detectDevServer({ projectRoot: '/Users/sam/code/elsewhere', framework: 'astro', run: lsof().run, probe, platform: 'darwin' })
    expect(asked.sort((a, b) => a - b)).toEqual([3000, 4200, 4321, 5000, 5173, 8000, 8080])
    expect(detection.method).toBe('port')
    expect(detection.chosen).toEqual({ port: 4321, url: 'http://localhost:4321', via: 'port' })
    expect(detection.others).toEqual([{ port: 8080, url: 'http://localhost:8080', via: 'port' }])
    // Well-known ports that did not answer are not "ignored project ports".
    expect(detection.ignored).toEqual([])
  })

  it('on Windows, and without lsof, says so and still tries the well-known ports', async () => {
    const { probe } = probeWith({ 5173: html })
    const neverRun = async (): Promise<string> => {
      throw new Error('must not be called on Windows')
    }
    const windows = await detectDevServer({ projectRoot: 'C:\\code\\shop', run: neverRun, probe, platform: 'win32' })
    expect(windows.chosen?.port).toBe(5173)
    expect(windows.processScan).toMatch(/not supported on Windows; pass --target/)

    const missing = await detectDevServer({
      projectRoot: '/Users/sam/code/shop',
      run: async () => {
        throw Object.assign(new Error('spawn lsof ENOENT'), { code: 'ENOENT' })
      },
      probe,
      platform: 'linux',
    })
    expect(missing.chosen).toMatchObject({ port: 5173, via: 'port' })
    expect(missing.processScan).toMatch(/lsof is not installed/)
  })

  it('finds nothing when nothing answers', async () => {
    const detection = await detectDevServer({ projectRoot: '/nowhere', run: lsof('', '').run, probe: probeWith({}).probe, platform: 'linux' })
    expect(detection).toEqual({ others: [], ignored: [], method: 'none' })
  })
})

describe('against the real machine', () => {
  it.skipIf(process.platform === 'win32')('lsof finds a server this process opened, and the HTTP probe tells a page from a non-page', async (context) => {
    const { createServer } = await import('node:http')
    const { listProjectListeners, probeHttp } = await import('../src/detect.ts')
    const page = createServer((_, res) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<h1>ok</h1>'))
    const api = createServer((_, res) => res.writeHead(404, { 'content-type': 'application/json' }).end('{}'))
    const redirect = createServer((_, res) => res.writeHead(302, { location: '/en' }).end())
    const listen = (server: ReturnType<typeof createServer>, host: string): Promise<number> =>
      new Promise((resolve) => server.listen(0, host, () => resolve((server.address() as { port: number }).port)))
    // `::1` only, as Vite listens: reachable as "localhost", refused on 127.0.0.1.
    const pagePort = await listen(page, '::1')
    const apiPort = await listen(api, '127.0.0.1')
    const redirectPort = await listen(redirect, '127.0.0.1')
    try {
      expect(await probeHttp(pagePort)).toMatchObject({ html: true, answered: true })
      expect(await probeHttp(apiPort)).toMatchObject({ html: false, answered: true })
      expect(await probeHttp(redirectPort)).toMatchObject({ html: true, answered: true })
      page.close()
      await new Promise((resolve) => page.once('close', resolve))
      expect(await probeHttp(pagePort)).toMatchObject({ html: false, answered: false })

      let listeners
      try {
        listeners = await listProjectListeners(process.cwd())
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return context.skip('lsof is not installed')
        throw error
      }
      const mine = listeners.filter((socket) => socket.pid === process.pid).map((socket) => socket.port)
      expect(mine).toContain(apiPort)
      expect(mine).toContain(redirectPort)
      expect(mine).not.toContain(pagePort)
      // A directory this process does not work in.
      const elsewhere = await listProjectListeners(tempDirName)
      expect(elsewhere.filter((socket) => socket.pid === process.pid)).toEqual([])
    } finally {
      for (const server of [page, api, redirect]) server.close()
    }
  })
})

const tempDirName = join(process.cwd(), '.tmp', 'no-such-project')
