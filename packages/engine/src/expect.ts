import type { ChangeItem, Expectation, SiblingAnchor, SideEffect as RecordedSideEffect, StructuralChange, StyleChange } from '@reglet/protocol/change'
import { normalizeValue } from './units.ts'

/** `Omit` that keeps the members of a union apart, so `kind` still narrows. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** A change item before its expectations are known. */
export type ItemWithoutExpect = DistributiveOmit<ChangeItem, 'expect'>

/** Tolerance of every `no-move` expectation, in px. */
export const NO_MOVE_TOLERANCE_PX = 1

/**
 * Derives what must be true once the source matches an item: a computed value
 * per changed longhand, absence/hiddenness or the new sibling order for
 * structural edits, a `no-move` constraint for every side effect the user
 * marked unwanted, and an `unchanged` check for every bystander of a style change.
 *
 * Order (the same input always gives the same list):
 *   1. style change: `computed` expectations, one per longhand whose value changed, sorted by
 *      property name. Without `longhands`, or when none of them changed, a single one for
 *      `property` with `after.computed` (so a style change always has at least one). Each
 *      carries the item's condition, so a change made for `:hover` is checked in that state.
 *      structural change: `absent` for remove, `hidden` for hide. For reorder one `order`
 *      built from `move.now`: the neighbour before (if any), the moved element itself (the
 *      item's target, marked `self`), the neighbour after (if any). Nothing when neither
 *      neighbour is recorded (an only child, or no `move`): there is no order to check then.
 *   2. one `no-move` per side effect with verdict `unwanted`, in the order of `sideEffects`,
 *      each carrying the BEFORE rectangle. A selector listed twice gives one constraint.
 *   3. style change with `bystanders`: `unchanged` expectations, bystander by bystander in the
 *      recorded order, and per bystander sorted by property name. A bystander records every
 *      longhand of the edited property; checked are the ones the edit changes (the properties
 *      of step 1), because those are what an edit of the shared rule would drag along. When
 *      the edit changes no computed value (step 1 fell back to `property`), every recorded
 *      value is checked.
 *
 * CONTRACT: pure; called by the dock whenever an item or a verdict changes, and the result is stored in `item.expect`.
 */
export function deriveExpectations(item: ItemWithoutExpect): Expectation[]
export function deriveExpectations(item: Omit<ChangeItem, 'expect'>): Expectation[]
export function deriveExpectations(input: ItemWithoutExpect | Omit<ChangeItem, 'expect'>): Expectation[] {
  const item = input as Omit<StyleChange, 'expect'> | Omit<StructuralChange, 'expect'>
  const out: Expectation[] = []

  /** Longhands whose computed value the edit changes; empty for a structural change. */
  let changedNames: string[] = []
  if (item.kind === 'style') {
    const changed = Object.entries(item.longhands ?? {})
      .filter(([, value]) => normalizeValue(value.before) !== normalizeValue(value.after))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    changedNames = changed.map(([property]) => property)
    if (changed.length > 0) {
      for (const [property, value] of changed) {
        out.push({ type: 'computed', property, value: value.after, condition: item.condition })
      }
    } else {
      out.push({ type: 'computed', property: item.property, value: item.after.computed, condition: item.condition })
    }
  } else if (item.op === 'remove') {
    out.push({ type: 'absent' })
  } else if (item.op === 'hide') {
    out.push({ type: 'hidden' })
  } else {
    const now = item.move?.now
    const anchor = (sibling: SiblingAnchor | undefined): SiblingAnchor[] => (sibling === undefined ? [] : [{ label: sibling.label, locator: sibling.locator }])
    const plain = (siblings: readonly SiblingAnchor[]): SiblingAnchor[] => siblings.map((sibling) => ({ label: sibling.label, locator: sibling.locator }))
    // Every sibling recorded around the element, not just the two next to it: with only the neighbours,
    // an order in which the element stands somewhere before its next neighbour would pass.
    const around = item.move?.around
    const before = around === undefined ? anchor(now?.prev) : plain(around.before)
    const after = around === undefined ? anchor(now?.next) : plain(around.after)
    if (before.length + after.length > 0) {
      out.push({ type: 'order', siblings: [...before, { label: item.target.label, locator: item.target.locator, self: true }, ...after] })
    }
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

  if (item.kind === 'style') {
    for (const bystander of item.bystanders ?? []) {
      const recorded = Object.keys(bystander.values).sort()
      const checked = changedNames.length > 0 ? recorded.filter((property) => changedNames.includes(property)) : recorded
      for (const property of checked) {
        out.push({ type: 'unchanged', label: bystander.label, selector: bystander.selector, locator: bystander.locator, property, value: bystander.values[property] ?? '' })
      }
    }
  }
  return out
}
