import type {
  SettleClientMessage,
  SettleClientState,
  SettleOverlayReport,
  SettleServerMessage,
} from '../../../server/src/settle.ts'

/**
 * Browser half of settle detection (the server half is
 * `packages/server/src/settle.ts`, which also documents the protocol).
 *
 * The client observes and answers; it decides nothing and measures no waiting
 * time of its own:
 *
 *   - a MutationObserver on the whole document counts mutation batches and
 *     remembers when the last one happened. A notice goes to the server for
 *     the first batch after a pause (every batch while the server is waiting);
 *   - stylesheet links added to the document are tracked until they load, since
 *     the styles of an update only apply then;
 *   - `load` and `pagehide` are reported, and so is every finished fetch of
 *     Next's server-rendered tree (from Resource Timing);
 *   - a probe from the server is answered with the current state, after a
 *     timer of the length the server asked for and one MessageChannel hop. The
 *     timer is not a clock: it puts the answer behind timers the page already
 *     had pending (React Refresh applies an update from a 16 ms timer) and the
 *     hop puts it behind the task those timers scheduled. In a background tab
 *     the browser runs timers late, and the answer is late with them, which is
 *     the point;
 *   - told that the dev server is Vite, it asks Vite's own HMR client (the
 *     module the page already loaded) to say when an update has been applied.
 *
 * Nothing here uses requestAnimationFrame, which does not run in a hidden tab.
 *
 * Everything the client adds to the page is this one observer and a few
 * listeners; it does not touch the DOM. Mutations inside an element marked
 * `data-reglet-root` (the dock) are ignored, and so is anything in a shadow
 * tree, which a document-level observer does not see. So are reglet's own
 * marks on the page: the `data-reglet-id` attribute of a previewed element and
 * the insertion or removal of a node that carries `data-reglet-root`.
 */

export interface SettleTransport {
  /** Sends one message to the server. May be called before the socket is open; the transport queues. */
  send(message: SettleClientMessage): void
}

export interface SettleClientOptions {
  /** Id of the document. Default: a random one. The overlay passes the id it also uses for `session:hello`. */
  id?: string
}

export interface SettleClient {
  /** Id of the document, as sent in every message. */
  readonly id: string
  /** Sends `settle:hello` again: a new socket (the server restarted) knows nothing about this document. */
  hello(): void
  /** Feed every message the server sends. Unknown messages are ignored. */
  handle(message: unknown): void
  /** The state a probe would be answered with right now (without the drain). */
  state(receivedAt?: number): SettleClientState
  dispose(): void
}

/** A fetch of Next's server-rendered tree (React Server Components payload). */
const RSC_FETCH = /[?&]_rsc=/

/** Minimum pause between mutation notices while the server is not waiting. */
const NOTICE_INTERVAL_MS = 50

type HotListener = (payload: unknown) => void
interface ViteHotContext {
  on(event: string, listener: HotListener): void
}
interface ViteClientModule {
  createHotContext?: (ownerPath: string) => ViteHotContext
}

function pageNow(): number {
  return performance.timeOrigin + performance.now()
}

function randomId(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  let id = ''
  for (const byte of bytes) id += byte.toString(16).padStart(2, '0')
  return id
}

function isStylesheetLink(node: Node): node is HTMLLinkElement {
  return node.nodeType === 1 && (node as Element).localName === 'link' && /(?:^|\s)stylesheet(?:\s|$)/i.test((node as HTMLLinkElement).rel)
}

function insideReglet(node: Node): boolean {
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement
  return element !== null && element.closest('[data-reglet-root]') !== null
}

/** Marks an element that has a preview on it (packages/overlay/src/probe/preview.ts). */
const MARK_ATTR = 'data-reglet-id'

function isRegletNode(node: Node): boolean {
  return node.nodeType === 1 && (node as Element).hasAttribute('data-reglet-root')
}

/** A mutation reglet made itself: its mark on an element, or one of its own nodes coming or going. */
function isOwnRecord(record: MutationRecord): boolean {
  if (record.type === 'attributes') return record.attributeName === MARK_ATTR
  if (record.type !== 'childList') return false
  for (const node of record.addedNodes) if (!isRegletNode(node)) return false
  for (const node of record.removedNodes) if (!isRegletNode(node)) return false
  return record.addedNodes.length + record.removedNodes.length > 0
}

function trimmed(text: string | null | undefined, max = 600): string {
  const clean = (text ?? '').replace(/\s+\n/g, '\n').trim()
  return clean.length > max ? `${clean.slice(0, max)}...` : clean
}

/**
 * The dev server's error overlay, if it is on screen.
 *
 * Vite 8:    `<vite-error-overlay>` appended to `<body>`; the message is in
 *            `.message-body` and the file in `.file` of its open shadow root.
 * Next 16.4: `<nextjs-portal>` is always present (it also holds the dev
 *            indicator). An error dialog is open when its open shadow root
 *            contains `[data-nextjs-dialog-overlay]`; the error type ("Build
 *            Error", "Runtime TypeError", ...) is in `#nextjs__container_errors_label`,
 *            the message in `#nextjs__container_errors_desc` and the file in
 *            `[data-nextjs-codeframe] [data-text]`.
 *
 * Both were read from the running fixtures (Vite 8.3.8, Next 16.4.6). They are
 * dev-server internals and can change with any release.
 */
export function findErrorOverlay(doc: Document = document): SettleOverlayReport | null {
  const vite = doc.querySelector('vite-error-overlay')
  if (vite !== null) {
    const root = vite.shadowRoot
    const message = trimmed(root?.querySelector('.message-body')?.textContent ?? root?.querySelector('.message')?.textContent)
    const report: SettleOverlayReport = { framework: 'vite', message }
    // `.file` reads `<path>:<line>:<column>`, or only the path when the error has no location.
    withLocation(report, trimmed(root?.querySelector('.file')?.textContent, 400), /^(.*?):(\d+):(\d+)$/)
    return report
  }
  const next = doc.querySelector('nextjs-portal')?.shadowRoot
  if (next != null && next.querySelector('[data-nextjs-dialog-overlay]') !== null) {
    const kind = trimmed(next.querySelector('#nextjs__container_errors_label')?.textContent, 80)
    const message = trimmed(
      next.querySelector('#nextjs__container_errors_desc')?.textContent ?? next.querySelector('[data-nextjs-dialog-body]')?.textContent,
    )
    const report: SettleOverlayReport = { framework: 'next', message }
    if (kind !== '') report.kind = kind
    // The code frame's header reads `./<path> (<line>:<column>)`.
    withLocation(report, trimmed(next.querySelector('[data-nextjs-codeframe] [data-text]')?.textContent, 400), /^(.*?) \((\d+):(\d+)\)$/)
    return report
  }
  return null
}

function withLocation(report: SettleOverlayReport, text: string, pattern: RegExp): void {
  if (text === '') return
  const match = pattern.exec(text)
  if (match === null) {
    report.file = text
    return
  }
  report.file = match[1] as string
  report.line = Number(match[2])
  report.column = Number(match[3])
}

export function createSettleClient(transport: SettleTransport, doc: Document = document, options: SettleClientOptions = {}): SettleClient {
  const view = doc.defaultView ?? window
  const id = options.id ?? randomId()
  let mutations = 0
  let lastMutationAt: number | null = null
  let lastNoticeAt = Number.NEGATIVE_INFINITY
  let watching = false
  let loadedAt: number | null = doc.readyState === 'complete' ? pageNow() : null
  let disposed = false
  const pendingSheets = new Set<HTMLLinkElement>()
  let vite: { pending: number; applied: number } | undefined
  let viteRequested = false

  const send = (message: SettleClientMessage): void => {
    if (disposed) return
    try {
      transport.send(message)
    } catch {
      // A closed socket: the next document starts over.
    }
  }

  const noteChange = (): void => {
    mutations += 1
    const at = pageNow()
    lastMutationAt = at
    if (watching || at - lastNoticeAt >= NOTICE_INTERVAL_MS) {
      lastNoticeAt = at
      send({ type: 'settle:mutation', doc: id, seq: mutations, at })
    }
  }

  const trackSheet = (link: HTMLLinkElement): void => {
    if (pendingSheets.has(link) || link.sheet !== null || !link.isConnected) return
    pendingSheets.add(link)
    const done = (): void => {
      link.removeEventListener('load', done)
      link.removeEventListener('error', done)
      if (!pendingSheets.delete(link)) return
      // The styles change now, not when the element was inserted.
      mutations += 1
      const at = pageNow()
      lastMutationAt = at
      send({ type: 'settle:event', doc: id, name: 'sheet-loaded', at })
    }
    link.addEventListener('load', done)
    link.addEventListener('error', done)
  }

  const observer = new MutationObserver((records) => {
    let relevant = false
    for (const record of records) {
      if (insideReglet(record.target) || isOwnRecord(record)) continue
      relevant = true
      if (record.type === 'childList') {
        for (const node of record.addedNodes) {
          if (isStylesheetLink(node)) trackSheet(node)
          else if (node.nodeType === 1) for (const link of (node as Element).querySelectorAll('link')) if (isStylesheetLink(link)) trackSheet(link)
        }
        // A link removed before it loaded will never fire `load`.
        for (const node of record.removedNodes) if (isStylesheetLink(node)) pendingSheets.delete(node)
      } else if (record.type === 'attributes' && record.attributeName === 'href' && isStylesheetLink(record.target)) {
        trackSheet(record.target)
      }
    }
    if (relevant) noteChange()
  })
  observer.observe(doc, { subtree: true, childList: true, attributes: true, characterData: true })

  // Next's router refetches the server-rendered tree with `?_rsc=...` after a server component
  // changed, and commits the result when the response has ended. The Resource Timing entry of
  // that fetch appears at that moment and is the only passive sign of it; nothing is wrapped.
  let resources: PerformanceObserver | undefined
  try {
    resources = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!RSC_FETCH.test(entry.name)) continue
        const timing = entry as PerformanceResourceTiming
        send({
          type: 'settle:event',
          doc: id,
          name: 'rsc-fetched',
          at: performance.timeOrigin + (timing.responseEnd > 0 ? timing.responseEnd : timing.startTime + timing.duration),
          detail: performance.timeOrigin + timing.startTime,
        })
      }
    })
    resources.observe({ type: 'resource', buffered: true })
  } catch {
    // No Resource Timing: the server falls back to waiting for the page to change.
  }

  const onLoad = (): void => {
    loadedAt = pageNow()
    send({ type: 'settle:event', doc: id, name: 'load', at: loadedAt })
  }
  const onPageHide = (): void => send({ type: 'settle:event', doc: id, name: 'pagehide', at: pageNow() })
  const onVisibility = (): void =>
    send({ type: 'settle:event', doc: id, name: 'visibilitychange', at: pageNow(), detail: doc.visibilityState })
  view.addEventListener('load', onLoad)
  view.addEventListener('pagehide', onPageHide)
  doc.addEventListener('visibilitychange', onVisibility)

  const state = (receivedAt = pageNow()): SettleClientState => {
    for (const link of pendingSheets) if (link.sheet !== null || !link.isConnected) pendingSheets.delete(link)
    const snapshot: SettleClientState = {
      receivedAt,
      now: pageNow(),
      mutations,
      lastMutationAt,
      pendingSheets: pendingSheets.size,
      readyState: doc.readyState,
      loadedAt,
      visibility: doc.visibilityState,
      overlay: findErrorOverlay(doc),
    }
    if (vite !== undefined) snapshot.vite = { pending: vite.pending, applied: vite.applied }
    return snapshot
  }

  const answer = (probeId: number, drainMs: number): void => {
    const receivedAt = pageNow()
    const reply = (): void => send({ type: 'settle:state', doc: id, id: probeId, state: state(receivedAt) })
    if (drainMs <= 0) {
      reply()
      return
    }
    view.setTimeout(() => {
      // One hop behind whatever task the page's own timers scheduled.
      const channel = new MessageChannel()
      channel.port1.onmessage = () => {
        channel.port1.close()
        reply()
      }
      channel.port2.postMessage(0)
    }, drainMs)
  }

  /** Largest `timestamp` among the updates of a Vite `update` payload. */
  const updateTimestamp = (payload: unknown): number => {
    const updates = (payload as { updates?: unknown } | null)?.updates
    let latest = 0
    if (Array.isArray(updates)) {
      for (const update of updates) {
        const timestamp = (update as { timestamp?: unknown } | null)?.timestamp
        if (typeof timestamp === 'number' && timestamp > latest) latest = timestamp
      }
    }
    return latest
  }

  const hookVite = (clientPath: string): void => {
    if (viteRequested) {
      // Asked again over a new socket: the new server has not heard that the hook is in place.
      if (vite !== undefined) send({ type: 'settle:event', doc: id, name: 'vite-hooked', at: pageNow() })
      return
    }
    viteRequested = true
    // The same URL the page's own modules import, so this is the module instance that is already
    // connected, not a second client.
    const url = new URL(clientPath, doc.baseURI).href
    void (import(/* @vite-ignore */ url) as Promise<ViteClientModule>)
      .then((module) => {
        if (typeof module.createHotContext !== 'function') throw new Error('no createHotContext export')
        const hot = module.createHotContext('/@reglet/settle-client')
        const hooked = { pending: 0, applied: 0 }
        hot.on('vite:beforeUpdate', () => {
          hooked.pending += 1
        })
        // Fires after every module of the update was fetched and its accept callbacks ran, also
        // when a fetch failed.
        hot.on('vite:afterUpdate', (payload) => {
          hooked.pending = Math.max(0, hooked.pending - 1)
          const timestamp = updateTimestamp(payload)
          if (timestamp > hooked.applied) hooked.applied = timestamp
          send({ type: 'settle:event', doc: id, name: 'vite-applied', at: pageNow(), detail: timestamp })
        })
        vite = hooked
        send({ type: 'settle:event', doc: id, name: 'vite-hooked', at: pageNow() })
      })
      .catch((error: unknown) => {
        send({ type: 'settle:event', doc: id, name: 'vite-hook-failed', at: pageNow(), detail: String(error).slice(0, 200) })
      })
  }

  const hello = (): void =>
    send({ type: 'settle:hello', doc: id, url: doc.location?.href ?? '', timeOrigin: performance.timeOrigin, at: pageNow() })
  hello()

  return {
    id,
    hello,
    handle(raw) {
      if (disposed || typeof raw !== 'object' || raw === null) return
      const message = raw as SettleServerMessage
      if (message.type === 'settle:probe' && typeof message.id === 'number') {
        answer(message.id, typeof message.drainMs === 'number' ? message.drainMs : 0)
      } else if (message.type === 'settle:watch') {
        watching = message.on === true
      } else if (message.type === 'settle:vite' && typeof message.clientPath === 'string') {
        hookVite(message.clientPath)
      }
    },
    state,
    dispose() {
      disposed = true
      observer.disconnect()
      resources?.disconnect()
      view.removeEventListener('load', onLoad)
      view.removeEventListener('pagehide', onPageHide)
      doc.removeEventListener('visibilitychange', onVisibility)
    },
  }
}

/**
 * Opens a WebSocket of its own to `path` on the page's origin and runs a
 * settle client over it. This is what the spike injects; the real overlay will
 * pass its shared socket to `createSettleClient` instead.
 *
 * Must be called synchronously from the injected head script: a page with a
 * `<meta>` Content-Security-Policy only lets the hook open its socket before
 * the meta element is parsed.
 */
export function connectSettleClient(path = '/__reglet/settle'): SettleClient {
  const url = new URL(path, location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(url)
  const queue: string[] = []
  const client = createSettleClient({
    send(message) {
      const text = JSON.stringify(message)
      if (socket.readyState === WebSocket.OPEN) socket.send(text)
      else if (socket.readyState === WebSocket.CONNECTING) queue.push(text)
    },
  })
  socket.addEventListener('open', () => {
    for (const text of queue.splice(0)) socket.send(text)
  })
  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return
    try {
      client.handle(JSON.parse(event.data))
    } catch {
      // Not ours.
    }
  })
  return client
}

declare const __REGLET_SETTLE_AUTOSTART__: boolean | undefined

// Bundled as a head script of its own (the spike does this with esbuild's `define`), it starts itself.
if (typeof __REGLET_SETTLE_AUTOSTART__ !== 'undefined' && __REGLET_SETTLE_AUTOSTART__) {
  const started = connectSettleClient()
  ;(window as unknown as { __reglet_settle?: SettleClient }).__reglet_settle = started
}
