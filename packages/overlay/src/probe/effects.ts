/**
 * Side effects of one edit: what else on the page moved, resized, overflowed, wrapped or left
 * the viewport because of it.
 *
 * `measureEffects` takes a geometry snapshot, lets the caller apply the preview, waits one
 * animation frame (with a timer as fallback: frames do not run in a hidden tab), forces layout
 * with one read, takes the second snapshot and hands both to the engine's classifier. The edited
 * element (every instance for an all-instances edit) is the primary change and never listed.
 *
 * Budget: both snapshots plus the diff stay under 30 ms for 2,500 elements (spike S5 measured
 * about 5 ms); `ms` in the result is what this call spent, without the wait for the frame.
 */

import { sideEffects, type SideEffect as EngineEffect } from '@primp/engine/side-effects'
import type { SideEffect } from '@primp/protocol/change'
import { buildSelector, labelOf, locatorOf } from './ref.ts'
import { DEFAULT_CAP, elementOf, idOf, snapshot } from './snapshot.ts'

export interface EffectsResult {
  sideEffects: SideEffect[]
  /** One line, e.g. `14 elements moved up 48px; .footer overflows`. */
  summary: string
  /** The page has more elements than the snapshot looks at, so the list may be incomplete. */
  partial: boolean
  /** Main-thread time of snapshots, diff and conversion. */
  ms: number
  /** Where `ms` went: the first snapshot, the second, diff + classification, and describing the affected elements. */
  parts: { before: number; after: number; classify: number; describe: number }
  /** Elements in the second snapshot. */
  elements: number
}

/** Most effects kept on an item; the summary still counts all of them. */
const MAX_EFFECTS = 40
const FRAME_FALLBACK_MS = 120

/** Resolves after the next animation frame, or after a short timer when no frame comes (hidden tab). */
export function nextFrame(view: Window = window): Promise<void> {
  return new Promise((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      view.clearTimeout(timer)
      resolve()
    }
    const timer = view.setTimeout(finish, FRAME_FALLBACK_MS)
    view.requestAnimationFrame(finish)
  })
}

const zeroAt = (rect: { x: number; y: number }): SideEffect['before'] => ({ x: rect.x, y: rect.y, w: 0, h: 0 })

function toProtocol(effect: EngineEffect): SideEffect | undefined {
  const element = elementOf(effect.id)
  // The page itself getting longer or shorter is the sum of the effects, not one of them.
  if (element === null || element === element.ownerDocument.body || element === element.ownerDocument.documentElement) return undefined
  const before = effect.before ?? (effect.after === null ? undefined : zeroAt(effect.after))
  const after = effect.after ?? (effect.before === null ? undefined : zeroAt(effect.before))
  if (before === undefined || after === undefined) return undefined
  return {
    label: labelOf(element),
    selector: buildSelector(element),
    locator: locatorOf(element),
    type: effect.type,
    before,
    after,
    // The protocol counts the elements inside; the engine counts the top-most one too.
    subtreeCount: Math.max(0, effect.subtreeCount - 1),
    verdict: 'unreviewed',
  }
}

/**
 * Measures what `apply` does to the rest of the page.
 * `apply` makes the change (sets the preview) and returns the edited elements.
 */
export async function measureEffects(apply: () => readonly Element[], root: Element = document.body): Promise<EffectsResult> {
  const view = root.ownerDocument.defaultView ?? window
  const t0 = performance.now()
  const before = snapshot(root, { cap: DEFAULT_CAP })
  const t1 = performance.now()

  const edited = apply()

  await nextFrame(view)

  const t2 = performance.now()
  // One read: the browser recalculates style and layout for the edit here, if the frame did not.
  void root.getBoundingClientRect().height
  const editedIds = edited.map((element) => idOf(element))
  const pin = new Set<number>(editedIds)
  for (const entry of before.entries) pin.add(entry.id)
  const after = snapshot(root, { cap: DEFAULT_CAP, pin })
  const t2a = performance.now()
  const report = sideEffects(before, after, { edited: editedIds })
  const t2b = performance.now()
  const converted: SideEffect[] = []
  for (const effect of report.effects) {
    if (converted.length >= MAX_EFFECTS) break
    const out = toProtocol(effect)
    if (out !== undefined) converted.push(out)
  }
  const t3 = performance.now()

  return {
    sideEffects: converted,
    summary: report.summary,
    partial: report.truncated,
    ms: t1 - t0 + (t3 - t2),
    parts: { before: t1 - t0, after: t2a - t2, classify: t2b - t2a, describe: t3 - t2b },
    elements: after.entries.length,
  }
}

const px = (n: number): string => `${Math.round(Math.abs(n) * 2) / 2}px`

/** A phrase for one recorded effect, from its rectangles: `moved up 48px`, `became 16px taller`. */
export function describeEffect(effect: SideEffect): string {
  const dx = effect.after.x - effect.before.x
  const dy = effect.after.y - effect.before.y
  const dw = effect.after.w - effect.before.w
  const dh = effect.after.h - effect.before.h
  const moved = (): string => {
    const parts: string[] = []
    if (Math.abs(dy) > 0.5) parts.push(`${dy < 0 ? 'up' : 'down'} ${px(dy)}`)
    if (Math.abs(dx) > 0.5) parts.push(`${dx < 0 ? 'left' : 'right'} ${px(dx)}`)
    return parts.length === 0 ? 'moved' : `moved ${parts.join(' and ')}`
  }
  switch (effect.type) {
    case 'moved':
      return moved()
    case 'resized': {
      if (effect.before.w === 0 && effect.before.h === 0) return 'appeared'
      if (effect.after.w === 0 && effect.after.h === 0) return 'disappeared'
      const parts: string[] = []
      if (Math.abs(dw) > 0.5) parts.push(`${px(dw)} ${dw < 0 ? 'narrower' : 'wider'}`)
      if (Math.abs(dh) > 0.5) parts.push(`${px(dh)} ${dh < 0 ? 'shorter' : 'taller'}`)
      return parts.length === 0 ? 'resized' : `became ${parts.join(' and ')}`
    }
    case 'overflow':
      return 'now overflows'
    case 'wrapped':
      return 'text re-wrapped'
    case 'offscreen':
      return 'pushed out of view'
  }
}

/** A one-line summary from recorded effects alone, for items whose engine summary is not at hand (after a reload). */
export function summarizeRecorded(effects: readonly SideEffect[]): string {
  if (effects.length === 0) return 'no side effects'
  const groups = new Map<string, { count: number; label: string }>()
  for (const effect of effects) {
    const phrase = describeEffect(effect)
    const group = groups.get(phrase)
    if (group === undefined) groups.set(phrase, { count: 1 + effect.subtreeCount, label: effect.label })
    else group.count += 1 + effect.subtreeCount
  }
  const sorted = [...groups.entries()].sort((a, b) => b[1].count - a[1].count)
  const clauses = sorted.slice(0, 2).map(([phrase, group]) => (group.count === 1 ? `${group.label.split(' "')[0]} ${phrase}` : `${group.count} elements ${phrase}`))
  const rest = sorted.slice(2).reduce((sum, [, group]) => sum + group.count, 0)
  if (rest > 0) clauses.push(`${rest} more affected`)
  return clauses.join('; ')
}
