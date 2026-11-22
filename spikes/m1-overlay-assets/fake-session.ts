/**
 * A small stand-in for the session server, for the overlay's integration check. It speaks the
 * protocol of packages/protocol/src/messages.ts over the overlay socket and nothing more:
 *
 *   session:hello    -> session:state
 *   session:resolve  -> session:resolved with a canned source position
 *   session:upsert   -> stored as a draft, then session:state to every socket
 *   session:delete   -> removed, then session:state
 *   session:send     -> the drafts become `queued`; session:sent with a prompt that lists them
 *   session:shifts   -> session:shift-report from the real attributor (packages/engine)
 *   session:measured -> resolves the pending `measure()` call
 *
 * Every `session:*` message the browser sends is parsed with the protocol's zod schema; a
 * message that does not parse is recorded in `invalid` and the spike fails on it.
 * `settle:*` messages are counted and otherwise ignored.
 */

import type { IncomingMessage } from 'node:http'
import type { WebSocket } from 'ws'
import { attributeShifts } from '../../packages/engine/src/shift-attributor.ts'
import type { ChangeItem, SourceLoc } from '../../packages/protocol/src/change.ts'
import { ClientMessageSchema, type ClientMessage, type ServerMessage, type SessionInfo } from '../../packages/protocol/src/messages.ts'
import type { ShiftReport } from '../../packages/protocol/src/shift.ts'

type Measured = Extract<ClientMessage, { type: 'session:measured' }>
type MeasureItems = Extract<ServerMessage, { type: 'session:measure' }>['items']

export interface FakeSession {
  onWebSocket(socket: WebSocket, request: IncomingMessage): void
  items: Map<string, ChangeItem>
  /** Every valid `session:*` message received, in order. */
  received: ClientMessage[]
  /** Messages that did not match the protocol: type and the first schema issues. */
  invalid: string[]
  settleMessages: number
  hellos: { doc: string; url: string }[]
  /** The last report the attributor produced, by document id. */
  reports: Map<string, ShiftReport>
  /** Open sockets that have said hello. */
  connections(): number
  /** Sends a report to every document as if it were its own. */
  pushShiftReport(report: ShiftReport): void
  /** Changes a stored item (a status, a verification result) and broadcasts the state. */
  patchItem(id: string, patch: Partial<ChangeItem>): void
  /** Asks the newest document to measure and resolves with its answer. */
  measure(items: MeasureItems): Promise<Measured>
  /** Forgets everything and drops every socket, like a server that restarted. */
  restart(): void
  count(type: ClientMessage['type']): number
  /** What `session:sent` says after Send in place of the dock's own text (`note`); undefined: nothing, as primp's server. */
  sentNote: string | undefined
}

export function sourceFor(tag: string): SourceLoc {
  return {
    file: 'src/components/Card.tsx',
    line: 12,
    col: 5,
    component: 'Card',
    framework: 'react',
    level: 'exact',
    verifiedOnDisk: true,
    via: `canned for <${tag}>`,
    target: 'element',
    notes: [],
  }
}

export function createFakeSession(info: SessionInfo): FakeSession {
  const sockets = new Map<WebSocket, { doc?: string }>()
  const items = new Map<string, ChangeItem>()
  const pendingMeasures = new Map<string, (message: Measured) => void>()
  let seq = 0
  let batches = 0
  let requests = 0

  const send = (socket: WebSocket, message: ServerMessage): void => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
  }
  const state = (): ServerMessage => ({ type: 'session:state', info, items: [...items.values()].sort((a, b) => a.seq - b.seq) })
  const broadcast = (): void => {
    for (const [socket, connection] of sockets) if (connection.doc !== undefined) send(socket, state())
  }

  const session: FakeSession = {
    items,
    received: [],
    invalid: [],
    settleMessages: 0,
    sentNote: undefined,
    hellos: [],
    reports: new Map(),
    connections: () => [...sockets.values()].filter((connection) => connection.doc !== undefined).length,
    count: (type) => session.received.filter((message) => message.type === type).length,

    onWebSocket(socket) {
      const connection: { doc?: string } = {}
      sockets.set(socket, connection)
      socket.on('close', () => sockets.delete(socket))
      socket.on('error', () => sockets.delete(socket))
      socket.on('message', (data) => {
        let raw: unknown
        try {
          raw = JSON.parse(String(data))
        } catch {
          session.invalid.push(`not JSON: ${String(data).slice(0, 80)}`)
          return
        }
        const type = (raw as { type?: unknown } | null)?.type
        if (typeof type !== 'string') return
        if (type.startsWith('settle:')) {
          session.settleMessages++
          return
        }
        const parsed = ClientMessageSchema.safeParse(raw)
        if (!parsed.success) {
          session.invalid.push(`${type}: ${parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}`)
          return
        }
        const message = parsed.data
        session.received.push(message)
        switch (message.type) {
          case 'session:hello':
            connection.doc = message.doc
            session.hellos.push({ doc: message.doc, url: message.url })
            send(socket, state())
            break
          case 'session:resolve': {
            const tag = (message.evidence as { context?: { tag?: string } } | null)?.context?.tag
            send(socket, { type: 'session:resolved', reqId: message.reqId, source: typeof tag === 'string' ? sourceFor(tag) : null })
            break
          }
          case 'session:upsert': {
            const existing = items.get(message.item.id)
            if (existing !== undefined && existing.status !== 'draft') {
              send(socket, state())
              break
            }
            items.set(message.item.id, { ...message.item, status: 'draft', seq: existing?.seq ?? ++seq })
            broadcast()
            break
          }
          case 'session:delete':
            if (items.get(message.id)?.status === 'draft') items.delete(message.id)
            broadcast()
            break
          case 'session:send': {
            const wanted = new Set(message.ids)
            const drafts = [...items.values()].filter((item) => wanted.has(item.id) && item.status === 'draft').sort((a, b) => a.seq - b.seq)
            const batchId = `batch-${++batches}`
            for (const item of drafts) {
              item.status = 'queued'
              item.batchId = batchId
            }
            const lines = drafts.map((item, index) => {
              const where = item.target.source?.file === undefined ? 'source unknown' : `${item.target.source.file}:${item.target.source.line ?? '?'}`
              const what = item.kind === 'style' ? `${item.property}: ${item.before.authored ?? item.before.computed} -> ${item.after.authored}` : item.kind === 'structure' ? item.op : `note: ${item.text}`
              return `${index + 1}. ${item.target.label} (${where}): ${what}`
            })
            const prompt = `# primp ${batchId}: ${drafts.length} change(s)\n${lines.join('\n')}`
            const batch = { batchId, items: drafts, prompt: drafts.length === 0 ? '' : prompt }
            send(socket, session.sentNote === undefined ? { type: 'session:sent', reqId: message.reqId, batch } : { type: 'session:sent', reqId: message.reqId, batch, note: session.sentNote })
            broadcast()
            break
          }
          case 'session:shifts': {
            const report = attributeShifts(message.recording)
            session.reports.set(message.doc, report)
            const culpritSources: Record<string, SourceLoc> = {}
            for (const issue of report.issues) if (issue.culprit !== undefined) culpritSources[issue.id] = { ...sourceFor(issue.culprit.node.tag), file: 'index.html', line: 38, level: 'file', verifiedOnDisk: false }
            send(socket, { type: 'session:shift-report', doc: message.doc, report, culpritSources })
            break
          }
          case 'session:measured':
            pendingMeasures.get(message.reqId)?.(message)
            pendingMeasures.delete(message.reqId)
            break
          default:
            break
        }
      })
    },

    pushShiftReport(report) {
      for (const [socket, connection] of sockets) {
        if (connection.doc !== undefined) send(socket, { type: 'session:shift-report', doc: connection.doc, report, culpritSources: {} })
      }
    },

    patchItem(id, patch) {
      const item = items.get(id)
      if (item === undefined) throw new Error(`no item ${id}`)
      items.set(id, { ...item, ...patch } as ChangeItem)
      broadcast()
    },

    measure(measureItems) {
      const target = [...sockets.entries()].filter(([, connection]) => connection.doc !== undefined).pop()
      if (target === undefined) return Promise.reject(new Error('no document is connected'))
      const reqId = `m-${++requests}`
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingMeasures.delete(reqId)
          reject(new Error('the page did not answer session:measure within 5 s'))
        }, 5000)
        pendingMeasures.set(reqId, (message) => {
          clearTimeout(timer)
          resolve(message)
        })
        send(target[0], { type: 'session:measure', reqId, items: measureItems })
      })
    },

    restart() {
      items.clear()
      for (const socket of sockets.keys()) socket.close()
    },
  }
  return session
}
