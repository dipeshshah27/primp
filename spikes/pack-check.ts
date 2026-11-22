/**
 * Packaging check: what `npm pack` produces must work installed, with nothing else from this repo.
 *
 *   build -> npm pack -> install the tarball into an empty project (offline: it has no dependencies)
 *   -> run the installed `primp` in front of a fixture -> the page gets the dock
 *   -> the installed `primp mcp` answers an MCP client -> Ctrl+C cleans up.
 *
 *   pnpm spike:pack
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client, type CallToolResult } from '@modelcontextprotocol/client'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { createReport, expect, launchBrowser, newPage, onCleanup, rawNavigate, rawRequest, REPO_ROOT, runCleanups, sleep, startFixture, TMP_ROOT, waitFor } from './lib/index.ts'

const report = createReport('Packaging: the npm tarball works installed on its own')
const WORK = join(TMP_ROOT, `pack-${process.pid}`)
const APP = join(WORK, 'app')
const SESSIONS = join(WORK, 'sessions')
const SESSION_DIR_ENV = 'PRIMP_SESSION_DIR'

try {
  mkdirSync(APP, { recursive: true })
  mkdirSync(SESSIONS, { recursive: true })
  onCleanup(() => rmSync(WORK, { recursive: true, force: true }))

  report.section('Build and pack')
  let tarball = ''
  await report.attempt('npm pack builds the package; the tarball holds the bundle, the page scripts and the licence files, and no sources', async () => {
    const out = execFileSync('npm', ['pack', '--json', '--pack-destination', WORK], { cwd: join(REPO_ROOT, 'packages/cli'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const packed = (JSON.parse(out.slice(out.indexOf('['))) as { filename: string; files: { path: string; size: number }[]; size: number; unpackedSize: number }[])[0]
    expect(packed !== undefined, 'npm pack printed no result')
    const info = packed as { filename: string; files: { path: string; size: number }[]; size: number; unpackedSize: number }
    tarball = join(WORK, info.filename)
    const paths = info.files.map((file) => file.path).sort()
    for (const needed of ['dist/cli.js', 'dist/assets/hook.js', 'dist/assets/overlay.js', 'package.json', 'README.md', 'LICENSE', 'NOTICE']) expect(paths.includes(needed), `${needed} is missing from the tarball: ${paths.join(', ')}`)
    const stray = paths.filter((path) => path.startsWith('src/') || path.startsWith('test/') || path.endsWith('.ts'))
    expect(stray.length === 0, `sources in the tarball: ${stray.join(', ')}`)
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'packages/cli/package.json'), 'utf8')) as { dependencies?: Record<string, string>; bin: Record<string, string> }
    expect(Object.keys(pkg.dependencies ?? {}).length === 0, `the package declares dependencies: ${Object.keys(pkg.dependencies ?? {}).join(', ')}`)
    return `${info.filename}: ${(info.size / 1024).toFixed(0)} kB packed, ${(info.unpackedSize / 1024).toFixed(0)} kB unpacked, ${paths.length} files (${paths.join(', ')})`
  })

  report.section('Install into an empty project')
  const bin = join(APP, 'node_modules/.bin/primp')
  await report.attempt('npm install <tarball> works offline and adds nothing but @primp/cli', async () => {
    writeFileSync(join(APP, 'package.json'), JSON.stringify({ name: 'pack-check-app', private: true, version: '0.0.0' }))
    execFileSync('npm', ['install', tarball, '--offline', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: APP, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    expect(existsSync(bin), 'node_modules/.bin/primp is missing')
    const installed = readdirSync(join(APP, 'node_modules')).filter((name) => !name.startsWith('.'))
    expect(installed.length === 1 && installed[0] === '@primp' && readdirSync(join(APP, 'node_modules/@primp')).join() === 'cli', `node_modules holds: ${installed.join(', ')}`)
    const help = execFileSync(bin, ['--help'], { cwd: APP, encoding: 'utf8' })
    expect(help.includes('mcp') && help.includes('doctor') && help.includes('--target'), 'the help text is not the CLI\'s')
    return `installed: ${installed.join(', ')}; primp --help lists mcp, setup, doctor`
  })

  report.section('Run the installed CLI in front of a fixture')
  const fixture = await startFixture('static-html')
  let child: ChildProcess | undefined
  let output = ''
  let proxyUrl = ''
  const started = await report.attempt('primp --target <port> starts, reports prebuilt page scripts, and prints the npx registration command', async () => {
    child = spawn(bin, ['--target', String(fixture.port), '--project', fixture.dir, '--no-open'], { cwd: fixture.dir, env: { ...process.env, [SESSION_DIR_ENV]: SESSIONS, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
    const proc = child
    onCleanup(() => {
      if (proc.exitCode === null) proc.kill('SIGKILL')
    })
    proc.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()))
    proc.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()))
    await waitFor(() => /open\s+(http:\/\/localhost:\d+)/.exec(output)?.[1], { what: 'the line with the proxy URL', timeoutMs: 15_000 })
    proxyUrl = /open\s+(http:\/\/localhost:\d+)/.exec(output)?.[1] ?? ''
    await waitFor(() => output.includes('Ctrl+C'), { timeoutMs: 5000, what: 'the end of the start-up text' })
    expect(output.includes('npx -y @primp/cli mcp'), `the registration text does not use the published command:\n${output}`)
    expect(!output.includes('tsx'), 'the installed CLI mentions tsx')
    const doctor = execFileSync(bin, ['doctor', '--project', fixture.dir], { cwd: fixture.dir, encoding: 'utf8', env: { ...process.env, [SESSION_DIR_ENV]: SESSIONS, NO_COLOR: '1' } })
    expect(/hook\.js .*\(prebuilt\)/.test(doctor) && /overlay\.js .*\(prebuilt\)/.test(doctor), `doctor does not report prebuilt bundles:\n${doctor}`)
    expect(/Session\s+.*running/i.test(doctor) && doctor.includes(proxyUrl), `doctor does not see the running session:\n${doctor}`)
    return `proxy ${proxyUrl}; doctor: ${doctor.split('\n').filter((line) => /Overlay|Session/.test(line)).map((line) => line.trim()).join(' | ')}`
  })

  if (started) {
    await report.attempt('the page comes through with the hook, both scripts are served, and the dock mounts in a browser', async () => {
      const page = await rawNavigate(`${proxyUrl}/`)
      expect(page.status === 200 && page.text.includes('/__primp/hook.js'), `GET / gave ${page.status}; hook tag ${page.text.includes('/__primp/hook.js')}`)
      const hook = await rawRequest(`${proxyUrl}/__primp/hook.js`)
      const overlay = await rawRequest(`${proxyUrl}/__primp/overlay.js`)
      expect(hook.status === 200 && overlay.status === 200, `hook.js ${hook.status}, overlay.js ${overlay.status}`)
      const browser = await launchBrowser()
      const { page: tab, record } = await newPage(browser)
      await tab.goto(`${proxyUrl}/`)
      await tab.waitForFunction(() => (window as unknown as { __primp_test?: unknown }).__primp_test !== undefined, undefined, { timeout: 15_000 })
      await tab.evaluate(() => (window as unknown as { __primp_test: { ready(): Promise<void> } }).__primp_test.ready())
      const mounted = await tab.evaluate(() => document.querySelector('primp-root') !== null)
      expect(mounted, 'no <primp-root> in the page')
      const errors = record.consoleErrors().map((entry) => entry.text)
      expect(errors.length === 0, `console errors: ${errors.slice(0, 3).join(' | ')}`)
      return `hook.js ${hook.body.length} B, overlay.js ${overlay.body.length} B; dock mounted; 0 console errors`
    })

    await report.attempt('the installed `primp mcp` answers an MCP client with six tools and a live session', async () => {
      const transport = new StdioClientTransport({ command: bin, args: ['mcp'], cwd: fixture.dir, env: { ...getDefaultEnvironment(), [SESSION_DIR_ENV]: SESSIONS }, stderr: 'pipe' })
      const client = new Client({ name: 'primp-pack-check', version: '0.0.0' })
      onCleanup(() => client.close().catch(() => undefined))
      await client.connect(transport)
      const names = (await client.listTools()).tools.map((tool) => tool.name)
      expect(names.length === 6, `tools: ${names.join(', ')}`)
      const result = (await client.callTool({ name: 'get_session', arguments: {} })) as CallToolResult
      const summary = result.structuredContent as { target: string; framework: string; browserConnected: boolean }
      expect(result.isError !== true && summary.browserConnected && summary.framework === 'static', JSON.stringify(result.structuredContent ?? result.content))
      await client.close()
      return `tools ${names.join(', ')}; get_session: ${summary.framework} at ${summary.target}, browser connected`
    })

    await report.attempt('Ctrl+C stops it: exit, port closed, session file removed', async () => {
      const proc = child as ChildProcess
      proc.kill('SIGINT')
      await waitFor(() => proc.exitCode !== null || proc.signalCode !== null, { what: 'the CLI to exit', timeoutMs: 10_000 })
      await sleep(200)
      const left = readdirSync(SESSIONS)
      expect(left.length === 0, `session files left: ${left.join(', ')}`)
      const refused = await rawRequest(`${proxyUrl}/`).then(
        () => false,
        () => true,
      )
      expect(refused, 'the proxy port still answers')
      return `exit code ${proc.exitCode}; no session file; the port refuses connections`
    })
  }
} catch (error) {
  report.check('spike ran to completion', false, error instanceof Error ? (error.stack ?? error.message) : String(error))
} finally {
  await runCleanups()
  report.finish()
}
