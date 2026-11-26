import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderPrompt } from '../../engine/src/prompt.ts'
import type { SourceLoc } from '../../protocol/src/change.ts'
import { ServerMessageSchema, type ClientMessage } from '../../protocol/src/messages.ts'
import { PendingChangesSchema } from '../../protocol/src/session.ts'
import type { ShiftRecording } from '../../protocol/src/shift.ts'
import type { Evidence, SourceResult } from '../../source/src/types.ts'
import { createSession, type Session, type SessionOptions } from '../src/session.ts'
import { FakeSocket, hello, noteItem, statuses, structureItem, styleItem } from './session-helpers.ts'

/**
 * The session with a fake socket per document and a fake resolver. Nothing
 * here touches the network, the file system or a clock other than the one
 * handed in.
 */

const INFO = { target: 'http://localhost:5173', framework: 'vite', projectName: 'shop', version: '0.0.0' }

const EVIDENCE: Evidence = {
  context: { tag: 'h1', classes: [], attrs: {}, ownText: 'Hi', text: 'Hi', path: [], pagePath: '/', pageOrigin: 'http://localhost:5174', pageLoadedAt: 0 },
  hints: [],
  collectMs: 0.2,
}

const RESULT: SourceResult = {
  file: 'src/components/Hero.tsx',
  line: 14,
  col: 7,
  component: 'Hero',
  framework: 'react',
  level: 'exact',
  verifiedOnDisk: true,
  via: 'react-stack',
  target: 'element',
  notes: [],
  resolveMs: 3.5,
}

const RECORDING = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../engine/test/shift-recordings/injected-content__cookie-bar-insertbefore.json', import.meta.url)), 'utf8'),
) as ShiftRecording

interface Rig {
  session: Session
  clock: { now: number }
  resolved: Evidence[]
  logs: string[]
  connect(doc: string, visible?: boolean): FakeSocket
}

function rig(overrides: Partial<SessionOptions> = {}): Rig {
  const clock = { now: 1_750_000_000_000 }
  const resolved: Evidence[] = []
  const logs: string[] = []
  let ids = 0
  const session = createSession({
    info: INFO,
    resolver: {
      async resolve(evidence) {
        resolved.push(evidence)
        return RESULT
      },
    },
    now: () => clock.now,
    newId: (kind) => `${kind}-${++ids}`,
    log: (level, message) => logs.push(`${level}: ${message}`),
    ...overrides,
  })
  return {
    session,
    clock,
    resolved,
    logs,
    connect(doc, visible = true) {
      const socket = new FakeSocket()
      session.attach(socket)
      socket.receive(hello(doc, visible))
      return socket
    },
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
})

describe('hello and state', () => {
  it('answers session:hello with session:state carrying info and items', () => {
    const { connect, session } = rig()
    const socket = connect('doc-a')
    expect(socket.sent).toEqual([{ type: 'session:state', info: INFO, items: [] }])
    expect(session.documents()).toMatchObject([{ doc: 'doc-a', url: 'http://localhost:5174/doc-a', viewport: { w: 1280, h: 800, dpr: 2 }, visible: true }])
    expect(session.getSession()).toEqual({ target: INFO.target, framework: 'vite', browserConnected: true, counts: {} })
  })

  it('every message it sends matches the protocol schema', async () => {
    const { connect, session } = rig({ culprits: async () => undefined })
    const socket = connect('doc-a')
    socket.receive({ type: 'session:upsert', item: styleItem('a') })
    socket.receive({ type: 'session:resolve', reqId: 'r1', evidence: EVIDENCE })
    socket.receive({ type: 'session:send', reqId: 's1', ids: ['a'] })
    socket.receive({ type: 'session:shifts', doc: 'doc-a', recording: RECORDING })
    void session.measure([styleItem('a')], 1000)
    session.reload('replay')
    await flush()
    await vi.waitFor(() => expect(socket.of('session:shift-report')).toHaveLength(1))
    expect(new Set(socket.sent.map((message) => message.type))).toEqual(
      new Set(['session:state', 'session:resolved', 'session:sent', 'session:shift-report', 'session:measure', 'session:reload']),
    )
    for (const message of socket.sent) expect(ServerMessageSchema.safeParse(message).success, message.type).toBe(true)
    session.close()
  })

  it('ignores settle:* messages, other families, binary noise and invalid JSON without answering', () => {
    const { connect } = rig()
    const socket = connect('doc-a')
    const before = socket.sent.length
    socket.receiveRaw(JSON.stringify({ type: 'settle:mutation', doc: 'doc-a', seq: 1, at: 5 }))
    socket.receiveRaw(JSON.stringify({ type: 'other:thing' }))
    socket.receiveRaw('not json')
    socket.receiveRaw(Buffer.from([0xff, 0x00]))
    socket.receiveRaw(JSON.stringify(null))
    socket.receiveRaw(42)
    expect(socket.sent).toHaveLength(before)
  })

  it('accepts Buffer and Buffer[] frames, as the ws package delivers them', () => {
    const { session } = rig()
    const socket = new FakeSocket()
    session.attach(socket)
    const text = JSON.stringify(hello('doc-b'))
    socket.receiveRaw([Buffer.from(text.slice(0, 10)), Buffer.from(text.slice(10))])
    expect(socket.last('session:state')).toBeDefined()
    socket.receiveRaw(Buffer.from(JSON.stringify({ type: 'session:upsert', item: styleItem('a') })))
    expect(session.items()).toHaveLength(1)
  })

  it('does not accept anything but hello before hello, and still answers requests', () => {
    const { session } = rig()
    const socket = new FakeSocket()
    session.attach(socket)
    socket.receive({ type: 'session:upsert', item: styleItem('a') })
    socket.receive({ type: 'session:resolve', reqId: 'r1', evidence: EVIDENCE })
    socket.receive({ type: 'session:send', reqId: 's1', ids: ['a'] })
    expect(session.items()).toEqual([])
    expect(socket.sent).toEqual([
      { type: 'session:resolved', reqId: 'r1', source: null },
      { type: 'session:sent', reqId: 's1', batch: { batchId: '', items: [], prompt: '' } },
    ])
    expect(session.getSession().browserConnected).toBe(false)
  })

  it('forgets a document when its socket closes, and replaces a connection that says hello again under the same id', () => {
    const { connect, session } = rig()
    const first = connect('doc-a')
    const second = connect('doc-a')
    expect(session.documents()).toHaveLength(1)
    session.broadcastState()
    expect(first.of('session:state')).toHaveLength(1)
    expect(second.of('session:state')).toHaveLength(2)
    second.close()
    expect(session.documents()).toEqual([])
    expect(session.getSession().browserConnected).toBe(false)
  })
})

describe('resolve', () => {
  it('passes the evidence to the resolver and answers with a SourceLoc (no timing field)', async () => {
    const { connect, resolved } = rig()
    const socket = connect('doc-a')
    socket.receive({ type: 'session:resolve', reqId: 'r1', evidence: EVIDENCE })
    await flush()
    expect(resolved).toEqual([EVIDENCE])
    const expected: SourceLoc = {
      file: 'src/components/Hero.tsx',
      line: 14,
      col: 7,
      component: 'Hero',
      framework: 'react',
      level: 'exact',
      verifiedOnDisk: true,
      via: 'react-stack',
      target: 'element',
      notes: [],
    }
    expect(socket.last('session:resolved')).toEqual({ type: 'session:resolved', reqId: 'r1', source: expected })
  })

  it('answers source: null when the resolver throws, rejects, or the evidence is not evidence', async () => {
    let mode: 'throw' | 'reject' = 'throw'
    const { connect, logs } = rig({
      resolver: {
        resolve() {
          if (mode === 'throw') throw new Error('boom')
          return Promise.reject(new Error('later boom'))
        },
      },
    })
    const socket = connect('doc-a')
    socket.receive({ type: 'session:resolve', reqId: 'r1', evidence: EVIDENCE })
    await flush()
    mode = 'reject'
    socket.receive({ type: 'session:resolve', reqId: 'r2', evidence: EVIDENCE })
    await flush()
    socket.receive({ type: 'session:resolve', reqId: 'r3', evidence: { nonsense: true } })
    socket.receive({ type: 'session:resolve', reqId: 'r4', evidence: null })
    await flush()
    expect(socket.of('session:resolved')).toEqual([
      { type: 'session:resolved', reqId: 'r1', source: null },
      { type: 'session:resolved', reqId: 'r2', source: null },
      { type: 'session:resolved', reqId: 'r3', source: null },
      { type: 'session:resolved', reqId: 'r4', source: null },
    ])
    expect(logs.filter((line) => line.includes('resolving an element failed'))).toHaveLength(2)
  })

  it('drops positions the protocol cannot carry instead of failing the whole answer', async () => {
    const { connect } = rig({ resolver: { resolve: async () => ({ ...RESULT, line: 0, col: undefined, level: 'file' as const }) } })
    const socket = connect('doc-a')
    socket.receive({ type: 'session:resolve', reqId: 'r1', evidence: EVIDENCE })
    await flush()
    const source = socket.last('session:resolved')?.source
    expect(source).toMatchObject({ file: 'src/components/Hero.tsx', level: 'file' })
    expect(source).not.toHaveProperty('line')
    expect(source).not.toHaveProperty('col')
  })
})

describe('upsert and delete', () => {
  it('stores a draft, numbers it, and broadcasts the state to every document', () => {
    const { connect, session } = rig()
    const a = connect('doc-a')
    const b = connect('doc-b')
    a.receive({ type: 'session:upsert', item: styleItem('one', undefined, { seq: 99 }) })
    a.receive({ type: 'session:upsert', item: structureItem('two') })
    const items = session.items()
    expect(items.map((item) => [item.id, item.seq, item.status])).toEqual([
      ['one', 1, 'draft'],
      ['two', 2, 'draft'],
    ])
    for (const socket of [a, b]) expect(socket.last('session:state')?.items.map((item) => item.id)).toEqual(['one', 'two'])
    expect(b.of('session:state')).toHaveLength(3)
  })

  it('replaces a draft under the same id and keeps its number', () => {
    const { connect, session } = rig()
    const socket = connect('doc-a')
    socket.receive({ type: 'session:upsert', item: styleItem('one') })
    socket.receive({ type: 'session:upsert', item: styleItem('two') })
    socket.receive({ type: 'session:upsert', item: styleItem('one', undefined, { after: { authored: '32px', computed: '32px' }, note: 'roomier' }) })
    const one = session.item('one')
    expect(one).toMatchObject({ seq: 1, note: 'roomier', after: { authored: '32px' } })
    expect(session.items().map((item) => item.id)).toEqual(['one', 'two'])
  })

  it('strips fields only the server sets from an incoming draft', () => {
    const { connect, session } = rig()
    const socket = connect('doc-a')
    socket.receive({ type: 'session:upsert', item: styleItem('one', undefined, { batchId: 'forged', claimedAt: 5, dismissReason: 'x' }) })
    const stored = session.item('one')
    expect(stored).not.toHaveProperty('batchId')
    expect(stored).not.toHaveProperty('claimedAt')
    expect(stored).not.toHaveProperty('dismissReason')
  })

  it('refuses an item that is not a draft, and one that was already sent, and shows the sender the stored state', () => {
    const { connect, session, logs } = rig()
    const socket = connect('doc-a')
    const other = connect('doc-b')
    socket.receive({ type: 'session:upsert', item: styleItem('forged', undefined, { status: 'verified' }) })
    expect(session.items()).toEqual([])
    socket.receive({ type: 'session:upsert', item: styleItem('one') })
    socket.receive({ type: 'session:send', reqId: 's1', ids: ['one'] })
    const statesBefore = other.of('session:state').length
    socket.receive({ type: 'session:upsert', item: styleItem('one', undefined, { after: { authored: '99px', computed: '99px' } }) })
    expect(session.item('one')).toMatchObject({ status: 'queued', after: { authored: '24px' } })
    expect(socket.last('session:state')?.items[0]).toMatchObject({ id: 'one', status: 'queued' })
    // Nothing changed, so the other document is not bothered.
    expect(other.of('session:state')).toHaveLength(statesBefore)
    expect(logs.some((line) => line.includes('only writes drafts'))).toBe(true)
    expect(logs.some((line) => line.includes('can no longer be edited'))).toBe(true)
  })

  it('drops a malformed item, keeps what is stored, and re-sends the state to the sender', () => {
    const { connect, session, logs } = rig()
    const socket = connect('doc-a')
    socket.receive({ type: 'session:upsert', item: styleItem('one') })
    const states = socket.of('session:state').length
    socket.receiveRaw(JSON.stringify({ type: 'session:upsert', item: { ...styleItem('bad'), property: 42 } }))
    socket.receiveRaw(JSON.stringify({ type: 'session:upsert', item: { id: 'worse' } }))
    expect(session.items().map((item) => item.id)).toEqual(['one'])
    expect(socket.of('session:state')).toHaveLength(states + 2)
    expect(logs.filter((line) => line.includes('did not match the protocol'))).toHaveLength(2)
  })

  it('deletes drafts only', () => {
    const { connect, session } = rig()
    const socket = connect('doc-a')
    socket.receive({ type: 'session:upsert', item: styleItem('one') })
    socket.receive({ type: 'session:upsert', item: styleItem('two') })
    socket.receive({ type: 'session:send', reqId: 's1', ids: ['two'] })
    socket.receive({ type: 'session:delete', id: 'one' })
    socket.receive({ type: 'session:delete', id: 'two' })
    socket.receive({ type: 'session:delete', id: 'never-existed' })
    expect(statuses(session.items())).toEqual({ two: 'queued' })
  })
})

describe('activity (the terminal lines)', () => {
  it('says when tabs attach and leave, what is sent, taken, waited for and dismissed', async () => {
    const { connect, session } = rig()
    const seen: string[] = []
    session.onActivity((activity) => seen.push(activity.type === 'tabs' ? `tabs ${activity.tabs}` : activity.type === 'waiting' ? `waiting ${activity.waiting}` : activity.type))
    const socket = connect('doc-a')
    socket.receive({ type: 'session:upsert', item: styleItem('one') })
    const waiting = session.waitForChanges(10_000)
    await flush()
    socket.receive({ type: 'session:send', reqId: 's1', ids: ['one'] })
    await waiting
    session.dismissChange({ id: 'one', reason: 'not ours' })
    socket.close()
    expect(seen).toEqual(['tabs 1', 'waiting true', 'sent', 'waiting false', 'claimed', 'dismissed', 'tabs 0'])
  })
})

describe('waitForChanges (an agent watching)', () => {
  it('hands queued changes over at once, as getPendingChanges does', async () => {
    const { connect, session } = rig()
    const socket = connect('doc-a')
    socket.receive({ type: 'session:upsert', item: styleItem('one') })
    socket.receive({ type: 'session:send', reqId: 's1', ids: ['one'] })
    const pending = await session.waitForChanges(10_000)
    expect(pending.count).toBe(1)
    expect(statuses(session.items())).toEqual({ one: 'claimed' })
  })

  it('waits for Send, tells the dock an agent is waiting meanwhile, and claims what is sent', async () => {
    const { connect, session } = rig()
    const socket = connect('doc-a')
    socket.receive({ type: 'session:upsert', item: styleItem('one') })
    const waiting = session.waitForChanges(10_000)
    await flush()
    expect(socket.last('session:state')?.info.agentWaiting).toBe(true)
    socket.receive({ type: 'session:send', reqId: 's1', ids: ['one'] })
    const pending = await waiting
    expect(pending.count).toBe(1)
    expect(statuses(session.items())).toEqual({ one: 'claimed' })
    expect(socket.last('session:state')?.info.agentWaiting).toBeUndefined()
  })

  it('gives up after the timeout with nothing handed over, and the dock stops saying an agent waits', async () => {
    vi.useFakeTimers()
    const { connect, session } = rig()
    const socket = connect('doc-a')
    const waiting = session.waitForChanges(5000)
    await vi.advanceTimersByTimeAsync(5000)
    const pending = await waiting
    expect(pending.count).toBe(0)
    expect(socket.last('session:state')?.info.agentWaiting).toBeUndefined()
  })

  it('a caller that hangs up claims nothing: the changes stay queued for the next agent', async () => {
    const { connect, session } = rig()
    const socket = connect('doc-a')
    socket.receive({ type: 'session:upsert', item: styleItem('one') })
    const gone = new AbortController()
    const waiting = session.waitForChanges(10_000, gone.signal)
    await flush()
    gone.abort()
    const answer = await waiting
    expect(answer).toMatchObject({ count: 0, waitEnded: 'gone' })
    expect(socket.last('session:state')?.info.agentWaiting).toBeUndefined()
    socket.receive({ type: 'session:send', reqId: 's1', ids: ['one'] })
    expect(statuses(session.items())).toEqual({ one: 'queued' })
  })

  it('two agents wait; the one that loses the Send is told another took it, not that nothing was sent', async () => {
    const { connect, session } = rig()
    const socket = connect('doc-a')
    socket.receive({ type: 'session:upsert', item: styleItem('one') })
    const first = session.waitForChanges(10_000)
    const second = session.waitForChanges(10_000)
    await flush()
    socket.receive({ type: 'session:send', reqId: 's1', ids: ['one'] })
    const answers = await Promise.all([first, second])
    expect(answers.map((answer) => answer.count).sort()).toEqual([0, 1])
    expect(answers.find((answer) => answer.count === 0)?.waitEnded).toBe('taken')
    expect(socket.last('session:sent')?.toAgent).toBe(true)
  })

  it('returns when the session closes', async () => {
    const { session } = rig()
    const waiting = session.waitForChanges(60_000)
    session.close()
    expect(await waiting).toMatchObject({ count: 0, waitEnded: 'closed' })
  })
})

describe('send', () => {
  it('queues the named drafts as one batch and answers with the clipboard prompt', () => {
    const { connect, session } = rig()
    const socket = connect('doc-a')
    const other = connect('doc-b')
    for (const id of ['one', 'two', 'three']) socket.receive({ type: 'session:upsert', item: styleItem(id) })
    socket.receive({ type: 'session:send', reqId: 's1', ids: ['three', 'one', 'unknown'] })
    const sent = socket.last('session:sent')
    expect(sent?.reqId).toBe('s1')
    expect(sent?.batch.batchId).toBe('batch-1')
    // Tray order, not the order of the ids.
    expect(sent?.batch.items.map((item) => [item.id, item.status, item.batchId])).toEqual([
      ['one', 'queued', 'batch-1'],
      ['three', 'queued', 'batch-1'],
    ])
    // The engine's renderer, asked for the clipboard wording.
    expect(sent?.batch.prompt).toBe(renderPrompt(sent?.batch.items ?? [], { batchId: 'batch-1', channel: 'clipboard' }))
    expect(sent?.batch.prompt.length).toBeGreaterThan(0)
    expect(statuses(session.items())).toEqual({ one: 'queued', two: 'draft', three: 'queued' })
    expect(other.last('session:state')?.items.map((item) => item.status)).toEqual(['queued', 'draft', 'queued'])
    expect(other.of('session:sent')).toEqual([])
    expect(session.batch('batch-1')).toMatchObject({ itemIds: ['one', 'three'], sentFrom: 'doc-a' })
    expect(session.batch('batch-1')).not.toHaveProperty('claimedAt')
  })

  it('answers with an empty batch when no id names a draft, and queues nothing', () => {
    const { connect, session } = rig()
    const socket = connect('doc-a')
    socket.receive({ type: 'session:upsert', item: styleItem('one') })
    socket.receive({ type: 'session:send', reqId: 's1', ids: ['one'] })
    socket.receive({ type: 'session:send', reqId: 's2', ids: ['one', 'nope'] })
    socket.receive({ type: 'session:send', reqId: 's3', ids: [] })
    expect(socket.of('session:sent').slice(1)).toEqual([
      { type: 'session:sent', reqId: 's2', batch: { batchId: '', items: [], prompt: '' } },
      { type: 'session:sent', reqId: 's3', batch: { batchId: '', items: [], prompt: '' } },
    ])
    expect(session.batches()).toHaveLength(1)
  })

  it('answers a send that does not parse, so the dock is not left waiting', () => {
    const { connect } = rig()
    const socket = connect('doc-a')
    socket.receiveRaw(JSON.stringify({ type: 'session:send', reqId: 's1', ids: 'one' }))
    expect(socket.last('session:sent')).toEqual({ type: 'session:sent', reqId: 's1', batch: { batchId: '', items: [], prompt: '' } })
  })
})

describe('getPendingChanges', () => {
  function sentRig(): Rig & { socket: FakeSocket } {
    const marks = { seq: 40, at: 0 }
    const base = rig({ mark: () => ({ seq: ++marks.seq, at: 1_750_000_000_500 }) })
    const socket = base.connect('doc-a')
    socket.receive({ type: 'session:upsert', item: styleItem('one', 'src/components/Header.tsx') })
    socket.receive({ type: 'session:upsert', item: structureItem('two', 'src/components/Banner.tsx') })
    socket.receive({ type: 'session:upsert', item: styleItem('three', 'src/components/Header.tsx') })
    socket.receive({ type: 'session:upsert', item: styleItem('four', null) })
    socket.receive({ type: 'session:upsert', item: styleItem('draft-only') })
    return { ...base, socket }
  }

  it('returns nothing, and claims nothing, while nothing is queued', () => {
    const { session, socket } = sentRig()
    const states = socket.of('session:state').length
    expect(session.getPendingChanges()).toEqual({ batchIds: [], count: 0, files: [], prompt: '', claimedAt: null })
    expect(socket.of('session:state')).toHaveLength(states)
  })

  it('hands over queued items grouped by source file, marks them claimed and anchors the batch at the journal mark', () => {
    const { session, socket, clock } = sentRig()
    socket.receive({ type: 'session:send', reqId: 's1', ids: ['one', 'two', 'three', 'four'] })
    clock.now += 4000
    const pending = session.getPendingChanges()
    expect(PendingChangesSchema.safeParse(pending).success).toBe(true)
    expect(pending.batchIds).toEqual(['batch-1'])
    expect(pending.count).toBe(4)
    expect(pending.claimedAt).toBe(clock.now)
    expect(pending.files.map((group) => [group.file, group.items.map((item) => item.id)])).toEqual([
      ['src/components/Header.tsx', ['one', 'three']],
      ['src/components/Banner.tsx', ['two']],
      [null, ['four']],
    ])
    expect(pending.files.flatMap((group) => group.items).every((item) => item.status === 'claimed' && item.claimedAt === clock.now)).toBe(true)
    expect(pending.prompt).toBe(renderPrompt(pending.files.flatMap((group) => group.items).sort((a, b) => a.seq - b.seq), { batchId: 'batch-1', channel: 'mcp' }))
    expect(statuses(session.items())).toEqual({ one: 'claimed', two: 'claimed', three: 'claimed', four: 'claimed', 'draft-only': 'draft' })
    expect(session.batch('batch-1')).toMatchObject({ claimedAt: clock.now, claimMark: { seq: 41, at: 1_750_000_000_500 } })
    expect(socket.last('session:state')?.items.map((item) => item.status)).toEqual(['claimed', 'claimed', 'claimed', 'claimed', 'draft'])
    expect(session.getSession().counts).toEqual({ claimed: 4, draft: 1 })
  })

  it('does not hand the same items out twice, but returns a batch again when asked for it by id', () => {
    const { session, socket, clock } = sentRig()
    socket.receive({ type: 'session:send', reqId: 's1', ids: ['one', 'two'] })
    const first = session.getPendingChanges()
    expect(first.count).toBe(2)
    clock.now += 9000
    expect(session.getPendingChanges().count).toBe(0)
    const again = session.getPendingChanges({ batchId: 'batch-1' })
    expect(again.count).toBe(2)
    // The first claim stays the anchor.
    expect(again.claimedAt).toBe(first.claimedAt)
    expect(session.batch('batch-1')).toMatchObject({ claimedAt: first.claimedAt, claimMark: { seq: 41 } })
    expect(session.getPendingChanges({ batchId: 'no-such-batch' })).toMatchObject({ count: 0, claimedAt: null })
  })

  it('takes several queued batches at once and renders a prompt per batch', () => {
    const { session, socket } = sentRig()
    socket.receive({ type: 'session:send', reqId: 's1', ids: ['one'] })
    socket.receive({ type: 'session:send', reqId: 's2', ids: ['two', 'three'] })
    const pending = session.getPendingChanges()
    expect(pending.batchIds).toEqual(['batch-1', 'batch-2'])
    expect(pending.count).toBe(3)
    const of = (batchId: string) => session.items().filter((item) => item.batchId === batchId)
    expect(pending.prompt).toBe([renderPrompt(of('batch-1'), { batchId: 'batch-1', channel: 'mcp' }), renderPrompt(of('batch-2'), { batchId: 'batch-2', channel: 'mcp' })].join('\n\n'))
    expect(session.batches().every((batch) => batch.claimMark?.seq === 41)).toBe(true)
  })

  it('limits the claim to one batch when a batch id is given', () => {
    const { session, socket } = sentRig()
    socket.receive({ type: 'session:send', reqId: 's1', ids: ['one'] })
    socket.receive({ type: 'session:send', reqId: 's2', ids: ['two'] })
    expect(session.getPendingChanges({ batchId: 'batch-2' }).files.flatMap((group) => group.items.map((item) => item.id))).toEqual(['two'])
    expect(statuses(session.items())).toMatchObject({ one: 'queued', two: 'claimed' })
  })
})

describe('notes', () => {
  it('stores, sends and hands over a note with the other changes; the prompt carries its text', () => {
    const { connect, session } = rig()
    const socket = connect('doc-a')
    socket.receive({ type: 'session:upsert', item: styleItem('one', 'src/components/Header.tsx') })
    socket.receive({ type: 'session:upsert', item: noteItem('n1', 'src/components/Header.tsx', { text: 'Call it "Log in", not "Sign in"' }) })
    socket.receive({ type: 'session:upsert', item: noteItem('n2', 'index.html', { on: 'page', text: 'Add a favicon' }) })
    socket.receive({ type: 'session:send', reqId: 's1', ids: ['one', 'n1', 'n2'] })
    expect(socket.last('session:sent')?.batch.prompt).toContain('> Call it "Log in", not "Sign in"')
    const pending = session.getPendingChanges()
    expect(PendingChangesSchema.safeParse(pending).success).toBe(true)
    expect(pending.count).toBe(3)
    expect(pending.prompt).toContain('# primp batch `batch-1`: 1 change, 2 notes')
    expect(pending.prompt).toContain('Note from the user about the whole page (`/`):\n  > Add a favicon')
    expect(pending.prompt).toContain('these ids: `one`, `n1`, `n2`')
    expect(statuses(session.items())).toEqual({ one: 'claimed', n1: 'claimed', n2: 'claimed' })
  })

  it('refuses a note without text', () => {
    const { connect, session } = rig()
    const socket = connect('doc-a')
    socket.receive({ type: 'session:upsert', item: noteItem('n1', null, { text: '' }) })
    socket.receive({ type: 'session:upsert', item: noteItem('n2', null, { text: '  \n ' }) })
    expect(session.items()).toEqual([])
  })
})

describe('dismissChange', () => {
  it('dismisses a queued or claimed item with the reason and broadcasts', () => {
    const { connect, session } = rig()
    const socket = connect('doc-a')
    socket.receive({ type: 'session:upsert', item: styleItem('one') })
    socket.receive({ type: 'session:upsert', item: styleItem('two') })
    socket.receive({ type: 'session:send', reqId: 's1', ids: ['one', 'two'] })
    session.getPendingChanges({ batchId: 'batch-1' })
    const result = session.dismissChange({ id: 'one', reason: 'comes from a dependency' })
    expect(result).toMatchObject({ id: 'one', dismissed: true, status: 'dismissed' })
    expect(session.item('one')).toMatchObject({ status: 'dismissed', dismissReason: 'comes from a dependency' })
    expect(socket.last('session:state')?.items[0]).toMatchObject({ id: 'one', status: 'dismissed', dismissReason: 'comes from a dependency' })
  })

  it('says why when there is no such item, or it is a draft, or it is closed already', () => {
    const { connect, session } = rig()
    const socket = connect('doc-a')
    socket.receive({ type: 'session:upsert', item: styleItem('draft') })
    socket.receive({ type: 'session:upsert', item: styleItem('sent') })
    socket.receive({ type: 'session:send', reqId: 's1', ids: ['sent'] })
    expect(session.dismissChange({ id: 'nope', reason: 'x' })).toMatchObject({ dismissed: false, status: null })
    expect(session.dismissChange({ id: 'draft', reason: 'x' })).toMatchObject({ dismissed: false, status: 'draft' })
    expect(session.dismissChange({ id: 'sent', reason: 'first' }).dismissed).toBe(true)
    const second = session.dismissChange({ id: 'sent', reason: 'second' })
    expect(second).toMatchObject({ dismissed: false, status: 'dismissed' })
    expect(session.item('sent')?.dismissReason).toBe('first')
    session.patchItem('draft', { status: 'verified' })
    expect(session.dismissChange({ id: 'draft', reason: 'x' })).toMatchObject({ dismissed: false, status: 'verified' })
  })
})

describe('shifts', () => {
  it('attributes the recording, resolves each culprit and answers with the report', async () => {
    const asked: string[] = []
    const where: SourceLoc = { file: 'consent.js', line: 9, framework: 'unknown', level: 'file', verifiedOnDisk: true, via: 'shift-stack', target: 'element', notes: [] }
    const { connect, session } = rig({
      culprits: async (issue) => {
        asked.push(issue.id)
        return where
      },
    })
    const socket = connect('doc-a')
    socket.receive({ type: 'session:shifts', doc: 'doc-a', recording: RECORDING })
    await vi.waitFor(() => expect(socket.of('session:shift-report')).toHaveLength(1))
    const message = socket.last('session:shift-report')
    expect(message?.doc).toBe('doc-a')
    expect(message?.report.status).toBe('ok')
    const withCulprit = message?.report.issues.filter((issue) => issue.culprit !== undefined).map((issue) => issue.id) ?? []
    expect(withCulprit.length).toBeGreaterThan(0)
    expect(asked.sort()).toEqual([...withCulprit].sort())
    expect(message?.culpritSources).toEqual(Object.fromEntries(withCulprit.map((id) => [id, where])))
    expect(session.shifts('doc-a')).toMatchObject({ doc: 'doc-a', report: { status: 'ok' }, culpritSources: message?.culpritSources })
    expect(session.shifts()).toBe(session.shifts('doc-a'))
  })

  it('sends the report without sources when no culprit resolver is given, or when it fails', async () => {
    const plain = rig()
    const a = plain.connect('doc-a')
    a.receive({ type: 'session:shifts', doc: 'doc-a', recording: RECORDING })
    await vi.waitFor(() => expect(a.of('session:shift-report')).toHaveLength(1))
    expect(a.last('session:shift-report')?.culpritSources).toEqual({})

    const failing = rig({
      culprits: () => Promise.reject(new Error('no')),
    })
    const b = failing.connect('doc-b')
    b.receive({ type: 'session:shifts', doc: 'doc-b', recording: RECORDING })
    await vi.waitFor(() => expect(b.of('session:shift-report')).toHaveLength(1))
    expect(b.last('session:shift-report')?.culpritSources).toEqual({})
    expect(b.last('session:shift-report')?.report.issues.length).toBeGreaterThan(0)
  })

  it('does not wait for a slow culprit lookup longer than the limit', async () => {
    vi.useFakeTimers()
    const { connect } = rig({ culprits: () => new Promise(() => {}), culpritTimeoutMs: 500 })
    const socket = connect('doc-a')
    socket.receive({ type: 'session:shifts', doc: 'doc-a', recording: RECORDING })
    await vi.advanceTimersByTimeAsync(499)
    expect(socket.of('session:shift-report')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(2)
    expect(socket.of('session:shift-report')).toHaveLength(1)
    expect(socket.last('session:shift-report')?.culpritSources).toEqual({})
  })

  it('answers only for the newest recording of a document when they arrive faster than they resolve', async () => {
    const release: (() => void)[] = []
    const { connect, session } = rig({ culprits: () => new Promise((resolve) => release.push(() => resolve(undefined))) })
    const socket = connect('doc-a')
    socket.receive({ type: 'session:shifts', doc: 'doc-a', recording: RECORDING })
    socket.receive({ type: 'session:shifts', doc: 'doc-a', recording: { ...RECORDING, capturedAt: RECORDING.capturedAt + 50 } })
    await flush()
    for (const done of release) done()
    await vi.waitFor(() => expect(socket.of('session:shift-report')).toHaveLength(1))
    await flush()
    expect(socket.of('session:shift-report')).toHaveLength(1)
    expect(session.shifts('doc-a')?.recording.capturedAt).toBe(RECORDING.capturedAt + 50)
  })

  it('drops a recording that does not parse', async () => {
    const { connect, logs, session } = rig()
    const socket = connect('doc-a')
    socket.receiveRaw(JSON.stringify({ type: 'session:shifts', doc: 'doc-a', recording: { version: 1, shifts: 'many' } }))
    await flush()
    expect(socket.of('session:shift-report')).toEqual([])
    expect(session.shifts()).toBeUndefined()
    expect(logs.some((line) => line.includes('session:shifts message did not match'))).toBe(true)
  })
})

describe('measure', () => {
  const measured = (reqId: string, visible = true): ClientMessage => ({
    type: 'session:measured',
    reqId,
    visible,
    results: [{ itemId: 'one', locatorConfidence: 0.93, found: true, checks: [] }],
  })

  it('reports no_browser when no document is connected', async () => {
    const { session } = rig()
    expect(await session.measure([styleItem('one')], 1000)).toEqual({ status: 'no_browser' })
  })

  it('sends session:measure with locator and expectations and resolves with the answer', async () => {
    const { connect, session } = rig()
    const socket = connect('doc-a')
    const item = styleItem('one')
    const pending = session.measure([item], 1000)
    const request = socket.last('session:measure')
    expect(request?.items).toEqual([{ itemId: 'one', locator: item.target.locator, expect: item.expect }])
    socket.receive(measured(request?.reqId ?? ''))
    expect(await pending).toEqual({
      status: 'measured',
      doc: 'doc-a',
      url: 'http://localhost:5174/doc-a',
      visible: true,
      results: [{ itemId: 'one', locatorConfidence: 0.93, found: true, checks: [] }],
    })
  })

  it('accepts ready-made measure items as well as whole items', async () => {
    const { connect, session } = rig()
    const socket = connect('doc-a')
    void session.measure([{ itemId: 'x', locator: styleItem('x').target.locator, expect: [{ type: 'hidden' }] }], 1000)
    expect(socket.last('session:measure')?.items).toEqual([{ itemId: 'x', locator: styleItem('x').target.locator, expect: [{ type: 'hidden' }] }])
    session.close()
  })

  it('asks the visible document; among visible ones the one that became visible last', async () => {
    const { connect, session, clock } = rig()
    const hidden = connect('doc-hidden', false)
    clock.now += 10
    const early = connect('doc-early', true)
    clock.now += 10
    const late = connect('doc-late', true)
    void session.measure([], 1000)
    expect([hidden, early, late].map((socket) => socket.of('session:measure').length)).toEqual([0, 0, 1])

    // The early tab is brought to the front again: the late one goes hidden.
    clock.now += 10
    late.receive({ type: 'session:visibility', doc: 'doc-late', visible: false })
    void session.measure([], 1000)
    expect([hidden, early, late].map((socket) => socket.of('session:measure').length)).toEqual([0, 1, 1])
    session.close()
  })

  it('with no visible document, asks the one that was visible most recently and passes on that it is hidden', async () => {
    const { connect, session, clock } = rig()
    const never = connect('doc-never', false)
    clock.now += 10
    const once = connect('doc-once', true)
    clock.now += 10
    once.receive({ type: 'session:visibility', doc: 'doc-once', visible: false })
    clock.now += 10
    const newer = connect('doc-newer', false)
    const pending = session.measure([], 1000)
    expect([never, once, newer].map((socket) => socket.of('session:measure').length)).toEqual([0, 1, 0])
    once.receive(measured(once.last('session:measure')?.reqId ?? '', false))
    expect(await pending).toMatchObject({ status: 'measured', doc: 'doc-once', visible: false })
    expect(session.documents().find((document) => document.doc === 'doc-once')).toMatchObject({ visible: false, lastVisibleAt: 1_750_000_000_020 })
  })

  it('times out, and ignores an answer that arrives afterwards or from another document', async () => {
    vi.useFakeTimers()
    const { connect, session } = rig()
    const socket = connect('doc-a')
    const stranger = connect('doc-b', false)
    const pending = session.measure([], 800)
    const reqId = socket.last('session:measure')?.reqId ?? ''
    stranger.receive(measured(reqId))
    await vi.advanceTimersByTimeAsync(801)
    expect(await pending).toEqual({ status: 'timeout', doc: 'doc-a', visible: true })
    socket.receive(measured(reqId))
  })

  it('resolves as disconnected when the document goes away, or the session closes', async () => {
    const { connect, session } = rig()
    const socket = connect('doc-a')
    const first = session.measure([], 5000)
    socket.close()
    expect(await first).toEqual({ status: 'disconnected', doc: 'doc-a' })
    const other = connect('doc-b')
    const second = session.measure([], 5000)
    expect(other.of('session:measure')).toHaveLength(1)
    session.close()
    expect(await second).toEqual({ status: 'disconnected', doc: 'doc-b' })
    expect(await session.measure([], 5000)).toEqual({ status: 'no_browser' })
  })
})

describe('hooks for later milestones', () => {
  it('forwards session:reverify to listeners until they unsubscribe', () => {
    const { connect, session } = rig()
    const socket = connect('doc-a')
    const seen: [string[], string | undefined][] = []
    const off = session.onReverify((ids, doc) => seen.push([ids, doc]))
    socket.receive({ type: 'session:reverify', ids: ['one', 'two'] })
    off()
    socket.receive({ type: 'session:reverify', ids: ['three'] })
    expect(seen).toEqual([[['one', 'two'], 'doc-a']])
  })

  it('patchItem stores a verification result and broadcasts; reload reaches one document', () => {
    const { connect, session } = rig()
    const a = connect('doc-a')
    const b = connect('doc-b', false)
    a.receive({ type: 'session:upsert', item: styleItem('one') })
    const verification = { itemId: 'one', attempt: 1, at: 5, status: 'pass' as const, checks: [], hint: 'matches' }
    expect(session.patchItem('one', { status: 'verified', verification })).toBe(true)
    expect(session.patchItem('nope', { status: 'verified' })).toBe(false)
    expect(b.last('session:state')?.items[0]).toMatchObject({ status: 'verified', verification })
    expect(session.reload('cold replay')).toBe(true)
    expect(a.last('session:reload')).toEqual({ type: 'session:reload', reason: 'cold replay' })
    expect(b.of('session:reload')).toEqual([])
    expect(session.reload('for b', 'doc-b')).toBe(true)
    expect(b.of('session:reload')).toHaveLength(1)
    expect(session.reload('nobody', 'doc-z')).toBe(false)
  })

  it('keeps a journal of what happened to items, numbered with the items', () => {
    const { connect, session } = rig()
    const socket = connect('doc-a')
    socket.receive({ type: 'session:upsert', item: styleItem('one') })
    socket.receive({ type: 'session:upsert', item: styleItem('two') })
    socket.receive({ type: 'session:delete', id: 'two' })
    socket.receive({ type: 'session:send', reqId: 's1', ids: ['one'] })
    session.getPendingChanges()
    session.dismissChange({ id: 'one', reason: 'no' })
    expect(session.journal().map((event) => [event.seq, event.type, event.itemIds.join(',')])).toEqual([
      [1, 'upsert', 'one'],
      [2, 'upsert', 'two'],
      [3, 'delete', 'two'],
      [4, 'send', 'one'],
      [5, 'claim', 'one'],
      [6, 'dismiss', 'one'],
    ])
    expect(session.journal(4).map((event) => event.type)).toEqual(['claim', 'dismiss'])
  })
})

describe('prompt rendering', () => {
  it('still hands the changes over when the renderer throws', async () => {
    vi.resetModules()
    vi.doMock('../../engine/src/prompt.ts', () => ({
      renderPrompt: () => {
        throw new Error('renderer bug')
      },
    }))
    try {
      const { createSession: createWithBrokenRenderer } = await import('../src/session.ts')
      const session = createWithBrokenRenderer({ info: INFO, resolver: { resolve: async () => RESULT }, newId: () => 'batch-x' })
      const socket = new FakeSocket()
      session.attach(socket)
      socket.receive(hello('doc-a'))
      socket.receive({ type: 'session:upsert', item: styleItem('one') })
      socket.receive({ type: 'session:send', reqId: 's1', ids: ['one'] })
      const prompt = socket.last('session:sent')?.batch.prompt ?? ''
      expect(prompt).toContain('batch-x')
      expect(prompt).toContain('renderer bug')
      expect(prompt).toContain('"padding-top"')
      expect(session.getPendingChanges().prompt).toContain('"padding-top"')
    } finally {
      vi.doUnmock('../../engine/src/prompt.ts')
      vi.resetModules()
    }
  })
})

describe('projectRelative', () => {
  it('makes a stylesheet path inside the project relative and leaves everything else alone', async () => {
    const { projectRelative } = await import('../src/session.ts')
    expect(projectRelative('/work/app/src/styles/site.css', '/work/app')).toBe('src/styles/site.css')
    expect(projectRelative('/work/app/src/Card.module.css?direct', '/work/app/')).toBe('src/Card.module.css?direct')
    expect(projectRelative('/work/application/a.css', '/work/app')).toBe('/work/application/a.css')
    expect(projectRelative('http://localhost:5173/src/a.css', '/work/app')).toBe('http://localhost:5173/src/a.css')
    expect(projectRelative('/work/app/a.css', undefined)).toBe('/work/app/a.css')
  })
})
