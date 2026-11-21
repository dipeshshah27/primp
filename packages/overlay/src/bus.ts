/**
 * The internal bus between the two injected bundles.
 *
 * The head script (`entry/hook.ts`) owns the ONE overlay WebSocket of the document and
 * publishes `window.__primp_bus`. The dock (`entry/overlay.ts`), loaded later, sends and
 * receives `session:*` messages through it. `settle:*` messages never reach the bus: the
 * settle client in the head script handles them itself.
 *
 * Only types are imported from the protocol package: importing a value would pull the schema
 * library into the injected bundles.
 */

import type { ClientMessage, OVERLAY_ASSET_PATH, OVERLAY_SOCKET_PATH, ServerMessage } from '@primp/protocol/messages'

/** Must equal the protocol's constants; the type annotation makes the compiler check it. */
export const SOCKET_PATH: typeof OVERLAY_SOCKET_PATH = '/__primp/ws'
export const OVERLAY_PATH: typeof OVERLAY_ASSET_PATH = '/__primp/overlay.js'

/** What the bus tells the dock about the socket itself. */
export type BusSignal =
  /** The socket is open. `reconnect`: it had been open before (the server restarted, or the network dropped). */
  { type: 'bus:open'; reconnect: boolean } | { type: 'bus:close' }

export type BusEvent = ServerMessage | BusSignal
export type BusEventType = BusEvent['type']
export type BusListener<T extends BusEventType = BusEventType> = (event: Extract<BusEvent, { type: T }>) => void

export interface PrimpBus {
  /** Random id of this document; the settle client and `session:hello` use the same one. */
  readonly doc: string
  /** Nonce of the head script (empty when the page has no nonce policy); primp's later scripts copy it. */
  readonly nonce: string
  connected(): boolean
  /** Sends now, or as soon as the socket is open (again). The queue is bounded. */
  send(message: ClientMessage): void
  /**
   * Calls `listener` for every event of `type` (`'*'`: every event). Events that arrived before
   * the first listener was registered are delivered to the listeners registered in that same task.
   * Returns the function that removes the listener.
   */
  on<T extends BusEventType>(type: T, listener: BusListener<T>): () => void
  on(type: '*', listener: (event: BusEvent) => void): () => void
}

declare global {
  interface Window {
    __primp_bus?: PrimpBus
  }
}
