import type { ShiftIssue } from '@reglet/protocol/shift'
import { describe, expect, it } from 'vitest'
import { movement, outlinesOf } from '../src/ui/shifts.tsx'

/**
 * The Shifts tab must not read a movement off the empty rectangle the browser reports for a victim
 * that left the viewport ("up 593px, left 84px" for a box that was pushed down, out of sight).
 */

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height })

describe('movement of a shift victim, in the dock', () => {
  it('a victim with two rectangles: direction and distance', () => {
    expect(movement({ dx: 0, dy: 17.6 })).toBe('down 18px')
    expect(movement({ dx: -6, dy: 0 })).toBe('left 6px')
    expect(movement({ dx: 0, dy: 0 })).toBe('resized')
  })

  it('a victim that left the viewport: the measured distance, a least distance, or just that it left', () => {
    expect(movement({ dx: 0, dy: 359.4, viewport: 'out' })).toBe('down 359px, out of view')
    expect(movement({ dx: 0, dy: 207.3, viewport: 'out', distance: 'at-least' })).toBe('down at least 207px, out of view')
    expect(movement({ dx: 0, dy: 0, viewport: 'out', distance: 'unknown' })).toBe('moved out of view')
    expect(movement({ dx: 0, dy: 0, viewport: 'in', distance: 'unknown' })).toBe('moved into view')
  })

  it('draws no outline for an empty rectangle', () => {
    const issue = {
      victims: [{ node: null, previousRect: rect(84, 592, 1112, 207), currentRect: rect(0, 0, 0, 0), dx: 0, dy: 359, viewport: 'out', explained: 'direct' }],
    } as unknown as ShiftIssue
    expect(outlinesOf(issue)).toEqual([{ kind: 'previous', rect: rect(84, 592, 1112, 207) }])
  })
})
