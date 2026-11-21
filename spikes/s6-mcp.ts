/**
 * Spike S6: agent handoff plumbing over MCP stdio.
 *
 *   pnpm spike:s6            run every check (makes ONE headless Claude Code call)
 *   S6_SKIP_CLAUDE=1 ...     leave the Claude Code call out; the spike then cannot pass
 *
 * What is exercised, end to end and with real processes:
 *
 *   fake primp process  --writes-->  ~/.cache/primp/sessions/<id>.json
 *        ^ control endpoint (loopback, bearer token)
 *        |
 *   primp mcp (stdio shim, started from source)  <--stdio-->  MCP client / Claude Code
 *
 * Exit code 0 only when every check passed. A Claude Code check that could not
 * run because of the environment is reported as FAILED-ENV and leaves the exit
 * code to the other checks, but the verdict line says so.
 *
 * This file is also the fake primp process: it re-runs itself with
 * `--fake-primp <projectRoot> <marker>`.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, rmdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { Client, type CallToolResult } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { NOT_RUNNING } from '../packages/cli/src/mcp-shim.ts'
import { defaultSessionDir, findSession, listSessions, writeSessionFile } from '../packages/cli/src/session-file.ts'
import { SessionFileSchema, type SessionSummary } from '../packages/protocol/src/session.ts'
import { createControlServer } from '../packages/server/src/control.ts'

const SELF = fileURLToPath(import.meta.url)
const REPO = resolve(dirname(SELF), '..')
const WORK = join(REPO, '.tmp', 's6-mcp')
const CLI_ENTRY = join(REPO, 'packages', 'cli', 'src', 'index.ts')
/** tsx's loader as a file URL, so `node --import` finds it from any working directory. */
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
const CLAUDE_BIN = join(homedir(), '.local', 'bin', 'claude')
const CLAUDE_TIMEOUT_MS = 120_000

/** `primp mcp`, run from source. */
const SHIM = { command: process.execPath, args: ['--import', TSX_LOADER, CLI_ENTRY, 'mcp'] }

function fakeSummary(marker: string): SessionSummary {
  return {
    target: 'http://dev-server.invalid',
    framework: marker,
    browserConnected: false,
    counts: { pending: 2, claimed: 1, verified: 0 },
  }
}

// ---------------------------------------------------------------------------
// Fake primp process
// ---------------------------------------------------------------------------

async function runFakePrimp(projectRoot: string, marker: string): Promise<void> {
  const emit = (event: Record<string, unknown>): void => void process.stdout.write(`${JSON.stringify(event)}\n`)
  let calls = 0

  // Stands in for the proxy listener, so proxyUrl names a real local port.
  const placeholder = createServer((_req, res) => res.writeHead(204).end())
  await new Promise<void>((done) => placeholder.listen(0, '127.0.0.1', done))

  const control = await createControlServer({
    handlers: {
      get_session: () => {
        calls += 1
        emit({ event: 'call', method: 'get_session', calls })
        return fakeSummary(marker)
      },
    },
  })
  const handle = writeSessionFile({
    projectRoot,
    controlPort: control.port,
    token: control.token,
    proxyUrl: `http://localhost:${(placeholder.address() as AddressInfo).port}`,
  })
  emit({ event: 'ready', pid: process.pid, sessionPath: handle.path, controlPort: control.port, token: control.token })

  const stop = (): void => {
    placeholder.close()
    // process.exit runs the 'exit' listener that removes the session file.
    void control.close().finally(() => process.exit(0))
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

type Outcome = 'PASS' | 'FAIL' | 'SKIP' | 'FAILED-ENV'
interface CheckResult {
  id: string
  name: string
  outcome: Outcome
  evidence: string
}
const results: CheckResult[] = []

function record(id: string, name: string, outcome: Outcome, evidence: string): void {
  results.push({ id, name, outcome, evidence })
  console.log(`[${outcome}] ${id} ${name}\n        ${evidence.split('\n').join('\n        ')}`)
}

/** Runs one check; a thrown error is a FAIL with the message as evidence. */
async function check(id: string, name: string, body: () => Promise<string> | string): Promise<boolean> {
  try {
    record(id, name, 'PASS', await body())
    return true
  } catch (error) {
    record(id, name, 'FAIL', error instanceof Error ? error.message : String(error))
    return false
  }
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: no result within ${ms} ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// ---------------------------------------------------------------------------
// Process bookkeeping: every child is in its own process group and is killed on exit
// ---------------------------------------------------------------------------

const children = new Set<ChildProcess>()

function spawnTracked(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: 'pipe' | 'ignore' }): ChildProcess {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: [options.stdin ?? 'ignore', 'pipe', 'pipe'],
    detached: true,
  })
  children.add(child)
  child.once('exit', () => children.delete(child))
  return child
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    // already gone
  }
}

function waitForExit(child: ChildProcess, ms: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return withTimeout(
    new Promise((done) => child.once('exit', (code, signal) => done({ code, signal }))),
    ms,
    `waiting for pid ${child.pid} to exit`,
  )
}

interface FakePrimp {
  child: ChildProcess
  pid: number
  sessionPath: string
  controlPort: number
  token: string
  marker: string
  projectRoot: string
  /** Number of get_session calls the control endpoint has served. */
  calls(): number
}

async function startFakePrimp(projectRoot: string, marker: string): Promise<FakePrimp> {
  const child = spawnTracked(process.execPath, ['--import', TSX_LOADER, SELF, '--fake-primp', projectRoot, marker], { cwd: REPO })
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
  let calls = 0
  const ready = new Promise<Record<string, unknown>>((done, reject) => {
    createInterface({ input: child.stdout! }).on('line', (line) => {
      let event: Record<string, unknown>
      try {
        event = JSON.parse(line) as Record<string, unknown>
      } catch {
        return
      }
      if (event.event === 'ready') done(event)
      if (event.event === 'call') calls = Number(event.calls)
    })
    child.once('exit', (code, signal) => reject(new Error(`fake primp exited early (code ${code}, signal ${signal}): ${stderr.trim()}`)))
  })
  const event = await withTimeout(ready, 20_000, 'fake primp start')
  return {
    child,
    pid: Number(event.pid),
    sessionPath: String(event.sessionPath),
    controlPort: Number(event.controlPort),
    token: String(event.token),
    marker,
    projectRoot,
    calls: () => calls,
  }
}

// ---------------------------------------------------------------------------
// Small clients
// ---------------------------------------------------------------------------

function rawRpc(port: number, headers: Record<string, string>, body: unknown, method = 'POST'): Promise<{ status: number; body: string }> {
  const data = JSON.stringify(body)
  return new Promise((done, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/rpc', method, agent: false, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => done({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(data)
  })
}

interface ShimConnection {
  client: Client
  transport: StdioClientTransport
  stderr(): string
  close(): Promise<void>
}

const openConnections = new Set<ShimConnection>()

/** Starts the shim in `cwd` and connects the official MCP client to it over stdio. */
async function connectShim(cwd: string, mode: 'legacy' | 'auto', extraArgs: string[] = []): Promise<ShimConnection> {
  // No `env`: the SDK then passes only its default short list (HOME, PATH, ...),
  // which is close to what an agent host gives a stdio server.
  const transport = new StdioClientTransport({ command: SHIM.command, args: [...SHIM.args, ...extraArgs], cwd, stderr: 'pipe' })
  let stderr = ''
  transport.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
  const client = new Client({ name: 'primp-spike-s6', version: '0.0.0' }, { versionNegotiation: { mode } })
  const connection: ShimConnection = {
    client,
    transport,
    stderr: () => stderr,
    close: async () => {
      openConnections.delete(connection)
      await client.close().catch(() => undefined)
    },
  }
  openConnections.add(connection)
  try {
    await withTimeout(client.connect(transport), 30_000, 'MCP connect')
  } catch (error) {
    await connection.close()
    throw new Error(`${error instanceof Error ? error.message : String(error)}${stderr ? `\nshim stderr: ${stderr.trim()}` : ''}`)
  }
  return connection
}

function textOf(result: CallToolResult): string {
  return result.content.map((block) => (block.type === 'text' ? block.text : `[${block.type}]`)).join('\n')
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function checkFakeProcess(fake: FakePrimp, projectRoot: string): Promise<void> {
  await check('1a', 'fake primp process writes a session file with mode 0600', () => {
    expect(fake.pid !== process.pid, 'the fake must be a separate process')
    const sessionsDir = defaultSessionDir()
    expect(dirname(fake.sessionPath) === sessionsDir, `session file is in ${dirname(fake.sessionPath)}, expected ${sessionsDir}`)
    expect(sessionsDir === join(homedir(), '.cache', 'primp', 'sessions'), `unexpected sessions directory ${sessionsDir}`)
    const fileMode = statSync(fake.sessionPath).mode & 0o777
    const dirMode = statSync(sessionsDir).mode & 0o777
    expect(fileMode === 0o600, `file mode is 0${fileMode.toString(8)}, expected 0600`)
    expect((dirMode & 0o077) === 0, `sessions directory mode is 0${dirMode.toString(8)}, expected no group/other access`)
    const file = SessionFileSchema.parse(JSON.parse(readFileSync(fake.sessionPath, 'utf8')))
    expect(file.pid === fake.pid, `pid ${file.pid} != fake pid ${fake.pid}`)
    expect(file.projectRoot === realpathSync.native(projectRoot), `projectRoot ${file.projectRoot}`)
    expect(file.controlPort === fake.controlPort, 'controlPort mismatch')
    expect(file.token === fake.token && file.token.length >= 32, 'token missing or short')
    expect(Math.abs(Date.now() - Date.parse(file.startedAt)) < 60_000, `startedAt ${file.startedAt}`)
    return `pid ${file.pid} (spike pid ${process.pid}); ${fake.sessionPath}; file mode 0${fileMode.toString(8)}, dir mode 0${dirMode.toString(8)}; keys ${Object.keys(file).join(', ')}; token ${file.token.length} chars; control port ${file.controlPort}; proxyUrl ${file.proxyUrl}`
  })

  await check('1b', 'control endpoint answers with the token and refuses everything else', async () => {
    const auth = { authorization: `Bearer ${fake.token}` }
    const before = fake.calls()
    const ok = await rawRpc(fake.controlPort, auth, { method: 'get_session', params: {} })
    expect(ok.status === 200, `authorised call: HTTP ${ok.status} ${ok.body}`)
    const parsed = JSON.parse(ok.body) as { ok: boolean; result: unknown }
    expect(parsed.ok && isDeepStrictEqual(parsed.result, fakeSummary(fake.marker)), `unexpected body ${ok.body}`)
    const cases: [string, number, Promise<{ status: number; body: string }>][] = [
      ['no token', 401, rawRpc(fake.controlPort, {}, { method: 'get_session' })],
      ['wrong token', 401, rawRpc(fake.controlPort, { authorization: `Bearer ${'x'.repeat(43)}` }, { method: 'get_session' })],
      ['Origin header', 403, rawRpc(fake.controlPort, { ...auth, origin: 'http://localhost:3000' }, { method: 'get_session' })],
      ['foreign Host header', 403, rawRpc(fake.controlPort, { ...auth, host: `rebind.example:${fake.controlPort}` }, { method: 'get_session' })],
      ['unknown method', 404, rawRpc(fake.controlPort, auth, { method: 'no_such_method' })],
      ['GET', 400, rawRpc(fake.controlPort, auth, {}, 'GET')],
    ]
    const seen: string[] = []
    for (const [label, status, pending] of cases) {
      const response = await pending
      expect(response.status === status, `${label}: HTTP ${response.status}, expected ${status} (${response.body})`)
      seen.push(`${label} -> ${response.status}`)
    }
    // Give the 'call' line time to arrive, then make sure only the authorised request reached the handler.
    await new Promise((done) => setTimeout(done, 150))
    expect(fake.calls() === before + 1, `handler ran ${fake.calls() - before} times, expected 1`)
    return `authorised -> 200 with the summary; ${seen.join('; ')}; handler ran once`
  })
}

async function checkShim(fake: FakePrimp, nestedCwd: string): Promise<void> {
  let connection: ShimConnection | undefined
  try {
    const connected = await check('2a', 'official MCP client initializes against the shim (cwd nested in the project)', async () => {
      const started = performance.now()
      connection = await connectShim(nestedCwd, 'legacy')
      const ms = Math.round(performance.now() - started)
      const info = connection.client.getServerVersion()
      const instructions = connection.client.getInstructions() ?? ''
      expect(info?.name === 'primp', `server name ${info?.name}`)
      expect(instructions.length > 100, 'server instructions missing')
      expect(connection.client.getProtocolEra() === 'legacy', `era ${connection.client.getProtocolEra()}`)
      return `initialize handshake in ${ms} ms (includes tsx start); server ${info?.name}@${info?.version}; protocol ${connection.client.getNegotiatedProtocolVersion()}; instructions ${instructions.length} chars; cwd ${nestedCwd}`
    })
    if (!connected || !connection) {
      record('2b', 'tools/list returns get_session', 'FAIL', 'not run: no connection')
      record('2c', 'get_session returns text and structuredContent from the fake', 'FAIL', 'not run: no connection')
    } else {
      const { client } = connection
      await check('2b', 'tools/list returns get_session', async () => {
        const { tools } = await withTimeout(client.listTools(), 10_000, 'tools/list')
        // M1/M2 added get_pending_changes and dismiss_change next to get_session (checked by spike:m1-server).
        const tool = tools.find((candidate) => candidate.name === 'get_session')
        expect(tool !== undefined, `tools: ${tools.map((candidate) => candidate.name).join(', ')}`)
        expect((tool.description ?? '').length > 40, 'description missing')
        expect((tool.inputSchema.required ?? []).length === 0, 'get_session must take no arguments')
        const outputKeys = Object.keys((tool.outputSchema?.properties ?? {}) as object)
        expect(isDeepStrictEqual(outputKeys.sort(), ['browserConnected', 'counts', 'framework', 'target']), `outputSchema properties: ${outputKeys.join(', ')}`)
        return `${tools.length} tool(s): ${tools.map((candidate) => candidate.name).join(', ')}; get_session description ${tool.description?.length} chars; no required arguments; outputSchema properties ${outputKeys.join(', ')}; readOnlyHint ${tool.annotations?.readOnlyHint}`
      })
      await check('2c', 'get_session returns text and structuredContent from the fake', async () => {
        const before = fake.calls()
        const started = performance.now()
        const result = await withTimeout(client.callTool({ name: 'get_session', arguments: {} }), 15_000, 'tools/call')
        const ms = Math.round(performance.now() - started)
        expect(!result.isError, `tool reported an error: ${textOf(result)}`)
        expect(isDeepStrictEqual(result.structuredContent, fakeSummary(fake.marker)), `structuredContent ${JSON.stringify(result.structuredContent)}`)
        const text = textOf(result)
        expect(text.includes(fake.marker) && text.includes('browserConnected: false'), `text content lacks the values: ${text}`)
        await new Promise((done) => setTimeout(done, 150))
        expect(fake.calls() === before + 1, `control endpoint served ${fake.calls() - before} calls, expected 1`)
        return `call took ${ms} ms; structuredContent ${JSON.stringify(result.structuredContent)}; text content ${text.length} chars and contains the marker; control endpoint served exactly 1 call`
      })
    }
  } finally {
    await connection?.close()
  }

  await check('2d', 'same shim serves the 2026-07-28 revision (client in auto negotiation mode)', async () => {
    const modern = await connectShim(nestedCwd, 'auto')
    try {
      const era = modern.client.getProtocolEra()
      const version = modern.client.getNegotiatedProtocolVersion()
      expect(era === 'modern', `negotiated era ${era} (protocol ${version})`)
      const result = await withTimeout(modern.client.callTool({ name: 'get_session', arguments: {} }), 15_000, 'tools/call')
      expect(!result.isError && isDeepStrictEqual(result.structuredContent, fakeSummary(fake.marker)), `result ${JSON.stringify(result)}`)
      return `era ${era}, protocol ${version}; structuredContent matches`
    } finally {
      await modern.close()
    }
  })

  await check('2e', 'shim exits by itself when the client closes stdin', async () => {
    const child = spawnTracked(SHIM.command, SHIM.args, { cwd: nestedCwd, stdin: 'pipe' })
    const firstLine = new Promise<string>((done) => createInterface({ input: child.stdout! }).once('line', done))
    child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'eof-check', version: '0' } } })}\n`)
    const reply = JSON.parse(await withTimeout(firstLine, 20_000, 'initialize reply')) as { result?: { serverInfo?: { name?: string } } }
    expect(reply.result?.serverInfo?.name === 'primp', 'no initialize reply on stdout')
    const closedAt = performance.now()
    child.stdin!.end()
    const exit = await waitForExit(child, 5_000)
    const ms = Math.round(performance.now() - closedAt)
    expect(exit.code === 0 && exit.signal === null, `exit code ${exit.code}, signal ${exit.signal}`)
    return `exit code 0, no signal, ${ms} ms after stdin EOF`
  })
}

/** Lookup rules, exercised in this process against a private sessions directory. */
async function checkLookupRules(): Promise<void> {
  await check('2f', 'session lookup: nearest root, symlinked cwd, project below cwd, ambiguity, dead pid cleanup', () => {
    const dir = join(WORK, 'lookup-sessions')
    const tree = join(WORK, 'lookup-tree')
    const mono = join(tree, 'mono')
    const web = join(mono, 'apps', 'web')
    const docs = join(mono, 'apps', 'docs')
    for (const path of [join(web, 'src', 'components'), join(docs, 'src'), join(tree, 'elsewhere')]) mkdirSync(path, { recursive: true })
    symlinkSync(web, join(tree, 'web-link'))
    const base = { controlPort: 1, token: 't'.repeat(43), proxyUrl: 'http://localhost:1' }
    const notes: string[] = []
    const handles: { remove(): void }[] = []

    expect(findSession(web, { dir }).kind === 'none', 'empty directory must give none')

    handles.push(writeSessionFile({ ...base, projectRoot: web }, { dir }))
    let found = findSession(join(web, 'src', 'components'), { dir })
    expect(found.kind === 'found' && found.relation === 'contains-cwd' && found.session.projectRoot === realpathSync.native(web), `nested cwd: ${JSON.stringify(found)}`)
    notes.push('cwd two levels below the root -> found')

    found = findSession(join(tree, 'web-link', 'src'), { dir })
    expect(found.kind === 'found' && found.session.projectRoot === realpathSync.native(web), `symlinked cwd: ${JSON.stringify(found)}`)
    notes.push('cwd reached through a symlink -> found')

    found = findSession(mono, { dir })
    expect(found.kind === 'found' && found.relation === 'inside-cwd', `monorepo root with one app running: ${JSON.stringify(found)}`)
    notes.push('cwd above the only running project -> found')

    expect(findSession(join(tree, 'elsewhere'), { dir }).kind === 'none', 'sibling directory must give none')
    expect(findSession(docs, { dir }).kind === 'none', 'sibling app must give none')
    notes.push('sibling directories -> none')

    handles.push(writeSessionFile({ ...base, projectRoot: docs }, { dir }))
    const ambiguous = findSession(mono, { dir })
    expect(ambiguous.kind === 'ambiguous' && ambiguous.projectRoots.length === 2, `two apps below cwd: ${JSON.stringify(ambiguous)}`)
    notes.push('cwd above two running projects -> ambiguous (2 roots listed)')

    handles.push(writeSessionFile({ ...base, projectRoot: mono, controlPort: 2 }, { dir }))
    found = findSession(join(web, 'src'), { dir })
    expect(found.kind === 'found' && found.session.projectRoot === realpathSync.native(web), `nearest root: ${JSON.stringify(found)}`)
    found = findSession(mono, { dir })
    expect(found.kind === 'found' && found.session.controlPort === 2, `exact root beats projects below: ${JSON.stringify(found)}`)
    notes.push('roots at mono and mono/apps/web -> nearest root wins')

    const exited = spawnSync(process.execPath, ['-e', ''])
    expect(typeof exited.pid === 'number' && exited.pid > 0, 'could not obtain a dead pid')
    const stale = writeSessionFile({ ...base, projectRoot: join(tree, 'elsewhere'), pid: exited.pid }, { dir })
    expect(existsSync(stale.path), 'stale file was not written')
    expect(findSession(join(tree, 'elsewhere'), { dir }).kind === 'none', 'a dead pid must not be returned')
    expect(!existsSync(stale.path), 'the dead session file was not deleted')
    notes.push(`session of exited pid ${exited.pid} -> ignored and file deleted`)

    writeFileSync(join(dir, 'garbage.json'), '{not json')
    expect(listSessions({ dir }).length === 3, `expected 3 live sessions, got ${listSessions({ dir }).length}`)
    notes.push('unparsable file -> skipped')

    for (const handle of handles) handle.remove()
    stale.remove()
    expect(listSessions({ dir }).length === 0, 'remove() left session files behind')
    return notes.join('; ')
  })
}

async function checkNoSession(staleRoot: string, unrelatedCwd: string): Promise<void> {
  await check('3a', 'no session for the directory: the tool returns the actionable error', async () => {
    const lookup = findSession(unrelatedCwd)
    expect(lookup.kind === 'none', `precondition: a real session already covers ${unrelatedCwd} (${JSON.stringify(lookup)})`)
    const connection = await connectShim(unrelatedCwd, 'legacy')
    try {
      const { tools } = await connection.client.listTools()
      expect(tools.some((tool) => tool.name === 'get_session'), 'tools/list must still work without a session')
      const result = await withTimeout(connection.client.callTool({ name: 'get_session', arguments: {} }), 15_000, 'tools/call')
      const text = textOf(result)
      expect(result.isError === true, `expected isError, got ${JSON.stringify(result)}`)
      expect(result.structuredContent === undefined, 'an error result must not carry structuredContent')
      expect(text.startsWith(NOT_RUNNING), `unexpected message: ${text}`)
      return `cwd ${unrelatedCwd}; isError true; text: "${text}"`
    } finally {
      await connection.close()
    }
  })

  await check('3b', 'session of a killed process: reported as not running and its file is cleaned up', async () => {
    const doomed = await startFakePrimp(staleRoot, `doomed-${randomBytes(4).toString('hex')}`)
    killGroup(doomed.child, 'SIGKILL')
    await waitForExit(doomed.child, 5_000)
    expect(existsSync(doomed.sessionPath), 'precondition: SIGKILL should leave the session file behind')
    const connection = await connectShim(staleRoot, 'legacy')
    try {
      const result = await withTimeout(connection.client.callTool({ name: 'get_session', arguments: {} }), 15_000, 'tools/call')
      const text = textOf(result)
      expect(result.isError === true && text.startsWith(NOT_RUNNING), `unexpected result: ${JSON.stringify(result)}`)
      expect(!existsSync(doomed.sessionPath), 'stale session file was not removed')
      return `pid ${doomed.pid} killed with SIGKILL left ${doomed.sessionPath}; shim answered "${text}" and removed the file`
    } finally {
      await connection.close()
      rmSync(doomed.sessionPath, { force: true })
    }
  })
}

/** A session whose pid is alive (reused by another program) but whose control port is closed. */
async function checkDeadEndpoint(root: string): Promise<void> {
  await check('3d', 'session with a live pid but nothing on its control port: not running, file cleaned up', async () => {
    const probe = createServer()
    await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done))
    const closedPort = (probe.address() as AddressInfo).port
    await new Promise((done) => probe.close(done))
    // This process stands in for the unrelated program that now owns the pid.
    const orphan = writeSessionFile({ projectRoot: root, controlPort: closedPort, token: 'o'.repeat(43), proxyUrl: 'http://localhost:1' })
    const connection = await connectShim(root, 'legacy')
    try {
      const result = await withTimeout(connection.client.callTool({ name: 'get_session', arguments: {} }), 15_000, 'tools/call')
      const text = textOf(result)
      expect(result.isError === true && text.startsWith(NOT_RUNNING), `unexpected result: ${JSON.stringify(result)}`)
      expect(!existsSync(orphan.path), 'session file with a dead endpoint was not removed')
      return `pid ${process.pid} alive, port ${closedPort} closed; shim answered "${text}" and removed the file`
    } finally {
      await connection.close()
      orphan.remove()
    }
  })
}

async function checkSessionRemovedOnExit(fake: FakePrimp): Promise<void> {
  await check('3c', 'session file is removed when the primp process exits on SIGTERM', async () => {
    expect(existsSync(fake.sessionPath), 'precondition: session file should still exist')
    fake.child.kill('SIGTERM')
    const exit = await waitForExit(fake.child, 5_000)
    expect(exit.code === 0, `fake exited with code ${exit.code}, signal ${exit.signal}`)
    expect(!existsSync(fake.sessionPath), 'session file still exists after exit')
    return `exit code 0; ${fake.sessionPath} is gone`
  })
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

/** Variables that tie a process to the Claude Code session it was started from; a user's terminal has none of them. */
const PARENT_SESSION_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_CHILD_NOTES_DIR',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
]

const ENV_FAILURE = /log ?in|logged out|api key|credential|authenticat|unauthori[sz]ed|oauth|billing|credit balance|usage limit|rate limit|overloaded|quota|not allowed|account/i

interface StreamEvent {
  type?: string
  subtype?: string
  [key: string]: unknown
}

async function checkClaudeCode(fake: FakePrimp, nestedCwd: string): Promise<void> {
  const id = '4'
  const name = 'Claude Code (headless, one call) calls get_session through the shim'
  if (process.env.S6_SKIP_CLAUDE) {
    record(id, name, 'SKIP', 'S6_SKIP_CLAUDE is set; this check is required, so the spike cannot pass')
    return
  }
  if (!existsSync(CLAUDE_BIN)) {
    record(id, name, 'FAILED-ENV', `claude CLI not found at ${CLAUDE_BIN}`)
    return
  }

  const configPath = join(WORK, 'claude-mcp.json')
  writeFileSync(configPath, `${JSON.stringify({ mcpServers: { primp: { type: 'stdio', command: SHIM.command, args: SHIM.args } } }, null, 2)}\n`)
  const prompt = [
    'Call the get_session tool of the primp MCP server (full name mcp__primp__get_session) exactly once.',
    'Then answer with exactly one line and nothing else, in this form, using the values the tool returned:',
    'browserConnected=<value>; framework=<value>',
    'If the tool is unavailable or fails, answer exactly: TOOL-UNAVAILABLE: <reason>',
  ].join('\n')
  const args = [
    '-p', prompt,
    '--mcp-config', configPath,
    '--strict-mcp-config',
    '--allowedTools', 'mcp__primp__get_session',
    '--tools', 'ToolSearch',
    '--model', 'haiku',
    '--permission-mode', 'dontAsk',
    '--setting-sources', 'project,local',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--max-budget-usd', '0.50',
    '--output-format', 'stream-json',
    '--verbose',
  ]
  const env = { ...process.env }
  for (const key of PARENT_SESSION_ENV) delete env[key]

  const version = spawnSync(CLAUDE_BIN, ['--version'], { encoding: 'utf8', env }).stdout?.trim() ?? 'unknown'
  const callsBefore = fake.calls()
  const started = performance.now()
  const child = spawnTracked(CLAUDE_BIN, args, { cwd: nestedCwd, env })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
  child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    killGroup(child, 'SIGKILL')
  }, CLAUDE_TIMEOUT_MS)
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((done) => {
    child.once('error', (error) => done({ code: null, signal: null, error }))
    child.once('close', (code, signal) => done({ code, signal }))
  })
  clearTimeout(timer)
  const seconds = ((performance.now() - started) / 1000).toFixed(1)
  await new Promise((done) => setTimeout(done, 200))
  const toolCalls = fake.calls() - callsBefore

  const events: StreamEvent[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line) as StreamEvent)
    } catch {
      // not a JSON line; kept in stdout for the error report
    }
  }
  const init = events.find((event) => event.type === 'system' && event.subtype === 'init')
  const final = events.findLast((event) => event.type === 'result')
  const retries = events.filter((event) => event.type === 'system' && event.subtype === 'api_retry')
  const toolUses: string[] = []
  for (const event of events) {
    if (event.type !== 'assistant') continue
    const content = (event.message as { content?: { type?: string; name?: string }[] } | undefined)?.content ?? []
    for (const block of content) if (block.type === 'tool_use' && block.name) toolUses.push(block.name)
  }
  const answer = typeof final?.result === 'string' ? final.result.trim() : ''
  const servers = JSON.stringify(init?.mcp_servers ?? null)
  const facts = [
    `claude ${version}; cwd ${nestedCwd}; ${seconds} s; exit code ${exit.code}${exit.signal ? `, signal ${exit.signal}` : ''}`,
    `model ${String(init?.model ?? 'unknown')}; mcp_servers ${servers}; tool_use blocks: ${toolUses.join(', ') || 'none'}`,
    `turns ${String(final?.num_turns ?? '?')}; estimated cost $${String(final?.total_cost_usd ?? '?')}; permission_denials ${JSON.stringify(final?.permission_denials ?? [])}`,
    `get_session calls that reached the fake control endpoint during the run: ${toolCalls}`,
    `final answer: ${JSON.stringify(answer)}`,
    claudeProjectEntryNote(nestedCwd),
  ].join('\n')
  const tail = (text: string): string => text.trim().split('\n').slice(-12).join('\n')

  if (exit.error) {
    record(id, name, 'FAILED-ENV', `could not start ${CLAUDE_BIN}: ${exit.error.message}`)
    return
  }
  if (timedOut) {
    const outcome: Outcome = retries.length > 0 ? 'FAILED-ENV' : 'FAIL'
    record(id, name, outcome, `killed after the ${CLAUDE_TIMEOUT_MS / 1000} s limit\n${facts}\napi_retry events: ${JSON.stringify(retries)}\nstderr tail: ${tail(stderr)}`)
    return
  }

  const markerInAnswer = answer.includes(fake.marker)
  const valueInAnswer = /browserConnected\s*=\s*false\b/i.test(answer)
  if (exit.code === 0 && final?.is_error !== true && markerInAnswer && valueInAnswer && toolCalls >= 1) {
    record(id, name, 'PASS', `${facts}\nthe answer contains the marker ${fake.marker}, which only the tool result carries, and browserConnected=false`)
    return
  }

  // The model never got to use the tool for a reason outside this repo (login, quota, API outage).
  const failureText = `${answer}\n${stderr}\n${stdout.length > 0 && events.length === 0 ? stdout : ''}`
  const envFailure = toolCalls === 0 && toolUses.length === 0 && (retries.length > 0 || ((final?.is_error === true || exit.code !== 0) && ENV_FAILURE.test(failureText)))
  record(
    id,
    name,
    envFailure ? 'FAILED-ENV' : 'FAIL',
    `${facts}\nmarker in answer: ${markerInAnswer}; browserConnected=false in answer: ${valueInAnswer}; result.is_error: ${String(final?.is_error)}; result.subtype: ${String(final?.subtype)}\napi_retry events: ${JSON.stringify(retries)}\nstderr tail: ${tail(stderr) || '(empty)'}\nstdout tail: ${events.length === 0 ? tail(stdout) : '(stream parsed)'}`,
  )
}

/** Reports whether the headless run left a project entry for its cwd in ~/.claude.json (read-only). */
function claudeProjectEntryNote(cwd: string): string {
  try {
    const config = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8')) as { projects?: Record<string, unknown> }
    const keys = Object.keys(config.projects ?? {})
    const mine = keys.filter((key) => key === cwd || key === realpathSync.native(cwd))
    return mine.length > 0
      ? `note: Claude Code recorded this run's cwd as a project in ~/.claude.json; remove it with: claude purge ${JSON.stringify(mine[0])} --yes`
      : 'no project entry for the run cwd was added to ~/.claude.json'
  } catch (error) {
    return `could not inspect ~/.claude.json: ${error instanceof Error ? error.message : String(error)}`
  }
}

// ---------------------------------------------------------------------------
// Registration reference
// ---------------------------------------------------------------------------

function printRegistration(): void {
  const fromSource = `${SHIM.command} ${SHIM.args.join(' ')}`
  console.log(`
How users register the shim (published package; not executed by this spike)

  Claude Code   https://code.claude.com/docs/en/mcp
    claude mcp add primp -- npx -y primp mcp
    claude mcp add --scope project primp -- npx -y primp mcp      (shared through .mcp.json)
    .mcp.json equivalent:
      { "mcpServers": { "primp": { "command": "npx", "args": ["-y", "primp", "mcp"] } } }

  Codex CLI     https://developers.openai.com/codex/mcp  (redirects to https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
    codex mcp add primp -- npx -y primp mcp
    ~/.codex/config.toml equivalent:
      [mcp_servers.primp]
      command = "npx"
      args = ["-y", "primp", "mcp"]

  Cursor        https://cursor.com/docs/context/mcp      (.cursor/mcp.json in the project)
      {
        "mcpServers": {
          "primp": {
            "type": "stdio",
            "command": "npx",
            "args": ["-y", "primp", "mcp", "--project", "\${workspaceFolder}"]
          }
        }
      }

  From this checkout, replace "npx -y primp mcp" with:
    ${fromSource}
`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  console.log(`Spike S6: agent handoff over MCP stdio\nnode ${process.version}; shim: ${SHIM.command} ${SHIM.args.join(' ')}\n`)
  rmSync(WORK, { recursive: true, force: true })
  const projectRoot = join(WORK, 'project')
  const nestedCwd = join(projectRoot, 'apps', 'web', 'src')
  const staleRoot = join(WORK, 'stale-project')
  const unrelatedCwd = join(WORK, 'unrelated', 'deep')
  for (const path of [nestedCwd, staleRoot, unrelatedCwd]) mkdirSync(path, { recursive: true })

  const sessionsDir = defaultSessionDir()
  const createdDirs = [sessionsDir, dirname(sessionsDir)].filter((path) => !existsSync(path))
  const marker = `s6-${randomBytes(8).toString('hex')}`
  let fake: FakePrimp | undefined

  try {
    try {
      fake = await startFakePrimp(projectRoot, marker)
    } catch (error) {
      record('1a', 'fake primp process writes a session file with mode 0600', 'FAIL', error instanceof Error ? error.message : String(error))
      return 1
    }
    await checkFakeProcess(fake, projectRoot)
    await checkShim(fake, nestedCwd)
    await checkLookupRules()
    await checkNoSession(staleRoot, unrelatedCwd)
    await checkDeadEndpoint(staleRoot)
    await checkClaudeCode(fake, nestedCwd)

    const codex = spawnSync('codex', ['--version'], { encoding: 'utf8' })
    if (codex.error) {
      record('5', 'Codex CLI calls get_session through the shim', 'SKIP', 'codex is not installed on this machine (not on PATH); users register with: codex mcp add primp -- npx -y primp mcp')
    } else {
      record('5', 'Codex CLI calls get_session through the shim', 'SKIP', `codex ${codex.stdout.trim()} is installed but this spike has no Codex check yet; register with: codex mcp add primp -- npx -y primp mcp`)
    }

    await checkSessionRemovedOnExit(fake)
  } finally {
    for (const connection of [...openConnections]) await connection.close()
    for (const child of [...children]) killGroup(child, 'SIGKILL')
    if (fake) rmSync(fake.sessionPath, { force: true })
    rmSync(WORK, { recursive: true, force: true })
    // Leave ~/.cache as it was found: drop the directories this run created, if they are empty.
    for (const path of createdDirs) {
      try {
        rmdirSync(path)
      } catch {
        // not empty or already gone
      }
    }
  }

  printRegistration()

  const failed = results.filter((result) => result.outcome === 'FAIL')
  const claude = results.find((result) => result.id === '4')
  const passed = results.filter((result) => result.outcome === 'PASS').length
  console.log(`Summary: ${passed} passed, ${failed.length} failed, ${results.filter((result) => result.outcome === 'SKIP').length} skipped, ${results.filter((result) => result.outcome === 'FAILED-ENV').length} failed-env`)
  for (const result of results) console.log(`  ${result.outcome.padEnd(10)} ${result.id.padEnd(3)} ${result.name}`)

  if (failed.length > 0) {
    console.log(`\nS6 FAIL: ${failed.map((result) => result.id).join(', ')}`)
    return 1
  }
  if (claude?.outcome === 'FAILED-ENV') {
    console.log('\nS6 NOT PROVEN: every local check passed, but the Claude Code check could not run in this environment (FAILED-ENV above). Exit code follows the other checks.')
    return 0
  }
  if (claude?.outcome !== 'PASS') {
    console.log('\nS6 FAIL: the Claude Code check did not run, and it is required.')
    return 1
  }
  console.log('\nS6 PASS (Codex not checked: not installed)')
  return 0
}

if (process.argv[2] === '--fake-primp') {
  const [, , , projectRoot, marker] = process.argv
  if (!projectRoot || !marker) {
    console.error('usage: s6-mcp.ts --fake-primp <projectRoot> <marker>')
    process.exit(2)
  }
  await runFakePrimp(projectRoot, marker)
} else {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      // Children run in their own process groups, so the terminal's signal does not reach them.
      for (const child of [...children]) killGroup(child, 'SIGKILL')
      rmSync(WORK, { recursive: true, force: true })
      process.exit(130)
    })
  }
  let code = 1
  try {
    code = await main()
  } catch (error) {
    console.error(error)
    for (const child of [...children]) killGroup(child, 'SIGKILL')
  }
  process.exit(code)
}
