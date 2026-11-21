import { sleep } from './proc.ts'

export interface WaitOptions {
  /** Give up after this long. Default 10 s. */
  timeoutMs?: number
  /** Pause between attempts. Default 50 ms. */
  intervalMs?: number
  /** Used in the timeout error. */
  what?: string
}

export class WaitTimeoutError extends Error {
  constructor(
    message: string,
    /** The last value the probe returned, or the last error it threw. */
    readonly last: unknown,
  ) {
    super(message)
    this.name = 'WaitTimeoutError'
  }
}

/**
 * Calls `probe` until it returns something other than `undefined`, `null` or
 * `false`, and returns that value. A probe that throws counts as "not yet".
 * Rejects with `WaitTimeoutError` (carrying the last value or error) on timeout.
 */
export async function waitFor<T>(
  probe: () => T | Promise<T>,
  options: WaitOptions = {},
): Promise<Exclude<T, undefined | null | false>> {
  const timeoutMs = options.timeoutMs ?? 10_000
  const intervalMs = options.intervalMs ?? 50
  const deadline = Date.now() + timeoutMs
  let last: unknown
  for (;;) {
    try {
      const value = await probe()
      if (value !== undefined && value !== null && value !== false) {
        return value as Exclude<T, undefined | null | false>
      }
      last = value
    } catch (error) {
      last = error
    }
    if (Date.now() >= deadline) {
      const detail = last instanceof Error ? `: ${last.message}` : ''
      throw new WaitTimeoutError(`timed out after ${timeoutMs} ms waiting for ${options.what ?? 'condition'}${detail}`, last)
    }
    await sleep(intervalMs)
  }
}

/** Milliseconds since `start` (a `performance.now()` value), rounded to 0.1 ms. */
export function since(start: number): number {
  return Math.round((performance.now() - start) * 10) / 10
}
