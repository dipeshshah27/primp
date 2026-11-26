/**
 * Moving an element among its siblings: which elements count as siblings, whether the element
 * can be moved at all, and where a drop at the pointer puts it.
 *
 * Indexes count the element children of the parent, from 0, as the protocol's `move` does
 * (primp's own nodes are never counted). A reorder never changes the parent.
 *
 * `dropSlot` and `toIndexOf` are pure (rectangles in, numbers out) so that the drop position can
 * be tested without a browser.
 */

import { pickBest } from '@primp/engine/locator'
import type { Locator } from '@primp/protocol/change'
import { isOwn, locate, type LocateResult, type LocatorPicker } from './ref.ts'
import { isUtilityClass } from './styles.ts'

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
    return 'This element sits directly in the page body: primp moves elements only inside one of the page’s own containers.'
  }
  if (position.siblings.length < 2) return 'This element is the only child of its parent: there is nothing to move it among.'
  if (hiddenBy !== undefined) return `This element is ${hiddenBy === 'hide' ? 'hidden' : 'removed'} by a recorded change. Delete that change to move it.`
  return null
}

// ---------------------------------------------------------------------------
// Finding a moved element again
// ---------------------------------------------------------------------------

/**
 * `locate`'s choice ignoring the element's position among its siblings: the last index-path step
 * and the neighbour anchors are left out (the parent's path and the rest still count). A moved
 * element, or one whose order is being checked, must not be recognised by its recorded position:
 * after a reorder the sibling now standing there would win on position alone. Siblings only their
 * position tells apart are then ambiguous, and `locate` reports that instead of guessing.
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

/** Every gap the boxes offer, each with the line that stands for it (see `dropSlot`). */
function slotOffers(boxes: readonly Box[]): DropSlot[] {
  const out: DropSlot[] = []
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
      out.push({ slot: index, line: { left: lead - 1, top: box.top, width: 2, height: box.height } })
      out.push({ slot: index + 1, line: { left: trail - 1, top: box.top, width: 2, height: box.height } })
    } else {
      const stackedPrev = prev !== undefined && box.top >= bottom(prev) - 1
      const stackedNext = next !== undefined && next.top >= bottom(box) - 1
      const lead = stackedPrev ? (box.top + bottom(prev!)) / 2 : box.top
      const trail = stackedNext ? (bottom(box) + next!.top) / 2 : bottom(box)
      out.push({ slot: index, line: { left: box.left, top: lead - 1, width: box.width, height: 2 } })
      out.push({ slot: index + 1, line: { left: box.left, top: trail - 1, width: box.width, height: 2 } })
    }
  })
  return out
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
  for (const offer of slotOffers(boxes)) {
    const distance = distanceToBox(x, y, offer.line)
    if (best === undefined || distance < best.distance - 0.01) best = { slot: offer, distance }
  }
  return best?.slot ?? null
}

/** Where a drop puts the dragged element (see `dropTarget`). */
export interface DropTarget {
  /** Its index among ALL the element children after the drop; `from` when the drop changes nothing. */
  toIndex: number
  /** The sibling under the pointer (an index among all the children), if any. */
  over: number | null
  /** The gap the drop stands for, as an insertion line; null when the drop changes nothing. */
  line: Box | null
}

const contains = (box: Box, x: number, y: number): boolean => x >= box.left && x <= right(box) && y >= box.top && y <= bottom(box)

/**
 * Where a drop at the pointer puts the element at index `from`, as a sortable list does it:
 * - over a sibling, the dragged element takes that sibling's place (before it when it comes from
 *   later in the list, after it when it comes from earlier);
 * - over its own box, nothing changes;
 * - anywhere else, it goes into the nearest gap (`dropSlot`).
 * `boxes` has one entry per element child; null (or an empty box) for a child that is not rendered
 * (`<script>`, `display: none`): such children are not drop targets and offer no gap, but they
 * still count in the indexes, which are the DOM's. The boxes are the layout as it was when the
 * drag began, so that showing the move live does not move the targets under the pointer.
 * Null when no child has a box.
 */
export function dropTarget(boxes: readonly (Box | null)[], from: number, x: number, y: number): DropTarget | null {
  const shown: number[] = []
  boxes.forEach((box, index) => {
    if (box !== null && (box.width > 0 || box.height > 0)) shown.push(index)
  })
  if (shown.length === 0) return null
  const visible = shown.map((index) => boxes[index]!)
  // The last one in document order paints on top where boxes overlap.
  let over: number | null = null
  for (const index of shown) if (contains(boxes[index]!, x, y)) over = index
  if (over === from) return { toIndex: from, over, line: null }
  const offers = slotOffers(visible)
  if (over !== null) {
    const at = shown.indexOf(over)
    const slot = over > from ? at + 1 : at
    return { toIndex: over, over, line: offers.find((offer) => offer.slot === slot)?.line ?? null }
  }
  const nearest = dropSlot(visible, x, y)
  if (nearest === null) return null
  // A gap among the shown children, as a gap among all of them: before the shown child it precedes, or after the last.
  const gap = nearest.slot < shown.length ? shown[nearest.slot]! : shown[shown.length - 1]! + 1
  const toIndex = toIndexOf(gap, from)
  return { toIndex, over: null, line: toIndex === from ? null : nearest.line }
}

/** What a sibling is, to tell whether it and its neighbours are items of one list. */
export interface Signature {
  tag: string
  classes: readonly string[]
}

/**
 * Two elements look like items of one list: the same tag, and a class of their own in common
 * (`card`, `group`). Utility classes (`flex`, `p-4`) say nothing about what an element is, so
 * elements styled only with utilities are items of one list when their classes are the same
 * (as a list rendered from one component is), and elements without classes when the tag is.
 */
export function sameKind(a: Signature, b: Signature): boolean {
  if (a.tag !== b.tag) return false
  const ownA = a.classes.filter((name) => !isUtilityClass(name))
  const ownB = b.classes.filter((name) => !isUtilityClass(name))
  if (ownA.length > 0 || ownB.length > 0) return ownA.some((name) => ownB.includes(name))
  return a.classes.length === b.classes.length && a.classes.every((name) => b.classes.includes(name))
}

/**
 * Which element of a chain is the item a drag should move: `chain` goes from the selected element
 * up through its ancestors, each with its own signature and those of its rendered siblings. The
 * first that has a sibling of its kind (a card among cards, a link among links) wins. Null when
 * none does.
 */
export function listItemIndex(chain: readonly { self: Signature; siblings: readonly Signature[] }[]): number | null {
  for (let index = 0; index < chain.length; index++) {
    const { self, siblings } = chain[index]!
    if (siblings.some((sibling) => sameKind(self, sibling))) return index
  }
  return null
}

const signatureOf = (element: Element): Signature => ({ tag: element.localName, classes: [...element.classList] })
const rendered = (element: Element): boolean => element.getClientRects().length > 0

/**
 * The element the grip moves for a selection: the selection itself when it is one item of a list
 * (a link among links), else the nearest ancestor that is (the card a paragraph sits in, among
 * the other cards); null when nothing up to `up` levels looks like a list item. Never a child of
 * the body (it cannot be moved).
 */
export function itemOf(selected: Element, up = 8): Element | null {
  const chain: { self: Signature; siblings: Signature[] }[] = []
  const elements: Element[] = []
  for (let element: Element | null = selected; element !== null && chain.length < up; element = element.parentElement) {
    const parent: Element | null = element.parentElement
    if (parent === null || parent.localName === 'body' || parent.localName === 'html') break
    const self = element
    const siblings = elementChildren(parent)
      .filter((sibling) => sibling !== self && rendered(sibling))
      .map(signatureOf)
    chain.push({ self: signatureOf(element), siblings })
    elements.push(element)
  }
  const index = listItemIndex(chain)
  return index === null ? null : elements[index]!
}

/** The index the dragged element ends up at when it is dropped into gap `slot`. */
export function toIndexOf(slot: number, fromIndex: number): number {
  return slot > fromIndex ? slot - 1 : slot
}
