/**
 * Session windows, as Cumulative Layout Shift defines them: consecutive layout
 * shifts with less than 1 second between them, in a window of at most
 * 5 seconds. The page's CLS is the window with the largest sum.
 * (https://web.dev/articles/cls, checked 2026-11-20.)
 *
 * Pure: works on numbers only.
 */

import type { SessionWindow } from '../../protocol/src/shift.ts'

export const SESSION_GAP_MS = 1000
export const SESSION_MAX_MS = 5000

export interface WindowInput {
  index: number
  startTime: number
  value: number
}

/** Groups entries (any order) into session windows, in time order. */
export function sessionWindows(entries: readonly WindowInput[]): SessionWindow[] {
  const windows: SessionWindow[] = []
  let current: SessionWindow | undefined
  for (const entry of [...entries].sort((a, b) => a.startTime - b.startTime)) {
    // The gap is measured from the previous shift, the length from the first one of the window.
    if (current === undefined || entry.startTime - current.end >= SESSION_GAP_MS || entry.startTime - current.start >= SESSION_MAX_MS) {
      current = { start: entry.startTime, end: entry.startTime, value: 0, entries: [] }
      windows.push(current)
    }
    current.end = entry.startTime
    current.value += entry.value
    current.entries.push(entry.index)
  }
  return windows
}

/** The largest window's value; 0 when there are none. */
export function cumulativeLayoutShift(windows: readonly SessionWindow[]): number {
  return windows.reduce((max, window) => Math.max(max, window.value), 0)
}
