import { describe, expect, it } from 'vitest'
import { diff } from '../src/rect-diff.ts'
import type { RectDelta, Snapshot } from '../src/rect-diff.ts'
import { classify, shortLabel, sideEffects, summarize } from '../src/side-effects.ts'
import type { SideEffect } from '../src/side-effects.ts'
import bannerHidden from './fixtures/banner-hidden.json' with { type: 'json' }
import cardPadding from './fixtures/card-padding.json' with { type: 'json' }
import sidebarWidened from './fixtures/sidebar-widened.json' with { type: 'json' }
import { snap } from './helpers.ts'

interface Case {
  edited: number[]
  before: Snapshot
  after: Snapshot
}

// Every expected value below was worked out by hand from the fixture files, not copied from a run.

describe('hand-computed case 1: banner hidden', () => {
  const c = bannerHidden as Case

  it('diff: exact raw deltas', () => {
    expect(diff(c.before, c.after)).toEqual<RectDelta[]>([
      { id: 1, type: 'resized', dx: 0, dy: 0, dw: 0, dh: -48 },
      { id: 4, type: 'moved', dx: 0, dy: -48, dw: 0, dh: 0 },
      { id: 5, type: 'moved', dx: 0, dy: -48, dw: 0, dh: 0 },
      { id: 6, type: 'moved', dx: 0, dy: -48, dw: 0, dh: 0 },
      { id: 7, type: 'moved', dx: 0, dy: -48, dw: 0, dh: 0 },
      { id: 8, type: 'moved', dx: 0, dy: -48, dw: 0, dh: 0 },
      { id: 9, type: 'moved', dx: 0, dy: -48, dw: 0, dh: 0 },
      { id: 10, type: 'moved', dx: 0, dy: -48, dw: 0, dh: 0 },
      { id: 2, type: 'disappeared', dx: 0, dy: 0, dw: -1000, dh: -48 },
      { id: 3, type: 'disappeared', dx: 0, dy: 0, dw: -300, dh: -20 },
    ])
  })

  it('side effects: three moved subtrees, body as ancestor, banner as primary', () => {
    const report = sideEffects(c.before, c.after, { edited: c.edited })
    expect(report.primary).toEqual<RectDelta[]>([
      { id: 2, type: 'disappeared', dx: 0, dy: 0, dw: -1000, dh: -48 },
      { id: 3, type: 'disappeared', dx: 0, dy: 0, dw: -300, dh: -20 },
    ])
    expect(report.effects).toEqual<SideEffect[]>([
      {
        id: 4,
        desc: 'header.header',
        path: '1',
        type: 'moved',
        relation: 'outside',
        before: { x: 0, y: 48, w: 1000, h: 64 },
        after: { x: 0, y: 0, w: 1000, h: 64 },
        dx: 0,
        dy: -48,
        dw: 0,
        dh: 0,
        subtreeCount: 3,
        reflowed: 0,
        label: 'moved up 48px',
      },
      {
        id: 7,
        desc: 'main#main',
        path: '2',
        type: 'moved',
        relation: 'outside',
        before: { x: 0, y: 112, w: 1000, h: 600 },
        after: { x: 0, y: 64, w: 1000, h: 600 },
        dx: 0,
        dy: -48,
        dw: 0,
        dh: 0,
        subtreeCount: 3,
        reflowed: 0,
        label: 'moved up 48px',
      },
      {
        id: 10,
        desc: 'footer.footer',
        path: '3',
        type: 'moved',
        relation: 'outside',
        before: { x: 0, y: 712, w: 1000, h: 136 },
        after: { x: 0, y: 664, w: 1000, h: 136 },
        dx: 0,
        dy: -48,
        dw: 0,
        dh: 0,
        subtreeCount: 1,
        reflowed: 0,
        label: 'moved up 48px',
      },
      {
        id: 1,
        desc: 'body',
        path: '',
        type: 'resized',
        relation: 'ancestor',
        before: { x: 0, y: 0, w: 1000, h: 848 },
        after: { x: 0, y: 0, w: 1000, h: 800 },
        dx: 0,
        dy: 0,
        dw: 0,
        dh: -48,
        subtreeCount: 1,
        reflowed: 0,
        label: 'became 48px shorter',
      },
    ])
    expect(report.summary).toBe('7 elements moved up 48px')
    expect(report.pageOverflowX).toBe(false)
    expect(report.truncated).toBe(false)
  })
})

describe('hand-computed case 2: card padding', () => {
  const c = cardPadding as Case

  it('diff: exact raw deltas', () => {
    expect(diff(c.before, c.after)).toEqual<RectDelta[]>([
      { id: 2, type: 'resized', dx: 0, dy: 0, dw: 0, dh: 16 },
      { id: 3, type: 'resized', dx: 0, dy: 0, dw: 0, dh: 16 },
      { id: 5, type: 'moved', dx: 0, dy: 16, dw: 0, dh: 0 },
      { id: 6, type: 'resized', dx: 0, dy: 0, dw: 0, dh: 16 },
      { id: 7, type: 'resized', dx: 8, dy: 8, dw: -16, dh: 0 },
      { id: 8, type: 'moved', dx: 8, dy: 8, dw: 0, dh: 0 },
      { id: 9, type: 'resized', dx: 0, dy: 0, dw: 0, dh: 16 },
      { id: 10, type: 'moved', dx: 0, dy: 16, dw: 0, dh: 0 },
      { id: 11, type: 'moved', dx: 0, dy: 16, dw: 0, dh: 0 },
      { id: 12, type: 'moved', dx: 0, dy: 16, dw: 0, dh: 0 },
      { id: 13, type: 'moved', dx: 0, dy: 16, dw: 0, dh: 0 },
    ])
  })

  it('side effects: siblings stretch, later rows move, the fixed-height body overflows', () => {
    const report = sideEffects(c.before, c.after, { edited: c.edited })
    expect(report.primary).toEqual<RectDelta[]>([
      { id: 6, type: 'resized', dx: 0, dy: 0, dw: 0, dh: 16 },
      { id: 7, type: 'resized', dx: 8, dy: 8, dw: -16, dh: 0 },
      { id: 8, type: 'moved', dx: 8, dy: 8, dw: 0, dh: 0 },
    ])
    const moved = { dx: 0, dy: 16, dw: 0, dh: 0, reflowed: 0, label: 'moved down 16px' } as const
    const taller = { dx: 0, dy: 0, dw: 0, dh: 16 } as const
    expect(report.effects).toEqual<SideEffect[]>([
      {
        id: 3,
        desc: 'article#card-a.card',
        path: '0.0',
        type: 'resized',
        relation: 'outside',
        before: { x: 0, y: 0, w: 320, h: 240 },
        after: { x: 0, y: 0, w: 320, h: 256 },
        ...taller,
        subtreeCount: 2,
        reflowed: 1,
        label: 'became 16px taller (1 inside reflowed)',
      },
      {
        id: 10,
        desc: 'article#card-d.card',
        path: '0.3',
        type: 'moved',
        relation: 'outside',
        before: { x: 0, y: 260, w: 320, h: 240 },
        after: { x: 0, y: 276, w: 320, h: 240 },
        ...moved,
        subtreeCount: 2,
      },
      {
        id: 9,
        desc: 'article#card-c.card',
        path: '0.2',
        type: 'resized',
        relation: 'outside',
        before: { x: 680, y: 0, w: 320, h: 240 },
        after: { x: 680, y: 0, w: 320, h: 256 },
        ...taller,
        subtreeCount: 1,
        reflowed: 0,
        label: 'became 16px taller',
      },
      {
        id: 12,
        desc: 'article#card-e.card',
        path: '0.4',
        type: 'moved',
        relation: 'outside',
        before: { x: 340, y: 260, w: 320, h: 240 },
        after: { x: 340, y: 276, w: 320, h: 240 },
        ...moved,
        subtreeCount: 1,
      },
      {
        id: 13,
        desc: 'footer.footer',
        path: '1',
        type: 'moved',
        relation: 'outside',
        before: { x: 0, y: 540, w: 1000, h: 160 },
        after: { x: 0, y: 556, w: 1000, h: 160 },
        ...moved,
        subtreeCount: 1,
      },
      {
        id: 2,
        desc: 'main.grid',
        path: '0',
        type: 'resized',
        relation: 'ancestor',
        before: { x: 0, y: 0, w: 1000, h: 520 },
        after: { x: 0, y: 0, w: 1000, h: 536 },
        ...taller,
        subtreeCount: 1,
        reflowed: 0,
        label: 'became 16px taller',
      },
      {
        id: 1,
        desc: 'body',
        path: '',
        type: 'overflow',
        relation: 'ancestor',
        before: { x: 0, y: 0, w: 1000, h: 700 },
        after: { x: 0, y: 0, w: 1000, h: 700 },
        dx: 0,
        dy: 0,
        dw: 0,
        dh: 0,
        subtreeCount: 1,
        reflowed: 0,
        overflow: 'y',
        label: 'overflows vertically',
      },
    ])
    // The button inside card A moved too, but it is counted with card A, not as a fifth mover.
    expect(report.summary).toBe('4 elements moved down 16px; 2 elements became 16px taller; body overflows')
    expect(report.pageOverflowX).toBe(false)
  })
})

describe('hand-computed case 3: sidebar widened', () => {
  const c = sidebarWidened as Case

  it('diff: exact raw deltas', () => {
    expect(diff(c.before, c.after)).toEqual<RectDelta[]>([
      { id: 1, type: 'resized', dx: 0, dy: 0, dw: 0, dh: 40 },
      { id: 2, type: 'resized', dx: 0, dy: 0, dw: 0, dh: 40 },
      { id: 3, type: 'resized', dx: 0, dy: 0, dw: 60, dh: 40 },
      { id: 4, type: 'resized', dx: 0, dy: 0, dw: 60, dh: 0 },
      { id: 5, type: 'resized', dx: 60, dy: 0, dw: -60, dh: 40 },
      { id: 6, type: 'resized', dx: 60, dy: 0, dw: -60, dh: 40 },
      { id: 7, type: 'resized', dx: 60, dy: 40, dw: -60, dh: 0 },
      { id: 8, type: 'moved', dx: 60, dy: 40, dw: 0, dh: 0 },
      { id: 9, type: 'moved', dx: 60, dy: 40, dw: 0, dh: 0 },
      { id: 10, type: 'moved', dx: 0, dy: 40, dw: 0, dh: 0 },
    ])
  })

  it('side effects: main reflows as one effect; overflow, wrap, offscreen and page scroll are named', () => {
    const report = sideEffects(c.before, c.after, { edited: c.edited })
    expect(report.primary).toEqual<RectDelta[]>([
      { id: 3, type: 'resized', dx: 0, dy: 0, dw: 60, dh: 40 },
      { id: 4, type: 'resized', dx: 0, dy: 0, dw: 60, dh: 0 },
    ])
    const main = {
      id: 5,
      desc: 'main#content.content',
      path: '0.1',
      relation: 'outside',
      before: { x: 200, y: 0, w: 800, h: 600 },
      after: { x: 260, y: 0, w: 740, h: 640 },
      dx: 60,
      dy: 0,
      dw: -60,
      dh: 40,
    } as const
    expect(report.effects).toEqual<SideEffect[]>([
      {
        ...main,
        type: 'resized',
        subtreeCount: 5,
        reflowed: 3,
        label: 'became 60px narrower and 40px taller (3 inside reflowed)',
      },
      {
        id: 10,
        desc: 'footer.footer',
        path: '1',
        type: 'moved',
        relation: 'outside',
        before: { x: 0, y: 600, w: 1000, h: 80 },
        after: { x: 0, y: 640, w: 1000, h: 80 },
        dx: 0,
        dy: 40,
        dw: 0,
        dh: 0,
        subtreeCount: 1,
        reflowed: 0,
        label: 'moved down 40px',
      },
      { ...main, type: 'overflow', subtreeCount: 1, reflowed: 0, overflow: 'x', label: 'overflows horizontally' },
      {
        id: 6,
        desc: 'h1.title',
        path: '0.1.0',
        type: 'wrapped',
        relation: 'outside',
        before: { x: 210, y: 10, w: 780, h: 40 },
        after: { x: 270, y: 10, w: 720, h: 80 },
        dx: 60,
        dy: 0,
        dw: -60,
        dh: 40,
        subtreeCount: 1,
        reflowed: 0,
        lines: { before: 1, after: 2 },
        label: 'wrapped to 2 lines',
      },
      {
        id: 9,
        desc: 'span.badge',
        path: '0.1.2.0',
        type: 'offscreen',
        relation: 'outside',
        before: { x: 950, y: 140, w: 40, h: 20 },
        after: { x: 1010, y: 180, w: 40, h: 20 },
        dx: 60,
        dy: 40,
        dw: 0,
        dh: 0,
        subtreeCount: 1,
        reflowed: 0,
        label: 'pushed out of view',
      },
      {
        id: 1,
        desc: 'body',
        path: '',
        type: 'resized',
        relation: 'ancestor',
        before: { x: 0, y: 0, w: 1000, h: 680 },
        after: { x: 0, y: 0, w: 1000, h: 720 },
        dx: 0,
        dy: 0,
        dw: 0,
        dh: 40,
        subtreeCount: 2,
        reflowed: 0,
        label: 'became 40px taller',
      },
    ])
    expect(report.summary).toBe(
      '.footer moved down 40px; 2 elements became 60px narrower and 40px taller; ' +
        '.badge pushed out of view; #content overflows; .title wrapped to 2 lines; page scrolls horizontally',
    )
    expect(report.pageOverflowX).toBe(true)
  })
})

describe('classify', () => {
  it('reports no side effects when nothing outside the edited element changed', () => {
    const before = snap([
      [1, 0, 'body', '', 0, 0, 1000, 600],
      [2, 1, 'div.box', '0', 10, 10, 100, 100],
      [3, 2, 'span.label', '0.0', 20, 20, 50, 20],
    ])
    const after = snap([
      [1, 0, 'body', '', 0, 0, 1000, 600],
      [2, 1, 'div.box', '0', 10, 10, 120, 100],
      [3, 2, 'span.label', '0.0', 30, 20, 50, 20],
    ])
    const report = sideEffects(before, after, { edited: [2] })
    expect(report.effects).toEqual([])
    expect(report.primary.map((d) => d.id)).toEqual([2, 3])
    expect(report.summary).toBe('no side effects')
  })

  it('treats every delta as a side effect when no edited element is given', () => {
    const before = snap([
      [1, 0, 'body', '', 0, 0, 1000, 600],
      [2, 1, 'div.box', '0', 10, 10, 100, 100],
    ])
    const after = snap([
      [1, 0, 'body', '', 0, 0, 1000, 600],
      [2, 1, 'div.box', '0', 10, 30, 100, 100],
    ])
    const report = sideEffects(before, after)
    expect(report.primary).toEqual([])
    expect(report.summary).toBe('.box moved down 20px')
  })

  it('keeps a child with a different delta out of its parent group', () => {
    // The section moves down 10px; its sticky child stays where it was on the page.
    const before = snap([
      [1, 0, 'body', '', 0, 0, 1000, 600],
      [2, 1, 'div.edit', '0', 0, 0, 1000, 40],
      [3, 1, 'section.list', '1', 0, 40, 1000, 400],
      [4, 3, 'div.row', '1.0', 0, 40, 1000, 100],
      [5, 3, 'div.sticky', '1.1', 0, 140, 1000, 30],
      [6, 5, 'span.pin', '1.1.0', 0, 140, 30, 30],
    ])
    const after = snap([
      [1, 0, 'body', '', 0, 0, 1000, 600],
      [2, 1, 'div.edit', '0', 0, 0, 1000, 50],
      [3, 1, 'section.list', '1', 0, 50, 1000, 400],
      [4, 3, 'div.row', '1.0', 0, 50, 1000, 100],
      [5, 3, 'div.sticky', '1.1', 0, 140, 1000, 30],
      [6, 5, 'span.pin', '1.1.0', 0, 140, 30, 30],
    ])
    const report = sideEffects(before, after, { edited: [2] })
    expect(report.effects.map((e) => [e.id, e.type, e.subtreeCount])).toEqual([[3, 'moved', 2]])
    expect(report.summary).toBe('2 elements moved down 10px')
  })

  it('groups within the tolerance and describes diagonal moves', () => {
    const before = snap([
      [1, 0, 'body', '', 0, 0, 1000, 600],
      [2, 1, 'div.a', '0', 0, 0, 100, 100],
      [3, 2, 'div.b', '0.0', 0, 0, 50, 50],
    ])
    const after = snap([
      [1, 0, 'body', '', 0, 0, 1000, 600],
      [2, 1, 'div.a', '0', 30, 12, 100, 100],
      [3, 2, 'div.b', '0.0', 30.5, 12, 50, 50],
    ])
    const report = sideEffects(before, after)
    expect(report.effects).toHaveLength(1)
    expect(report.effects[0]).toMatchObject({ id: 2, subtreeCount: 2, label: 'moved down 12px and right 30px' })
  })

  it('folds the smaller groups of a type into "N more"', () => {
    const before = snap([
      [1, 0, 'body', '', 0, 0, 1000, 600],
      [2, 1, 'div.a', '0', 0, 0, 100, 50],
      [3, 2, 'i.x', '0.0', 0, 0, 10, 10],
      [4, 2, 'i.y', '0.1', 10, 0, 10, 10],
      [5, 1, 'div.b', '1', 0, 100, 100, 50],
      [6, 5, 'i.z', '1.0', 0, 100, 10, 10],
      [7, 1, 'div.c', '2', 0, 200, 100, 50],
      [8, 1, 'div.d', '3', 0, 300, 100, 50],
    ])
    const after = snap([
      [1, 0, 'body', '', 0, 0, 1000, 600],
      [2, 1, 'div.a', '0', 0, 5, 100, 50],
      [3, 2, 'i.x', '0.0', 0, 5, 10, 10],
      [4, 2, 'i.y', '0.1', 10, 5, 10, 10],
      [5, 1, 'div.b', '1', 0, 110, 100, 50],
      [6, 5, 'i.z', '1.0', 0, 110, 10, 10],
      [7, 1, 'div.c', '2', 0, 220, 100, 50],
      [8, 1, 'div.d', '3', 0, 330, 100, 50],
    ])
    const report = sideEffects(before, after)
    expect(report.summary).toBe('3 elements moved down 5px; 2 elements moved down 10px; 2 more moved')
    expect(sideEffects(before, after, { maxClausesPerType: 4 }).summary).toBe(
      '3 elements moved down 5px; 2 elements moved down 10px; .c moved down 20px; .d moved down 30px',
    )
  })

  it('reports elements that appear or disappear outside the edit, collapsed to the top-most one', () => {
    const before = snap([
      [1, 0, 'body', '', 0, 0, 1000, 600],
      [2, 1, 'button.toggle', '0', 0, 0, 100, 40],
      [3, 1, 'nav.menu', '1', 0, 40, 200, 90],
      [4, 3, 'a.item', '1.0', 0, 40, 200, 30],
      [5, 3, 'a.item', '1.1', 0, 70, 200, 30],
    ])
    const after = snap([
      [1, 0, 'body', '', 0, 0, 1000, 600],
      [2, 1, 'button.toggle', '0', 0, 0, 100, 40],
    ])
    const gone = sideEffects(before, after, { edited: [2] })
    expect(gone.effects.map((e) => [e.id, e.type, e.presence, e.subtreeCount, e.after])).toEqual([
      [3, 'resized', 'disappeared', 3, null],
    ])
    expect(gone.summary).toBe('3 elements disappeared')

    const back = sideEffects(after, before, { edited: [2] })
    expect(back.effects.map((e) => [e.id, e.type, e.presence, e.subtreeCount, e.before])).toEqual([
      [3, 'resized', 'appeared', 3, null],
    ])
    expect(back.summary).toBe('3 elements appeared')
  })

  it('collapses offscreen to the top-most element and uses each snapshot\'s own viewport', () => {
    const before = snap(
      [
        [1, 0, 'body', '', 0, 0, 1000, 2000],
        [2, 1, 'div.hero', '0', 0, 0, 1000, 500],
        [3, 1, 'div.cta', '1', 0, 500, 1000, 90],
        [4, 3, 'a.buy', '1.0', 20, 520, 100, 40],
      ],
      { page: { w: 1000, h: 2000 } },
    )
    const after = snap(
      [
        [1, 0, 'body', '', 0, 0, 1000, 2120],
        [2, 1, 'div.hero', '0', 0, 0, 1000, 620],
        [3, 1, 'div.cta', '1', 0, 620, 1000, 90],
        [4, 3, 'a.buy', '1.0', 20, 640, 100, 40],
      ],
      { page: { w: 1000, h: 2120 } },
    )
    const report = sideEffects(before, after, { edited: [2] })
    expect(report.effects.map((e) => [e.id, e.type, e.subtreeCount])).toEqual([
      [3, 'moved', 2],
      [3, 'offscreen', 2],
      [1, 'resized', 1],
    ])
    expect(report.summary).toBe('2 elements moved down 120px; 2 elements pushed out of view')

    // Same geometry, but the page was scrolled 200px when the second snapshot was taken.
    const scrolled = { ...after, viewport: { x: 0, y: 200, w: 1000, h: 600 } }
    expect(sideEffects(before, scrolled, { edited: [2] }).summary).toBe('2 elements moved down 120px')
  })

  it('reports unwrapping and counts several wraps together', () => {
    const before = snap([
      [1, 0, 'h2.title', '0', 0, 0, 200, 60, { lines: 3 }],
      [2, 0, 'p.note', '1', 0, 60, 200, 20, { lines: 1 }],
    ])
    const one = snap([
      [1, 0, 'h2.title', '0', 0, 0, 400, 20, { lines: 1 }],
      [2, 0, 'p.note', '1', 0, 20, 400, 20, { lines: 1 }],
    ])
    expect(sideEffects(before, one).summary).toBe(
      '.title became 200px wider and 40px shorter; .note became 200px wider; .title unwrapped to 1 line',
    )
    const two = snap([
      [1, 0, 'h2.title', '0', 0, 0, 200, 80, { lines: 4 }],
      [2, 0, 'p.note', '1', 0, 80, 200, 40, { lines: 2 }],
    ])
    expect(sideEffects(before, two).summary).toBe('2 elements became 20px taller; 2 elements re-wrapped')
  })

  it('reports only newly overflowing axes', () => {
    const before = snap([
      [1, 0, 'div.a', '0', 0, 0, 100, 100, { overflow: 'y' }],
      [2, 0, 'div.b', '1', 0, 100, 100, 100, { overflow: 'x' }],
      [3, 0, 'div.c', '2', 0, 200, 100, 100],
    ])
    const after = snap([
      [1, 0, 'div.a', '0', 0, 0, 100, 100, { overflow: 'xy' }],
      [2, 0, 'div.b', '1', 0, 100, 100, 100, { overflow: 'x' }],
      [3, 0, 'div.c', '2', 0, 200, 100, 100, { overflow: 'xy' }],
    ])
    const report = sideEffects(before, after)
    expect(report.effects.map((e) => [e.id, e.type, e.overflow, e.label])).toEqual([
      [1, 'overflow', 'x', 'overflows horizontally'],
      [3, 'overflow', 'xy', 'overflows'],
    ])
    expect(report.summary).toBe('2 elements overflow')
  })

  it('says how much of a truncated page was checked', () => {
    const before = snap([[1, 0, 'div.a', '0', 0, 0, 100, 100]], { total: 40 })
    const after = snap([[1, 0, 'div.a', '0', 0, 10, 100, 100]], { total: 40, pinned: true })
    const report = sideEffects(before, after)
    expect(report.truncated).toBe(true)
    expect(report.summary).toBe('.a moved down 10px (checked 1 of 40 elements)')
  })

  it('classify accepts deltas computed elsewhere and matches sideEffects', () => {
    const c = cardPadding as Case
    const deltas = diff(c.before, c.after)
    expect(classify(c.before, c.after, deltas, { edited: c.edited })).toEqual(
      sideEffects(c.before, c.after, { edited: c.edited }),
    )
  })
})

describe('summarize and shortLabel', () => {
  it('returns "no side effects" for an empty list', () => {
    expect(summarize([])).toBe('no side effects')
  })

  it('shortens descriptors', () => {
    expect(shortLabel('footer#site-footer.footer.dark')).toBe('#site-footer')
    expect(shortLabel('div.footer.dark')).toBe('.footer')
    expect(shortLabel('footer')).toBe('footer')
  })
})
