/**
 * Bystanders of a style edit: elements that the rule behind the previous value styles too, but
 * that the edit is not meant for. An agent that implements the edit by changing that rule in
 * place changes them as well, and nothing measured on the edited element would show it.
 *
 * `findBystanders` counts them and picks up to three to be named in the prompt and measured
 * again at verification; `describeBystander` records one with the values it has now.
 *
 * Reads the DOM and writes nothing.
 */

import type { Bystander } from '@reglet/protocol/change'
import { buildSelector, instancesOf, labelOf, locatorOf } from './ref.ts'
import { OVERLAY_ROOT_ATTR } from './snapshot.ts'
import { splitSelectorList, withoutStates } from './specificity.ts'

export const MAX_BYSTANDERS = 3

/**
 * The parts of a rule's selector list as they match at rest: without pseudo-elements and
 * without `:hover` and the like, so that an element the rule only styles in a state or through
 * its `::before` still counts as styled by it. A part that is nothing but such a pseudo
 * (`::selection`) would match every element and is left out. Pure.
 */
export function restingSelectors(ruleSelector: string): string[] {
  const out: string[] = []
  for (const part of splitSelectorList(ruleSelector)) {
    const resting = withoutStates(part)
    if (resting === '' || (resting === '*' && part !== '*') || out.includes(resting)) continue
    out.push(resting)
  }
  return out
}

export interface BystanderSearch {
  /** Every rendered element outside the change that the rule matches. */
  count: number
  /** At most `MAX_BYSTANDERS` of them, the most telling first. */
  elements: Element[]
}

const classKey = (el: Element): string => [...el.classList].sort().join(' ')

/**
 * The elements matched by `ruleSelector` that are outside the change, are rendered and are not
 * the dock's. Null when no part of the selector can be queried, which is "not known", not "none".
 *
 * Outside the change means, for an edit of `instance` scope: every element but the target, its
 * other instances included. For `all-instances`: every element but the target, its instances
 * (the ones the preview styles, see `attach` in preview.ts) and its twins, which are elements
 * with the target's tag and exactly its classes that sit elsewhere in the page (the same button
 * in the hero and in a card). A twin is the same kind of thing to any rule written by class, so
 * an edit "for all of them" that reaches it is not what a bystander check is there to catch.
 *
 * Chosen first are elements in or near the viewport (within one viewport of it), and among
 * those the ones whose class list differs from the target's: a different kind of element says
 * more about the rule being shared than a twin of the target does. Document order decides the rest.
 */
export function findBystanders(ruleSelector: string, target: Element, scope: 'instance' | 'all-instances'): BystanderSearch | null {
  const doc = target.ownerDocument
  const view = doc.defaultView ?? window
  // Validity is tested per part on an empty fragment: one part this browser cannot parse must not lose the others.
  const probe = doc.createDocumentFragment()
  const parts = restingSelectors(ruleSelector).filter((part) => {
    try {
      probe.querySelector(part)
      return true
    } catch {
      return false
    }
  })
  if (parts.length === 0) return null
  let matched: NodeListOf<Element>
  try {
    matched = doc.querySelectorAll(parts.join(', '))
  } catch {
    return null
  }

  const all = scope === 'all-instances'
  const own = new Set<Element>(all ? instancesOf(target) : []).add(target)
  const targetClasses = classKey(target)
  const w = view.innerWidth
  const h = view.innerHeight
  /** 0: near the viewport, other classes. 1: near, same classes. 2 and 3: the same, far away. */
  const ranked: Element[][] = [[], [], [], []]
  let count = 0
  for (const el of matched) {
    if (own.has(el) || el.closest(`[${OVERLAY_ROOT_ATTR}]`) !== null || el.getClientRects().length === 0) continue
    const twin = classKey(el) === targetClasses
    if (all && twin && targetClasses !== '' && el.localName === target.localName) continue
    count++
    // Three of the best kind are found: the rest only needs counting.
    if (ranked[0]!.length >= MAX_BYSTANDERS) continue
    const r = el.getBoundingClientRect()
    const near = r.bottom > -h && r.top < 2 * h && r.right > -w && r.left < 2 * w
    const bucket = ranked[(near ? 0 : 2) + (twin ? 1 : 0)]!
    if (bucket.length < MAX_BYSTANDERS) bucket.push(el)
  }
  return { count, elements: ranked.flat().slice(0, MAX_BYSTANDERS) }
}

/** Computed values of `properties` on `el`, as `getComputedStyle` gives them now. */
export function valuesOf(el: Element, properties: readonly string[]): Record<string, string> {
  const style = getComputedStyle(el)
  const out: Record<string, string> = {}
  for (const name of properties) out[name] = style.getPropertyValue(name).trim()
  return out
}

/** One bystander as it is recorded: named and locatable like a `Ref`, with the values it must keep. */
export function describeBystander(el: Element, properties: readonly string[]): Bystander {
  return { label: labelOf(el), selector: buildSelector(el), locator: locatorOf(el), values: valuesOf(el, properties) }
}
