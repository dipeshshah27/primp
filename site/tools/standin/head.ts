/**
 * The head part of the website's stand-in for primp's server. Bundled with primp's real head
 * script into public/primp/head.js (tools/build-assets.ts): this code first, then the hook, as
 * ONE synchronous script that tools/postbuild.ts puts first in every page's <head>. It
 *
 *   1. marks the layout-shift replay. On `?shift=1` it sets `data-primp-shift` on <html>, which
 *      shows the hero screenshot without reserved space (app/globals.css). The picture's response
 *      is held back by the service worker /primp-sw.js (tools/sw.ts), so it arrives after the
 *      first paint and the page jumps. A page is controlled by a worker only from its next load
 *      on: when none controls this one, it stops the page, registers the worker and reloads once.
 *      Nothing installs the worker on any other load.
 *   2. gives the overlay socket (`/__primp/ws`) an in-page fake. `window.WebSocket` is wrapped so
 *      that only that path gets a fake socket; messages wait until session.ts (loaded async after
 *      DOMContentLoaded) takes them.
 *   3. rewrites the dock's URL. The hook loads `/__primp/overlay.js`; here the dock is the file
 *      next to this script, so the `src` setter of script elements is wrapped for that one value.
 *
 * Nothing here talks to any other host.
 */

import { OVERLAY_PATH, SOCKET_PATH } from '../../../packages/overlay/src/bus.ts'
import type { StandinHost, StandinSocket } from './host.ts'

const NO_SW_KEY = 'primp-site-no-sw'
const RELOADED_KEY = 'primp-site-sw-reload'

function session(): Storage | undefined {
  try {
    return window.sessionStorage
  } catch {
    return undefined
  }
}

function start(): void {
  const me = document.currentScript as HTMLScriptElement | null
  const base = new URL('.', me?.src ?? new URL('/primp/head.js', location.href).href)

  // -------------------------------------------------------------------------
  // 1. The layout-shift replay
  // -------------------------------------------------------------------------

  const replay = new URLSearchParams(location.search).get('shift') === '1'
  const controlled = navigator.serviceWorker?.controller != null
  const host: StandinHost = { sockets: new Set(), receive: undefined, pending: [], shift: { replay, held: replay && controlled } }
  window.__primp_site_host = host
  if (replay) {
    document.documentElement.setAttribute('data-primp-shift', '')
    const storage = session()
    const canUse = 'serviceWorker' in navigator && window.isSecureContext && storage?.getItem(NO_SW_KEY) !== '1' && storage?.getItem(RELOADED_KEY) !== location.href
    if (!controlled && canUse) {
      window.stop()
      storage?.setItem(RELOADED_KEY, location.href)
      const giveUp = (): void => {
        storage?.setItem(NO_SW_KEY, '1')
        location.reload()
      }
      const timer = setTimeout(giveUp, 4000)
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        clearTimeout(timer)
        location.reload()
      })
      navigator.serviceWorker.register(new URL('/primp-sw.js', location.href), { scope: '/' }).catch(() => {
        clearTimeout(timer)
        giveUp()
      })
      return
    }
    storage?.removeItem(RELOADED_KEY)
  }

  // -------------------------------------------------------------------------
  // 3. The dock's URL
  // -------------------------------------------------------------------------

  const srcDescriptor = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src')
  if (srcDescriptor?.set !== undefined) {
    const nativeSet = srcDescriptor.set
    Object.defineProperty(HTMLScriptElement.prototype, 'src', {
      ...srcDescriptor,
      set(this: HTMLScriptElement, value: string) {
        if (value === OVERLAY_PATH) {
          nativeSet.call(this, new URL('overlay.js', base).href)
          // Only the dock's script element needed it: put the native setter back.
          Object.defineProperty(HTMLScriptElement.prototype, 'src', srcDescriptor)
          return
        }
        nativeSet.call(this, value)
      },
    })
  }

  // -------------------------------------------------------------------------
  // 2. The fake socket
  // -------------------------------------------------------------------------

  let sessionRequested = false
  const loadSession = (): void => {
    if (sessionRequested) return
    sessionRequested = true
    const script = document.createElement('script')
    script.src = new URL('session.js', base).href
    script.async = true
    // The recorder and the settle client skip nodes that carry this attribute.
    script.setAttribute('data-primp-root', '')
    script.onload = script.onerror = () => script.remove()
    document.documentElement.append(script)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loadSession, { once: true })
  else loadSession()

  class FakeSocket extends EventTarget implements StandinSocket {
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
        host.sockets.add(this)
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
      if (typeof data !== 'string') return
      if (host.receive === undefined) host.pending.push([this, data])
      else host.receive(this, data)
    }

    deliver(message: object): void {
      const text = JSON.stringify(message)
      setTimeout(() => {
        if (this.readyState === 1) this.fire('message', new MessageEvent('message', { data: text }))
      }, 0)
    }

    close(): void {
      if (this.readyState >= 2) return
      this.readyState = 3
      host.sockets.delete(this)
      this.fire('close', new CloseEvent('close', { code: 1000, wasClean: true }))
    }
  }

  const NativeWebSocket = window.WebSocket
  window.WebSocket = new Proxy(NativeWebSocket, {
    construct(target, args: [string | URL, (string | string[])?]) {
      const url = new URL(String(args[0]), location.href)
      if (url.pathname.endsWith(SOCKET_PATH)) return new FakeSocket(url.href) as unknown as WebSocket
      return Reflect.construct(target, args) as WebSocket
    },
  })
}

try {
  if (window.top === window && window.__primp_site_host === undefined) start()
} catch (error) {
  console.warn('[primp site] the stand-in could not start:', error)
}
