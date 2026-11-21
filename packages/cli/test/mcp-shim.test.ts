import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Client, InMemoryTransport, type CallToolResult } from '@modelcontextprotocol/client'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { DismissChangeResultSchema, PendingChangesSchema, SessionSummarySchema } from '../../protocol/src/session.ts'
import { createControlServer, type ControlServer } from '../../server/src/control.ts'
import { writeSessionFile, type SessionHandle } from '../../server/src/session-file.ts'
import { createSession, type Session } from '../../server/src/session.ts'
import { FakeSocket, hello, removeDir, structureItem, styleItem, tempDir } from '../../server/test/session-helpers.ts'
import { createShimServer, NOT_RUNNING } from '../src/mcp-shim.ts'

/**
 * The MCP shim against a real control endpoint and a real session, with the
 * official MCP client on an in-memory transport. (The same over real stdio,
 * with a browser on the other end, is spike `m1-server`.)
 */

let work: string
let project: string
let sessionDir: string
let session: Session
let control: ControlServer
let file: SessionHandle | undefined
let page: FakeSocket
const closers: (() => Promise<void>)[] = []

beforeAll(() => {
  work = tempDir('shim-test')
  project = join(work, 'shop')
  sessionDir = join(work, 'sessions')
  mkdirSync(join(project, 'src'), { recursive: true })
})

afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.()
  file?.remove()
  file = undefined
  await control?.close()
})

afterAll(() => removeDir(work))

async function startBackend(): Promise<void> {
  let ids = 0
  session = createSession({
    info: { target: 'http://localhost:5173', framework: 'vite', projectName: 'shop', version: '0.0.0' },
    resolver: { resolve: async () => ({ framework: 'unknown', level: 'candidates', verifiedOnDisk: false, via: 'none', target: 'element', notes: [], resolveMs: 0 }) },
    newId: (kind) => `${kind}-${++ids}`,
  })
  control = await createControlServer({
    handlers: {
      get_session: () => session.getSession(),
      get_pending_changes: (params) => session.getPendingChanges(params),
      dismiss_change: (params) => session.dismissChange(params),
    },
  })
  file = writeSessionFile({ projectRoot: project, controlPort: control.port, token: control.token, proxyUrl: 'http://localhost:5174' }, { dir: sessionDir })
  page = new FakeSocket()
  session.attach(page)
  page.receive(hello('doc-1'))
}

async function connect(cwd = join(project, 'src')): Promise<Client> {
  const server = createShimServer({ cwd, dir: sessionDir, version: '1.2.3', controlTimeoutMs: 3000 })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'primp-test', version: '0.0.0' })
  await server.connect(serverSide)
  await client.connect(clientSide)
  closers.push(async () => {
    await client.close()
    await server.close()
  })
  return client
}

const text = (result: CallToolResult): string => result.content.map((block) => (block.type === 'text' ? block.text : `[${block.type}]`)).join('\n')
const call = async (client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> => (await client.callTool({ name, arguments: args })) as CallToolResult

describe('primp mcp', () => {
  it('lists six tools with schemas, and instructions that describe the loop', async () => {
    await startBackend()
    const client = await connect()
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toEqual(['get_session', 'get_pending_changes', 'verify_changes', 'get_layout_shifts', 'verify_layout_shift', 'dismiss_change'])
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
    expect(Object.keys(byName.get_pending_changes?.inputSchema.properties ?? {})).toEqual(['batchId'])
    expect(byName.get_pending_changes?.inputSchema.required ?? []).toEqual([])
    expect([...(byName.dismiss_change?.inputSchema.required ?? [])].sort()).toEqual(['id', 'reason'])
    expect(Object.keys(byName.verify_changes?.inputSchema.properties ?? {}).sort()).toEqual(['ids', 'waitMs'])
    expect(byName.verify_changes?.inputSchema.required ?? []).toEqual([])
    expect(Object.keys(byName.verify_changes?.outputSchema?.properties ?? {}).sort()).toEqual(['counts', 'fixup', 'results', 'summary'])
    expect(Object.keys(byName.get_pending_changes?.outputSchema?.properties ?? {}).sort()).toEqual(['batchIds', 'claimedAt', 'count', 'files', 'prompt'])
    expect(Object.keys(byName.dismiss_change?.outputSchema?.properties ?? {}).sort()).toEqual(['dismissed', 'id', 'message', 'status'])
    for (const tool of tools) expect((tool.description ?? '').length, tool.name).toBeGreaterThan(120)
    expect(byName.get_session?.annotations?.readOnlyHint).toBe(true)
    expect(byName.get_pending_changes?.annotations?.readOnlyHint).toBe(false)

    const instructions = client.getInstructions() ?? ''
    for (const word of ['get_session', 'get_pending_changes', 'dismiss_change', 'verify_changes', 'could not look']) expect(instructions).toContain(word)
    expect(client.getServerVersion()).toMatchObject({ name: 'primp', version: '1.2.3' })
  })

  it('get_pending_changes hands over what was sent, as text and as structured content, and claims it', async () => {
    await startBackend()
    const client = await connect()
    const empty = await call(client, 'get_pending_changes')
    expect(empty.isError).toBeFalsy()
    expect(text(empty)).toMatch(/^Nothing is queued/)
    expect(empty.structuredContent).toEqual({ batchIds: [], count: 0, files: [], prompt: '', claimedAt: null })

    page.receive({ type: 'session:upsert', item: styleItem('pad', 'src/Header.tsx') })
    page.receive({ type: 'session:upsert', item: structureItem('gone', 'src/Banner.tsx') })
    page.receive({ type: 'session:upsert', item: styleItem('lost', null) })
    page.receive({ type: 'session:send', reqId: 's1', ids: ['pad', 'gone', 'lost'] })

    const summary = SessionSummarySchema.parse((await call(client, 'get_session')).structuredContent)
    expect(summary).toMatchObject({ browserConnected: true, counts: { queued: 3 } })

    const result = await call(client, 'get_pending_changes')
    expect(result.isError).toBeFalsy()
    const pending = PendingChangesSchema.parse(result.structuredContent)
    expect(pending.count).toBe(3)
    expect(pending.batchIds).toEqual(['batch-1'])
    expect(pending.files.map((group) => [group.file, group.items.map((item) => `${item.id}:${item.status}`)])).toEqual([
      ['src/Header.tsx', ['pad:claimed']],
      ['src/Banner.tsx', ['gone:claimed']],
      [null, ['lost:claimed']],
    ])
    const body = text(result)
    expect(body).toContain('3 change(s) from batch batch-1 are now claimed by you.')
    expect(body).toContain('  src/Header.tsx: pad')
    expect(body).toContain('  (source file unknown): lost')
    expect(body.endsWith(pending.prompt)).toBe(true)
    expect(pending.prompt.length).toBeGreaterThan(0)

    // The dock was told, and a second call has nothing new.
    expect(page.last('session:state')?.items.map((item) => item.status)).toEqual(['claimed', 'claimed', 'claimed'])
    expect(PendingChangesSchema.parse((await call(client, 'get_pending_changes')).structuredContent).count).toBe(0)
    const again = PendingChangesSchema.parse((await call(client, 'get_pending_changes', { batchId: 'batch-1' })).structuredContent)
    expect([again.count, again.claimedAt]).toEqual([3, pending.claimedAt])
    expect(text(await call(client, 'get_pending_changes', { batchId: 'batch-9' }))).toMatch(/^Batch batch-9 has no queued or claimed changes/)
  })

  it('dismiss_change closes a change with the reason; a refusal is a tool error with the explanation', async () => {
    await startBackend()
    const client = await connect()
    page.receive({ type: 'session:upsert', item: styleItem('pad') })
    page.receive({ type: 'session:upsert', item: styleItem('draft') })
    page.receive({ type: 'session:send', reqId: 's1', ids: ['pad'] })
    await call(client, 'get_pending_changes')

    const done = await call(client, 'dismiss_change', { id: 'pad', reason: 'The header comes from the design-system package.' })
    expect(done.isError).toBeFalsy()
    expect(DismissChangeResultSchema.parse(done.structuredContent)).toMatchObject({ id: 'pad', dismissed: true, status: 'dismissed' })
    expect(text(done)).toContain('Change pad is dismissed')
    expect(session.item('pad')).toMatchObject({ status: 'dismissed', dismissReason: 'The header comes from the design-system package.' })

    const twice = await call(client, 'dismiss_change', { id: 'pad', reason: 'again' })
    expect(twice.isError).toBe(true)
    expect(text(twice)).toBe('Change pad was not dismissed: it was dismissed before.')
    expect(twice.structuredContent).toBeUndefined()
    expect(text(await call(client, 'dismiss_change', { id: 'draft', reason: 'x' }))).toContain('still editing it')
    expect(text(await call(client, 'dismiss_change', { id: 'nope', reason: 'x' }))).toBe('No change has the id nope.')

    // Arguments the schema refuses never reach primp.
    const invalid = await call(client, 'dismiss_change', { id: 'pad' }).catch((error: unknown) => error)
    const refused = invalid instanceof Error ? invalid.message : text(invalid as CallToolResult)
    expect(refused).toMatch(/reason/)
    expect(session.item('draft')?.status).toBe('draft')
  })

  it('says that primp is not running, for every tool, when no session covers the directory', async () => {
    await startBackend()
    const client = await connect(join(work, 'elsewhere-not-a-project'))
    for (const [name, args] of [
      ['get_session', {}],
      ['get_pending_changes', {}],
      ['dismiss_change', { id: 'x', reason: 'y' }],
    ] as const) {
      const result = await call(client, name, args)
      expect(result.isError, name).toBe(true)
      expect(text(result).startsWith(NOT_RUNNING), name).toBe(true)
      expect(result.structuredContent).toBeUndefined()
    }
  })

  it('reports a session whose process stopped answering and removes its stale file', async () => {
    await startBackend()
    const client = await connect()
    await control.close()
    const result = await call(client, 'get_pending_changes')
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('no longer answers')
    expect(text(await call(client, 'get_session'))).toContain('no running session covers')
  })
})
