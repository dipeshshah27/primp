/**
 * Pure CSS text helpers for the style reader: splitting selector lists, specificity, resolving
 * nested selectors, parsing a declaration block, and picking the declaration that wins.
 *
 * "Good enough for the common cases" is the bar: inline style first, then `!important`, then
 * cascade layers, specificity and source order. Scoping (`@scope`) proximity is not modelled.
 */

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

interface Scan {
  spec: [number, number, number]
  pseudoElement: boolean
  dynamic: boolean
}

function scan(selector: string): Scan {
  const out: Scan = { spec: [0, 0, 0], pseudoElement: false, dynamic: false }
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
        // Zero by definition.
      } else if (args !== undefined && LIST_PSEUDO_CLASSES.has(name)) {
        let best: Specificity = [0, 0, 0]
        for (const part of splitSelectorList(args)) {
          const inner = scan(part)
          if (compareSpecificity(inner.spec, best) > 0) best = inner.spec
          if (name !== 'not' && name !== 'has' && inner.dynamic) out.dynamic = true
        }
        out.spec[0] += best[0]
        out.spec[1] += best[1]
        out.spec[2] += best[2]
      } else {
        out.spec[1]++
        if (DYNAMIC_STATES.has(name)) out.dynamic = true
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
