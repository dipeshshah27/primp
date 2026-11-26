/**
 * Pure CSS text helpers for the style reader: splitting selector lists, specificity, resolving
 * nested selectors, parsing a declaration block, and picking the declaration that wins.
 *
 * "Good enough for the common cases" is the bar: `!important`, then inline style, then cascade
 * layers, specificity and source order. Scoping (`@scope`) proximity is not modelled.
 */

import type { ElementState } from '@primp/protocol/change'

export type Specificity = readonly [ids: number, classes: number, types: number]

/** Index just past the string that starts at `start` (a quote character). */
function skipString(text: string, start: number): number {
  const quote = text[start]
  let i = start + 1
  while (i < text.length && text[i] !== quote) i += text[i] === '\\' ? 2 : 1
  return i + 1
}

/** Index just past the bracket group that opens at `start` (`(` or `[`). */
function skipGroup(text: string, start: number): number {
  let depth = 0
  let i = start
  while (i < text.length) {
    const ch = text[i]!
    if (ch === '\\') i += 2
    else if (ch === '"' || ch === "'") i = skipString(text, i)
    else {
      if (ch === '(' || ch === '[') depth++
      else if (ch === ')' || ch === ']') depth--
      i++
      if (depth === 0) return i
    }
  }
  return text.length
}

/** Splits at top-level occurrences of `separator`: not inside brackets or strings. */
export function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = []
  let start = 0
  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    if (ch === '\\') i += 2
    else if (ch === '"' || ch === "'") i = skipString(text, i)
    else if (ch === '(' || ch === '[') i = skipGroup(text, i)
    else if (ch === separator) {
      parts.push(text.slice(start, i))
      start = ++i
    } else i++
  }
  parts.push(text.slice(start))
  return parts.map((part) => part.trim()).filter((part) => part !== '')
}

export const splitSelectorList = (text: string): string[] => splitTopLevel(text, ',')

const LEGACY_PSEUDO_ELEMENTS = new Set(['before', 'after', 'first-line', 'first-letter'])
const LIST_PSEUDO_CLASSES = new Set(['is', 'not', 'has', 'matches', '-webkit-any', '-moz-any'])
const DYNAMIC_STATES = new Set(['hover', 'active', 'focus', 'focus-visible', 'focus-within'])
/** The states an edit can be made for, in the order a stylesheet usually writes them. */
export const ELEMENT_STATES: readonly ElementState[] = ['hover', 'focus', 'focus-visible', 'active']

interface Scan {
  spec: [number, number, number]
  pseudoElement: boolean
  dynamic: boolean
  /** Editable states the selector asks for, outside `:not()` and `:has()`. */
  states: Set<string>
  /** A transient state is mentioned somewhere, at any depth. */
  anyState: boolean
  /** See `StateNeeds.beyond`. */
  beyond: boolean
}

function scan(selector: string): Scan {
  const out: Scan = { spec: [0, 0, 0], pseudoElement: false, dynamic: false, states: new Set(), anyState: false, beyond: false }
  const absorb = (inner: Scan, negated: boolean): void => {
    if (!inner.anyState) return
    out.anyState = true
    if (negated || inner.beyond) out.beyond = true
    else for (const state of inner.states) out.states.add(state)
  }
  const n = selector.length
  let i = 0
  const ident = (): string => {
    const start = i
    while (i < n) {
      const ch = selector[i]!
      if (ch === '\\') i += 2
      else if (/[\w-]/.test(ch) || ch.charCodeAt(0) > 0x7f) i++
      else break
    }
    return selector.slice(start, i).toLowerCase()
  }
  while (i < n) {
    const ch = selector[i]!
    if (ch === '#') {
      i++
      ident()
      out.spec[0]++
    } else if (ch === '.') {
      i++
      ident()
      out.spec[1]++
    } else if (ch === '[') {
      i = skipGroup(selector, i)
      out.spec[1]++
    } else if (ch === ':') {
      i++
      const double = selector[i] === ':'
      if (double) i++
      const name = ident()
      let args: string | undefined
      if (selector[i] === '(') {
        const end = skipGroup(selector, i)
        args = selector.slice(i + 1, end - 1)
        i = end
      }
      if (double || LEGACY_PSEUDO_ELEMENTS.has(name)) {
        out.spec[2]++
        out.pseudoElement = true
      } else if (name === 'where') {
        // Zero by definition; the states inside still count.
        if (args !== undefined) for (const part of splitSelectorList(args)) absorb(scan(part), false)
      } else if (args !== undefined && LIST_PSEUDO_CLASSES.has(name)) {
        let best: Specificity = [0, 0, 0]
        for (const part of splitSelectorList(args)) {
          const inner = scan(part)
          if (compareSpecificity(inner.spec, best) > 0) best = inner.spec
          if (name !== 'not' && name !== 'has' && inner.dynamic) out.dynamic = true
          absorb(inner, name === 'not' || name === 'has')
        }
        out.spec[0] += best[0]
        out.spec[1] += best[1]
        out.spec[2] += best[2]
      } else {
        out.spec[1]++
        if (DYNAMIC_STATES.has(name)) {
          out.dynamic = true
          out.anyState = true
          if (name === 'focus-within') out.beyond = true
          else out.states.add(name)
        }
      }
    } else if (ch === '*' || ch === '&' || ch === '|' || ch === '>' || ch === '+' || ch === '~' || /\s/.test(ch)) {
      i++
    } else if (ch === '\\' || /[\w-]/.test(ch) || ch.charCodeAt(0) > 0x7f) {
      ident()
      out.spec[2]++
    } else {
      i++
    }
  }
  return out
}

/** Specificity of ONE complex selector (not a list). */
export function specificityOf(selector: string): Specificity {
  return scan(selector).spec
}

/** Whether the selector styles a pseudo-element (`::before`, `:after`, `::placeholder`) and not the element itself. */
export function hasPseudoElement(selector: string): boolean {
  return scan(selector).pseudoElement
}

/** Whether the selector only applies in a transient state (`:hover`, `:active`, `:focus`...). */
export function hasDynamicState(selector: string): boolean {
  return scan(selector).dynamic
}

export interface StateNeeds {
  /** The states ONE complex selector asks for (`.btn:hover:focus` asks for two), in the order of `ELEMENT_STATES`. */
  states: ElementState[]
  /** The selector mentions a transient state at all. */
  any: boolean
  /**
   * It depends on a state in a way the dock does not model: `:focus-within`, or a state inside
   * `:not()` or `:has()`. Such a selector is never treated as a rule "for" a state.
   */
  beyond: boolean
}

/** Which interaction states ONE complex selector (not a list) needs before it can match. */
export function statesOf(selector: string): StateNeeds {
  const found = scan(selector)
  return { states: ELEMENT_STATES.filter((state) => found.states.has(state)), any: found.anyState, beyond: found.beyond }
}

/** The pseudo-classes that hold while `state` does: `:active` is only reached through `:hover`, a visible focus is still a focus. */
export function activeStates(state: ElementState | null | undefined): ElementState[] {
  switch (state) {
    case 'hover':
      return ['hover']
    case 'active':
      return ['hover', 'active']
    case 'focus':
      return ['focus']
    case 'focus-visible':
      return ['focus', 'focus-visible']
    default:
      return []
  }
}

const NEVER = ':not(*)'
/** In `el.matches()`, `:scope` is `el`: these stand for "the element under test" and "it or one of its ancestors". */
const SELF = ':scope'
const SELF_OR_ABOVE = ':is(:scope, :has(:scope))'

/**
 * ONE complex selector as it reads while no transient state holds anywhere on the page: every
 * `:hover`, `:focus`... becomes a selector that matches nothing. `el.matches(atRest(s))` is then
 * the same whatever the pointer and the focus are doing at that moment.
 */
export function atRest(selector: string): string {
  let text = selector
  for (const state of DYNAMIC_STATES) text = replaceState(text, state, NEVER) ?? text
  return text
}

/**
 * ONE complex selector as it reads, for `el.matches()`, while `el` is in every one of `states`
 * and nothing else is: `:hover` and `:active` hold for `el` and its ancestors (as the real ones
 * do), `:focus` and `:focus-visible` for `el` alone, every other transient state for nothing.
 * So `.card:hover .btn` matches a button inside the card, and `.a:hover + .b` does not match `.b`.
 */
export function inStates(selector: string, states: readonly ElementState[]): string {
  let text = selector
  for (const state of DYNAMIC_STATES) {
    // The focus is "within" the focused element and everything above it.
    const holds = (states as readonly string[]).includes(state === 'focus-within' ? 'focus' : state)
    text = replaceState(text, state, !holds ? NEVER : state === 'focus' || state === 'focus-visible' ? SELF : SELF_OR_ABOVE) ?? text
  }
  return text
}

/**
 * ONE complex selector with every `:<state>` written as `replacement` instead: with
 * `replaceState('.btn:hover > i', 'hover', '[x]')` the result is `.btn[x] > i`. Used to make a
 * rule apply to an element that is marked as being in a state without the pointer or the focus
 * being there. Looks inside `:is()`, `:where()`, `:not()` and `:has()` too. Returns null when the
 * selector does not mention the state, so the caller can leave such rules alone.
 */
export function replaceState(selector: string, state: string, replacement: string): string | null {
  const n = selector.length
  let out = ''
  let found = false
  let i = 0
  while (i < n) {
    const ch = selector[i]!
    if (ch === '\\') {
      out += selector.slice(i, i + 2)
      i += 2
    } else if (ch === '"' || ch === "'") {
      const end = skipString(selector, i)
      out += selector.slice(i, end)
      i = end
    } else if (ch === '[') {
      const end = skipGroup(selector, i)
      out += selector.slice(i, end)
      i = end
    } else if (ch === ':') {
      const start = i++
      const double = selector[i] === ':'
      if (double) i++
      const nameStart = i
      while (i < n && (selector[i] === '\\' || /[\w-]/.test(selector[i]!) || selector.charCodeAt(i) > 0x7f)) i += selector[i] === '\\' ? 2 : 1
      const name = selector.slice(nameStart, i).toLowerCase()
      let args: string | undefined
      if (selector[i] === '(') {
        const end = skipGroup(selector, i)
        args = selector.slice(i + 1, end - 1)
        i = end
      }
      if (!double && args === undefined && name === state) {
        out += replacement
        found = true
      } else if (!double && args !== undefined && (name === 'where' || LIST_PSEUDO_CLASSES.has(name))) {
        const inner = splitSelectorList(args).map((part) => {
          const replaced = replaceState(part, state, replacement)
          if (replaced !== null) found = true
          return replaced ?? part
        })
        out += `:${name}(${inner.join(', ')})`
      } else {
        out += selector.slice(start, i)
      }
    } else {
      out += ch
      i++
    }
  }
  return found ? out : null
}

/**
 * ONE complex selector without its pseudo-elements and transient states: `.btn:hover::before`
 * becomes `.btn`. What is left matches every element the selector can style, whatever the
 * pointer and the focus are doing. A compound that consisted of nothing else becomes `*`
 * (`.menu > :hover` -> `.menu > *`). The alternatives inside `:is()`, `:where()`, `:has()` and
 * `:not()` are treated the same way; `:not(:hover)` is dropped, since `:not(*)` would match nothing.
 */
export function withoutStates(selector: string): string {
  const n = selector.length
  let out = ''
  let i = 0
  /** A compound is being written of which everything so far was dropped. */
  let bare = false
  const keep = (text: string, continues: boolean): void => {
    if (bare && !continues) out += '*'
    bare = false
    out += text
  }
  while (i < n) {
    const ch = selector[i]!
    if (ch === '\\') {
      keep(selector.slice(i, i + 2), true)
      i += 2
    } else if (ch === '"' || ch === "'") {
      const end = skipString(selector, i)
      keep(selector.slice(i, end), true)
      i = end
    } else if (ch === '[') {
      const end = skipGroup(selector, i)
      keep(selector.slice(i, end), true)
      i = end
    } else if (ch === ':') {
      const start = i++
      const double = selector[i] === ':'
      if (double) i++
      const nameStart = i
      while (i < n && (selector[i] === '\\' || /[\w-]/.test(selector[i]!) || selector.charCodeAt(i) > 0x7f)) i += selector[i] === '\\' ? 2 : 1
      const name = selector.slice(nameStart, i).toLowerCase()
      let args: string | undefined
      if (selector[i] === '(') {
        const end = skipGroup(selector, i)
        args = selector.slice(i + 1, end - 1)
        i = end
      }
      let kept: string | null = selector.slice(start, i)
      if (double || LEGACY_PSEUDO_ELEMENTS.has(name) || DYNAMIC_STATES.has(name)) {
        kept = null
      } else if (args !== undefined && (name === 'where' || LIST_PSEUDO_CLASSES.has(name))) {
        const inner = splitSelectorList(args)
          .map((part) => [part, withoutStates(part)] as const)
          .filter(([part, stripped]) => stripped !== '' && !(name === 'not' && stripped === '*' && part !== '*'))
          .map(([, stripped]) => stripped)
        kept = inner.length === 0 ? null : `:${name}(${inner.join(', ')})`
      }
      if (kept !== null) keep(kept, true)
      else if (out === '' || /[\s>+~,]$/.test(out)) bare = true
    } else {
      keep(ch, !/[\s>+~,]/.test(ch))
      i++
    }
  }
  keep('', false)
  return out.trim()
}

export function compareSpecificity(a: Specificity, b: Specificity): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

/**
 * The selector of a nested rule written out in full: `&` stands for the parent selector, and a
 * nested selector without `&` is a descendant of it.
 */
export function resolveNested(parent: string, child: string): string {
  const scope = `:is(${parent})`
  return splitSelectorList(child)
    .map((part) => {
      let out = ''
      let found = false
      let i = 0
      while (i < part.length) {
        const ch = part[i]!
        if (ch === '\\') {
          out += part.slice(i, i + 2)
          i += 2
        } else if (ch === '"' || ch === "'") {
          const end = skipString(part, i)
          out += part.slice(i, end)
          i = end
        } else if (ch === '[') {
          const end = skipGroup(part, i)
          out += part.slice(i, end)
          i = end
        } else if (ch === '&') {
          out += scope
          found = true
          i++
        } else {
          out += ch
          i++
        }
      }
      if (found) return out
      return /^[>+~]/.test(part) ? `${scope} ${part}` : `${scope} ${part}`
    })
    .join(', ')
}

export interface ParsedDeclaration {
  property: string
  value: string
  important: boolean
}

/** Parses the text of a declaration block (`CSSStyleDeclaration.cssText`). */
export function parseDeclarations(cssText: string): ParsedDeclaration[] {
  const out: ParsedDeclaration[] = []
  for (const part of splitTopLevel(cssText, ';')) {
    const colon = part.indexOf(':')
    if (colon <= 0) continue
    const property = part.slice(0, colon).trim()
    let value = part.slice(colon + 1).trim()
    const important = /!\s*important$/i.test(value)
    if (important) value = value.replace(/\s*!\s*important$/i, '')
    if (property === '' || value === '') continue
    out.push({ property: property.startsWith('--') ? property : property.toLowerCase(), value, important })
  }
  return out
}

/** Where a declaration stands in the cascade. */
export interface CascadeRank {
  /** From the `style` attribute. */
  inline: boolean
  important: boolean
  /** Position of the rule's cascade layer; `Infinity` for a rule outside every layer. */
  layer: number
  specificity: Specificity
  /** Source order: larger is later. */
  order: number
}

/** Positive when `a` beats `b`. */
export function compareCascade(a: CascadeRank, b: CascadeRank): number {
  if (a.important !== b.important) return a.important ? 1 : -1
  if (a.inline !== b.inline) return a.inline ? 1 : -1
  if (a.layer !== b.layer) {
    // Later layers (and unlayered rules) win for normal declarations; `!important` turns that around.
    const later = a.layer > b.layer ? 1 : -1
    return a.important ? -later : later
  }
  return compareSpecificity(a.specificity, b.specificity) || a.order - b.order
}

export function pickWinner<T extends CascadeRank>(entries: readonly T[]): T | undefined {
  let best: T | undefined
  for (const entry of entries) if (best === undefined || compareCascade(entry, best) > 0) best = entry
  return best
}

/** `backgroundColor` -> `background-color`, `cssFloat` -> `float`, `webkitLineClamp` -> `-webkit-line-clamp`. */
export function kebab(name: string): string {
  if (name.startsWith('--') || name.includes('-')) return name
  if (name === 'cssFloat') return 'float'
  const dashed = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
  return /^(webkit|moz|ms|o)-/.test(dashed) ? `-${dashed}` : dashed
}
