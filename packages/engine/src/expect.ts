import type { ChangeItem, Expectation, SideEffect as RecordedSideEffect, StructuralChange, StyleChange } from '@reglet/protocol/change'
import { normalizeValue } from './units.ts'

/** `Omit` that keeps the members of a union apart, so `kind` still narrows. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** A change item before its expectations are known. */
export type ItemWithoutExpect = DistributiveOmit<ChangeItem, 'expect'>

/** Tolerance of every `no-move` expectation, in px. */
export const NO_MOVE_TOLERANCE_PX = 1

/**
 * Derives what must be true once the source matches an item: a computed value
 * per changed longhand, absence/hiddenness for structural edits, and a
 * `no-move` constraint for every side effect the user marked unwanted.
 *
 * Order (the same input always gives the same list):
 *   1. style change: `computed` expectations, one per longhand whose value changed, sorted by
 *      property name. Without `longhands`, or when none of them changed, a single one for
 *      `property` with `after.computed` (so a style change always has at least one).
 *      structural change: `absent` for remove, `hidden` for hide.
 *   2. one `no-move` per side effect with verdict `unwanted`, in the order of `sideEffects`,
 *      each carrying the BEFORE rectangle. A selector listed twice gives one constraint.
 *
 * CONTRACT: pure; called by the dock whenever an item or a verdict changes, and the result is stored in `item.expect`.
 */
export function deriveExpectations(item: ItemWithoutExpect): Expectation[]
export function deriveExpectations(item: Omit<ChangeItem, 'expect'>): Expectation[]
export function deriveExpectations(input: ItemWithoutExpect | Omit<ChangeItem, 'expect'>): Expectation[] {
  const item = input as Omit<StyleChange, 'expect'> | Omit<StructuralChange, 'expect'>
  const out: Expectation[] = []

  if (item.kind === 'style') {
    const changed = Object.entries(item.longhands ?? {})
      .filter(([, value]) => normalizeValue(value.before) !== normalizeValue(value.after))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    if (changed.length > 0) {
      for (const [property, value] of changed) {
        out.push({ type: 'computed', property, value: value.after, condition: item.condition })
      }
    } else {
      out.push({ type: 'computed', property: item.property, value: item.after.computed, condition: item.condition })
    }
  } else {
    out.push(item.op === 'remove' ? { type: 'absent' } : { type: 'hidden' })
  }

  const seen = new Set<string>()
  for (const effect of item.sideEffects as readonly RecordedSideEffect[]) {
    if (effect.verdict !== 'unwanted' || seen.has(effect.selector)) continue
    seen.add(effect.selector)
    out.push({
      type: 'no-move',
      label: effect.label,
      locator: effect.locator,
      rect: effect.before,
      tolerancePx: NO_MOVE_TOLERANCE_PX,
    })
  }
  return out
}
