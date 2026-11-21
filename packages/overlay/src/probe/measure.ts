/**
 * Answers a `session:measure` request: with every preview switched off, find each item's
 * element again and report what its expectations look like in the page right now.
 *
 * The browser measures; it does not judge. `measureExpectation` returns raw facts in the shape
 * of the engine's `Measured` (packages/engine/src/judge.ts), and the server's judge decides
 * pass, drift or fail with its tolerances. Because the wire format of this milestone still
 * carries `CheckResult`s, `toCheck` fills one from the raw facts with a plain equality
 * comparison and nothing cleverer.
 *
 * Two things the raw facts guarantee:
 *   - nothing reads as measured when it was not: an element that is not found has
 *     `found: false`, a media-scoped expectation outside its query has `mediaMatches: false`;
 *   - `expectedComputed` is the recorded value as the browser computes it ON THIS ELEMENT
 *     (`1.75rem` -> `28px`). It is resolved with a temporary rule in a stylesheet of primp's,
 *     so the DOM is never touched, and only reported when that rule demonstrably takes effect
 *     on the element (a page rule with `!important` could beat it; then it stays undefined).
 *
 * An expectation for a state (`condition.state`) is read with that state forced on the element
 * (states.ts): the page's own rules for the state apply, the pointer and the focus stay where
 * they are. When a stylesheet cannot be read and the forced value is the resting value, a rule
 * in that stylesheet may be the one that is missing: the check is then `not_measurable`, with a
 * note that starts with `STATE_NOT_EMULATED`. A state the dock itself holds forced for its
 * selection is let go for the whole measurement and put back afterwards.
 *
 * An `order` expectation (after a reorder) locates each listed sibling with `locate()` and the
 * moved element (`self`) with the item's own locator. Previews are suspended, which puts every
 * reorder preview's element back where the page has it, so the page's own order is what is
 * read. Wire convention (packages/server/src/verify.ts, `toMeasured`): `expected` is the JSON
 * array of the listed labels in the wanted order, `actual` the JSON array of the labels of those
 * found, in document order; `unresolved` when the moved element was not found or fewer than two
 * listed elements were, else `pass` when the found ones stand in the wanted relative order as
 * children of one parent, else `fail`.
 *
 * Everything happens in one task, so no frame is rendered between switching the previews off
 * and on again.
 */

import { ORDER_NEIGHBOURS_LOST, type Measured as EngineMeasured } from '@primp/engine/judge'
import type { CheckResult, Expectation, Rect } from '@primp/protocol/change'
import type { ClientMessage, ServerMessage } from '@primp/protocol/messages'
import type { Preview } from './preview.ts'
import { longhandsOf } from './properties.ts'
import { locateAmongSiblings } from './order.ts'
import { buildSelector, locate, rectOf, type LocateResult } from './ref.ts'
import { forcedNow, forceState, withState } from './states.ts'
import { ignoreSheet } from './styles.ts'

/**
 * What the engine's judge takes, plus what only matters on the way to the wire: why a state
 * expectation could not be measured.
 */
export type Measured = EngineMeasured & {
  /** `computed` with `condition.state`: the reason the state could not be emulated. The values are then not to be trusted. */
  stateBlocked?: string
}

/** How the note of a check starts when its state could not be emulated; the server looks for exactly this. */
export const STATE_NOT_EMULATED = 'the state could not be emulated'
/** The note of a check that was read with its state forced. */
export const emulatedNote = (state: string): string => `measured with :${state} emulated`

export type MeasureRequest = Extract<ServerMessage, { type: 'session:measure' }>['items']
export type MeasureResults = Extract<ClientMessage, { type: 'session:measured' }>['results']

export interface Measurement {
  visible: boolean
  results: MeasureResults
}

let probeSheet: CSSStyleSheet | undefined

function probe(doc: Document): CSSStyleSheet {
  if (probeSheet === undefined) {
    probeSheet = new (doc.defaultView ?? window).CSSStyleSheet()
    ignoreSheet(probeSheet)
  }
  if (!doc.adoptedStyleSheets.includes(probeSheet)) doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, probeSheet]
  return probeSheet
}

/** Raises the specificity of the temporary rule above anything an author plausibly wrote. */
const BOOST = ':not(#_primp_):not(#_primp_):not(#_primp_)'

/** The value of `property` as one string: the browser's own serialisation, or its longhands spelled out when they do not combine. */
function read(style: CSSStyleDeclaration, property: string, longhands: readonly string[]): string {
  const whole = style.getPropertyValue(property).trim()
  if (whole !== '' || longhands.length === 0) return whole
  return longhands.map((name) => `${name}: ${style.getPropertyValue(name).trim()}`).join('; ')
}

/**
 * The computed value `element` would have with `property: value`, or undefined when the
 * temporary rule cannot be shown to take effect on this element.
 */
export function resolveOn(element: Element, property: string, value: string): string | undefined {
  const sheet = probe(element.ownerDocument)
  const style = getComputedStyle(element)
  const longhands = longhandsOf(property)
  const selector = `:is(${buildSelector(element)})${BOOST}`
  const withRule = (text: string): string | undefined => {
    try {
      // No transition: a computed value read right after a change would otherwise be the transition's start.
      sheet.replaceSync(`${selector} { transition: none !important; ${property}: ${text} !important }`)
      const rule = sheet.cssRules[0] as CSSStyleRule | undefined
      // The browser drops a declaration it does not accept.
      if (rule === undefined || ![property, ...longhands].some((name) => rule.style.getPropertyValue(name) !== '')) return undefined
      return read(style, property, longhands)
    } catch {
      return undefined
    }
  }
  try {
    const plain = read(style, property, longhands)
    const resolved = withRule(value)
    if (resolved === undefined) return undefined
    if (resolved !== plain) return resolved
    // Same as without the rule: only meaningful if the rule is able to change this element at all.
    for (const keyword of ['initial', 'inherit']) {
      const other = withRule(keyword)
      if (other !== undefined && other !== plain) return resolved
    }
    return undefined
  } finally {
    sheet.replaceSync('')
  }
}

/** Whether the element takes space or is painted. */
function isRendered(element: Element): boolean {
  if (element.getClientRects().length === 0) return false
  const style = getComputedStyle(element)
  const rect = element.getBoundingClientRect()
  const painted = style.visibility === 'visible' && style.opacity !== '0'
  return !(rect.width === 0 && rect.height === 0 && (!painted || style.overflow !== 'visible' || element.childNodes.length === 0))
}

function matches(query: string | undefined, view: Window): boolean {
  if (query === undefined || query.trim() === '') return true
  try {
    return view.matchMedia(query).matches
  } catch {
    return false
  }
}

/**
 * Raw facts about one expectation. `target` is the item's element as `locate` found it; a
 * `no-move` and an `unchanged` expectation carry their own locator and are looked up here.
 */
export function measureExpectation(target: LocateResult, expectation: Expectation, doc: Document = document): Measured {
  const view = doc.defaultView ?? window
  if (expectation.type === 'no-move') {
    const other = locate(expectation.locator, { document: doc })
    return other.element === null ? { found: false, locatorConfidence: other.confidence } : { found: true, locatorConfidence: other.confidence, rectNow: rectOf(other.element) }
  }
  if (expectation.type === 'unchanged') {
    // A bystander: what it computes to now, next to what was recorded for it. Nothing to resolve: the recorded value was computed too.
    const other = locate(expectation.locator, { document: doc })
    if (other.element === null) return { found: false, locatorConfidence: other.confidence }
    const actual = read(getComputedStyle(other.element), expectation.property, longhandsOf(expectation.property))
    return { found: true, locatorConfidence: other.confidence, actual, expectedComputed: expectation.value }
  }
  const element = target.element
  const base = { found: element !== null, locatorConfidence: target.confidence }
  if (expectation.type === 'order') return measureOrder(target, expectation, doc)
  if (expectation.type === 'computed') {
    const mediaMatches = matches(expectation.condition.media, view)
    if (element === null || !mediaMatches) return { ...base, mediaMatches }
    const longhands = longhandsOf(expectation.property)
    const recorded = expectation.value.trim()
    const measureNow = (): { actual: string; expectedComputed: string | undefined } => {
      const actual = read(getComputedStyle(element), expectation.property, longhands)
      // A recorded value that already reads the same needs no resolving.
      return { actual, expectedComputed: actual === recorded ? recorded : resolveOn(element, expectation.property, recorded) }
    }
    const state = expectation.condition.state
    if (state === undefined) {
      const { actual, expectedComputed } = measureNow()
      return expectedComputed === undefined ? { ...base, mediaMatches, actual } : { ...base, mediaMatches, actual, expectedComputed }
    }
    // In a state: the value at rest first (to tell "the state changes nothing" from "the state was not reached"), then the same with the state forced.
    let blocked: string | undefined
    let inState: { actual: string; expectedComputed: string | undefined } | undefined
    try {
      const resting = unforced(() => read(getComputedStyle(element), expectation.property, longhands))
      inState = withState(element, state, (forced) => {
        const now = measureNow()
        if (forced.unreadable > 0 && now.actual === resting) {
          blocked = `${forced.unreadable} ${forced.unreadable === 1 ? 'stylesheet' : 'stylesheets'} from another origin cannot be read`
        }
        return now
      })
    } catch (error) {
      blocked = `forcing :${state} failed (${error instanceof Error ? error.message : String(error)})`.slice(0, 200)
    }
    const out: Measured = { ...base, mediaMatches }
    if (inState !== undefined) {
      out.actual = inState.actual
      if (inState.expectedComputed !== undefined) out.expectedComputed = inState.expectedComputed
    }
    if (blocked !== undefined) out.stateBlocked = blocked
    return out
  }
  // absent / hidden
  if (element !== null) return { ...base, present: true, rendered: isRendered(element) }
  // Two candidates too close to call: the element may well be there.
  return target.reason === 'ambiguous' ? base : { ...base, present: false }
}

/**
 * The order of a moved element and its listed siblings as the page has them. `found` is about the
 * moved element; `order.actual` lists the labels of the elements found, in document order. An
 * element found for two entries (siblings that look alike) counts for the first only.
 *
 * Every entry, the moved element too (its locator is the item's target locator), is found again
 * WITHOUT its position among its siblings (order.ts `siblingPicker`): the position is what is
 * being measured, and recognising an element by it would make the check agree with itself.
 * `target` (the item's element as `measure` located it) is not used for that reason.
 */
export function measureOrder(target: LocateResult, expectation: Extract<Expectation, { type: 'order' }>, doc: Document = document): Measured {
  const seen = new Set<Element>()
  const found: { wanted: number; label: string; element: Element }[] = []
  expectation.siblings.forEach((sibling, wanted) => {
    let element: Element | null
    try {
      element = locateAmongSiblings(sibling.locator, doc).element
    } catch {
      element = null
    }
    if (element === null || seen.has(element)) return
    seen.add(element)
    found.push({ wanted, label: sibling.label, element })
  })
  found.sort((a, b) => (a.element === b.element ? 0 : a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
  const parent = found[0]?.element.parentElement ?? null
  const oneParent = parent !== null && found.every((entry) => entry.element.parentElement === parent)
  const inOrder = oneParent && found.every((entry, index) => index === 0 || found[index - 1]!.wanted < entry.wanted)
  const selfFound = found.some((entry) => expectation.siblings[entry.wanted]?.self === true)
  return { found: selfFound, locatorConfidence: target.confidence, order: { actual: found.map((entry) => entry.label), inOrder } }
}

/** Runs `read` with nothing forced, then forces again what was (the same element in the same state). */
function unforced<T>(read: () => T): T {
  const held = forcedNow()
  if (held === undefined) return read()
  const { element, state } = held
  held.release()
  try {
    return read()
  } finally {
    if (element.isConnected) forceState(element, state)
  }
}

const rectJson = (rect: Rect): string => JSON.stringify({ x: rect.x, y: rect.y, w: rect.w, h: rect.h })

/** A `CheckResult` from raw facts by plain equality; the server's judge refines it. */
export function toCheck(expectation: Expectation, measured: Measured, view: Window = window): CheckResult {
  switch (expectation.type) {
    case 'computed': {
      const expected = measured.expectedComputed ?? expectation.value
      if (measured.mediaMatches === false) {
        return { expectation, status: 'not_measurable', expected, actual: '', note: `the viewport (${view.innerWidth}x${view.innerHeight}) does not match @media ${expectation.condition.media}` }
      }
      if (!measured.found) return { expectation, status: 'unresolved', expected, actual: '', note: 'the element was not found again' }
      const state = expectation.condition.state
      if (state !== undefined && measured.stateBlocked !== undefined) {
        return { expectation, status: 'not_measurable', expected, actual: measured.actual ?? '', note: `${STATE_NOT_EMULATED}: ${measured.stateBlocked}` }
      }
      if (measured.actual === undefined) return { expectation, status: 'unresolved', expected, actual: '', note: 'the element was not found again' }
      const notes: string[] = []
      if (state !== undefined) notes.push(emulatedNote(state))
      if (measured.expectedComputed === undefined) notes.push('the expected value could not be resolved on this element; compared as recorded')
      return { expectation, status: measured.actual === expected ? 'pass' : 'fail', expected, actual: measured.actual, ...(notes.length === 0 ? {} : { note: notes.join('; ') }) }
    }
    case 'absent':
    case 'hidden': {
      const actual = measured.present === true ? (measured.rendered === false ? 'hidden' : 'rendered') : 'absent'
      if (measured.present === undefined) return { expectation, status: 'unresolved', expected: expectation.type, actual: '', note: 'more than one element could be the recorded one' }
      if (expectation.type === 'hidden' && !measured.present) return { expectation, status: 'unresolved', expected: 'hidden', actual, note: 'the element was not found again' }
      return { expectation, status: actual === expectation.type ? 'pass' : 'fail', expected: expectation.type, actual }
    }
    case 'no-move': {
      const expected = rectJson(expectation.rect)
      const now = measured.rectNow
      if (!measured.found || now === undefined) return { expectation, status: 'unresolved', expected, actual: '', note: `${expectation.label} was not found again` }
      const delta = Math.max(Math.abs(now.x - expectation.rect.x), Math.abs(now.y - expectation.rect.y), Math.abs(now.w - expectation.rect.w), Math.abs(now.h - expectation.rect.h))
      return { expectation, status: delta <= expectation.tolerancePx ? 'pass' : 'fail', expected, actual: rectJson(now), delta }
    }
    case 'unchanged': {
      const expected = measured.expectedComputed ?? expectation.value
      if (!measured.found || measured.actual === undefined) return { expectation, status: 'unresolved', expected, actual: '', note: `${expectation.label} was not found again` }
      return { expectation, status: measured.actual === expected ? 'pass' : 'fail', expected, actual: measured.actual }
    }
    case 'order': {
      const expected = JSON.stringify(expectation.siblings.map((sibling) => sibling.label))
      const actual = JSON.stringify(measured.order?.actual ?? [])
      if (!measured.found || measured.order === undefined) return { expectation, status: 'unresolved', expected, actual, note: 'the moved element was not found again' }
      if (measured.order.actual.length < 2) return { expectation, status: 'unresolved', expected, actual, note: ORDER_NEIGHBOURS_LOST }
      return { expectation, status: measured.order.inOrder === true ? 'pass' : 'fail', expected, actual }
    }
  }
}

/** Measures every item of a request. Previews are off while it runs and back on when it returns. */
export function measure(items: MeasureRequest, preview: Pick<Preview, 'suspend' | 'resume'>, doc: Document = document): Measurement {
  const view = doc.defaultView ?? window
  preview.suspend('measure: previews off')
  // A state the dock holds for its selection would be read as the resting style of that element.
  const held = forcedNow()
  const holding = held === undefined ? undefined : { element: held.element, state: held.state }
  held?.release()
  try {
    const results: MeasureResults = items.map((item) => {
      let target: LocateResult
      try {
        target = locate(item.locator, { document: doc })
      } catch {
        target = { element: null, confidence: 0, candidates: 0, reason: 'ambiguous' }
      }
      return {
        itemId: item.itemId,
        locatorConfidence: target.confidence,
        found: target.element !== null,
        checks: item.expect.map((expectation) => toCheck(expectation, measureExpectation(target, expectation, doc), view)),
      }
    })
    return { visible: doc.visibilityState === 'visible', results }
  } finally {
    if (holding !== undefined && holding.element.isConnected) forceState(holding.element, holding.state)
    preview.resume('measure: previews back on')
  }
}
