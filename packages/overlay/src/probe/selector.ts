/**
 * Pure helpers for building a short unique CSS selector. The DOM side (`ref.ts`) describes the
 * element and its ancestors as steps and supplies the uniqueness test.
 */

export interface SelectorStep {
  /** Lower-case tag name. */
  tag: string
  id?: string
  testId?: string
  /** 1-based position among the parent's children of the same tag. */
  nthOfType: number
  /** Whether the parent has more children of the same tag. */
  hasTwin: boolean
}

/** Escapes an identifier for use in a selector; `CSS.escape` where it exists (always in a browser). */
export function escapeIdent(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/^(-?\d)/, (_all, first: string) => `\\3${first} `).replace(/[^\w-]/g, (char) => `\\${char}`)
}

export function escapeString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\a ')
}

/** The strongest single selector for one step: `#id`, `[data-testid="x"]`, or `tag:nth-of-type(n)`. */
export function stepSelector(step: SelectorStep, positional = true): string {
  if (step.id !== undefined && step.id !== '') return `#${escapeIdent(step.id)}`
  if (step.testId !== undefined && step.testId !== '') return `[data-testid="${escapeString(step.testId)}"]`
  return positional && step.hasTwin ? `${step.tag}:nth-of-type(${step.nthOfType})` : step.tag
}

/**
 * The shortest selector that `isUnique` accepts.
 *
 * `steps` go from the element (first) up to `<body>`'s child (last). An id or test id on the
 * element is tried alone; otherwise the path grows upwards, one `>` step at a time, until it is
 * unique (which an ancestor with an id usually settles). The full path from `<body>` is
 * returned when nothing shorter is unique.
 */
export function composeSelector(steps: readonly SelectorStep[], isUnique: (selector: string) => boolean): string {
  if (steps.length === 0) return 'body'
  let selector = ''
  for (const step of steps) {
    const part = stepSelector(step)
    selector = selector === '' ? part : `${part} > ${selector}`
    if (isUnique(selector)) return selector
  }
  return `body > ${selector}`
}
