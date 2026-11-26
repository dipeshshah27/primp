import { randomBytes } from 'node:crypto'
import { renderFixup, renderPrompt } from '../../engine/src/prompt.ts'
import { attributeShifts } from '../../engine/src/shift-attributor.ts'
import type { Batch, ChangeItem, CheckResult, Expectation, ItemStatus, Locator, SourceLoc } from '../../protocol/src/change.ts'
import { ClientMessageSchema, type ClientMessage, type ServerMessage, type SessionInfo } from '../../protocol/src/messages.ts'
import type { DismissChangeResult, PendingChanges, PendingFileGroup, SessionSummary } from '../../protocol/src/session.ts'
import type { ShiftIssue, ShiftRecording, ShiftReport } from '../../protocol/src/shift.ts'
import type { Evidence, SourceResult } from '../../source/src/types.ts'
import type { JournalPosition } from './settle.ts'
import { toSourceLoc } from './source-loc.ts'

/**
 * The session: everything primp remembers while it runs, and the `session:*`
 * half of the overlay socket.
 *
 *   - items: the changes recorded in the dock, by id. The dock writes drafts
 *     (`session:upsert`, `session:delete`); every later status is set here:
 *       draft -> queued     the user pressed Send (`session:send`)
 *       queued -> claimed   an agent fetched them (`getPendingChanges`)
 *       queued/claimed/failed -> dismissed   an agent closed one (`dismissChange`)
 *     `verified` and `failed` are set by verification (M3) through `patchItem`.
 *   - documents: one per open overlay socket that said `session:hello`.
 *   - shifts: the latest recording and attributed report per document.
 *
 * Every change to an item is followed by a `session:state` broadcast to all
 * documents, so every open tab shows the same tray.
 *
 * Nothing a browser sends can make a handler throw: a message that does not
 * parse is dropped (a request gets an empty answer so the dock is not left
 * waiting), and failures of the resolver or the attributor become `null` /
 * `not_measurable` answers.
 */

/** The part of a WebSocket (the `ws` package's, or a test double) the session uses. */
export interface SessionSocket {
  send(data: string): void
  on(event: 'message', listener: (data: unknown) => void): unknown
  on(event: 'close', listener: () => void): unknown
  on(event: 'error', listener: (error: unknown) => void): unknown
}

export type SessionLogger = (level: 'debug' | 'info' | 'warn' | 'error', message: string, detail?: unknown) => void

export interface SessionOptions {
  info: SessionInfo
  /** Element evidence to source position: `createResolver(...)` of @primp/source, or a double. */
  resolver: { resolve(evidence: Evidence): Promise<SourceResult> }
  /** Culprit of a shift issue to source position (`createCulpritResolver`). Without it reports carry no sources. */
  culprits?: (issue: ShiftIssue, recording: ShiftRecording) => Promise<SourceLoc | undefined>
  /** The settle detector's `mark`: recorded on a batch when an agent claims it. */
  mark?: () => JournalPosition
  /**
   * Absolute path of the project. A stylesheet identity under it (Vite puts the absolute file path in
   * `data-vite-dev-id`) is stored project-relative, which is what an agent can use and what belongs in a prompt.
   */
  projectRoot?: string
  /** Epoch milliseconds. Default `Date.now`. */
  now?: () => number
  /** Makes batch and request ids. Default: random hex. */
  newId?: (kind: 'batch' | 'request') => string
  /** Longest wait for culprit sources before a shift report is sent without the missing ones. Default 3000 ms. */
  culpritTimeoutMs?: number
  log?: SessionLogger
}

export interface SessionDocument {
  doc: string
  url: string
  viewport: { w: number; h: number; dpr: number }
  visible: boolean
  connectedAt: number
  /** When the document was last known to be visible (now, while it is). Undefined: never seen visible. */
  lastVisibleAt: number | undefined
}

export interface SessionBatch {
  batchId: string
  /** Ids of the items sent together, in tray order. */
  itemIds: string[]
  /** When the user pressed Send. */
  sentAt: number
  /** Document the batch was sent from. */
  sentFrom: string | undefined
  /** When an agent first fetched the batch. */
  claimedAt?: number
  /** The settle detector's journal position at that moment: the settle window for verification starts here. */
  claimMark?: JournalPosition
}

export interface SessionShifts {
  doc: string
  /** When the recording arrived. */
  at: number
  recording: ShiftRecording
  report: ShiftReport
  /** By issue id. Filled in when resolution finishes; empty until then. */
  culpritSources: Record<string, SourceLoc>
}

export type SessionEventType = 'upsert' | 'delete' | 'send' | 'claim' | 'dismiss' | 'patch'

/** What happened, for the terminal's activity lines (cli/src/activity.ts). */
export type Activity =
  /** A tab with the dock connected or went away; `tabs` is how many are connected now. */
  | { type: 'tabs'; tabs: number; url?: string }
  | { type: 'sent'; count: number; batchId: string; toAgent: boolean }
  | { type: 'claimed'; count: number }
  /**
   * An agent started or stopped waiting for the next Send (MCP wait_for_changes). Stopped: `sent` (a
   * Send woke it; it will be back after doing the work), `timeout` (it will call again), `gone` (it
   * hung up), `closed` (primp stops).
   */
  | { type: 'waiting'; waiting: true }
  | { type: 'waiting'; waiting: false; why: 'sent' | 'timeout' | 'gone' | 'closed' }
  | { type: 'dismissed'; id: string; label: string; reason: string }
  /** A verification finished; `lines` name what did not pass. `auto`: started by a quiet period after source edits, not asked for. */
  | { type: 'verified'; counts: Record<string, number>; lines: string[]; auto: boolean }

export interface SessionEvent {
  /** Shares the counter that numbers items. */
  seq: number
  at: number
  type: SessionEventType
  itemIds: string[]
  batchId?: string
  doc?: string
}

/** One entry of a `session:measure` request. A whole item is accepted in its place. */
export interface MeasureItem {
  itemId: string
  locator: Locator
  expect: Expectation[]
}

export interface MeasuredItem {
  itemId: string
  locatorConfidence: number
  found: boolean
  checks: CheckResult[]
}

export type MeasureOutcome =
  | { status: 'measured'; doc: string; url: string; visible: boolean; results: MeasuredItem[] }
  /** No document with the dock is connected. */
  | { status: 'no_browser' }
  /** The document did not answer in time (a hidden tab runs timers late; a frozen one not at all). */
  | { status: 'timeout'; doc: string; visible: boolean }
  /** The document went away before answering (reload, closed tab). */
  | { status: 'disconnected'; doc: string }

export interface Session {
  /** Hands over an overlay socket. The same socket also goes to the settle detector. */
  attach(socket: SessionSocket): void
  info(): SessionInfo

  // --- what control handlers call ---
  getSession(): SessionSummary
  /**
   * Queued items (all of them, or those of `batchId`, which also returns that batch's already
   * claimed items again), grouped by source file, with the prompt for an MCP reader. Marks what
   * was queued as claimed.
   */
  getPendingChanges(params?: { batchId?: string }): PendingChanges
  /**
   * `getPendingChanges`, after waiting for the developer to press Send when nothing is queued.
   * While it waits the dock is told an agent is waiting. Resolves with nothing handed over after
   * `timeoutMs`, or when the session closes.
   */
  waitForChanges(timeoutMs: number, gone?: AbortSignal): Promise<PendingChanges>
  dismissChange(params: { id: string; reason: string }): DismissChangeResult

  // --- state ---
  items(): ChangeItem[]
  item(id: string): ChangeItem | undefined
  documents(): SessionDocument[]
  batch(batchId: string): SessionBatch | undefined
  batches(): SessionBatch[]
  /** Latest recording and report of one document, or of the document that reported last. */
  shifts(doc?: string): SessionShifts | undefined
  journal(sinceSeq?: number): SessionEvent[]

  // --- plumbing for verification (M3) and replay (M4) ---
  /**
   * Asks the browser to measure, in the connected document that was visible most recently, and
   * resolves with its answer. Never rejects.
   */
  measure(items: readonly (MeasureItem | ChangeItem)[], timeoutMs: number): Promise<MeasureOutcome>
  /** Called on every Activity. Returns the function that removes the listener. */
  onActivity(listener: (activity: Activity) => void): () => void
  /** Passes an Activity from outside the session (the verifier's results) to its listeners. */
  announce(activity: Activity): void
  /** Called when the user asks from the dock for items to be checked again. Returns the function that removes the listener. */
  onReverify(listener: (ids: string[], doc: string | undefined) => void): () => void
  /** Changes fields of a stored item (status, verification, ...) and broadcasts the state. False when there is no such item. */
  patchItem(id: string, patch: Partial<Pick<ChangeItem, 'status' | 'verification' | 'claimedAt' | 'dismissReason'>>): boolean
  /** Sends `session:reload` to one document, or to the one `measure` would pick. False when none is connected. */
  reload(reason: string, doc?: string): boolean
  broadcastState(): void
  /** Tells every document that a verification of these items started (the dock shows them as being checked). */
  broadcastVerifying(ids: string[]): void
  /** Answers every pending measurement as disconnected and stops handling messages. */
  close(): void
}

interface Connection {
  socket: SessionSocket
  open: boolean
  /** Set by `session:hello`. */
  doc: string | undefined
  url: string
  viewport: { w: number; h: number; dpr: number }
  visible: boolean
  connectedAt: number
  lastVisibleAt: number | undefined
}

interface PendingMeasure {
  connection: Connection
  timer: ReturnType<typeof setTimeout>
  settle(outcome: MeasureOutcome): void
}

const MAX_ITEMS = 2000
const MAX_EVENTS = 2000
const MAX_SHIFT_DOCUMENTS = 20
const EMPTY_BATCH: Batch = { batchId: '', items: [], prompt: '' }

function textOf(data: unknown): string | undefined {
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return undefined
}

function isEvidence(value: unknown): value is Evidence {
  if (typeof value !== 'object' || value === null) return false
  const context = (value as { context?: unknown }).context
  return typeof context === 'object' && context !== null && typeof (context as { tag?: unknown }).tag === 'string' && Array.isArray((value as { hints?: unknown }).hints)
}

/** `/abs/project/src/a.css?x` -> `src/a.css?x` when it lies inside the project; anything else unchanged. */
export function projectRelative(sheet: string, projectRoot: string | undefined): string {
  if (projectRoot === undefined || projectRoot === '') return sheet
  const root = projectRoot.endsWith('/') ? projectRoot : `${projectRoot}/`
  return sheet.startsWith(root) ? sheet.slice(root.length) : sheet
}

export function createSession(options: SessionOptions): Session {
  const now = options.now ?? Date.now
  const log: SessionLogger = options.log ?? (() => {})
  const newId = options.newId ?? ((kind) => (kind === 'batch' ? `batch-${randomBytes(4).toString('hex')}` : randomBytes(8).toString('hex')))
  const culpritTimeoutMs = options.culpritTimeoutMs ?? 3000

  const items = new Map<string, ChangeItem>()
  const batches = new Map<string, SessionBatch>()
  const connections = new Set<Connection>()
  const shiftsByDoc = new Map<string, SessionShifts>()
  const shiftSeq = new Map<string, number>()
  const events: SessionEvent[] = []
  const measures = new Map<string, PendingMeasure>()
  const reverifyListeners = new Set<(ids: string[], doc: string | undefined) => void>()
  let seq = 0
  let lastShiftDoc: string | undefined
  let closed = false

  const sorted = (): ChangeItem[] => [...items.values()].sort((a, b) => a.seq - b.seq)

  const record = (type: SessionEventType, itemIds: string[], extra: { batchId?: string; doc?: string } = {}): number => {
    seq += 1
    const event: SessionEvent = { seq, at: now(), type, itemIds }
    if (extra.batchId !== undefined) event.batchId = extra.batchId
    if (extra.doc !== undefined) event.doc = extra.doc
    events.push(event)
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS)
    return seq
  }

  const send = (connection: Connection, message: ServerMessage): void => {
    if (!connection.open) return
    try {
      connection.socket.send(JSON.stringify(message))
    } catch {
      // The socket is closing; its close handler cleans up.
    }
  }

  const activityListeners = new Set<(activity: Activity) => void>()
  const announce = (activity: Activity): void => {
    for (const listener of activityListeners) {
      try {
        listener(activity)
      } catch {
        // A listener's failure is not the session's.
      }
    }
  }

  /** Agents waiting in `waitForChanges`; each is woken by a Send. */
  const waiters = new Set<(why: 'sent' | 'closed') => void>()
  const stateMessage = (): ServerMessage => ({ type: 'session:state', info: waiters.size > 0 ? { ...options.info, agentWaiting: true } : options.info, items: sorted() })

  const broadcastState = (): void => {
    const message = stateMessage()
    for (const connection of connections) {
      if (connection.doc !== undefined) send(connection, message)
    }
  }

  const render = (batchId: string, batchItems: ChangeItem[], channel: 'mcp' | 'clipboard'): string => {
    try {
      return renderPrompt(batchItems, { batchId, channel })
    } catch (error) {
      log('error', 'the prompt could not be rendered', error)
      // The hand-off must still carry the changes; the structured items say everything the prompt would.
      return `# primp batch ${batchId}: ${batchItems.length} change(s)\n\nThe prompt could not be rendered (${error instanceof Error ? error.message : String(error)}). The recorded changes follow as JSON.\n\n${JSON.stringify(batchItems, null, 2)}`
    }
  }

  // --- documents ------------------------------------------------------------

  const documentOf = (connection: Connection): SessionDocument => ({
    doc: connection.doc as string,
    url: connection.url,
    viewport: { ...connection.viewport },
    visible: connection.visible,
    connectedAt: connection.connectedAt,
    lastVisibleAt: connection.visible ? now() : connection.lastVisibleAt,
  })

  const live = (): Connection[] => [...connections].filter((connection) => connection.open && connection.doc !== undefined)

  /** The document a measurement should run in: a visible one if there is any, else the one seen visible last. */
  const measureTarget = (): Connection | undefined => {
    let best: Connection | undefined
    const rank = (connection: Connection): [number, number, number] => [
      connection.visible ? 1 : 0,
      connection.lastVisibleAt ?? Number.NEGATIVE_INFINITY,
      connection.connectedAt,
    ]
    for (const connection of live()) {
      if (best === undefined) {
        best = connection
        continue
      }
      const a = rank(connection)
      const b = rank(best)
      if (a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] >= b[2])))) best = connection
    }
    return best
  }

  const setVisible = (connection: Connection, visible: boolean): void => {
    // Leaving the visible state: remember until when it was visible.
    if (visible || connection.visible) connection.lastVisibleAt = now()
    connection.visible = visible
  }

  // --- handlers -------------------------------------------------------------

  const onHello = (connection: Connection, message: Extract<ClientMessage, { type: 'session:hello' }>): void => {
    // A document that reconnects (socket dropped, page still open) replaces its old connection.
    for (const other of connections) {
      if (other !== connection && other.doc === message.doc) drop(other)
    }
    connection.doc = message.doc
    connection.url = message.url
    connection.viewport = message.viewport
    connection.connectedAt = now()
    setVisible(connection, message.visible)
    send(connection, stateMessage())
    announce({ type: 'tabs', tabs: live().length, url: message.url })
  }

  const onResolve = async (connection: Connection, reqId: string, evidence: unknown): Promise<void> => {
    let source: SourceLoc | null = null
    if (isEvidence(evidence)) {
      try {
        source = toSourceLoc(await options.resolver.resolve(evidence))
      } catch (error) {
        log('warn', 'resolving an element failed', error)
      }
    }
    send(connection, { type: 'session:resolved', reqId, source })
  }

  const onUpsert = (connection: Connection, incoming: ChangeItem): void => {
    const existing = items.get(incoming.id)
    const refused =
      incoming.status !== 'draft'
        ? `item ${incoming.id} arrived with status ${incoming.status}; the dock only writes drafts`
        : existing !== undefined && existing.status !== 'draft'
          ? `item ${incoming.id} is ${existing.status} and can no longer be edited`
          : existing === undefined && items.size >= MAX_ITEMS
            ? `more than ${MAX_ITEMS} items; item ${incoming.id} was not stored`
            : undefined
    if (refused !== undefined) {
      log('warn', refused)
      // Shows the sender what is really stored.
      send(connection, stateMessage())
      return
    }
    const item: ChangeItem = { ...incoming, status: 'draft', seq: existing?.seq ?? 0 }
    if (item.kind === 'style' && item.origin?.sheet !== undefined) item.origin = { ...item.origin, sheet: projectRelative(item.origin.sheet, options.projectRoot) }
    delete item.batchId
    delete item.claimedAt
    delete item.verification
    delete item.dismissReason
    const eventSeq = record('upsert', [item.id], { doc: connection.doc })
    if (existing === undefined) item.seq = eventSeq
    items.set(item.id, item)
    broadcastState()
  }

  const onDelete = (connection: Connection, id: string): void => {
    const existing = items.get(id)
    if (existing === undefined || existing.status !== 'draft') {
      if (existing !== undefined) log('warn', `item ${id} is ${existing.status}; only drafts can be deleted`)
      send(connection, stateMessage())
      return
    }
    items.delete(id)
    record('delete', [id], { doc: connection.doc })
    broadcastState()
  }

  const onSend = (connection: Connection, reqId: string, ids: string[]): void => {
    const wanted = new Set(ids)
    const drafts = sorted().filter((item) => wanted.has(item.id) && item.status === 'draft')
    if (drafts.length === 0) {
      // Nothing to queue (unknown ids, or already sent from another tab): an empty batch, so the dock is not left waiting.
      send(connection, { type: 'session:sent', reqId, batch: EMPTY_BATCH })
      send(connection, stateMessage())
      return
    }
    const batchId = newId('batch')
    for (const item of drafts) {
      item.status = 'queued'
      item.batchId = batchId
    }
    const batch: SessionBatch = { batchId, itemIds: drafts.map((item) => item.id), sentAt: now(), sentFrom: connection.doc }
    batches.set(batchId, batch)
    record('send', batch.itemIds, { batchId, doc: connection.doc })
    // Decided before the waiting agents wake, which ends their wait.
    const toAgent = waiters.size > 0
    send(connection, { type: 'session:sent', reqId, batch: { batchId, items: drafts, prompt: render(batchId, drafts, 'clipboard') }, ...(toAgent ? { toAgent } : {}) })
    broadcastState()
    announce({ type: 'sent', count: drafts.length, batchId, toAgent })
    // Waiting agents take the batch now; each wakes, and the first to claim gets it.
    for (const wake of [...waiters]) wake('sent')
  }

  /** Copy without Send: the prompt the drafts would be sent with. Nothing is queued and no state changes. */
  const onPrompt = (connection: Connection, reqId: string, ids: string[]): void => {
    const wanted = new Set(ids)
    const drafts = sorted().filter((item) => wanted.has(item.id) && item.status === 'draft')
    const prompt = drafts.length === 0 ? '' : render('preview', drafts, 'clipboard')
    send(connection, { type: 'session:prompt-text', reqId, prompt, count: drafts.length })
  }

  const onShifts = async (connection: Connection, doc: string, recording: ShiftRecording): Promise<void> => {
    const turn = (shiftSeq.get(doc) ?? 0) + 1
    shiftSeq.set(doc, turn)
    let report: ShiftReport
    try {
      report = attributeShifts(recording)
    } catch (error) {
      log('error', 'the shift attributor failed', error)
      report = {
        status: 'not_measurable',
        reason: `the recording could not be analysed: ${error instanceof Error ? error.message : String(error)}`,
        cls: null,
        windows: [],
        issues: [],
        cachedResources: [],
        notes: [],
      }
    }
    const entry: SessionShifts = { doc, at: now(), recording, report, culpritSources: {} }
    shiftsByDoc.delete(doc)
    shiftsByDoc.set(doc, entry)
    for (const stale of [...shiftsByDoc.keys()].slice(0, Math.max(0, shiftsByDoc.size - MAX_SHIFT_DOCUMENTS))) {
      shiftsByDoc.delete(stale)
      shiftSeq.delete(stale)
    }
    lastShiftDoc = doc

    const culprits = options.culprits
    if (culprits !== undefined) {
      const pending = report.issues
        .filter((issue) => issue.culprit !== undefined)
        .map(async (issue) => {
          try {
            const source = await culprits(issue, recording)
            if (source !== undefined) entry.culpritSources[issue.id] = source
          } catch (error) {
            log('warn', `the culprit of ${issue.id} could not be resolved`, error)
          }
        })
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([Promise.all(pending), new Promise<void>((resolve) => (timer = setTimeout(resolve, culpritTimeoutMs)))])
      clearTimeout(timer)
    }
    // A newer recording of the same document arrived meanwhile: its report is the one to show.
    if (shiftSeq.get(doc) !== turn) return
    send(connection, { type: 'session:shift-report', doc, report, culpritSources: { ...entry.culpritSources } })
  }

  const onMeasured = (connection: Connection, message: Extract<ClientMessage, { type: 'session:measured' }>): void => {
    const pending = measures.get(message.reqId)
    if (pending === undefined || pending.connection !== connection) return
    setVisible(connection, message.visible)
    pending.settle({
      status: 'measured',
      doc: connection.doc as string,
      url: connection.url,
      visible: message.visible,
      results: message.results,
    })
  }

  const dispatch = (connection: Connection, message: ClientMessage): void => {
    // Everything but hello needs a document to belong to.
    if (message.type !== 'session:hello' && connection.doc === undefined) {
      log('debug', `${message.type} before session:hello was ignored`)
      if (message.type === 'session:resolve') send(connection, { type: 'session:resolved', reqId: message.reqId, source: null })
      if (message.type === 'session:send') send(connection, { type: 'session:sent', reqId: message.reqId, batch: EMPTY_BATCH })
      if (message.type === 'session:prompt') send(connection, { type: 'session:prompt-text', reqId: message.reqId, prompt: '', count: 0 })
      return
    }
    switch (message.type) {
      case 'session:hello':
        return onHello(connection, message)
      case 'session:resolve':
        return void onResolve(connection, message.reqId, message.evidence)
      case 'session:upsert':
        return onUpsert(connection, message.item)
      case 'session:delete':
        return onDelete(connection, message.id)
      case 'session:send':
        return onSend(connection, message.reqId, message.ids)
      case 'session:prompt':
        return onPrompt(connection, message.reqId, message.ids)
      case 'session:shifts':
        return void onShifts(connection, message.doc, message.recording).catch((error: unknown) => log('error', 'session:shifts failed', error))
      case 'session:measured':
        return onMeasured(connection, message)
      case 'session:shift-prompt': {
        // The same instructions get_layout_shifts gives an agent over MCP, worded for the clipboard.
        const entry = shiftsByDoc.get(message.doc)
        const wanted = new Set(message.ids)
        const issues = entry?.report.issues.filter((issue) => wanted.has(issue.id)) ?? []
        let prompt = ''
        try {
          if (entry !== undefined && issues.length > 0) prompt = renderPrompt([], { batchId: 'layout-shifts', channel: 'clipboard' }, { shifts: issues, culpritSources: entry.culpritSources })
        } catch (error) {
          log('error', 'the layout-shift prompt could not be rendered', error)
        }
        return send(connection, { type: 'session:prompt-text', reqId: message.reqId, prompt, count: issues.length })
      }
      case 'session:fixup': {
        // What did not pass, as instructions to paste: the same fix-up an agent gets over MCP, worded for the clipboard.
        const wanted = message.ids.map((id) => items.get(id)).filter((item): item is ChangeItem => item !== undefined && item.status !== 'draft')
        const open = wanted.filter((item) => item.verification !== undefined && item.verification.status !== 'pass' && item.kind !== 'note')
        return send(connection, { type: 'session:fixup-text', reqId: message.reqId, prompt: open.length === 0 ? '' : renderFixup(wanted, { channel: 'clipboard' }), count: open.length })
      }
      case 'session:reverify':
        for (const listener of [...reverifyListeners]) {
          try {
            listener([...message.ids], connection.doc)
          } catch (error) {
            log('error', 'a reverify listener threw', error)
          }
        }
        return
      case 'session:visibility':
        return setVisible(connection, message.visible)
    }
  }

  const onMessage = (connection: Connection, data: unknown): void => {
    if (closed || !connection.open) return
    let raw: unknown
    try {
      const text = textOf(data)
      if (text === undefined) return
      raw = JSON.parse(text)
    } catch {
      return
    }
    if (typeof raw !== 'object' || raw === null) return
    const type = (raw as { type?: unknown }).type
    // `settle:*` belongs to the settle detector, which listens on the same socket.
    if (typeof type !== 'string' || !type.startsWith('session:')) return
    const parsed = ClientMessageSchema.safeParse(raw)
    if (!parsed.success) {
      log('warn', `a ${type} message did not match the protocol and was dropped`, parsed.error.issues.slice(0, 3))
      // A request must not be left without an answer.
      const reqId = (raw as { reqId?: unknown }).reqId
      if (typeof reqId === 'string') {
        if (type === 'session:resolve') send(connection, { type: 'session:resolved', reqId, source: null })
        if (type === 'session:send') send(connection, { type: 'session:sent', reqId, batch: EMPTY_BATCH })
        if (type === 'session:prompt') send(connection, { type: 'session:prompt-text', reqId, prompt: '', count: 0 })
      }
      // An item that was refused: show the sender what is stored.
      if (type === 'session:upsert' && connection.doc !== undefined) send(connection, stateMessage())
      return
    }
    try {
      dispatch(connection, parsed.data)
    } catch (error) {
      log('error', `handling ${type} failed`, error)
    }
  }

  function drop(connection: Connection): void {
    if (!connection.open) return
    if (connection.visible) connection.lastVisibleAt = now()
    connection.open = false
    connections.delete(connection)
    if (connection.doc !== undefined) announce({ type: 'tabs', tabs: live().length })
    for (const pending of [...measures.values()]) {
      if (pending.connection === connection) pending.settle({ status: 'disconnected', doc: connection.doc ?? '' })
    }
  }

  const attach = (socket: SessionSocket): void => {
    const connection: Connection = {
      socket,
      open: true,
      doc: undefined,
      url: '',
      viewport: { w: 0, h: 0, dpr: 1 },
      visible: false,
      connectedAt: now(),
      lastVisibleAt: undefined,
    }
    connections.add(connection)
    socket.on('message', (data) => onMessage(connection, data))
    socket.on('close', () => drop(connection))
    socket.on('error', () => drop(connection))
  }

  // --- agent side -----------------------------------------------------------

  const getSession = (): SessionSummary => {
    const counts: Record<string, number> = {}
    for (const item of items.values()) counts[item.status] = (counts[item.status] ?? 0) + 1
    return {
      target: options.info.target,
      framework: options.info.framework,
      browserConnected: live().length > 0,
      counts,
    }
  }

  const getPendingChanges = (params: { batchId?: string } = {}): PendingChanges => {
    const { batchId } = params
    const picked = sorted().filter((item) =>
      batchId === undefined ? item.status === 'queued' : item.batchId === batchId && (item.status === 'queued' || item.status === 'claimed'),
    )
    if (picked.length === 0) return { batchIds: [], count: 0, files: [], prompt: '', claimedAt: null }

    const at = now()
    const mark = options.mark?.()
    const newlyClaimed: string[] = []
    for (const item of picked) {
      if (item.status !== 'queued') continue
      item.status = 'claimed'
      item.claimedAt = at
      newlyClaimed.push(item.id)
    }
    const batchIds = [...new Set(picked.map((item) => item.batchId).filter((id): id is string => id !== undefined))]
    for (const id of batchIds) {
      const batch = batches.get(id)
      // The first claim anchors the batch: an agent that asks again has usually started editing already.
      if (batch === undefined || batch.claimedAt !== undefined) continue
      batch.claimedAt = at
      if (mark !== undefined) batch.claimMark = mark
    }

    const groups = new Map<string | null, PendingFileGroup>()
    for (const item of picked) {
      const file = item.target.source?.file ?? null
      let group = groups.get(file)
      if (group === undefined) groups.set(file, (group = { file, items: [] }))
      group.items.push(item)
    }
    const prompt = batchIds
      .map((id) => render(id, picked.filter((item) => item.batchId === id), 'mcp'))
      .join('\n\n')

    if (newlyClaimed.length > 0) {
      announce({ type: 'claimed', count: newlyClaimed.length })
      record('claim', newlyClaimed, batchIds.length === 1 ? { batchId: batchIds[0] as string } : {})
      broadcastState()
    }
    return {
      batchIds,
      count: picked.length,
      files: [...groups.values()],
      prompt,
      claimedAt: Math.min(...picked.map((item) => item.claimedAt ?? at)),
    }
  }

  const waitForChanges = async (timeoutMs: number, gone?: AbortSignal): Promise<PendingChanges> => {
    const queued = (): boolean => [...items.values()].some((item) => item.status === 'queued')
    const started = now()
    if (!queued() && !closed && timeoutMs > 0 && gone?.aborted !== true) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => done('timeout'), timeoutMs)
        // A caller that went away claims nothing: the changes stay queued for whoever asks next.
        const hungUp = (): void => done('gone')
        gone?.addEventListener('abort', hungUp, { once: true })
        function done(why: 'sent' | 'timeout' | 'gone' | 'closed'): void {
          clearTimeout(timer)
          gone?.removeEventListener('abort', hungUp)
          waiters.delete(done)
          resolve()
          // The dock stops saying an agent waits once the last one is gone.
          if (waiters.size === 0) {
            broadcastState()
            announce({ type: 'waiting', waiting: false, why })
          }
        }
        waiters.add(done)
        if (waiters.size === 1) {
          broadcastState()
          announce({ type: 'waiting', waiting: true })
        }
      })
    }
    if (gone?.aborted === true) return { batchIds: [], count: 0, files: [], prompt: '', claimedAt: null, waitEnded: 'gone' }
    const pending = getPendingChanges()
    if (pending.count > 0) return pending
    // Nothing for this caller: say why, so an agent is not told "nothing was sent" when something was.
    const sentMeanwhile = [...batches.values()].some((batch) => batch.sentAt >= started)
    return { ...pending, waitEnded: closed ? 'closed' : sentMeanwhile ? 'taken' : 'timeout' }
  }

  const DISMISSABLE: ReadonlySet<ItemStatus> = new Set<ItemStatus>(['queued', 'claimed', 'failed'])

  const dismissChange = (params: { id: string; reason: string }): DismissChangeResult => {
    const item = items.get(params.id)
    if (item === undefined) {
      return { id: params.id, dismissed: false, status: null, message: `No change has the id ${params.id}.` }
    }
    if (!DISMISSABLE.has(item.status)) {
      const why =
        item.status === 'draft'
          ? 'the developer is still editing it and has not sent it'
          : item.status === 'dismissed'
            ? 'it was dismissed before'
            : 'it has been verified already'
      return { id: item.id, dismissed: false, status: item.status, message: `Change ${item.id} was not dismissed: ${why}.` }
    }
    item.status = 'dismissed'
    item.dismissReason = params.reason
    record('dismiss', [item.id], item.batchId === undefined ? {} : { batchId: item.batchId })
    broadcastState()
    announce({ type: 'dismissed', id: item.id, label: item.target.label, reason: params.reason })
    return { id: item.id, dismissed: true, status: 'dismissed', message: `Change ${item.id} is dismissed; the developer sees the reason in the dock.` }
  }

  // --- measuring ------------------------------------------------------------

  const measure = (wanted: readonly (MeasureItem | ChangeItem)[], timeoutMs: number): Promise<MeasureOutcome> => {
    const connection = closed ? undefined : measureTarget()
    if (connection === undefined) return Promise.resolve({ status: 'no_browser' })
    const reqId = newId('request')
    const request = wanted.map((entry) =>
      'target' in entry ? { itemId: entry.id, locator: entry.target.locator, expect: entry.expect } : { itemId: entry.itemId, locator: entry.locator, expect: entry.expect },
    )
    return new Promise<MeasureOutcome>((resolve) => {
      const settle = (outcome: MeasureOutcome): void => {
        if (!measures.delete(reqId)) return
        clearTimeout(timer)
        resolve(outcome)
      }
      const timer = setTimeout(() => settle({ status: 'timeout', doc: connection.doc as string, visible: connection.visible }), timeoutMs)
      measures.set(reqId, { connection, timer, settle })
      send(connection, { type: 'session:measure', reqId, items: request })
    })
  }

  return {
    attach,
    info: () => options.info,
    getSession,
    getPendingChanges,
    waitForChanges,
    dismissChange,
    items: sorted,
    item: (id) => items.get(id),
    documents: () => live().map(documentOf),
    batch: (batchId) => batches.get(batchId),
    batches: () => [...batches.values()],
    shifts: (doc) => (doc !== undefined ? shiftsByDoc.get(doc) : lastShiftDoc === undefined ? undefined : shiftsByDoc.get(lastShiftDoc)),
    journal: (sinceSeq = 0) => events.filter((event) => event.seq > sinceSeq),
    measure,
    onActivity(listener) {
      activityListeners.add(listener)
      return () => activityListeners.delete(listener)
    },
    announce,
    onReverify(listener) {
      reverifyListeners.add(listener)
      return () => reverifyListeners.delete(listener)
    },
    patchItem(id, patch) {
      const item = items.get(id)
      if (item === undefined) return false
      Object.assign(item, patch)
      record('patch', [id], item.batchId === undefined ? {} : { batchId: item.batchId })
      broadcastState()
      return true
    },
    reload(reason, doc) {
      const connection = doc === undefined ? measureTarget() : live().find((candidate) => candidate.doc === doc)
      if (connection === undefined) return false
      send(connection, { type: 'session:reload', reason })
      return true
    },
    broadcastState,
    broadcastVerifying(ids) {
      for (const connection of connections) if (connection.doc !== undefined) send(connection, { type: 'session:verifying', ids: [...ids] })
    },
    close() {
      if (closed) return
      closed = true
      for (const pending of [...measures.values()]) pending.settle({ status: 'disconnected', doc: pending.connection.doc ?? '' })
      reverifyListeners.clear()
      for (const wake of [...waiters]) wake('closed')
      activityListeners.clear()
    },
  }
}
