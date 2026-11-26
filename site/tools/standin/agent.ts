/**
 * The website's simulated agent: it carries out sent changes on this page the way an agent's
 * source edit would show up after a hot reload, so that primp's REAL verification (the dock
 * measures, the engine judges) can be tried without installing anything.
 *
 * There is no source to edit here, so the "edit" is applied to the running page: a stylesheet
 * in <head> for style and hide changes (as a CSS edit would arrive), and DOM moves and removals
 * for reorders and removals (as a re-render would). Nothing about the judging is simulated.
 *
 *   careful  does what each change asks, scoped to the changed element: the checks pass.
 *   sloppy   makes the two mistakes verification exists to catch: it edits a CSS rule that other
 *            elements share (a bystander moves: fail), and it rounds a length to a nearby value
 *            (drift). Changes where neither mistake is possible are done right.
 *
 * The rules are unlayered and not `!important`: they win over this site's Tailwind utilities (which
 * sit in cascade layers) as a source edit would, and the dock's own previews still win over them.
 */

import type { ChangeItem, StyleChange } from '../../../packages/protocol/src/change.ts'

export type AgentMode = 'careful' | 'sloppy'

export interface AgentEdit {
  itemId: string
  /** What the simulated agent did, in words, for the page's notice. */
  did: string
  /** A deliberate mistake (sloppy mode). */
  mistake?: 'shared-rule' | 'near-value'
}

const SHEET_ID = 'primp-site-agent'

function sheet(): HTMLStyleElement {
  let node = document.getElementById(SHEET_ID) as HTMLStyleElement | null
  if (node === null) {
    node = document.createElement('style')
    node.id = SHEET_ID
    document.head.append(node)
  }
  return node
}

const one = (selector: string): Element | null => {
  try {
    const found = document.querySelectorAll(selector)
    return found.length === 1 ? found[0]! : null
  } catch {
    return null
  }
}

const px = /^(-?\d+(?:\.\d+)?)px$/

/** A value one step short of the target, toward where it came from: within the judge's drift band, never on the target. */
function nearValue(item: StyleChange): string | null {
  const target = px.exec(item.after.computed ?? item.after.authored)
  const from = px.exec(item.before.computed)
  if (target === null || from === null) return null
  const want = Number(target[1])
  const was = Number(from[1])
  const step = Math.abs(want - was) >= 2 ? 1 : 0
  if (step === 0) return null
  return `${want > was ? want - step : want + step}px`
}

function styleRule(selector: string, item: StyleChange, value: string): string {
  const state = item.condition.state
  // `:is()` keeps a selector list (or one with `:is(a, b)` inside) whole.
  const target = state === undefined ? selector : `:is(${selector}):${state}`
  const rule = `${target} { ${item.property}: ${value}; }`
  return item.condition.media === undefined || item.condition.media === '' ? rule : `@media ${item.condition.media} { ${rule} }`
}

/** Applies the changes to the page as the simulated agent; returns what it did for each. */
export function applyAsAgent(items: readonly ChangeItem[], mode: AgentMode): AgentEdit[] {
  const css: string[] = []
  const edits: AgentEdit[] = []
  for (const item of items) {
    const label = item.target.label.split(' "')[0] ?? item.target.label
    if (item.kind === 'note') {
      edits.push({ itemId: item.id, did: `read your note on ${label} (a note is checked by eye)` })
      continue
    }
    const element = one(item.target.selector)
    if (item.kind === 'style') {
      // Only a class rule: an agent edits `.btn`, not `*` or `a` (which would restyle the whole page).
      const selector = item.origin?.selector
      // Not a rule under a media query either: copied without it, the edit would reach other widths too.
      const shared = item.origin?.via === 'rule' && (item.origin.alsoStyles ?? 0) > 0 && item.origin.media === undefined && selector !== undefined && /^\.[^\s,>+~]+$/.test(selector) ? selector : undefined
      if (mode === 'sloppy' && shared !== undefined && item.condition.state === undefined) {
        css.push(styleRule(shared, item, item.after.authored))
        edits.push({ itemId: item.id, did: `changed ${item.property} in the shared rule ${shared.replace(/\\(.)/g, '$1')}, which other elements use too`, mistake: 'shared-rule' })
        continue
      }
      const near = mode === 'sloppy' ? nearValue(item) : null
      if (element === null) {
        edits.push({ itemId: item.id, did: `could not find ${label} to change` })
        continue
      }
      css.push(styleRule(item.target.selector, item, near ?? item.after.authored))
      edits.push(near === null ? { itemId: item.id, did: `set ${item.property} to ${item.after.authored} on ${label}` } : { itemId: item.id, did: `set ${item.property} to ${near} on ${label}, not ${item.after.authored}`, mistake: 'near-value' })
      continue
    }
    if (element === null) {
      edits.push({ itemId: item.id, did: `could not find ${label} to change` })
      continue
    }
    if (item.op === 'hide') {
      css.push(`${item.target.selector} { display: none; }`)
      edits.push({ itemId: item.id, did: `hid ${label}` })
    } else if (item.op === 'remove') {
      element.remove()
      edits.push({ itemId: item.id, did: `removed ${label}` })
    } else if (item.op === 'reorder' && item.move !== undefined && element.parentElement !== null) {
      const parent = element.parentElement
      const others = [...parent.children].filter((child) => child !== element)
      const ref = others[item.move.toIndex] ?? null
      parent.insertBefore(element, ref)
      edits.push({ itemId: item.id, did: `moved ${label} to position ${item.move.toIndex + 1}` })
    } else {
      edits.push({ itemId: item.id, did: `left ${label} as it was` })
    }
  }
  if (css.length > 0) sheet().append(`\n${css.join('\n')}`)
  return edits
}
