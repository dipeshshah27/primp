import { describe, expect, it } from 'vitest'
import { diff } from '../src/rect-diff.ts'
import { snap } from './helpers.ts'

describe('diff', () => {
  it('returns nothing for identical snapshots', () => {
    const a = snap([
      [1, 0, 'body', '', 0, 0, 1000, 600],
      [2, 1, 'div.a', '0', 0, 0, 100, 50],
    ])
    expect(diff(a, structuredClone(a))).toEqual([])
  })

  it('ignores changes up to the tolerance and reports the first step past it', () => {
    const before = snap([
      [1, 0, 'div.a', '0', 10, 10, 100, 50],
      [2, 0, 'div.b', '1', 10, 70, 100, 50],
      [3, 0, 'div.c', '2', 10, 130, 100, 50],
      [4, 0, 'div.d', '3', 10, 190, 100, 50],
    ])
    const after = snap([
      [1, 0, 'div.a', '0', 10.5, 9.5, 100.5, 49.5], // every component off by exactly 0.5: ignored
      [2, 0, 'div.b', '1', 11, 70, 100, 50], // 1px right
      [3, 0, 'div.c', '2', 10, 130, 100, 51], // 1px taller
      [4, 0, 'div.d', '3', 10, 190, 100, 50],
    ])
    expect(diff(before, after)).toEqual([
      { id: 2, type: 'moved', dx: 1, dy: 0, dw: 0, dh: 0 },
      { id: 3, type: 'resized', dx: 0, dy: 0, dw: 0, dh: 1 },
    ])
  })

  it('honours a custom tolerance', () => {
    const before = snap([[1, 0, 'div.a', '0', 0, 0, 100, 50]])
    const after = snap([[1, 0, 'div.a', '0', 2, 0, 100, 50]])
    expect(diff(before, after, { tolerance: 2 })).toEqual([])
    expect(diff(before, after, { tolerance: 1.5 })).toEqual([{ id: 1, type: 'moved', dx: 2, dy: 0, dw: 0, dh: 0 }])
  })

  it('reports resized, with the position change kept, when both position and size changed', () => {
    const before = snap([[1, 0, 'main', '0', 200, 0, 800, 600]])
    const after = snap([[1, 0, 'main', '0', 260, 0, 740, 600]])
    expect(diff(before, after)).toEqual([{ id: 1, type: 'resized', dx: 60, dy: 0, dw: -60, dh: 0 }])
  })

  it('reports appeared and disappeared, changed elements first in document order', () => {
    const before = snap([
      [1, 0, 'body', '', 0, 0, 1000, 300],
      [2, 1, 'div.gone', '0', 0, 0, 1000, 100],
      [3, 1, 'div.stays', '1', 0, 100, 1000, 200],
    ])
    const after = snap([
      [1, 0, 'body', '', 0, 0, 1000, 240],
      [4, 1, 'div.new', '0', 0, 0, 1000, 40],
      [3, 1, 'div.stays', '1', 0, 40, 1000, 200],
    ])
    expect(diff(before, after)).toEqual([
      { id: 1, type: 'resized', dx: 0, dy: 0, dw: 0, dh: -60 },
      { id: 4, type: 'appeared', dx: 0, dy: 0, dw: 1000, dh: 40 },
      { id: 3, type: 'moved', dx: 0, dy: -60, dw: 0, dh: 0 },
      { id: 2, type: 'disappeared', dx: 0, dy: 0, dw: -1000, dh: -100 },
    ])
  })

  it('does not call an element appeared when the earlier snapshot was truncated', () => {
    const before = snap([[1, 0, 'body', '', 0, 0, 1000, 300]], { total: 5 })
    const after = snap([
      [1, 0, 'body', '', 0, 0, 1000, 300],
      [2, 1, 'div.a', '0', 0, 0, 100, 100],
    ])
    expect(diff(before, after)).toEqual([])
  })

  it('calls an element disappeared from a truncated snapshot only when the earlier ids were pinned', () => {
    const before = snap([
      [1, 0, 'body', '', 0, 0, 1000, 300],
      [2, 1, 'div.a', '0', 0, 0, 100, 100],
    ])
    const rows: Parameters<typeof snap>[0] = [[1, 0, 'body', '', 0, 0, 1000, 300]]
    expect(diff(before, snap(rows, { total: 9 }))).toEqual([])
    expect(diff(before, snap(rows, { total: 9, pinned: true }))).toEqual([
      { id: 2, type: 'disappeared', dx: 0, dy: 0, dw: -100, dh: -100 },
    ])
  })
})
