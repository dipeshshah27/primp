import { createServer, type Server } from 'node:net'

/**
 * Loopback listening helpers.
 *
 * Browsers resolve `localhost` to both `::1` and `127.0.0.1`, and other local
 * tools pick one or the other. A port is only "free on localhost" when nothing
 * holds it on either address, and a server is only reachable as `localhost`
 * from every client when it listens on both.
 */

export const LOOPBACK_V4 = '127.0.0.1'
export const LOOPBACK_V6 = '::1'

/** Errors that mean "this machine has no usable IPv6 loopback", not "port taken". */
const NO_IPV6 = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EINVAL', 'ENETUNREACH'])

export function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

export function listenOn(server: Server, port: number, host: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      const address = server.address()
      if (address === null || typeof address === 'string') reject(new Error('server has no TCP address'))
      else resolve(address.port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

export function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => resolve())
  })
}

/**
 * Binds one server per loopback family on the same port.
 *
 * `make` is called once per family. With `port` 0 the OS picks the IPv4 port
 * and the IPv6 bind is retried on a fresh port if that number happens to be
 * taken on `::1`. A machine without IPv6 loopback gets the IPv4 server alone.
 */
export async function listenOnLoopback<S extends Server>(
  make: () => S,
  port: number,
  attempts = 20,
): Promise<{ port: number; servers: S[] }> {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    const v4 = make()
    const bound = await listenOn(v4, port, LOOPBACK_V4)
    const v6 = make()
    try {
      await listenOn(v6, bound, LOOPBACK_V6)
      return { port: bound, servers: [v4, v6] }
    } catch (error) {
      if (NO_IPV6.has(errorCode(error) ?? '')) return { port: bound, servers: [v4] }
      await closeServer(v4)
      lastError = error
      // A fixed port that is taken on ::1 is taken; only port 0 may try again.
      if (port !== 0 || errorCode(error) !== 'EADDRINUSE') throw error
    }
  }
  throw lastError ?? new Error('no free loopback port found')
}

/** A TCP port that is free on both `127.0.0.1` and `::1` at the time of the call. */
export async function getFreePort(): Promise<number> {
  const { port, servers } = await listenOnLoopback(() => createServer(), 0)
  await Promise.all(servers.map((server) => closeServer(server)))
  return port
}
