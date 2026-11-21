import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  RPC_ERROR_STATUS,
  RPC_MAX_BODY_BYTES,
  RPC_PATH,
  RpcRequestSchema,
  controlMethods,
  isControlMethod,
  type ControlMethod,
  type ControlParams,
  type ControlResult,
  type RpcErrorCode,
  type RpcResponse,
} from '../../protocol/src/rpc.ts'

/**
 * Control endpoint of the long-running reglet process.
 *
 * It is the only way `reglet mcp` talks to the process. It listens on the IPv4
 * loopback interface on a port chosen by the OS and requires a random bearer
 * token, which the shim reads from the session file (mode 0600).
 *
 * Besides the token, two cheap checks keep web pages out: the Host header must
 * name the loopback address and port (stops DNS rebinding), and any request
 * carrying an Origin header is refused (no browser has a reason to call this).
 */

export type ControlHandlers = {
  [M in ControlMethod]?: (params: ControlParams<M>) => ControlResult<M> | Promise<ControlResult<M>>
}

/** A handler with its per-method types erased; see the note in dispatch(). */
type AnyHandler = (params: unknown) => unknown

export interface ControlServerOptions {
  handlers: ControlHandlers
  /** Called with errors thrown by handlers; the caller decides where they go. */
  onError?: (error: unknown, method: string) => void
}

export interface ControlServer {
  /** Loopback port the endpoint listens on. */
  port: number
  /** Bearer token every request must present. */
  token: string
  /** Stops listening and drops open connections. */
  close(): Promise<void>
}

const LOOPBACK = '127.0.0.1'

class RpcFailure extends Error {
  readonly code: RpcErrorCode

  constructor(code: RpcErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

export async function createControlServer(options: ControlServerOptions): Promise<ControlServer> {
  const token = randomBytes(32).toString('base64url')
  const expected = digest(`Bearer ${token}`)

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      // handle() answers every expected failure itself; this is a last resort.
      options.onError?.(error, '(transport)')
      if (!res.headersSent) send(res, fail('internal', 'control endpoint failed'))
      else res.destroy()
    })
  })
  // Shim calls are one-shot; do not keep idle sockets around.
  server.keepAliveTimeout = 1000

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const port = (server.address() as AddressInfo).port
    const host = req.headers.host
    if (host !== `${LOOPBACK}:${port}` && host !== `localhost:${port}`) {
      return send(res, fail('forbidden', 'unexpected Host header'))
    }
    if (req.headers.origin !== undefined) {
      return send(res, fail('forbidden', 'requests from web pages are not accepted'))
    }
    const presented = digest(req.headers.authorization ?? '')
    if (!timingSafeEqual(presented, expected)) {
      return send(res, fail('unauthorized', 'missing or wrong bearer token'))
    }
    const path = (req.url ?? '').split('?', 1)[0]
    if (req.method !== 'POST' || path !== RPC_PATH) {
      return send(res, fail('bad_request', `only POST ${RPC_PATH} is served here`))
    }

    try {
      send(res, { ok: true, result: await dispatch(await readJson(req)) })
    } catch (error) {
      if (error instanceof RpcFailure) return send(res, fail(error.code, error.message))
      throw error
    }
  }

  async function dispatch(body: unknown): Promise<unknown> {
    const request = RpcRequestSchema.safeParse(body)
    if (!request.success) throw new RpcFailure('bad_request', 'body must be {"method": string, "params"?: any}')
    const { method } = request.data

    // The table below pairs each method with its own schemas; the cast only
    // erases the per-method parameter type that TypeScript cannot correlate.
    const handler = isControlMethod(method) ? (options.handlers[method] as AnyHandler | undefined) : undefined
    if (!isControlMethod(method) || !handler) {
      throw new RpcFailure('method_not_found', `unknown control method "${method}"`)
    }
    const schema = controlMethods[method]
    const params = schema.params.safeParse(request.data.params ?? {})
    if (!params.success) {
      throw new RpcFailure('invalid_params', `invalid params for ${method}: ${params.error.message}`)
    }
    try {
      // Parsing the result strips anything the protocol does not declare.
      return schema.result.parse(await handler(params.data))
    } catch (error) {
      options.onError?.(error, method)
      throw new RpcFailure('internal', `${method} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, LOOPBACK, () => {
      server.off('error', reject)
      resolve()
    })
  })

  return {
    port: (server.address() as AddressInfo).port,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

function fail(code: RpcErrorCode, message: string): RpcResponse {
  return { ok: false, error: { code, message } }
}

function send(res: ServerResponse, body: RpcResponse): void {
  const payload = JSON.stringify(body)
  res.writeHead(body.ok ? 200 : RPC_ERROR_STATUS[body.error.code], {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    throw new RpcFailure('bad_request', 'Content-Type must be application/json')
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > RPC_MAX_BODY_BYTES) throw new RpcFailure('bad_request', 'request body is too large')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new RpcFailure('bad_request', 'body is not valid JSON')
  }
}
