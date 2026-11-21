/**
 * reglet's head script: the first script of every document the proxy serves, synchronous, small.
 *
 * In the top window it
 *   1. starts the layout-shift recorder (`window.__reglet`, see hook/install.ts);
 *   2. opens the document's ONE overlay WebSocket at once. A page with a `<meta>`
 *      Content-Security-Policy only lets a script open a socket before that element is parsed,
 *      and the settle client must see the document from its first mutation. Sends are queued
 *      until the socket is open; a closed socket is reopened with a growing pause;
 *   3. runs the settle client on that socket;
 *   4. publishes `window.__reglet_bus` for the dock (see bus.ts);
 *   5. after DOMContentLoaded, loads the dock bundle with a script element that carries this
 *      script's nonce.
 *
 * It writes nothing to the DOM except that one script element (removed again once it ran), logs
 * nothing, and does nothing at all inside a frame.
 *
 * Build: esbuild, IIFE. Optional `define`s: `__REGLET_HOOK_STACKS__` (true compiles in the
 * DOM-call stack capture) and `__REGLET_SETTLE_AUTOSTART__` (false drops the settle client's
 * stand-alone starter from the bundle).
 */

import type { ClientMessage } from '@reglet/protocol/messages'
import { OVERLAY_PATH, SOCKET_PATH, type BusEvent, type RegletBus } from '../bus.ts'
import { installHook } from '../hook/install.ts'
import { createSettleClient } from '../probe/settle-client.ts'

const QUEUE_LIMIT = 500
const BACKLOG_LIMIT = 100
const RETRY_FIRST_MS = 500
const RETRY_MAX_MS = 5000

function start(): void {
  // Read first: `currentScript` is only set while this script runs synchronously.
  const nonce = (document.currentScript as HTMLScriptElement | null)?.nonce ?? ''

  installHook()

  const bytes = crypto.getRandomValues(new Uint8Array(8))
  let doc = ''
  for (const byte of bytes) doc += byte.toString(16).padStart(2, '0')

  let socket: WebSocket | undefined
  let open = false
  let opens = 0
  let retries = 0
  let leaving = false
  const queue: string[] = []
  const listeners = new Map<string, Set<(event: never) => void>>()
  /** Events nobody listened to yet; the dock bundle loads after the socket has been talking for a while. */
  let backlog: BusEvent[] | undefined = []

  const deliver = (event: BusEvent): void => {
    for (const key of [event.type, '*']) {
      for (const listener of listeners.get(key) ?? []) {
        try {
          ;(listener as (event: BusEvent) => void)(event)
        } catch {
          // A listener's failure is its own.
        }
      }
    }
  }
  const emit = (event: BusEvent): void => {
    if (backlog === undefined) deliver(event)
    else if (backlog.length < BACKLOG_LIMIT) backlog.push(event)
  }

  const sendText = (text: string): void => {
    if (open && socket !== undefined) {
      try {
        socket.send(text)
        return
      } catch {
        // Closing: keep it for the next socket.
      }
    }
    if (queue.length >= QUEUE_LIMIT) queue.shift()
    queue.push(text)
  }
  const send = (message: object): void => sendText(JSON.stringify(message))

  const settle = createSettleClient({ send }, document, { id: doc })

  const hello = (): ClientMessage => ({
    type: 'session:hello',
    doc,
    url: location.href,
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    visible: document.visibilityState === 'visible',
  })

  const connect = (): void => {
    if (leaving) return
    let ws: WebSocket
    try {
      const url = new URL(SOCKET_PATH, location.href)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      ws = new WebSocket(url)
    } catch {
      return
    }
    socket = ws
    ws.onopen = () => {
      open = true
      retries = 0
      const reconnect = opens++ > 0
      // A new server knows nothing about this document.
      if (reconnect) settle.hello()
      const pending = queue.splice(0)
      // The settle client's own hello is the first thing in the queue of the first socket.
      const first = reconnect ? undefined : pending.shift()
      if (first !== undefined) ws.send(first)
      ws.send(JSON.stringify(hello()))
      for (const text of pending) ws.send(text)
      emit({ type: 'bus:open', reconnect })
    }
    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') return
      let message: unknown
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      const type = (message as { type?: unknown } | null)?.type
      if (typeof type !== 'string') return
      if (type.startsWith('settle:')) settle.handle(message)
      else emit(message as BusEvent)
    }
    ws.onclose = () => {
      if (socket !== ws) return
      const wasOpen = open
      open = false
      socket = undefined
      if (wasOpen) emit({ type: 'bus:close' })
      if (!leaving) setTimeout(connect, Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** retries++))
    }
  }
  connect()

  addEventListener('pagehide', () => {
    leaving = true
  })
  // Restored from the back/forward cache: the browser closed the socket when the page was stored.
  addEventListener('pageshow', (event) => {
    if (!event.persisted) return
    leaving = false
    if (socket === undefined) connect()
  })

  const bus: RegletBus = {
    doc,
    nonce,
    connected: () => open,
    send,
    on(type: string, listener: (event: never) => void) {
      let set = listeners.get(type)
      if (set === undefined) listeners.set(type, (set = new Set()))
      set.add(listener)
      if (backlog !== undefined) {
        const waiting = backlog
        backlog = undefined
        // After the caller has registered the rest of its listeners.
        queueMicrotask(() => waiting.forEach(deliver))
      }
      return () => set.delete(listener)
    },
  }
  window.__reglet_bus = bus

  const loadOverlay = (): void => {
    const script = document.createElement('script')
    script.src = OVERLAY_PATH
    script.async = true
    script.nonce = nonce
    // The recorder and the settle client skip nodes that carry this attribute.
    script.setAttribute('data-reglet-root', '')
    script.onload = script.onerror = () => script.remove()
    // Outside <head> and <body>, which frameworks own.
    document.documentElement.append(script)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loadOverlay, { once: true })
  else loadOverlay()
}

try {
  if (window.top === window && window.__reglet_bus === undefined) start()
} catch {
  // Never break the page.
}
