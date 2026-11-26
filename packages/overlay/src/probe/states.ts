/**
 * Puts an element into `:hover`, `:focus`, `:focus-visible` or `:active` as far as CSS is
 * concerned, without the pointer or the focus being there and without the DevTools protocol.
 *
 * How: the element (and, for the states that reach upwards, its ancestors) gets a marker
 * attribute, and every readable rule of the page that mentions the state gets a second selector
 * in which the pseudo-class is replaced by that marker:
 *
 *   .btn:hover { ... }   becomes   .btn:hover, .btn[data-primp-force~="hover"] { ... }
 *
 * The rule stays where it is, so its order, its `@media`, its `@layer` and its specificity (an
 * attribute selector weighs the same as a pseudo-class) are exactly the page's own. `release()`
 * puts every selector back.
 *
 * What this cannot do, and says so through `unreadable` or simply by not matching:
 *   - rules in stylesheets the page may not read (another origin);
 *   - behaviour made by script (a class added on mouseenter): nothing runs here;
 *   - the browser's own default styles for a state (the focus ring of a control).
 */

import { FORCE_ATTR, ignoreSheet } from './styles.ts'
import { replaceState, splitSelectorList } from './specificity.ts'

export type ForcedState = 'hover' | 'focus' | 'focus-visible' | 'active'
// Declared in styles.ts, which has to tell the marker selectors from the page's own.
export { FORCE_ATTR }

export interface Forced {
  state: ForcedState
  element: Element
  /** Rules that were given the marker selector. 0: the page has no readable rule for this state. */
  rules: number
  /** Stylesheets that could not be read; a rule for the state may be in one of them. */
  unreadable: number
  /** Looks at the stylesheets again (a dev server replaced one) and marks what is new. */
  refresh(): void
  release(): void
}

/** The pseudo-classes that hold while `state` does, each with the elements they hold for. */
function tokensFor(state: ForcedState): { self: string[]; ancestors: string[] } {
  switch (state) {
    // The pointer is over every ancestor too.
    case 'hover':
      return { self: ['hover'], ancestors: ['hover'] }
    case 'active':
      return { self: ['active', 'hover'], ancestors: ['active', 'hover'] }
    case 'focus':
      return { self: ['focus', 'focus-within'], ancestors: ['focus-within'] }
    // Focus that shows a ring is still focus.
    case 'focus-visible':
      return { self: ['focus', 'focus-visible', 'focus-within'], ancestors: ['focus-within'] }
  }
}

const marker = (token: string): string => `[${FORCE_ATTR}~="${token}"]`

const markSelf = (reason: string): void => {
  try {
    ;(window as unknown as { __primp?: { markSelf(reason: string): void } }).__primp?.markSelf(reason)
  } catch {
    // The recorder is optional.
  }
}

let current: Forced | undefined

/** The state being forced right now, if any. One at a time per document. */
export function forcedNow(): Forced | undefined {
  return current
}

export function forceState(element: Element, state: ForcedState, doc: Document = element.ownerDocument): Forced {
  current?.release()
  const tokens = tokensFor(state)
  const every = [...new Set([...tokens.self, ...tokens.ancestors])]
  const marked: { el: Element; had: string | null }[] = []
  const rewritten = new Map<CSSStyleRule, string>()
  let unreadable = 0

  // Values are read at their end state, not part of the way through a transition into it.
  const calm = new CSSStyleSheet()
  ignoreSheet(calm)
  calm.replaceSync(`[${FORCE_ATTR}] { transition: none !important }`)

  const visit = (rules: CSSRuleList): void => {
    for (const rule of rules) {
      if ('selectorText' in rule && typeof (rule as CSSStyleRule).selectorText === 'string') {
        const styleRule = rule as CSSStyleRule
        if (!rewritten.has(styleRule)) {
          const original = styleRule.selectorText
          const extra: string[] = []
          for (const part of splitSelectorList(original)) {
            let replaced: string | null = null
            let text = part
            for (const token of every) {
              const next = replaceState(text, token, marker(token))
              if (next !== null) {
                replaced = next
                text = next
              }
            }
            if (replaced !== null) extra.push(replaced)
          }
          if (extra.length > 0) {
            announce()
            try {
              styleRule.selectorText = `${original}, ${extra.join(', ')}`
              // A selector the browser refuses leaves the text as it was.
              if (styleRule.selectorText !== original) rewritten.set(styleRule, original)
            } catch {
              // Left alone.
            }
          }
        }
      }
      const inner = (rule as CSSGroupingRule).cssRules as CSSRuleList | undefined
      if (inner !== undefined && inner.length > 0) visit(inner)
    }
  }

  // A rewritten selector restyles the page: the layout-shift recorder hears of it first, once per pass.
  let announced = false
  const announce = (): void => {
    if (announced) return
    announced = true
    markSelf(`force :${state}`)
  }

  const scan = (): void => {
    announced = false
    unreadable = 0
    for (const sheet of [...doc.styleSheets, ...doc.adoptedStyleSheets]) {
      if (sheet === calm || sheet.disabled) continue
      try {
        visit(sheet.cssRules)
      } catch {
        unreadable += 1
      }
    }
  }

  const mark = (el: Element, add: string[]): void => {
    if (add.length === 0) return
    const had = el.getAttribute(FORCE_ATTR)
    marked.push({ el, had })
    el.setAttribute(FORCE_ATTR, [...new Set([...(had ?? '').split(/\s+/).filter(Boolean), ...add])].join(' '))
  }

  scan()
  announce()
  doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, calm]
  mark(element, tokens.self)
  for (let up = element.parentElement; up !== null; up = up.parentElement) mark(up, tokens.ancestors)

  let released = false
  const forced: Forced = {
    state,
    element,
    get rules() {
      return rewritten.size
    },
    get unreadable() {
      return unreadable
    },
    refresh: () => {
      if (!released) scan()
    },
    release: () => {
      if (released) return
      released = true
      markSelf(`release :${state}`)
      for (const { el, had } of marked.reverse()) {
        if (had === null) el.removeAttribute(FORCE_ATTR)
        else el.setAttribute(FORCE_ATTR, had)
      }
      for (const [rule, original] of rewritten) {
        try {
          rule.selectorText = original
        } catch {
          // The sheet is gone; nothing to restore.
        }
      }
      doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((sheet) => sheet !== calm)
      if (current === forced) current = undefined
    },
  }
  current = forced
  return forced
}

/** Runs `read` with the element forced into `state`, then releases. Whatever was forced before is restored. */
export function withState<T>(element: Element, state: ForcedState, read: (forced: Forced) => T): T {
  const before = current
  const forced = forceState(element, state)
  try {
    return read(forced)
  } finally {
    forced.release()
    if (before !== undefined) forceState(before.element, before.state)
  }
}
