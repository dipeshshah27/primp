/**
 * The size ledger and the mutation log: the hook's evidence about what CAUSED
 * a layout shift.
 *
 * A layout-shift entry lists what moved, never what made it move: the image
 * that arrived, the heading that re-wrapped, the banner that was inserted all
 * grow in place. So the hook keeps the last border-box size of the page's
 * elements (one ResizeObserver) and records every change with the old and new
 * size. "This element grew by 267 px in the frame in which that block moved
 * down 267 px" is the fact the attributor works from.
 *
 * A MutationObserver started at document start feeds the ledger (every element
 * is put under observation as it appears) and, from the first frame on,
 * records insertions, removals and attribute changes.
 *
 * Reads only. Nothing here writes to the DOM.
 */

import type { ResizeRecord, ShiftMutationRecord, ShiftSize } from '../../../protocol/src/shift.ts'
import { describe, isMedia, MEDIA_SELECTOR, mediaHints, rectOf, styleOf, uidOf } from './describe.ts'
import { snapshotFonts } from './fonts.ts'
import { cost, frame, now, OWN_ATTR, ring, round, timed } from './state.ts'

/** Elements under size observation at most. Replaced elements (images, video, frames) are always observed. */
export const TRACK_CAP = 2000
/** Resize records per callback that get a rectangle and computed style; a window resize changes thousands at once. */
const ENRICH_PER_CALLBACK = 40
/** Mutation records kept per observer callback; the rest are counted on the last one. */
const MUTATIONS_PER_CALLBACK = 30

export const resizes = ring<ResizeRecord>(400)
export const mutations = ring<ShiftMutationRecord>(300)

/** Last border-box size per observed element; null until the first measurement. */
const sizes = new WeakMap<Element, ShiftSize | null>()
/** Elements inserted after the first frame whose first measurement is news ("appeared with this size"). */
const late = new WeakSet<Element>()
/** Sizes of the elements removed in the current mutation batch: a node that is only being moved keeps its history. */
const moved = new Map<Element, ShiftSize | null>()
/** Stack of the DOM call per mutated parent, filled by the optional stack capture. */
export const pendingStacks = new Map<Node, string>()

/** Never-rendered and plain inline elements: no box of their own worth a slot. */
const SKIP_TAGS = new Set(
  'script style link meta head title base template noscript br wbr span b i em strong small code abbr sub sup u s mark option source track'.split(' '),
)

export function lastSize(element: Element): ShiftSize | undefined {
  return sizes.get(element) ?? undefined
}

let resizeObserver: ResizeObserver | undefined

function observe(element: Element, isLate: boolean): void {
  if (sizes.has(element)) return
  if (!isMedia(element)) {
    if (SKIP_TAGS.has(element.localName) && !isLate) return
    if (cost.tracked >= TRACK_CAP) {
      cost.untracked++
      return
    }
  }
  const known = moved.get(element)
  sizes.set(element, known ?? null)
  cost.tracked++
  if (isLate && known == null) late.add(element)
  resizeObserver?.observe(element)
}

/** Puts an added element and what is inside it under observation. */
function track(root: Element, isLate: boolean): void {
  if (sizes.has(root)) return
  const full = cost.tracked >= TRACK_CAP
  observe(root, isLate)
  if (root.firstElementChild === null) return
  // While the document is being parsed every node arrives in a record of its own; a subtree
  // attached in one call (a framework render, innerHTML) only reports its root.
  if (full && document.readyState === 'loading') return
  const all = root.querySelectorAll('*')
  let index = 0
  for (; index < all.length && cost.tracked < TRACK_CAP; index++) observe(all[index] as Element, false)
  if (index === all.length) return
  // Over the cap: the rest is only counted, except replaced elements, which are always watched.
  cost.untracked += all.length - index
  for (const element of root.querySelectorAll(MEDIA_SELECTOR)) observe(element, false)
}

function release(element: Element): void {
  const size = sizes.get(element)
  if (size === undefined) return
  sizes.delete(element)
  moved.set(element, size)
  cost.tracked--
  resizeObserver?.unobserve(element)
}

/** Gives back the slots of a removed subtree, so a page that replaces its content keeps being watched. */
function untrack(root: Element): void {
  release(root)
  if (root.firstElementChild !== null) for (const element of root.querySelectorAll('*')) release(element)
}

function onResize(entries: ResizeObserverEntry[]): void {
  cost.resizeCallbacks++
  const t = now()
  // A face that this frame's layout used is `loaded` by now; noting it here dates it to the frame.
  if (frame.seen) snapshotFonts()
  let enriched = 0
  for (const entry of entries) {
    const element = entry.target
    const box = entry.borderBoxSize[0]
    if (box === undefined) continue
    const after: ShiftSize = { w: round(box.inlineSize), h: round(box.blockSize) }
    const before = sizes.get(element) ?? null
    sizes.set(element, after)
    if (!frame.seen || !element.isConnected) continue
    if (before === null) {
      if (!late.has(element)) continue
      late.delete(element)
    } else if (before.w === after.w && before.h === after.h) continue
    const record: ResizeRecord = { t, node: describe(element), before, after }
    if (enriched++ < ENRICH_PER_CALLBACK) {
      record.rect = rectOf(element.getBoundingClientRect())
      const own = (record.style = styleOf(element, true)).fontFamily
      if (isMedia(element)) record.media = mediaHints(element)
      // Text in another font than its block sits in inline children, which get no size of their own
      // here (a display-face `span`, an icon `i`): note their fonts on the block, or a web font
      // swapping in there cannot be linked to the block that re-wrapped. Only for an element that
      // changed size (a new one did not re-wrap), first six children; a child with no height on
      // record is inline (or not rendered).
      for (let child = before && element.firstElementChild, n = 0, font; child && n < 6; n++, child = child.nextElementSibling) {
        if (!sizes.get(child)?.h && (font = getComputedStyle(child).fontFamily) !== own) (record.inlineFonts ??= []).push(font)
      }
    }
    resizes.push(record)
  }
}

const isOwn = (node: Node): boolean => node.nodeType === 1 && (node as Element).hasAttribute(OWN_ATTR)
const clip = (value: string | null): string | undefined => (value === null ? undefined : value.slice(0, 120))

function onMutations(records: MutationRecord[]): void {
  cost.mutationCallbacks++
  const t = now()
  const recording = frame.seen
  let kept = 0
  let last: ShiftMutationRecord | undefined
  /** Whether one more record fits this batch. Asked BEFORE a record is built: describing a node is the expensive part. */
  const room = (): boolean => {
    if (!recording) return false
    if (kept < MUTATIONS_PER_CALLBACK) return true
    if (last !== undefined) last.more = (last.more ?? 0) + 1
    return false
  }
  const keep = (record: ShiftMutationRecord): void => {
    kept++
    mutations.push((last = record))
  }
  for (const record of records) {
    const target = record.target
    if (record.type === 'childList') {
      // Removals first: a node that is moved appears in both lists of its batch.
      for (const node of record.removedNodes) {
        if (node.nodeType !== 1 || isOwn(node)) continue
        const size = lastSize(node as Element)
        untrack(node as Element)
        if (room()) keep({ t, kind: 'remove', node: describe(node), parent: describe(target), lastSize: size })
      }
      for (const node of record.addedNodes) {
        if (node.nodeType === 1) {
          if (isOwn(node)) continue
          track(node as Element, recording)
          if (!room()) continue
          keep({ t, kind: 'add', node: describe(node), parent: describe(target), stack: pendingStacks.get(target) })
        } else if (node.nodeType === 3 && target.nodeType === 1 && room()) {
          keep({ t, kind: 'text', node: describe(target) })
        }
      }
    } else if (recording && !isOwn(target)) {
      if (record.type === 'attributes') {
        const name = record.attributeName ?? ''
        // The same attribute of the same element again (an animation writing `style` every frame).
        if (last !== undefined && last.kind === 'attr' && last.attr === name && last.node.uid === uidOf(target)) continue
        if (!room()) continue
        keep({
          t,
          kind: 'attr',
          node: describe(target),
          attr: name,
          oldValue: clip(record.oldValue),
          value: clip((target as Element).getAttribute(name)),
          stack: pendingStacks.get(target),
        })
      } else if (target.parentElement !== null && room()) {
        keep({ t, kind: 'text', node: describe(target.parentElement) })
      }
    }
  }
  pendingStacks.clear()
  moved.clear()
}

export function installLedger(): void {
  resizeObserver = new ResizeObserver(timed(onResize, 'resizeMs'))
  new MutationObserver(timed(onMutations, 'mutationMs')).observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeOldValue: true,
    characterData: true,
  })
  // Whatever exists already (normally just <html> and <head>).
  track(document.documentElement, false)
}
