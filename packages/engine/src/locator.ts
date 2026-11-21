/**
 * Re-identification: given the locator recorded for an element and descriptions of the
 * elements in the page as it is now (after a re-render or a reload), decide which one is the
 * same element, or that none can be named with confidence.
 *
 * Pure: no DOM, no Node. The probe describes candidate elements with the same `Locator` shape.
 *
 * Class names are never used: an agent often implements a style change by changing classes.
 *
 * SCORE. The tag must be equal, otherwise the score is 0. Every other signal that the RECORDED
 * locator has contributes `weight x similarity`; the score is that sum over the sum of the
 * weights, so it is 1 for an unchanged element and signals the locator never had cost nothing.
 *
 *   signal            weight  similarity
 *   id                10      equal: 1, else 0
 *   testId             6      equal: 1, else 0
 *   role + accName     3      roles differ: 0; else 0.4 + 0.6 x text similarity of the names
 *   role only          1      equal: 1, else 0
 *   accName only       2      text similarity
 *   own text           4      text similarity
 *   href               2      equal: 1, else 0
 *   name               2      equal: 1, else 0
 *   index path         4      see `pathSimilarity`
 *   ancestor tags      2      see `ancestorSimilarity`
 *   previous anchor    1      equal: 1, else 0
 *   next anchor        1      equal: 1, else 0
 *
 * Text similarity: both lower-cased and split into letter/digit tokens; 1 when the token lists
 * are equal, otherwise the Dice overlap of the token sets (2 x shared / total).
 *
 * Index path: the smallest number of edits that turns one path into the other, where a step
 * that is off by one costs 1 (a sibling inserted or removed before the element at that level),
 * a step that is off by more costs 2, and a step missing on either side costs 1 (a wrapper
 * added or removed). Similarity is 1, 0.6, 0.2, 0 for a cost of 0, 1, 2, 3 or more. It does not
 * depend on the depth of the element, so among otherwise identical siblings the one at the
 * recorded position always wins by the same margin.
 *
 * DECISION (`pickBest`). The best candidate is returned only when its score is at least
 * `minConfidence` (0.55) AND it leads the runner-up by at least `minMargin` (0.05). A lead
 * smaller than that is ambiguity and gives null, with one exception: when the caller passes
 * `anyInstance` and the runner-up is an equivalent instance of the best (same tag, same
 * ancestor tags, index paths that differ at exactly one level: two items of one list), either
 * will do and the best is returned.
 *
 * Worked examples (see the tests): unchanged element 1.0; text changed but id kept 0.8 to 0.93;
 * sibling inserted above, text kept 0.81 to 0.89; wrapper added around it, text kept 0.7;
 * element removed, best remaining element of the same tag below 0.35 (null).
 *
 * Known limit: a locator cannot tell identical siblings apart except by position. When one of
 * several identical hand-written siblings is removed, the next one slides into its place and is
 * found there.
 */

import type { Locator } from '@reglet/protocol/change'

/** An element of the current page, described the way locators are recorded. */
export type LocatorCandidate = Locator

export interface PickOptions {
  /** Default 0.55. */
  minConfidence?: number
  /** Default 0.05. */
  minMargin?: number
  /** Accept a tie between equivalent instances (use for changes scoped to all instances). */
  anyInstance?: boolean
}

export interface LocatorPick {
  /** Index into the candidates array. */
  index: number
  /** Score of the chosen candidate, 0 to 1. */
  confidence: number
  /** Its lead over the runner-up (equal to `confidence` when it is the only candidate with a score). */
  margin: number
}

export const MIN_CONFIDENCE = 0.55
export const MIN_MARGIN = 0.05

const WEIGHT = {
  id: 10,
  testId: 6,
  roleAndName: 3,
  roleOnly: 1,
  nameOnly: 2,
  text: 4,
  href: 2,
  name: 2,
  indexPath: 4,
  ancestors: 2,
  anchor: 1,
} as const

const tokens = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []

/** 0 to 1; see the header. Two empty texts are equal. */
export function textSimilarity(a: string, b: string): number {
  const ta = tokens(a)
  const tb = tokens(b)
  if (ta.length === tb.length && ta.every((token, i) => token === tb[i])) return 1
  const sa = new Set(ta)
  const sb = new Set(tb)
  if (sa.size === 0 || sb.size === 0) return 0
  let shared = 0
  for (const token of sa) if (sb.has(token)) shared++
  return (2 * shared) / (sa.size + sb.size)
}

/** Edit distance between two sequences with a caller-supplied substitution cost; insert and delete cost 1. */
function editCost<T>(a: readonly T[], b: readonly T[], substitute: (x: T, y: T) => number): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      const x = a[i - 1] as T
      const y = b[j - 1] as T
      current.push(Math.min((previous[j] as number) + 1, (current[j - 1] as number) + 1, (previous[j - 1] as number) + substitute(x, y)))
    }
    previous = current
  }
  return previous[b.length] as number
}

/** 1, 0.6, 0.2 or 0; see the header. */
export function pathSimilarity(a: readonly number[], b: readonly number[]): number {
  if (Math.abs(a.length - b.length) >= 3) return 0
  const cost = editCost(a, b, (x, y) => (x === y ? 0 : Math.abs(x - y) === 1 ? 1 : 2))
  return Math.max(0, 1 - 0.4 * cost)
}

/** Tag paths: 1 when equal, 0.65 with one tag inserted, removed or replaced, 0.3 with two, else 0. */
export function ancestorSimilarity(a: readonly string[], b: readonly string[]): number {
  if (Math.abs(a.length - b.length) >= 3) return 0
  const cost = editCost(a, b, (x, y) => (x.toLowerCase() === y.toLowerCase() ? 0 : 1))
  return Math.max(0, Math.round((1 - 0.35 * cost) * 100) / 100)
}

const norm = (text: string): string => text.trim().replace(/\s+/g, ' ').toLowerCase()

/** How likely `candidate` is the element `locator` was recorded for: 0 to 1. */
export function scoreCandidate(locator: Locator, candidate: LocatorCandidate): number {
  if (locator.tag.toLowerCase() !== candidate.tag.toLowerCase()) return 0
  let total = 0
  let got = 0
  const add = (weight: number, similarity: number): void => {
    total += weight
    got += weight * similarity
  }
  const exact = (a: string, b: string | undefined): number => (b !== undefined && a === b ? 1 : 0)

  if (locator.id !== undefined) add(WEIGHT.id, exact(locator.id, candidate.id))
  if (locator.testId !== undefined) add(WEIGHT.testId, exact(locator.testId, candidate.testId))
  if (locator.role !== undefined && locator.accName !== undefined) {
    const sameRole = candidate.role !== undefined && norm(candidate.role) === norm(locator.role)
    add(WEIGHT.roleAndName, sameRole ? 0.4 + 0.6 * textSimilarity(locator.accName, candidate.accName ?? '') : 0)
  } else if (locator.role !== undefined) {
    add(WEIGHT.roleOnly, candidate.role !== undefined && norm(candidate.role) === norm(locator.role) ? 1 : 0)
  } else if (locator.accName !== undefined) {
    add(WEIGHT.nameOnly, textSimilarity(locator.accName, candidate.accName ?? ''))
  }
  if (locator.text !== undefined) add(WEIGHT.text, textSimilarity(locator.text, candidate.text ?? ''))
  if (locator.href !== undefined) add(WEIGHT.href, exact(locator.href, candidate.href))
  if (locator.name !== undefined) add(WEIGHT.name, exact(locator.name, candidate.name))
  add(WEIGHT.indexPath, pathSimilarity(locator.indexPath, candidate.indexPath))
  add(WEIGHT.ancestors, ancestorSimilarity(locator.ancestors, candidate.ancestors))
  if (locator.prevAnchor !== undefined) add(WEIGHT.anchor, candidate.prevAnchor !== undefined && norm(candidate.prevAnchor) === norm(locator.prevAnchor) ? 1 : 0)
  if (locator.nextAnchor !== undefined) add(WEIGHT.anchor, candidate.nextAnchor !== undefined && norm(candidate.nextAnchor) === norm(locator.nextAnchor) ? 1 : 0)

  return total === 0 ? 0 : got / total
}

/**
 * Two elements rendered from the same place in the source, as far as a locator can tell: same
 * tag, same ancestor tags, and index paths of the same length that differ at exactly one level.
 */
export function isEquivalentInstance(a: LocatorCandidate, b: LocatorCandidate): boolean {
  if (a.tag.toLowerCase() !== b.tag.toLowerCase()) return false
  if (a.ancestors.length !== b.ancestors.length || !a.ancestors.every((tag, i) => tag === b.ancestors[i])) return false
  if (a.indexPath.length !== b.indexPath.length) return false
  if ((a.testId ?? '') !== (b.testId ?? '') || (a.role ?? '') !== (b.role ?? '')) return false
  let differing = 0
  for (let i = 0; i < a.indexPath.length; i++) if (a.indexPath[i] !== b.indexPath[i]) differing++
  return differing === 1
}

/**
 * The candidate that is the recorded element, or null when there is none or it is ambiguous.
 * Ties are broken by position in `candidates` (pass them in document order).
 */
export function pickBest(locator: Locator, candidates: readonly LocatorCandidate[], options: PickOptions = {}): LocatorPick | null {
  const minConfidence = options.minConfidence ?? MIN_CONFIDENCE
  const minMargin = options.minMargin ?? MIN_MARGIN
  let best = -1
  let bestScore = 0
  let second = -1
  let secondScore = 0
  candidates.forEach((candidate, index) => {
    const score = scoreCandidate(locator, candidate)
    if (score > bestScore) {
      second = best
      secondScore = bestScore
      best = index
      bestScore = score
    } else if (score > secondScore) {
      second = index
      secondScore = score
    }
  })
  const winner = candidates[best]
  if (winner === undefined || bestScore < minConfidence) return null
  const margin = bestScore - secondScore
  if (margin < minMargin - 1e-9) {
    const runnerUp = candidates[second]
    const interchangeable = options.anyInstance === true && runnerUp !== undefined && isEquivalentInstance(winner, runnerUp)
    if (!interchangeable) return null
  }
  return { index: best, confidence: round(bestScore), margin: round(margin) }
}

const round = (n: number): number => Math.round(n * 1000) / 1000
