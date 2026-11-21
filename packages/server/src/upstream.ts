import { Agent, type ClientRequestArgs } from 'node:http'
import { connect as netConnect, isIP, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { connect as tlsConnect } from 'node:tls'
import { errorCode, LOOPBACK_V4, LOOPBACK_V6 } from './free-port.ts'
import { isLoopbackHost, type ProxyTarget } from './headers.ts'

/**
 * Connections to the dev server.
 *
 * Every byte the proxy sends upstream, for plain requests and for upgrade
 * tunnels alike, travels over a socket opened here, so address fallback and
 * TLS policy exist in one place.
 *
 * Address fallback: `localhost` means `::1` to some dev servers and
 * `127.0.0.1` to others, and a target written as one literal may be bound to
 * the other. A loopback target is tried on the configured address first and
 * on the other family when the connection is refused. The address that last
 * worked is tried first from then on.
 *
 * TLS: certificate verification is turned off for loopback targets only. A
 * local dev server presents a self-signed or mkcert certificate that Node
 * does not trust, and there is no network between the two ends to intercept.
 * Any other target is verified normally.
 */

const CONNECT_TIMEOUT_MS = 10_000

/** Failures that say "nothing listens at this address", so another address is worth trying. */
const TRY_NEXT = new Set(['ECONNREFUSED', 'EADDRNOTAVAIL', 'ENETUNREACH', 'EHOSTUNREACH', 'EAFNOSUPPORT'])

export function connectCandidates(host: string): string[] {
  const name = host.toLowerCase().replace(/^\[|\]$/g, '')
  // `localhost` is tried the way browsers try it: IPv6 first.
  if (name === 'localhost') return [LOOPBACK_V6, LOOPBACK_V4]
  if (name === LOOPBACK_V6) return [LOOPBACK_V6, LOOPBACK_V4]
  if (name === LOOPBACK_V4) return [LOOPBACK_V4, LOOPBACK_V6]
  return [name]
}

export class Upstream {
  readonly target: ProxyTarget
  readonly origin: string
  /** Reuses idle connections; for requests that can be sent again if one turns out stale. */
  readonly keepAliveAgent: Agent
  /** One connection per request; for requests whose body cannot be replayed. */
  readonly freshAgent: Agent

  private order: string[]

  constructor(target: ProxyTarget) {
    this.target = target
    const bare = target.host.replace(/^\[|\]$/g, '')
    this.origin = `${target.protocol}://${isIP(bare) === 6 ? `[${bare}]` : bare}:${target.port}`
    this.order = connectCandidates(target.host)
    this.keepAliveAgent = new UpstreamAgent(this, true)
    this.freshAgent = new UpstreamAgent(this, false)
  }

  /** Opens a connected (and, for HTTPS targets, handshaken) socket to the dev server. */
  async connect(): Promise<Socket> {
    let failure: unknown
    for (const host of [...this.order]) {
      try {
        const socket = await this.connectTo(host)
        if (this.order[0] !== host) this.order = [host, ...this.order.filter((other) => other !== host)]
        return socket
      } catch (error) {
        failure = error
        if (!TRY_NEXT.has(errorCode(error) ?? '')) break
      }
    }
    throw failure
  }

  destroy(): void {
    this.keepAliveAgent.destroy()
    this.freshAgent.destroy()
  }

  private connectTo(host: string): Promise<Socket> {
    const { target } = this
    const secure = target.protocol === 'https'
    return new Promise<Socket>((resolve, reject) => {
      const name = target.host.replace(/^\[|\]$/g, '')
      const socket: Socket = secure
        ? tlsConnect({
            host,
            port: target.port,
            rejectUnauthorized: !isLoopbackHost(target.host),
            ALPNProtocols: ['http/1.1'],
            // SNI carries the configured name; it may not carry an IP literal (RFC 6066).
            ...(isIP(name) === 0 ? { servername: name } : {}),
          })
        : netConnect({ host, port: target.port })
      const fail = (error: Error): void => {
        socket.destroy()
        reject(error)
      }
      const onTimeout = (): void => {
        fail(Object.assign(new Error(`connecting to ${host}:${target.port} timed out`), { code: 'ETIMEDOUT' }))
      }
      socket.setTimeout(CONNECT_TIMEOUT_MS, onTimeout)
      socket.once('error', fail)
      socket.once(secure ? 'secureConnect' : 'connect', () => {
        socket.setTimeout(0)
        socket.off('timeout', onTimeout)
        socket.off('error', fail)
        // Whoever takes the socket adds its own handling; until then an error must not be fatal.
        socket.on('error', () => {})
        socket.setNoDelay(true)
        resolve(socket)
      })
    })
  }
}

/** An http.Agent whose sockets come from `Upstream.connect`, TLS included. */
class UpstreamAgent extends Agent {
  constructor(
    private readonly upstream: Upstream,
    keepAlive: boolean,
  ) {
    super({ keepAlive, keepAliveMsecs: 1000 })
  }

  override createConnection(
    _options: ClientRequestArgs,
    callback?: (error: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    this.upstream.connect().then(
      (socket) => callback?.(null, socket),
      // The agent reports the error on the request; it ignores the socket argument.
      (error: unknown) => callback?.(error instanceof Error ? error : new Error(String(error)), undefined as never),
    )
    return undefined
  }
}
