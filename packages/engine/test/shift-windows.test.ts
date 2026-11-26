import { describe, expect, it } from 'vitest'
import { cumulativeLayoutShift, SESSION_GAP_MS, SESSION_MAX_MS, sessionWindows } from '../src/shift-windows.ts'

const entry = (index: number, startTime: number, value: number) => ({ index, startTime, value })

describe('sessionWindows', () => {
  it('has the documented limits: gaps under 1 s, windows of at most 5 s', () => {
    expect(SESSION_GAP_MS).toBe(1000)
    expect(SESSION_MAX_MS).toBe(5000)
  })

  it('returns nothing for no entries, and a CLS of 0', () => {
    expect(sessionWindows([])).toEqual([])
    expect(cumulativeLayoutShift([])).toBe(0)
  })

  it('puts shifts less than a second apart into one window', () => {
    const windows = sessionWindows([entry(0, 100, 0.1), entry(1, 900, 0.05), entry(2, 1899, 0.02)])
    expect(windows).toHaveLength(1)
    expect(windows[0]).toMatchObject({ start: 100, end: 1899, entries: [0, 1, 2] })
    expect(windows[0]?.value).toBeCloseTo(0.17, 10)
  })

  it('starts a new window when the gap is exactly one second', () => {
    const windows = sessionWindows([entry(0, 100, 0.1), entry(1, 1100, 0.05)])
    expect(windows.map((window) => window.entries)).toEqual([[0], [1]])
  })

  it('keeps a gap of 999 ms in the same window', () => {
    expect(sessionWindows([entry(0, 100, 0.1), entry(1, 1099, 0.05)])).toHaveLength(1)
  })

  it('caps a window at five seconds, measured from its first shift', () => {
    // One shift every 900 ms: never a one-second gap, so only the length limit can split them.
    const entries = Array.from({ length: 8 }, (_, index) => entry(index, index * 900, 0.01))
    const windows = sessionWindows(entries)
    // 0 .. 4500 fit (4500 < 5000); 5400 is 5.4 s after the start and opens the next window.
    expect(windows.map((window) => window.entries)).toEqual([[0, 1, 2, 3, 4, 5], [6, 7]])
    expect(windows[0]!.end - windows[0]!.start).toBeLessThan(SESSION_MAX_MS)
  })

  it('puts a shift exactly five seconds after the window start into a new window', () => {
    const windows = sessionWindows([entry(0, 0, 0.1), entry(1, 999, 0.1), entry(2, 1998, 0.1), entry(3, 2997, 0.1), entry(4, 3996, 0.1), entry(5, 4995, 0.1), entry(6, 5000, 0.1)])
    expect(windows.map((window) => window.entries)).toEqual([[0, 1, 2, 3, 4, 5], [6]])
  })

  it('sorts entries by time before grouping and does not change its input', () => {
    const input = [entry(2, 2500, 0.3), entry(0, 100, 0.1), entry(1, 300, 0.2)]
    const windows = sessionWindows(input)
    expect(windows.map((window) => window.entries)).toEqual([[0, 1], [2]])
    expect(input.map((item) => item.index)).toEqual([2, 0, 1])
  })

  it('reports the largest window as the CLS, not the sum of all shifts', () => {
    const windows = sessionWindows([entry(0, 100, 0.1), entry(1, 200, 0.1), entry(2, 3000, 0.15), entry(3, 9000, 0.05)])
    expect(windows).toHaveLength(3)
    expect(cumulativeLayoutShift(windows)).toBeCloseTo(0.2, 10)
  })
})
