/**
 * Moving an element among its siblings: which elements count as siblings, whether the element
 * can be moved at all, and where a drop at the pointer puts it.
 *
 * Indexes count the element children of the parent, from 0, as the protocol's `move` does
 * (reglet's own nodes are never counted). A reorder never changes the parent.
 *
 * `dropSlot` and `toIndexOf` are pure (rectangles in, numbers out) so that the drop position can
 * be tested without a browser.
 */

import { pickBest } from '@reglet/engine/locator'
import type { Locator } from '@reglet/protocol/change'
import { isOwn, locate, type LocateResult, type LocatorPicker } from './ref.ts'

/** The element children of `parent` that are the page's, in document order. */
export function elementChildren(parent: Element): Element[] {
  const out: Element[] = []
  for (let child = parent.firstElementChild; child !== null; child = child.nextElementSibling) if (!isOwn(child)) out.push(child)
  return out
}

export interface Position {
  parent: Element
  siblings: Element[]
  index: number
}

/** Where `element` stands among its siblings; null when it has no parent element. */
export function positionOf(element: Element): Position | null {
  const parent = element.parentElement
  if (parent === null) return null
  const siblings = elementChildren(parent)
  const index = siblings.indexOf(element)
  return index < 0 ? null : { parent, siblings, index }
}

/**
 * Why `element` cannot be moved among its siblings, in words; null when it can. `hiddenBy` names
 * the recorded change that hides or removes it, if one does.
 */
export function reorderRefusal(element: Element, hiddenBy?: 'hide' | 'remove'): string | null {
  const position = positionOf(element)
  const tag = position?.parent.localName
  if (position === null || tag === 'html' || tag === 'body' || tag === 'head') {
    return 'This element sits directly in the page body: reglet moves elements only inside one of the page’s own containers.'
  }
  if (position.siblings.length < 2) return 'This element is the only child of its parent: there is nothing to move it among.'
  if (hiddenBy !== undefined) return `This element is ${hiddenBy === 'hide' ? 'hidden' : 'removed'} by a recorded change. Delete that change to move it.`
  return null
}

// ---------------------------------------------------------------------------
// Finding a moved element again
// ---------------------------------------------------------------------------

/**
 * `locate`'s choice without the element's position among its siblings: the last step of the
 * index path and the neighbour anchors are left out of the comparison (the parent's path and
 * everything else still count). An element that was moved, or whose order is what is being
 * checked, must not be recognised by the position it was recorded at: after a reorder the
 * sibling now standing there would win on position alone. Siblings that only their position
 * tells apart are then ambiguous, and `locate` reports that instead of guessing.
 */
export const siblingPicker: LocatorPicker = (want, candidates, options) => {
  const last = want.indexPath.length - 1
  const neutral = (locator: Locator): Locator => {
    const { prevAnchor: _prev, nextAnchor: _next, ...rest } = locator
    void _prev
    void _next
    if (last < 0 || locator.indexPath.length !== want.indexPath.length) return rest
    return { ...rest, indexPath: [...locator.indexPath.slice(0, last), want.indexPath[last]!] }
  }
  return pickBest(neutral(want), candidates.map(neutral), options)
}

/** `locate` with `siblingPicker`. */
export function locateAmongSiblings(want: Locator, doc: Document = document): LocateResult {
  return locate(want, { document: doc, picker: siblingPicker })
}

// ---------------------------------------------------------------------------
// Where a drop lands
// ---------------------------------------------------------------------------

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

/** An insertion line: `slot` is the gap it stands for (0 = before the first sibling, n = after the last). */
export interface DropSlot {
  slot: number
  /** The line to draw, in the coordinates of the boxes; 2px across. */
  line: Box
}

const right = (box: Box): number => box.left + box.width
const bottom = (box: Box): number => box.top + box.height
const centerX = (box: Box): number => box.left + box.width / 2

/** Two boxes in one row: side by side, overlapping vertically by at least half the smaller height. */
function sameRow(a: Box, b: Box): boolean {
  const overlap = Math.min(bottom(a), bottom(b)) - Math.max(a.top, b.top)
  return overlap > Math.min(a.height, b.height) / 2 && (b.left >= right(a) - 1 || a.left >= right(b) - 1)
}

function distanceToBox(x: number, y: number, box: Box): number {
  const dx = Math.max(box.left - x, 0, x - right(box))
  const dy = Math.max(box.top - y, 0, y - bottom(box))
  return Math.hypot(dx, dy)
}

/**
 * The gap nearest to the pointer among the siblings' boxes (in document order, the dragged one
 * included). Each box offers a line at its leading edge (the gap before it) and at its trailing
 * edge (the gap after it); edges face along the row when the box shares a row with a neighbour
 * (a horizontal row, a grid), else up and down (a vertical list). Between two neighbours the line
 * is drawn halfway across the space between them. A grid's row break offers both the end of one
 * row and the start of the next for the same gap. Null without boxes.
 */
export function dropSlot(boxes: readonly Box[], x: number, y: number): DropSlot | null {
  let best: { slot: DropSlot; distance: number } | undefined
  const offer = (slot: number, line: Box): void => {
    const distance = distanceToBox(x, y, line)
    if (best === undefined || distance < best.distance - 0.01) best = { slot: { slot, line }, distance }
  }
  // Rows anywhere (a grid whose last row holds one box): that box's edges face along the row too.
  const rows = boxes.some((box, index) => index > 0 && sameRow(boxes[index - 1]!, box))
  boxes.forEach((box, index) => {
    const prev = boxes[index - 1]
    const next = boxes[index + 1]
    const rowPrev = prev !== undefined && sameRow(prev, box)
    const rowNext = next !== undefined && sameRow(box, next)
    if (rowPrev || rowNext || rows) {
      // Along a row; right to left when the neighbours say so.
      const rtl = (rowNext && centerX(next!) < centerX(box)) || (!rowNext && rowPrev && centerX(prev!) > centerX(box))
      const leadEdge = rtl ? right(box) : box.left
      const trailEdge = rtl ? box.left : right(box)
      const lead = rowPrev ? (leadEdge + (rtl ? prev!.left : right(prev!))) / 2 : leadEdge
      const trail = rowNext ? (trailEdge + (rtl ? right(next!) : next!.left)) / 2 : trailEdge
      offer(index, { left: lead - 1, top: box.top, width: 2, height: box.height })
      offer(index + 1, { left: trail - 1, top: box.top, width: 2, height: box.height })
    } else {
      const stackedPrev = prev !== undefined && box.top >= bottom(prev) - 1
      const stackedNext = next !== undefined && next.top >= bottom(box) - 1
      const lead = stackedPrev ? (box.top + bottom(prev!)) / 2 : box.top
      const trail = stackedNext ? (bottom(box) + next!.top) / 2 : bottom(box)
      offer(index, { left: box.left, top: lead - 1, width: box.width, height: 2 })
      offer(index + 1, { left: box.left, top: trail - 1, width: box.width, height: 2 })
    }
  })
  return best?.slot ?? null
}

/** The index the dragged element ends up at when it is dropped into gap `slot`. */
export function toIndexOf(slot: number, fromIndex: number): number {
  return slot > fromIndex ? slot - 1 : slot
}
