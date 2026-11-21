/**
 * Stand-in for reglet's head script, for spike `m1-server` (the real one is
 * packages/overlay/src/entry/hook.ts, which belongs to the dock work).
 *
 * It does the three things the server relies on, and nothing else:
 *   1. installs the React DevTools hook and the layout-shift recorder, as the real head script does;
 *   2. opens the document's ONE overlay socket and speaks both message families on it:
 *      `settle:hello` plus answers to `settle:probe` (just enough for the settle detector to
 *      count the document), and `session:hello`;
 *   3. loads the second bundle from OVERLAY_ASSET_PATH after DOMContentLoaded.
 *
 * `window.__regletM1` lets the spike drive the socket from Playwright.
 */

import '../../packages/source/src/browser/hook.ts'
import '../../packages/overlay/src/hook/index.ts'
import type { ClientMessage, OVERLAY_ASSET_PATH, OVERLAY_SOCKET_PATH, ServerMessage } from '../../packages/protocol/src/messages.ts'
import type { Evidence } from '../../packages/source/src/types.ts'

/** Must equal the protocol's constants; only their types are imported, so zod stays out of the bundle. */
const SOCKET_PATH: typeof OVERLAY_SOCKET_PATH = '/__reglet/ws'
const OVERLAY_PATH: typeof OVERLAY_ASSET_PATH = '/__reglet/overlay.js'

export interface M1Stub {
  doc: string
  /** Whether this script was the first element of <head> when it ran. */
  firstInHead: boolean
  scriptSrc: string | null
  /** Set by the second bundle. */
  overlayLoaded: boolean
  socketOpen: boolean
  /** Every `session:*` message received, in order. */
  received: ServerMessage[]
  /** `settle:*` messages received (probes from the detector). */
  settleMessages: number
  send(message: ClientMessage): void
  /** Sends a message that carries a `reqId` and resolves with the answer that repeats it. */
  request(message: ClientMessage & { reqId: string }): Promise<ServerMessage>
  /** Resolves with the first message of `type` at index `from` or later in `received`. */
  waitFor(type: ServerMessage['type'], from?: number, timeoutMs?: number): Promise<ServerMessage>
  /** Filled in by the second bundle: evidence for the n-th element matching a selector. */
  collect?: (selector: string, index: number) => Evidence | null
}

declare global {
  interface Window {
    __regletM1?: M1Stub
  }
}

const current = document.currentScript as HTMLScriptElement | null
const bytes = crypto.getRandomValues(new Uint8Array(8))
const doc = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
const pageNow = (): number => performance.timeOrigin + performance.now()

const url = new URL(SOCKET_PATH, location.href)
url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
const socket = new WebSocket(url)
const queue: string[] = []
const waiters = new Set<() => void>()

const sendRaw = (message: unknown): void => {
  const text = JSON.stringify(message)
  if (socket.readyState === WebSocket.OPEN) socket.send(text)
  else queue.push(text)
}

const stub: M1Stub = {
  doc,
  firstInHead: current !== null && document.head?.firstElementChild === current,
  scriptSrc: current?.getAttribute('src') ?? null,
  overlayLoaded: false,
  socketOpen: false,
  received: [],
  settleMessages: 0,
  send: sendRaw,
  request(message) {
    sendRaw(message)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(check)
        reject(new Error(`no answer to ${message.type} ${message.reqId} within 10 s`))
      }, 10_000)
      const check = (): void => {
        const answer = stub.received.find((candidate) => (candidate as { reqId?: string }).reqId === message.reqId)
        if (answer === undefined) return
        clearTimeout(timer)
        waiters.delete(check)
        resolve(answer)
      }
      waiters.add(check)
      check()
    })
  },
  waitFor(type, from = 0, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(check)
        reject(new Error(`no ${type} message at index ${from} or later within ${timeoutMs} ms (received: ${stub.received.map((message) => message.type).join(', ')})`))
      }, timeoutMs)
      const check = (): void => {
        const found = stub.received.slice(from).find((candidate) => candidate.type === type)
        if (found === undefined) return
        clearTimeout(timer)
        waiters.delete(check)
        resolve(found)
      }
      waiters.add(check)
      check()
    })
  },
}
window.__regletM1 = stub

socket.addEventListener('open', () => {
  stub.socketOpen = true
  // The settle family first, then the session family, then whatever was queued.
  socket.send(JSON.stringify({ type: 'settle:hello', doc, url: location.href, timeOrigin: performance.timeOrigin, at: pageNow() }))
  const hello: ClientMessage = {
    type: 'session:hello',
    doc,
    url: location.href,
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    visible: document.visibilityState === 'visible',
  }
  socket.send(JSON.stringify(hello))
  for (const text of queue.splice(0)) socket.send(text)
})
socket.addEventListener('close', () => (stub.socketOpen = false))
socket.addEventListener('message', (event) => {
  if (typeof event.data !== 'string') return
  const message = JSON.parse(event.data) as { type: string; id?: number }
  if (message.type.startsWith('settle:')) {
    stub.settleMessages += 1
    // The least a settle client must do: answer a probe with the page's state.
    if (message.type === 'settle:probe') {
      const receivedAt = pageNow()
      sendRaw({
        type: 'settle:state',
        doc,
        id: message.id,
        state: { receivedAt, now: pageNow(), mutations: 0, lastMutationAt: null, pendingSheets: 0, readyState: document.readyState, loadedAt: null, visibility: document.visibilityState, overlay: null },
      })
    }
    return
  }
  stub.received.push(message as ServerMessage)
  for (const waiter of [...waiters]) waiter()
})

document.addEventListener('visibilitychange', () => sendRaw({ type: 'session:visibility', doc, visible: document.visibilityState === 'visible' } satisfies ClientMessage))

const loadOverlay = (): void => {
  const script = document.createElement('script')
  script.src = OVERLAY_PATH
  script.setAttribute('data-reglet-root', '')
  document.documentElement.append(script)
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loadOverlay, { once: true })
else loadOverlay()
