import { describe, expect, it } from 'vitest'
import { pickBest } from '@primp/engine/locator'
import type { Locator } from '@primp/protocol/change'
import { dropSlot, dropTarget, listItemIndex, sameKind, siblingPicker, toIndexOf, type Box, type Signature } from '../src/probe/order.ts'
import { cssSizeFor } from '../src/probe/size.ts'

const box = (left: number, top: number, width: number, height: number): Box => ({ left, top, width, height })
/** The index a drop at (x, y) gives the element dragged from `from`. */
const dropAt = (boxes: Box[], from: number, x: number, y: number): number => toIndexOf(dropSlot(boxes, x, y)!.slot, from)

describe('cssSizeFor: the border box a drag produces, as the CSS width or height', () => {
  it('content-box takes padding and border off, in whole px', () => {
    expect(cssSizeFor(300, { boxSizing: 'content-box', paddingAndBorder: 42 })).toBe(258)
    expect(cssSizeFor(300.4, { boxSizing: 'content-box', paddingAndBorder: 42 })).toBe(258)
    expect(cssSizeFor(300.6, { boxSizing: 'content-box', paddingAndBorder: 42 })).toBe(259)
    // Never negative: below padding plus border the content is simply 0.
    expect(cssSizeFor(20, { boxSizing: 'content-box', paddingAndBorder: 42 })).toBe(0)
  })

  it('border-box is the border box itself, never below padding plus border', () => {
    expect(cssSizeFor(300, { boxSizing: 'border-box', paddingAndBorder: 42 })).toBe(300)
    expect(cssSizeFor(299.5, { boxSizing: 'border-box', paddingAndBorder: 42 })).toBe(300)
    expect(cssSizeFor(20, { boxSizing: 'border-box', paddingAndBorder: 42 })).toBe(42)
  })

  it('a fractional padding is taken off before rounding, so the border box lands within half a pixel', () => {
    const css = cssSizeFor(250, { boxSizing: 'content-box', paddingAndBorder: 41.5 })
    expect(Math.abs(css + 41.5 - 250)).toBeLessThanOrEqual(0.5)
  })
})

describe('dropSlot: the gap nearest to the pointer', () => {
  // Three rows of a vertical list, 40px tall with 10px between them.
  const column = [box(0, 0, 200, 40), box(0, 50, 200, 40), box(0, 100, 200, 40)]
  // Three cards in one row, 100px wide with 20px between them.
  const row = [box(0, 0, 100, 80), box(120, 0, 100, 80), box(240, 0, 100, 80)]
  // Six cards in a 3 x 2 grid.
  const grid = [box(0, 0, 100, 80), box(120, 0, 100, 80), box(240, 0, 100, 80), box(0, 100, 100, 80), box(120, 100, 100, 80), box(240, 100, 100, 80)]

  it('vertical list: horizontal lines halfway between rows', () => {
    const below = dropSlot(column, 100, 96)!
    expect(below.slot).toBe(2)
    expect(below.line).toEqual({ left: 0, top: 94, width: 200, height: 2 })
    expect(dropAt(column, 0, 100, 96)).toBe(1)
    expect(dropAt(column, 0, 100, 160)).toBe(2)
    expect(dropAt(column, 2, 100, -10)).toBe(0)
    // Over its own place: no move.
    expect(dropAt(column, 1, 100, 70)).toBe(1)
  })

  it('horizontal row: vertical lines halfway between cards', () => {
    const between = dropSlot(row, 228, 40)!
    expect(between.slot).toBe(2)
    expect(between.line).toEqual({ left: 229, top: 0, width: 2, height: 80 })
    // The first card dropped between the second and the third ends up second.
    expect(dropAt(row, 0, 228, 40)).toBe(1)
    expect(dropAt(row, 0, 360, 40)).toBe(2)
    expect(dropAt(row, 2, -5, 40)).toBe(0)
  })

  it('grid: the nearest gap in the nearest row, the row break offering both of its ends', () => {
    // Between cards 4 and 5 of the second row.
    expect(dropSlot(grid, 110, 140)!.slot).toBe(4)
    expect(dropAt(grid, 0, 110, 140)).toBe(3)
    // After the end of the first row is the same gap as before the start of the second.
    expect(dropSlot(grid, 345, 40)!.slot).toBe(3)
    expect(dropSlot(grid, -5, 140)!.slot).toBe(3)
    // After the very last card.
    expect(dropSlot(grid, 350, 150)!.slot).toBe(6)
    expect(dropAt(grid, 1, 350, 150)).toBe(5)
    // Lines in a grid are vertical.
    expect(dropSlot(grid, 110, 140)!.line.width).toBe(2)
  })

  it('a grid whose last row holds one card still offers its side edges', () => {
    const odd = [...grid, box(0, 200, 100, 80)]
    const after = dropSlot(odd, 104, 240)!
    expect(after.slot).toBe(7)
    expect(after.line.width).toBe(2)
  })

  it('nothing to drop among', () => {
    expect(dropSlot([], 0, 0)).toBeNull()
  })
})

describe('dropTarget: where a drop puts the dragged element, as a sortable list does it', () => {
  const row = [box(0, 0, 100, 80), box(120, 0, 100, 80), box(240, 0, 100, 80)]
  const column = [box(0, 0, 200, 40), box(0, 50, 200, 40), box(0, 100, 200, 40)]

  it('over a sibling: takes its place, coming from either side', () => {
    expect(dropTarget(row, 0, 290, 40)).toMatchObject({ toIndex: 2, over: 2 })
    expect(dropTarget(row, 2, 50, 40)).toMatchObject({ toIndex: 0, over: 0 })
    expect(dropTarget(column, 0, 100, 70)).toMatchObject({ toIndex: 1, over: 1 })
    // The line stands for the gap the element lands in: after the sibling when coming from before it.
    expect(dropTarget(row, 0, 290, 40)!.line).toEqual({ left: 339, top: 0, width: 2, height: 80 })
    expect(dropTarget(row, 2, 50, 40)!.line).toEqual({ left: -1, top: 0, width: 2, height: 80 })
  })

  it('in the middle of a big sibling far from any gap, the drop still lands (the bug: the nearest gap was its own)', () => {
    // A 2-column bento: a wide first card, a narrow second, then two halves. Dragging the first over the middle of the fourth.
    const bento = [box(0, 0, 760, 430), box(780, 0, 370, 430), box(0, 450, 570, 530), box(585, 450, 570, 530)]
    const target = dropTarget(bento, 0, 760, 520)!
    expect(target.toIndex).toBe(3)
    expect(target.line).not.toBeNull()
  })

  it('over its own box nothing changes, and no line is shown', () => {
    expect(dropTarget(row, 1, 170, 40)).toEqual({ toIndex: 1, over: 1, line: null })
  })

  it('in empty space: the nearest gap, as before', () => {
    expect(dropTarget(row, 0, 230, 40)).toMatchObject({ toIndex: 1, over: null })
    expect(dropTarget(column, 2, 100, 46)).toMatchObject({ toIndex: 1, over: null })
    // The gap next to the element itself is no move.
    expect(dropTarget(row, 0, 110, 40)).toEqual({ toIndex: 0, over: null, line: null })
  })

  it('children without a box (a <script>, display: none) are no target and offer no gap, but count in the indexes', () => {
    // DOM: [script, A, (hidden), B, C]; the hidden ones report an empty box at 0,0.
    const empty = box(0, 0, 0, 0)
    const boxes = [null, box(0, 0, 100, 80), empty, box(120, 0, 100, 80), box(240, 0, 100, 80)]
    // A (index 1) over C (index 4): after C.
    expect(dropTarget(boxes, 1, 290, 40)).toMatchObject({ toIndex: 4, over: 4 })
    // C over A: A's place, index 1 (the script stays first).
    expect(dropTarget(boxes, 4, 50, 40)).toMatchObject({ toIndex: 1, over: 1 })
    // At the top-left corner, where the empty boxes sit, the target is A, never a hidden child.
    expect(dropTarget(boxes, 4, 0, 0)).toMatchObject({ toIndex: 1, over: 1 })
    // C into the gap between A and B: before B, which is DOM index 3; C comes from later, so it lands at 3.
    expect(dropTarget(boxes, 4, 110, 40)).toMatchObject({ toIndex: 3, over: null })
    // After the last shown child.
    expect(dropTarget(boxes, 1, 350, 40)).toMatchObject({ toIndex: 4, over: null })
  })

  it('nothing rendered: no target', () => {
    expect(dropTarget([null, box(0, 0, 0, 0)], 0, 0, 0)).toBeNull()
  })
})

describe('listItemIndex: the item a drag moves is the first of the chain that has a sibling of its kind', () => {
  const sig = (tag: string, ...classes: string[]): Signature => ({ tag, classes })

  it('sameKind: same tag and a class in common, or both without classes', () => {
    expect(sameKind(sig('article', 'group', 'p-6'), sig('article', 'group', 'p-8'))).toBe(true)
    expect(sameKind(sig('li'), sig('li'))).toBe(true)
    expect(sameKind(sig('li', 'a'), sig('li'))).toBe(false)
    expect(sameKind(sig('div', 'x'), sig('section', 'x'))).toBe(false)
  })

  it('a paragraph inside a card inside a grid of cards: the card', () => {
    const chain = [
      { self: sig('p', 'border-b'), siblings: [sig('div', 'space-y-2')] },
      { self: sig('div', 'mt-6'), siblings: [sig('div', 'icon'), sig('h3'), sig('p', 'muted')] },
      { self: sig('article', 'group', 'lg:col-span-4'), siblings: [sig('article', 'group', 'lg:col-span-2'), sig('article', 'group')] },
      { self: sig('div', 'grid'), siblings: [] },
    ]
    expect(listItemIndex(chain)).toBe(2)
  })

  it('a link among links is its own item', () => {
    expect(listItemIndex([{ self: sig('a', 'rounded-md'), siblings: [sig('a', 'rounded-md'), sig('a', 'rounded-md')] }])).toBe(0)
  })

  it('nothing list-like: null', () => {
    expect(listItemIndex([{ self: sig('h1'), siblings: [sig('p')] }])).toBeNull()
  })
})

describe('siblingPicker: a moved element is found by what it is, not by where it stands', () => {
  const plan = (name: string, index: number, rest: string): Locator => ({
    tag: 'div',
    indexPath: [0, 2, index],
    ancestors: ['body', 'main', 'div'],
    accName: `${name} ${rest}`,
    ...(index > 0 ? { prevAnchor: 'div' } : {}),
    ...(index < 2 ? { nextAnchor: 'div' } : {}),
  })
  // Recorded after Starter was moved to the middle; the page still has its own order.
  const recorded = plan('Starter', 1, '$0 forever 1 project Community support 7 day history')
  const page = [
    plan('Starter', 0, '$0 forever 1 project Community support 7 day history'),
    plan('Team', 1, '$29 per seat / month Unlimited projects Email support 90 day history Shared'),
    plan('Scale', 2, '$99 per seat / month Unlimited projects Priority support Unlimited history'),
  ]

  it('the plain choice is not Starter: the element at its recorded position wins or ties', () => {
    expect(pickBest(recorded, page)?.index).not.toBe(0)
  })

  it('without the sibling position, Starter is found where the page has it', () => {
    expect(siblingPicker(recorded, page, {})?.index).toBe(0)
  })

  it('siblings that only their position tells apart are ambiguous, not guessed', () => {
    const same = (index: number): Locator => ({ tag: 'li', indexPath: [0, index], ancestors: ['body', 'ul'], accName: 'Item' })
    expect(siblingPicker(same(1), [same(0), same(1), same(2)], {})).toBeNull()
  })
})
