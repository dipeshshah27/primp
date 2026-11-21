/**
 * State shared by the hook's modules: the clock, the cost counters, the
 * first-frame gate and the ring buffers.
 *
 * The hook runs before anything else on the page and stays for the life of the
 * document, so everything here is bounded: every buffer has a fixed capacity
 * and counts what it had to drop.
 */

import type { HookCost } from '../../../protocol/src/shift.ts'

export const now = (): number => performance.now()

/** Rounds to 1/100 px (or ms); sub-pixel layout noise below that is not worth recording. */
export const round = (value: number): number => Math.round(value * 100) / 100

export interface Ring<T> {
  items: T[]
  dropped: number
  push(item: T): void
}

/** A list that keeps the newest `capacity` items. */
export function ring<T>(capacity: number): Ring<T> {
  const buffer: Ring<T> = {
    items: [],
    dropped: 0,
    push(item) {
      if (buffer.items.length >= capacity) {
        buffer.items.shift()
        buffer.dropped++
      }
      buffer.items.push(item)
    },
  }
  return buffer
}

export const cost: HookCost = {
  topLevelMs: 0,
  shiftMs: 0,
  mutationMs: 0,
  resizeMs: 0,
  otherMs: 0,
  mutationCallbacks: 0,
  resizeCallbacks: 0,
  tracked: 0,
  untracked: 0,
}

type TimedKind = 'shiftMs' | 'mutationMs' | 'resizeMs' | 'otherMs'

/** Wraps an observer callback so the time spent in it is added to `cost`. A throwing callback must never reach the page. */
export function timed<A extends unknown[]>(kind: TimedKind, body: (...args: A) => void): (...args: A) => void {
  return (...args) => {
    const start = now()
    try {
      body(...args)
    } catch {
      // The hook must never break the page it observes.
    }
    cost[kind] += now() - start
  }
}

/**
 * False until the first animation frame. Nothing can shift before the first
 * frame is produced, so until then the hook only learns sizes and records no
 * mutations: the parser's own insertions would fill every buffer.
 */
export const frame = { seen: false, at: undefined as number | undefined }

/** Marks the reglet overlay host. It and everything in it is never recorded. */
export const OWN_ATTR = 'data-reglet-root'
