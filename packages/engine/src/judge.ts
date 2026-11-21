/**
 * The expectation judge: turns what the probe measured after an agent's edit into a status per
 * check (`judgeCheck`) and per item (`judgeItem`).
 *
 * Pure: no DOM, no Node.
 *
 * COMPUTED VALUES (`computed` expectations). The target is `measured.expectedComputed` when the
 * probe re-resolved the value in the page as it is now, otherwise the recorded value. Values are
 * compared leaf by leaf (see `units.ts`):
 *
 *   pass    every leaf equal: lengths within 0.5px, numbers and percentages within 0.01,
 *           colours at a distance below 1 (CIEDE2000), keywords and strings identical.
 *   fail    with note `unchanged` when the value is not the target but still equals `before`.
 *   drift   not equal, but every leaf that differs landed NEAR its target:
 *             length / percentage / number, with a known `before`: it moved from `before` in
 *               the direction of the target, ended closer to the target than `before` was, and
 *               the remaining error is at most max(floor, 15% of the requested change). The
 *               floor is 2px for lengths, 1 point for percentages and 0 for plain numbers.
 *               12px -> 17px landing on 16px is drift (error 1, allowed 2); 12px -> 16px landing
 *               on 13px is fail (error 3, allowed 2); 12px -> 13px landing on 14px is fail (no
 *               closer than it started); 100px -> 200px landing on 192px is drift (8 <= 15).
 *             the same kinds without a usable `before` (not given, or of another shape): the
 *               error is at most the floor.
 *             colour: distance to the target at most 6 (about half a step of a typical design
 *               palette) and, when `before` is known, smaller than the distance from `before`
 *               to the target.
 *             font-family: the first family is the one asked for (only the fallbacks differ).
 *           A keyword, string or structure that differs is never near.
 *   fail    everything else.
 *
 * OTHER CHECKS
 *   not found                   `unresolved` for computed, hidden and no-move checks.
 *   media query does not match  `not_measurable` (checked after "found").
 *   absent                      pass when the element is not in the document. Present and
 *                               rendered: fail. Present but not rendered: drift ("hidden rather
 *                               than removed").
 *   hidden                      found and not rendered: pass. Found and rendered: fail. Not
 *                               found: drift ("removed rather than hidden") when the probe says
 *                               `present: false`, otherwise unresolved.
 *                               Removing and hiding look the same on the page, so getting one
 *                               for the other is reported as drift, not as fail and not as pass:
 *                               it may be deliberate (conditional rendering is how many projects
 *                               hide things), and the person decides.
 *   no-move                     pass when x, y, width and height are all within `tolerancePx`
 *                               of the recorded rectangle, else fail; `delta` is the largest of
 *                               the four differences.
 *   unchanged                   a bystander: an element the edited rule also styles, which was
 *                               not part of the change. Found, and its computed value equal to
 *                               the recorded one (same comparison and tolerances as above):
 *                               pass. Found and different: fail, with the note `changed from A
 *                               to B although it was not part of this edit`; near is not good
 *                               enough here, so there is no drift. Not found: PASS, with the
 *                               note `not checked: the element could not be found again`. A
 *                               bystander is only a witness: when it has left the page (another
 *                               edit removed it, the list re-rendered) that says nothing
 *                               against the change, and it must not block it. This is the one
 *                               check that can pass without a measurement, and it always says
 *                               so in its note and in the item's hint.
 *
 * ITEMS (`judgeItem`), first match wins:
 *   1. no_browser          no tab with the dock is connected.
 *   2. tab_hidden          the tab was not visible.
 *   3. build_error         settle status `build_error`.
 *   4. no_update_observed  settle status `no_update_observed` and not every check passes. When
 *                          every check already passes (and there is at least one) the item
 *                          passes: the page is as asked, whoever made it so.
 *   5. unresolved          any check is unresolved.
 *   6. fail                any check fails.
 *   7. drift               any check drifted.
 *   8. not_measurable      any check could not be measured, or there are no checks at all, or
 *                          nothing but bystanders that could not be found.
 *   9. pass                at least one check, and every check passes.
 * So `pass` is never reported for a change of which nothing was measured, and `not_measurable`
 * means exactly: nothing was found wrong, and at least one check is still open.
 */

import type { ChangeItem, CheckResult, Expectation, Rect, VerificationResult, VerificationStatus } from '@reglet/protocol/change'
import { colorDistance } from './color.ts'
import { code, num, oneLine, signedPx, truncate } from './text.ts'
import { TOLERANCE, alignLeaves, compareComputed, computedEqual } from './units.ts'
import type { Comparison, Leaf, LeafDiff } from './units.ts'

/** What "near" means for drift; see the header. */
export const DRIFT = {
  lengthFloorPx: 2,
  percentFloor: 1,
  ratio: 0.15,
  colorMax: 6,
} as const

/** What the probe found for one expectation. */
export interface Measured {
  /** The element the check is about was re-found with confidence. */
  found: boolean
  locatorConfidence: number
  /** `computed`, `unchanged`: the computed value now. */
  actual?: string
  /** `computed`: the recorded authored value resolved in the page as it is now, when the probe could do that. `unchanged`: the recorded value. */
  expectedComputed?: string
  /** `no-move`: the element's rectangle now, in document coordinates. */
  rectNow?: Rect
  /** `computed`: whether the expectation's media query matches now. */
  mediaMatches?: boolean
  /** `absent` / `hidden`: whether the element is in the document at all. False means the probe is sure it is gone. */
  present?: boolean
  /** `absent` / `hidden`: whether it takes space or is painted. */
  rendered?: boolean
}

export interface CheckContext {
  /** `computed`: the value before the user's edit (`item.before.computed`, or the longhand's `before`). */
  before?: string
}

/** The `before` value to pass as context for one of an item's expectations. Only `computed` checks have one: a bystander's recorded value is its target. */
export function beforeValueFor(item: ChangeItem, expectation: Expectation): string | undefined {
  if (item.kind !== 'style' || expectation.type !== 'computed') return undefined
  const longhand = item.longhands?.[expectation.property]
  if (longhand !== undefined) return longhand.before
  return expectation.property === item.property ? item.before.computed : undefined
}

// ---------------------------------------------------------------------------
// Rectangles in words
// ---------------------------------------------------------------------------

export function rectText(rect: Rect): string {
  return `x ${num(rect.x)}, y ${num(rect.y)}, ${num(rect.w)}x${num(rect.h)}`
}

/**
 * How a box changed, for a person: `moved 48px down`, `moved 8px right and 4px up`,
 * `24px taller`, `moved 48px down, 10px narrower`. `did not change` when nothing differs by
 * more than `minPx`.
 */
export function describeRectChange(before: Rect, after: Rect, minPx = 0.5): string {
  const dx = after.x - before.x
  const dy = after.y - before.y
  const dw = after.w - before.w
  const dh = after.h - before.h
  const moves: string[] = []
  if (Math.abs(dy) > minPx) moves.push(`${num(Math.abs(dy))}px ${dy > 0 ? 'down' : 'up'}`)
  if (Math.abs(dx) > minPx) moves.push(`${num(Math.abs(dx))}px ${dx > 0 ? 'right' : 'left'}`)
  const parts: string[] = []
  if (moves.length > 0) parts.push(`moved ${moves.join(' and ')}`)
  if (Math.abs(dw) > minPx) parts.push(`${num(Math.abs(dw))}px ${dw > 0 ? 'wider' : 'narrower'}`)
  if (Math.abs(dh) > minPx) parts.push(`${num(Math.abs(dh))}px ${dh > 0 ? 'taller' : 'shorter'}`)
  return parts.length === 0 ? 'did not change' : parts.join(', ')
}

// ---------------------------------------------------------------------------
// One check
// ---------------------------------------------------------------------------

const NOT_FOUND = 'element not found'
const NOT_MEASURED = 'not measured'
/** Note of a bystander check that passes because there was nothing to measure; see the header. */
export const BYSTANDER_NOT_CHECKED = 'not checked: the element could not be found again'

const roundDelta = (n: number): number => Math.round(n * 1000) / 1000

/** The one number that best says how far off a value is: the largest length error, else colour, else any other number. */
function primaryDelta(comparison: Comparison): number | undefined {
  const withDelta = comparison.leaves.filter((leaf) => leaf.delta !== undefined && Number.isFinite(leaf.delta))
  const unequal = withDelta.filter((leaf) => !leaf.equal)
  const pool = unequal.length > 0 ? unequal : withDelta
  const largest = (kinds: readonly string[]): LeafDiff | undefined =>
    pool.filter((leaf) => kinds.includes(leaf.kind)).sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0))[0]
  const chosen = largest(['length']) ?? largest(['color']) ?? largest(['number', 'percent', 'dimension'])
  return chosen?.delta === undefined ? undefined : roundDelta(chosen.delta)
}

function numericNear(kind: 'length' | 'percent' | 'number' | 'dimension', expected: number, actual: number, before: number | undefined): boolean {
  const floor = kind === 'length' ? DRIFT.lengthFloorPx : kind === 'percent' ? DRIFT.percentFloor : 0
  const tolerance = kind === 'length' ? TOLERANCE.lengthPx : TOLERANCE.number
  const error = Math.abs(actual - expected)
  if (before === undefined) return error <= floor
  const change = Math.abs(expected - before)
  // This leaf was not meant to change: only the floor applies.
  if (change <= tolerance) return error <= floor
  const towards = (actual - before) * (expected - before) > 0
  return towards && error < change && error <= Math.max(floor, DRIFT.ratio * change)
}

function leafNear(diff: LeafDiff, before: Leaf | undefined): boolean {
  const { expected, actual } = diff
  switch (diff.kind) {
    case 'length':
    case 'percent':
    case 'number':
    case 'dimension': {
      if (expected.num === undefined || actual.num === undefined) return false
      if (diff.kind === 'dimension' && expected.unit !== actual.unit) return false
      const usable = before !== undefined && before.kind === diff.kind && before.unit === expected.unit ? before.num : undefined
      return numericNear(diff.kind, expected.num, actual.num, usable)
    }
    case 'color': {
      if (expected.color === undefined || diff.delta === undefined || diff.delta > DRIFT.colorMax) return false
      if (before?.color === undefined) return true
      return diff.delta < colorDistance(before.color, expected.color)
    }
    case 'font-family':
      return expected.families?.[0] !== undefined && expected.families[0] === actual.families?.[0]
    default:
      return false
  }
}

/** Whether `actual` is not the target but close enough to it to be a deliberate token choice; see the header. */
export function isNear(target: string, actual: string, before: string | undefined, property?: string): boolean {
  const comparison = compareComputed(target, actual, property)
  if (!comparison.sameShape || comparison.equal) return false
  const beforePairs = before === undefined ? null : alignLeaves(target, before, property)
  return comparison.leaves.every((leaf, index) => leaf.equal || leafNear(leaf, beforePairs?.[index]?.[1]))
}

function judgeComputed(expectation: Extract<Expectation, { type: 'computed' }>, measured: Measured, context: CheckContext): CheckResult {
  const target = measured.expectedComputed ?? expectation.value
  const base = { expectation, expected: target }
  if (!measured.found) return { ...base, status: 'unresolved', actual: NOT_FOUND }
  const media = expectation.condition.media
  if (media !== undefined && measured.mediaMatches === false) {
    return { ...base, status: 'not_measurable', actual: measured.actual ?? NOT_MEASURED, note: `the viewport does not match @media ${oneLine(media)}` }
  }
  if (measured.actual === undefined) return { ...base, status: 'not_measurable', actual: NOT_MEASURED, note: 'no computed value was read' }

  const actual = measured.actual
  const comparison = compareComputed(target, actual, expectation.property)
  const delta = primaryDelta(comparison)
  const withDelta = delta === undefined ? {} : { delta }
  if (comparison.equal) {
    const resolved = target !== expectation.value ? { note: `the recorded value ${oneLine(expectation.value)} resolves to ${oneLine(target)} in the page as it is now` } : {}
    return { ...base, status: 'pass', actual, ...withDelta, ...resolved }
  }
  if (context.before !== undefined && computedEqual(context.before, actual, expectation.property)) {
    return { ...base, status: 'fail', actual, ...withDelta, note: 'unchanged' }
  }
  if (isNear(target, actual, context.before, expectation.property)) {
    return { ...base, status: 'drift', actual, ...withDelta, note: 'near the target' }
  }
  return { ...base, status: 'fail', actual, ...withDelta }
}

/** Judges one expectation against what was measured. */
export function judgeCheck(expectation: Expectation, measured: Measured, context: CheckContext = {}): CheckResult {
  switch (expectation.type) {
    case 'computed':
      return judgeComputed(expectation, measured, context)
    case 'absent': {
      const expected = 'not in the document'
      const present = measured.present ?? measured.found
      if (!present) return { expectation, status: 'pass', expected, actual: expected }
      if (measured.rendered === false) {
        return { expectation, status: 'drift', expected, actual: 'in the document, not displayed', note: 'hidden rather than removed' }
      }
      return { expectation, status: 'fail', expected, actual: 'still in the document' }
    }
    case 'hidden': {
      const expected = 'in the document, not displayed'
      if (measured.found) {
        if (measured.rendered === false) return { expectation, status: 'pass', expected, actual: expected }
        if (measured.rendered === true) return { expectation, status: 'fail', expected, actual: 'still displayed' }
        return { expectation, status: 'not_measurable', expected, actual: NOT_MEASURED, note: 'whether the element is displayed was not read' }
      }
      if (measured.present === false) {
        return { expectation, status: 'drift', expected, actual: 'not in the document', note: 'removed rather than hidden' }
      }
      return { expectation, status: 'unresolved', expected, actual: NOT_FOUND }
    }
    case 'no-move': {
      const expected = rectText(expectation.rect)
      if (!measured.found) return { expectation, status: 'unresolved', expected, actual: NOT_FOUND }
      const now = measured.rectNow
      if (now === undefined) return { expectation, status: 'not_measurable', expected, actual: NOT_MEASURED, note: 'its position was not read' }
      const delta = roundDelta(
        Math.max(
          Math.abs(now.x - expectation.rect.x),
          Math.abs(now.y - expectation.rect.y),
          Math.abs(now.w - expectation.rect.w),
          Math.abs(now.h - expectation.rect.h),
        ),
      )
      if (delta <= expectation.tolerancePx) return { expectation, status: 'pass', expected, actual: rectText(now), delta }
      return { expectation, status: 'fail', expected, actual: rectText(now), delta, note: describeRectChange(expectation.rect, now) }
    }
    case 'unchanged': {
      const expected = measured.expectedComputed ?? expectation.value
      if (!measured.found) return { expectation, status: 'pass', expected, actual: NOT_FOUND, note: BYSTANDER_NOT_CHECKED }
      const actual = measured.actual
      if (actual === undefined) return { expectation, status: 'not_measurable', expected, actual: NOT_MEASURED, note: 'no computed value was read' }
      const comparison = compareComputed(expected, actual, expectation.property)
      if (comparison.equal) return { expectation, status: 'pass', expected, actual }
      const delta = primaryDelta(comparison)
      return { expectation, status: 'fail', expected, actual, ...(delta === undefined ? {} : { delta }), note: `changed from ${oneLine(expected)} to ${oneLine(actual)} although it was not part of this edit` }
    }
  }
}

/** True for a bystander check that passed without a measurement. */
export function isSkippedBystander(check: CheckResult): boolean {
  return check.expectation.type === 'unchanged' && check.status === 'pass' && check.note === BYSTANDER_NOT_CHECKED
}

// ---------------------------------------------------------------------------
// One item
// ---------------------------------------------------------------------------

/** The part of the server's settle result the judge reads (structurally a `SettleResult`). */
export interface SettleInfo {
  status: string
  signal: string
  ms: number
  filesChanged: string[]
  error?: { message: string; file?: string; line?: number; column?: number }
  reason?: string
}

export interface JudgeExtras {
  settle?: SettleInfo
  /** The tab was visible while it was measured. */
  visible: boolean
  /** A browser tab with the dock is connected. */
  browser: boolean
  /** 1 for the first verification of this item, 2 for the next, ... */
  attempt: number
  /** Epoch ms; becomes `at`. */
  now: number
  /** How sure the probe is that it measured the same element. */
  locatorConfidence?: number
}

type CheckStatus = CheckResult['status']

/** Status of a list of checks on their own (steps 5 to 9 of the header). */
export function rollUpChecks(checks: readonly CheckResult[]): CheckStatus {
  const has = (status: CheckStatus): boolean => checks.some((check) => check.status === status)
  if (has('unresolved')) return 'unresolved'
  if (has('fail')) return 'fail'
  if (has('drift')) return 'drift'
  // Also true for no checks at all: a pass needs at least one thing that was measured.
  if (has('not_measurable') || checks.every(isSkippedBystander)) return 'not_measurable'
  return 'pass'
}

/** What a check is about, as a code span: the property, or the label of the element that must not move or must not change. */
export function checkSubject(check: CheckResult): string {
  const e = check.expectation
  if (e.type === 'computed') return code(e.property, 60)
  if (e.type === 'no-move' || e.type === 'unchanged') return code(e.label, 80)
  return 'the element'
}

/** One clause saying what a check found, naming expected and actual values. No full stop. */
export function describeCheck(check: CheckResult): string {
  const e = check.expectation
  const expected = code(check.expected)
  const actual = code(check.actual)
  switch (e.type) {
    case 'computed':
      if (check.status === 'pass') return `${checkSubject(check)} is ${actual}, as expected`
      if (check.status === 'unresolved') return `${checkSubject(check)} could not be read (expected ${expected})`
      if (check.status === 'not_measurable') return `${checkSubject(check)} could not be checked (expected ${expected})`
      if (check.status === 'drift') return `${checkSubject(check)} landed as ${actual} instead of ${expected}`
      if (check.note === 'unchanged') return `${checkSubject(check)} is still ${actual} (unchanged); expected ${expected}`
      return `${checkSubject(check)} is ${actual}; expected ${expected}`
    case 'absent':
      if (check.status === 'pass') return 'the element is gone from the document'
      if (check.status === 'drift') return 'the element is hidden but still in the document; it was to be removed'
      return 'the element is still in the document; it was to be removed'
    case 'hidden':
      if (check.status === 'pass') return 'the element is in the document and not displayed'
      if (check.status === 'drift') return 'the element was removed from the document; it was to be hidden, not removed'
      if (check.status === 'fail') return 'the element is still displayed; it was to be hidden'
      return 'whether the element is hidden could not be checked'
    case 'no-move':
      if (check.status === 'pass') return `${checkSubject(check)} did not move`
      if (check.status === 'fail') return `${checkSubject(check)} must not move, but it ${check.note ?? 'changed'} (now ${actual}, before the edit ${expected})`
      return `${checkSubject(check)}, which must not move, could not be ${check.status === 'unresolved' ? 'found again' : 'measured'}`
    case 'unchanged': {
      const property = code(e.property, 60)
      if (isSkippedBystander(check)) return `${checkSubject(check)} could not be found again, so its ${property} was not checked`
      if (check.status === 'pass') return `${checkSubject(check)} kept its ${property} (${actual})`
      if (check.status === 'fail') return `${checkSubject(check)} was not part of this change, but its ${property} went from ${expected} to ${actual}`
      return `the ${property} of ${checkSubject(check)}, which must stay ${expected}, could not be read`
    }
  }
}

const mediaClause = (check: CheckResult): string => {
  const e = check.expectation
  return e.type === 'computed' && e.condition.media !== undefined ? ` when ${code(`@media ${e.condition.media}`)} matches` : ''
}

function failAdvice(check: CheckResult): string {
  const e = check.expectation
  switch (e.type) {
    case 'computed':
      return check.note === 'unchanged'
        ? 'Your edit has no effect on this property here: check that you changed the file and rule that render this element, and that no more specific rule or inline style overrides it.'
        : `Make it compute to ${code(check.expected)}${mediaClause(check)}.`
    case 'absent':
      return 'Remove it from the source.'
    case 'hidden':
      return 'Hide it without removing it from the DOM.'
    case 'no-move':
      return 'Keep the requested change and adjust the layout so that this element stays where it was.'
    case 'unchanged':
      return 'The rule you edited is shared: restore it and make the change with a more specific rule or a class on the changed element(s).'
  }
}

function driftAdvice(check: CheckResult): string {
  const e = check.expectation
  if (e.type === 'absent') return 'Delete it from the source unless you kept it on purpose.'
  if (e.type === 'hidden') return 'Acceptable if conditional rendering is how this project hides things; otherwise keep it in the DOM and hide it.'
  return `Acceptable if ${code(check.actual)} is the nearest design token; otherwise set ${code(check.expected)} exactly.`
}

const sentence = (clause: string): string => `${clause.charAt(0).toUpperCase()}${clause.slice(1)}.`

/** `-3px`, `colour distance 4.2` or a plain number: a check's `delta` with the unit it is in. */
export function deltaText(check: CheckResult): string | undefined {
  if (check.delta === undefined) return undefined
  const e = check.expectation
  if (e.type === 'no-move') return `${num(check.delta)}px`
  if (e.type !== 'computed' && e.type !== 'unchanged') return undefined
  const leaves = compareComputed(check.expected, check.actual, e.property).leaves.filter((leaf) => !leaf.equal)
  if (leaves.some((leaf) => leaf.kind === 'length')) return signedPx(check.delta)
  if (leaves.some((leaf) => leaf.kind === 'color')) return `colour distance ${num(check.delta)}`
  return `${check.delta > 0 ? '+' : ''}${num(check.delta)}`
}

/**
 * Everything about one check that did not pass, in one or two sentences: what was found against
 * what was expected, how far off it is, and what to do about it. The hint of an item and the
 * fix-up prompt are both built from this, so they never disagree.
 */
export function explainCheck(check: CheckResult): string {
  const delta = check.expectation.type === 'computed' && check.note !== 'unchanged' && (check.status === 'fail' || check.status === 'drift') ? deltaText(check) : undefined
  const off = delta === undefined ? '' : delta.startsWith('colour') ? ` (${delta})` : ` (off by ${delta})`
  let advice = ''
  if (check.status === 'fail') advice = failAdvice(check)
  else if (check.status === 'drift') advice = driftAdvice(check)
  else if (check.status === 'unresolved' && check.expectation.type === 'no-move') advice = 'If you renamed or restructured it, that is why; otherwise ask the user to check it by eye.'
  else if (check.status === 'not_measurable' && check.note !== undefined) advice = `Reason: ${oneLine(check.note)}.`
  return `${sentence(`${describeCheck(check)}${off}`)}${advice === '' ? '' : ` ${advice}`}`
}

/** True for a `computed` check that could not be made because its media query does not match the viewport. */
export function isMediaBlocked(check: CheckResult): boolean {
  const e = check.expectation
  return check.status === 'not_measurable' && e.type === 'computed' && e.condition.media !== undefined && check.note?.startsWith('the viewport does not match') === true
}

/** What to say when the target of an item could not be found again. */
export function unresolvedText(item: ChangeItem): string {
  return `The element ${code(item.target.label, 80)} could not be found again after the edit: was it renamed or restructured? Its tag, text, id and position identify it; if you changed those on purpose, ask the user to check this change by eye.`
}

/** What to say when a media query kept a check from being made. */
export function mediaBlockedText(check: CheckResult): string {
  const e = check.expectation
  const media = e.type === 'computed' && e.condition.media !== undefined ? code(`@media ${e.condition.media}`) : 'the media query'
  return `Could not be checked at the current viewport: ${media} does not match (expected ${checkSubject(check)} ${code(check.expected)}). Resize the browser so that the query matches, then verify again.`
}

function others(checks: readonly CheckResult[], first: CheckResult): string {
  const rest = checks.filter((check) => check !== first && check.status !== 'pass')
  if (rest.length === 0) return ''
  const shown = rest.slice(0, 3).map(describeCheck)
  const more = rest.length > shown.length ? `; and ${rest.length - shown.length} more` : ''
  return ` Also not passing: ${shown.join('; ')}${more}.`
}

function buildErrorText(settle: SettleInfo | undefined): string {
  const error = settle?.error
  if (error === undefined) return settle?.reason === undefined ? '' : truncate(oneLine(settle.reason), 400)
  const where = error.file === undefined ? '' : ` (${code(`${error.file}${error.line === undefined ? '' : `:${error.line}${error.column === undefined ? '' : `:${error.column}`}`}`, 200)})`
  return `${code(error.message, 400)}${where}`
}

/** One or two sentences that tell the agent what to do next, naming expected and actual values. */
export function hintFor(status: VerificationStatus, item: ChangeItem, checks: readonly CheckResult[], settle?: SettleInfo): string {
  const first = (wanted: CheckStatus): CheckResult | undefined => checks.find((check) => check.status === wanted)
  const notPassing = checks.find((check) => check.status !== 'pass')
  const unsettled =
    settle?.status === 'timeout' && status !== 'pass' ? ' The page had not finished updating when it was measured; verify again if you believe the change is in place.' : ''

  switch (status) {
    case 'no_browser':
      return 'No browser tab with the reglet dock is connected, so nothing was measured. Ask the user to open the app through reglet, then verify again.'
    case 'tab_hidden':
      return 'The browser tab was hidden, so nothing measured in it can be trusted. Ask the user to bring the tab to the front, then verify again.'
    case 'build_error': {
      const text = buildErrorText(settle)
      return `The dev server reports a build error, so nothing was measured${text === '' ? '' : `: ${text}`}. Fix it, then verify again.`
    }
    case 'no_update_observed': {
      const files = settle?.filesChanged ?? []
      const state = notPassing === undefined ? '' : ` ${sentence(describeCheck(notPassing))}`
      return files.length === 0
        ? `No source file changed and the page did not update since the batch was claimed.${state} Make the edit and save the file, then verify again.`
        : `${files.length === 1 ? 'A file' : 'Files'} changed (${files.slice(0, 3).map((file) => code(file, 80)).join(', ')}${files.length > 3 ? `, +${files.length - 3} more` : ''}) but the page did not update.${state} Check that the dev server picked the change up and that this page renders the file you edited.`
    }
    case 'unresolved': {
      const check = first('unresolved')
      if (check?.expectation.type === 'no-move') return `${explainCheck(check)}${others(checks, check)}${unsettled}`
      return `${unresolvedText(item)}${check === undefined ? '' : others(checks, check)}${unsettled}`
    }
    case 'fail': {
      const check = first('fail')
      if (check === undefined) return `At least one check failed.${unsettled}`
      return `${explainCheck(check)}${others(checks, check)}${unsettled}`
    }
    case 'drift': {
      const check = first('drift')
      if (check === undefined) return `The change landed close to what was asked, not exactly on it.${unsettled}`
      return `${explainCheck(check)}${others(checks, check)}${unsettled}`
    }
    case 'not_measurable': {
      const check = first('not_measurable')
      if (check === undefined) return 'This change has nothing that can be checked.'
      if (isMediaBlocked(check)) return `${mediaBlockedText(check)}${unsettled}`
      return `${explainCheck(check)} Verify again.${unsettled}`
    }
    case 'pass': {
      if (settle?.status === 'no_update_observed') return 'Every check already passes, although no source change was observed since the batch was claimed.'
      // A pass that rests on fewer measurements than checks says so.
      const skipped = checks.filter(isSkippedBystander)
      const labels = [...new Set(skipped.map(checkSubject))]
      const open =
        skipped.length === 0
          ? ''
          : ` ${skipped.length === 1 ? 'One of them was' : `${skipped.length} of them were`} not measured: ${labels.slice(0, 3).join(', ')}${labels.length > 3 ? ` and ${labels.length - 3} more` : ''}, which this change must leave as ${labels.length === 1 ? 'it was' : 'they were'}, could not be found again.`
      return checks.length === 1 ? 'The check passes.' : `All ${checks.length} checks pass.${open}`
    }
  }
}

/** Rolls the checks of one item up into its verification result; precedence in the header. */
export function judgeItem(item: ChangeItem, checks: readonly CheckResult[], extras: JudgeExtras): VerificationResult {
  const settle = extras.settle
  const fromChecks = rollUpChecks(checks)
  let status: VerificationStatus
  if (!extras.browser) status = 'no_browser'
  else if (!extras.visible) status = 'tab_hidden'
  else if (settle?.status === 'build_error') status = 'build_error'
  else if (settle?.status === 'no_update_observed' && fromChecks !== 'pass') status = 'no_update_observed'
  else status = fromChecks

  return {
    itemId: item.id,
    attempt: extras.attempt,
    at: extras.now,
    status,
    checks: [...checks],
    ...(extras.locatorConfidence === undefined ? {} : { locatorConfidence: Math.min(1, Math.max(0, extras.locatorConfidence)) }),
    ...(settle === undefined ? {} : { settle: { status: settle.status, signal: settle.signal, ms: settle.ms, filesChanged: [...settle.filesChanged] } }),
    hint: hintFor(status, item, checks, settle),
  }
}
