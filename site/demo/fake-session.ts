/**
 * The live demo's stand-in for primp's server. It runs in the visitor's browser, in the demo
 * page, BEFORE primp's head script (`packages/overlay/src/entry/hook.ts`), and does four things:
 *
 *   1. A fake WebSocket for the overlay socket only. The head script opens
 *      `new WebSocket(<origin>/__primp/ws)`; `window.WebSocket` is wrapped so that a URL whose
 *      path ends in `/__primp/ws` gets an in-page socket, and every other URL the native one.
 *   2. Behind that socket, a small session that answers the dock the way
 *      packages/server/src/session.ts does (messages: packages/protocol/src/messages.ts):
 *        session:hello    -> session:state
 *        session:resolve  -> session:resolved, computed here by the same static-HTML resolution the
 *                            CLI uses (@primp/source locateByPath / searchHtml) on the text of this
 *                            page as it was served, which is the demo's "project file" index.html
 *        session:upsert   -> stored in memory as a draft, then session:state
 *        session:delete   -> removed, then session:state
 *        session:send     -> drafts become queued; session:sent with the prompt rendered by the REAL
 *                            renderPrompt of packages/engine
 *        session:shifts   -> session:shift-report from the REAL attributeShifts of packages/engine,
 *                            culprits resolved with the server's own locateByIndexPath
 *        anything else    -> ignored (settle:* traffic, reverify, visibility, measured)
 *      The server parses every message with the protocol's zod schemas; this bundle leaves zod out
 *      (build-demo.ts swaps it for a pass-through stub, which keeps the download small) and trusts
 *      the dock, which is the real one. Nothing is verified: verification needs an agent that edits
 *      source, and there is none here.
 *   3. The overlay URL. The head script loads the dock from the absolute path `/__primp/overlay.js`;
 *      a static host may serve this demo below a sub-path, so the `src` setter of script elements
 *      is wrapped for that one value until the dock's script element has been created.
 *   4. Tells the banner whether the picture was held back on this load. The demo server of
 *      `npx primp demo` holds back `?delay=<ms>` responses; here the service worker sw.ts does,
 *      installed by bootstrap.ts on a first visit.
 *
 * Nothing here talks to any other host. The demo page's banner reads `window.__primp_demo`.
 */

import { renderPrompt } from '../../packages/engine/src/prompt.ts'
import { attributeShifts } from '../../packages/engine/src/shift-attributor.ts'
import type { ChangeItem, SourceLoc } from '../../packages/protocol/src/change.ts'
import { OVERLAY_ASSET_PATH, OVERLAY_SOCKET_PATH, type ClientMessage, type ServerMessage, type SessionInfo } from '../../packages/protocol/src/messages.ts'
import type { ShiftIssue, ShiftRecording, ShiftReport } from '../../packages/protocol/src/shift.ts'
import { locateByIndexPath } from '../../packages/server/src/culprit-source.ts'
import { toSourceLoc } from '../../packages/server/src/source-loc.ts'
import { locateByPath, searchHtml } from '../../packages/source/src/node/static-html.ts'
import type { Evidence, SourceResult } from '../../packages/source/src/types.ts'

declare const __OVERLAY_URL__: string
declare const __PRIMP_VERSION__: string

/** The one file of this demo "project": the page as the browser received it. */
const PROJECT_FILE = 'index.html'

export interface DemoEvents {
  /** The prompt of the last Send, as an agent would receive it. */
  lastPrompt: string | null
  /** The last attributed layout-shift report. */
  lastReport: ShiftReport | null
  /** Whether the picture was held back by the service worker on this load. */
  delayed: boolean
  /** Why the seeded shift may be missing on this load, when it may. */
  delayProblem: string | null
  /** Called after every Send and every report; the banner subscribes. */
  listeners: Set<() => void>
}

declare global {
  interface Window {
    __primp_demo?: DemoEvents
  }
}

if ((window as { __primp_demo_reloading?: boolean }).__primp_demo_reloading !== true) start()

function start(): void {
  const events: DemoEvents = {
    lastPrompt: null,
    lastReport: null,
    delayed: navigator.serviceWorker?.controller != null,
    delayProblem: null,
    listeners: new Set(),
  }
  if (!events.delayed) {
    events.delayProblem = 'This browser did not let the demo install the small service worker that holds the picture back, so the picture may arrive before the first paint and the seeded shift may not happen.'
  }
  window.__primp_demo = events
  const notify = (): void => {
    for (const listener of events.listeners) {
      try {
        listener()
      } catch {
        // The banner's problem.
      }
    }
  }

  // -------------------------------------------------------------------------
  // 3. The overlay URL
  // -------------------------------------------------------------------------

  const srcDescriptor = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src')
  if (srcDescriptor?.set !== undefined) {
    const nativeSet = srcDescriptor.set
    Object.defineProperty(HTMLScriptElement.prototype, 'src', {
      ...srcDescriptor,
      set(this: HTMLScriptElement, value: string) {
        if (value === OVERLAY_ASSET_PATH) {
          nativeSet.call(this, new URL(__OVERLAY_URL__, document.baseURI).href)
          // Only the dock's script element needed it: put the native setter back.
          Object.defineProperty(HTMLScriptElement.prototype, 'src', srcDescriptor)
          return
        }
        nativeSet.call(this, value)
      },
    })
  }

  // -------------------------------------------------------------------------
  // 2. The session
  // -------------------------------------------------------------------------

  const info: SessionInfo = { target: 'in-browser demo', framework: 'html', projectName: 'primp-demo', version: __PRIMP_VERSION__ }
  const items = new Map<string, ChangeItem>()
  let seq = 0
  let batches = 0
  const sockets = new Set<FakeSocket>()

  let projectText: Promise<string | undefined> | undefined
  /** The page as served: fetched once, from the HTTP cache when it can be. */
  const project = (): Promise<string | undefined> =>
    (projectText ??= fetch(location.href.split('#')[0] as string)
      .then((response) => (response.ok ? response.text() : undefined))
      .catch(() => undefined))

  const sorted = (): ChangeItem[] => [...items.values()].sort((a, b) => a.seq - b.seq)
  const state = (): ServerMessage => ({ type: 'session:state', info, items: sorted() })
  const broadcast = (): void => {
    for (const socket of sockets) socket.deliver(state())
  }

  /** packages/source/src/node/resolve.ts `resolveHtml`, for a project of one HTML file. */
  const resolveHtml = (evidence: Evidence, html: string): SourceResult => {
    const started = performance.now()
    const { context } = evidence
    const done = (partial: Omit<SourceResult, 'resolveMs'>): SourceResult => ({ ...partial, resolveMs: performance.now() - started })
    const byPath = locateByPath(html, context.path, context)
    if (byPath?.exact) {
      return done({ framework: 'html', file: PROJECT_FILE, line: byPath.line, col: byPath.col, level: 'exact', verifiedOnDisk: true, via: 'html-path', target: 'element', notes: [] })
    }
    const candidates = searchHtml(html, PROJECT_FILE, context)
    const [best, second] = candidates
    if (!best || best.score < 3) {
      return done({ framework: 'unknown', level: 'candidates', verifiedOnDisk: false, via: 'none', target: 'element', candidates: [], notes: [`no <${context.tag}> found in the project's markup files`] })
    }
    const clear = second === undefined || best.score > second.score
    return done({
      framework: 'html',
      file: PROJECT_FILE,
      line: best.line,
      col: best.col,
      level: clear ? 'file' : 'candidates',
      verifiedOnDisk: true,
      via: 'html-search',
      target: 'element',
      notes: [...(byPath?.notes ?? ['the element is not at the same position in the file']), `picked by ${best.why.join(', ')}`],
      candidates,
    })
  }

  const isEvidence = (value: unknown): value is Evidence => {
    if (typeof value !== 'object' || value === null) return false
    const context = (value as { context?: unknown }).context
    return typeof context === 'object' && context !== null && typeof (context as { tag?: unknown }).tag === 'string' && Array.isArray((value as { hints?: unknown }).hints)
  }

  /** packages/server/src/culprit-source.ts `resolveOne`, html route (a static page has no insertion stacks). */
  const culpritSource = (issue: ShiftIssue, html: string): SourceLoc | undefined => {
    const node = issue.culprit?.node
    if (node === undefined) return undefined
    const match = locateByIndexPath(html, node)
    if (match === undefined) return undefined
    return {
      file: PROJECT_FILE,
      line: match.line,
      col: match.col,
      framework: 'html',
      level: match.agrees ? 'exact' : 'file',
      verifiedOnDisk: true,
      via: 'html-path',
      target: 'element',
      notes: match.agrees ? [] : [...match.notes, 'found by position in the document; the line is a best guess'],
    }
  }

  const receive = async (socket: FakeSocket, text: string): Promise<void> => {
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return
    }
    const type = (raw as { type?: unknown } | null)?.type
    if (typeof type !== 'string' || !type.startsWith('session:')) return
    const message = raw as ClientMessage
    switch (message.type) {
      case 'session:hello':
        socket.doc = message.doc
        socket.deliver(state())
        return
      case 'session:resolve': {
        let source: SourceLoc | null = null
        const html = await project()
        if (html !== undefined && isEvidence(message.evidence)) {
          try {
            source = toSourceLoc(resolveHtml(message.evidence, html))
          } catch (error) {
            console.warn('[primp demo] source lookup failed:', error)
          }
        }
        socket.deliver({ type: 'session:resolved', reqId: message.reqId, source })
        return
      }
      case 'session:upsert': {
        const incoming = message.item
        const existing = items.get(incoming.id)
        if (incoming.status !== 'draft' || (existing !== undefined && existing.status !== 'draft')) {
          socket.deliver(state())
          return
        }
        const item: ChangeItem = { ...incoming, status: 'draft', seq: existing?.seq ?? ++seq }
        delete item.batchId
        delete item.claimedAt
        delete item.verification
        delete item.dismissReason
        items.set(item.id, item)
        broadcast()
        return
      }
      case 'session:delete':
        if (items.get(message.id)?.status === 'draft') items.delete(message.id)
        broadcast()
        return
      case 'session:send': {
        const wanted = new Set(message.ids)
        const drafts = sorted().filter((item) => wanted.has(item.id) && item.status === 'draft')
        if (drafts.length === 0) {
          socket.deliver({ type: 'session:sent', reqId: message.reqId, batch: { batchId: '', items: [], prompt: '' } })
          socket.deliver(state())
          return
        }
        const batchId = `demo-${++batches}`
        for (const item of drafts) {
          item.status = 'queued'
          item.batchId = batchId
        }
        let prompt: string
        try {
          prompt = renderPrompt(drafts, { batchId, channel: 'clipboard' })
        } catch (error) {
          prompt = `# primp batch ${batchId}: ${drafts.length} change(s)\n\nThe prompt could not be rendered (${error instanceof Error ? error.message : String(error)}).\n\n${JSON.stringify(drafts, null, 2)}`
        }
        events.lastPrompt = prompt
        socket.deliver({ type: 'session:sent', reqId: message.reqId, batch: { batchId, items: drafts, prompt } })
        broadcast()
        notify()
        return
      }
      case 'session:shifts': {
        const recording: ShiftRecording = message.recording
        let report: ShiftReport
        try {
          report = attributeShifts(recording)
        } catch (error) {
          report = { status: 'not_measurable', reason: `the recording could not be analysed: ${error instanceof Error ? error.message : String(error)}`, cls: null, windows: [], issues: [], cachedResources: [], notes: [] }
        }
        const culpritSources: Record<string, SourceLoc> = {}
        const html = await project()
        if (html !== undefined) {
          for (const issue of report.issues) {
            try {
              const source = culpritSource(issue, html)
              if (source !== undefined) culpritSources[issue.id] = source
            } catch {
              // Leave this culprit without a source.
            }
          }
        }
        events.lastReport = report
        socket.deliver({ type: 'session:shift-report', doc: message.doc, report, culpritSources })
        notify()
        return
      }
      default:
        // session:measured, session:reverify, session:visibility: nothing asks for them here.
        return
    }
  }

  // -------------------------------------------------------------------------
  // 1. The fake WebSocket
  // -------------------------------------------------------------------------

  class FakeSocket extends EventTarget {
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSING = 2
    static readonly CLOSED = 3
    readonly CONNECTING = 0
    readonly OPEN = 1
    readonly CLOSING = 2
    readonly CLOSED = 3
    readonly url: string
    readonly protocol = ''
    readonly extensions = ''
    readonly bufferedAmount = 0
    binaryType: BinaryType = 'blob'
    readyState = 0
    doc: string | undefined
    onopen: ((event: Event) => void) | null = null
    onmessage: ((event: MessageEvent) => void) | null = null
    onclose: ((event: CloseEvent) => void) | null = null
    onerror: ((event: Event) => void) | null = null

    constructor(url: string) {
      super()
      this.url = url
      setTimeout(() => {
        if (this.readyState !== 0) return
        this.readyState = 1
        sockets.add(this)
        this.fire('open', new Event('open'))
      }, 0)
    }

    private fire(type: 'open' | 'message' | 'close', event: Event): void {
      const handler = this[`on${type}`] as ((event: Event) => void) | null
      handler?.call(this, event)
      this.dispatchEvent(event)
    }

    send(data: string): void {
      if (this.readyState !== 1) throw new DOMException('the socket is not open', 'InvalidStateError')
      if (typeof data === 'string') void receive(this, data)
    }

    /** Server -> browser, one task later, as a real socket would. */
    deliver(message: ServerMessage): void {
      const text = JSON.stringify(message)
      setTimeout(() => {
        if (this.readyState === 1) this.fire('message', new MessageEvent('message', { data: text }))
      }, 0)
    }

    close(): void {
      if (this.readyState >= 2) return
      this.readyState = 3
      sockets.delete(this)
      this.fire('close', new CloseEvent('close', { code: 1000, wasClean: true }))
    }
  }

  const NativeWebSocket = window.WebSocket
  window.WebSocket = new Proxy(NativeWebSocket, {
    construct(target, args: [string | URL, (string | string[])?]) {
      const url = new URL(String(args[0]), location.href)
      if (url.pathname.endsWith(OVERLAY_SOCKET_PATH)) return new FakeSocket(url.href) as unknown as WebSocket
      return Reflect.construct(target, args) as WebSocket
    },
  })
}
