import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { buildUpstreamHeaders } from './headers.ts'
import type { Upstream } from './upstream.ts'
import { createWsTap, type WsMessage } from './ws-frames.ts'

/**
 * Upgrade tunnel for the dev server's own sockets (HMR and anything else the
 * app opens).
 *
 * The handshake request is replayed to the dev server over a raw socket with
 * the same header policy as plain requests, then both sockets are piped into
 * each other. The proxy does not take part in the WebSocket protocol: it
 * forwards whatever status the dev server answers and never changes a frame.
 *
 * The only change to the handshake is that `Sec-WebSocket-Extensions` is not
 * forwarded. Without the offer the server cannot turn on permessage-deflate,
 * so the copy of the stream shown to `onFrame` is readable.
 */

export type FrameDirection = 'client-to-upstream' | 'upstream-to-client'

export interface TunnelInfo {
  /** Unique per tunnel for the life of the proxy. */
  id: number
  /** Request target of the upgrade, with query string. */
  path: string
  /** Subprotocols the browser offered (`Sec-WebSocket-Protocol`). */
  protocols: string[]
}

export type UpgradeFrameHandler = (direction: FrameDirection, socket: TunnelInfo, payload: WsMessage) => void

export interface TunnelContext {
  upstream: Upstream
  proxyPort: number
  onFrame: UpgradeFrameHandler | undefined
  /** Registers a socket to be destroyed when the proxy closes. */
  track: (socket: Duplex) => void
  warn: (message: string, detail?: unknown) => void
}

const MAX_RESPONSE_HEAD = 64 * 1024
const HEAD_END = Buffer.from('\r\n\r\n')

let nextTunnelId = 1

export function refuseUpgrade(socket: Duplex, status: number, reason: string): void {
  const body = `${reason}\n`
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  )
}

/**
 * Splits the dev server's handshake response from the frames that follow it.
 * Returns the bytes after the response head once the head is complete.
 */
class ResponseHead {
  status: number | undefined
  private pending: Buffer | undefined = Buffer.alloc(0)

  /** `undefined` while the head is incomplete; afterwards the chunk's frame bytes. */
  push(chunk: Buffer): Buffer | undefined {
    if (this.pending === undefined) return chunk
    const data = Buffer.concat([this.pending, chunk])
    const end = data.indexOf(HEAD_END)
    if (end === -1) {
      // Keep going, but a head this long is not a handshake; report no status.
      this.pending = data.length > MAX_RESPONSE_HEAD ? undefined : data
      if (this.pending === undefined) this.status = 0
      return undefined
    }
    this.pending = undefined
    const match = /^HTTP\/1\.[01] (\d{3})/.exec(data.subarray(0, Math.min(end, 32)).toString('latin1'))
    this.status = match ? Number(match[1]) : 0
    return data.subarray(end + HEAD_END.length)
  }
}

export function tunnelUpgrade(req: IncomingMessage, client: Duplex, head: Buffer, context: TunnelContext): void {
  const info: TunnelInfo = {
    id: nextTunnelId++,
    path: req.url ?? '/',
    protocols: String(req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((protocol) => protocol.trim())
      .filter(Boolean),
  }
  const headers = buildUpstreamHeaders(req, { navigation: false, upgrade: true, proxyPort: context.proxyPort })
  const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`]
  for (let i = 0; i + 1 < headers.length; i += 2) lines.push(`${headers[i]}: ${headers[i + 1]}`)
  const handshake = `${lines.join('\r\n')}\r\n\r\n`

  let clientGone = false
  client.once('close', () => {
    clientGone = true
  })

  context.upstream.connect().then(
    (upstream) => {
      if (clientGone) {
        upstream.destroy()
        return
      }
      context.track(upstream)
      const teardown = (): void => {
        upstream.destroy()
        client.destroy()
      }
      upstream.on('error', teardown)
      upstream.on('close', teardown)
      client.on('error', teardown)
      client.on('close', teardown)

      const onFrame = context.onFrame
      const websocket = String(req.headers.upgrade ?? '').toLowerCase() === 'websocket'
      if (onFrame !== undefined && websocket) {
        // The taps only read. A handler that throws must not break the tunnel.
        const tap = (direction: FrameDirection) =>
          createWsTap((message) => {
            try {
              onFrame(direction, info, message)
            } catch (error) {
              context.warn('onUpgradeFrame handler threw', error)
            }
          })
        const fromClient = tap('client-to-upstream')
        const fromUpstream = tap('upstream-to-client')
        const responseHead = new ResponseHead()
        // Frames are only frames after a 101; any other answer is plain HTTP.
        const switched = (): boolean => responseHead.status === undefined || responseHead.status === 101
        if (head.length > 0) fromClient(head)
        client.on('data', (chunk: Buffer) => {
          if (switched()) fromClient(chunk)
        })
        upstream.on('data', (chunk: Buffer) => {
          const frames = responseHead.push(chunk)
          if (frames !== undefined && frames.length > 0 && responseHead.status === 101) fromUpstream(frames)
        })
      }

      // Header strings came from the HTTP parser as latin1; write them back the same way.
      upstream.write(handshake, 'latin1')
      if (head.length > 0) upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
    },
    (error: unknown) => {
      context.warn(`could not open ${info.path} on ${context.upstream.origin}`, error)
      if (!clientGone) refuseUpgrade(client, 502, 'Bad Gateway')
    },
  )
}
