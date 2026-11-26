import { z } from 'zod'
import { DismissChangeResultSchema, PendingChangesSchema, SessionSummarySchema, VerifyChangesResultSchema, LayoutShiftsResultSchema, ShiftVerificationSchema } from './session.ts'

/**
 * Control RPC: the private channel between `primp mcp` (stdio shim) and the
 * long-running primp process.
 *
 *   POST http://127.0.0.1:<controlPort>/rpc
 *   Authorization: Bearer <token>
 *   Content-Type: application/json
 *   { "method": "get_session", "params": {} }
 *
 * The response body is always an RpcResponse; the HTTP status mirrors `ok`.
 */

export const RPC_PATH = '/rpc'

/** Largest request body the control endpoint accepts. */
export const RPC_MAX_BODY_BYTES = 1024 * 1024

export const RpcRequestSchema = z.object({
  method: z.string().min(1),
  params: z.unknown().optional(),
})
export type RpcRequest = z.infer<typeof RpcRequestSchema>

export const RpcErrorCodeSchema = z.enum([
  'unauthorized',
  'forbidden',
  'bad_request',
  'method_not_found',
  'invalid_params',
  'internal',
])
export type RpcErrorCode = z.infer<typeof RpcErrorCodeSchema>

export const RpcErrorSchema = z.object({
  code: RpcErrorCodeSchema,
  message: z.string(),
})
export type RpcError = z.infer<typeof RpcErrorSchema>

export const RpcResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({ ok: z.literal(false), error: RpcErrorSchema }),
])
export type RpcResponse = z.infer<typeof RpcResponseSchema>

export const RPC_ERROR_STATUS: Record<RpcErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  bad_request: 400,
  method_not_found: 404,
  invalid_params: 422,
  internal: 500,
}

/**
 * Every control method with the schema of its params and its result. The
 * control server validates both directions against this table and the shim
 * validates results again, so the two processes can be different versions
 * without passing malformed data to an agent.
 */
export const controlMethods = {
  get_session: {
    params: z.object({}),
    result: SessionSummarySchema,
  },
  /** Hands the queued changes to the caller and marks them claimed. */
  get_pending_changes: {
    params: z.object({
      /** Only this batch (also returns its changes when they were claimed before). Default: everything queued. */
      batchId: z.string().min(1).optional(),
    }),
    result: PendingChangesSchema,
  },
  /**
   * Like get_pending_changes, but when nothing is queued it waits until the developer presses Send
   * (or `timeoutMs` passes; then nothing is returned) and then hands those changes over.
   */
  wait_for_changes: {
    params: z.object({
      /** How long to wait for a Send. Default 50000. */
      timeoutMs: z.number().int().min(0).max(55_000).optional(),
    }),
    result: PendingChangesSchema,
  },
  /** Waits for the page to settle, measures the changes in the browser and judges them. Can take `waitMs` plus a few seconds. */
  verify_changes: {
    params: z.object({
      /** Default: every change that is claimed, queued or failed. */
      ids: z.array(z.string().min(1)).max(500).optional(),
      /** How long to wait for the page to settle after the last source edit. Default 5000. */
      waitMs: z.number().int().min(0).max(60_000).optional(),
    }),
    result: VerifyChangesResultSchema,
  },
  /** The layout shifts of the page's last load, with culprit, cause and source. Changes nothing. */
  get_layout_shifts: {
    params: z.object({
      /** Leave out issues scoring below this. Default 0. */
      minValue: z.number().min(0).max(10).optional(),
    }),
    result: LayoutShiftsResultSchema,
  },
  /** Reloads the developer's tab a few times without the browser cache and reports whether the shift came back. Takes several seconds per reload. */
  verify_layout_shift: {
    params: z.object({ id: z.string().min(1) }),
    result: ShiftVerificationSchema,
  },
  /** Closes one change without implementing it. */
  dismiss_change: {
    params: z.object({
      id: z.string().min(1),
      reason: z.string().min(1).max(2000),
    }),
    result: DismissChangeResultSchema,
  },
} as const

export type ControlMethod = keyof typeof controlMethods
export type ControlParams<M extends ControlMethod> = z.infer<(typeof controlMethods)[M]['params']>
export type ControlResult<M extends ControlMethod> = z.infer<(typeof controlMethods)[M]['result']>

export function isControlMethod(name: string): name is ControlMethod {
  return Object.hasOwn(controlMethods, name)
}
