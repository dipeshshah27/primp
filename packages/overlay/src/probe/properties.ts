/**
 * What the browser knows about CSS properties: the full list for autocomplete, value
 * validation, and the longhands of a shorthand. Everything comes from the running browser, so
 * the list is always the one the page can actually use.
 */

import { kebab } from './specificity.ts'

let supported: string[] | undefined

/**
 * Every CSS property this browser supports, shorthands included, in kebab case, standard names
 * before vendor-prefixed ones. Enumerating a computed style would omit the shorthands; the
 * keys of an element's `style` object do not.
 */
export function supportedProperties(): string[] {
  if (supported !== undefined) return supported
  const seen = new Set<string>()
  const style = document.documentElement.style
  for (const key in style) {
    // Methods, `length`, `cssText`, `parentRule` and numeric indexes are not properties.
    if (/^\d+$/.test(key) || key === 'cssText' || key === 'length' || key === 'parentRule') continue
    const name = kebab(key)
    if (seen.has(name)) continue
    try {
      if (CSS.supports(name, 'initial')) seen.add(name)
    } catch {
      // Not a property name.
    }
  }
  supported = [...seen].sort((a, b) => Number(a.startsWith('-')) - Number(b.startsWith('-')) || (a < b ? -1 : a > b ? 1 : 0))
  return supported
}

export const isCustomProperty = (property: string): boolean => property.startsWith('--')

export function isSupportedProperty(property: string): boolean {
  if (isCustomProperty(property)) return property.length > 2
  try {
    return CSS.supports(property, 'initial')
  } catch {
    return false
  }
}

/** Whether the browser accepts `value` for `property`. `!important` is not part of a value here. */
export function isValidValue(property: string, value: string): boolean {
  const text = value.trim()
  if (text === '' || /[;{}]/.test(text) || /!\s*important/i.test(text)) return false
  if (isCustomProperty(property)) return true
  try {
    return CSS.supports(property, text)
  } catch {
    return false
  }
}

const longhandCache = new Map<string, string[]>()

/**
 * The longhand properties a shorthand sets, in the browser's order; empty for a longhand or a
 * custom property. Found by setting the shorthand on a detached element and reading what appears.
 */
export function longhandsOf(property: string): string[] {
  if (isCustomProperty(property)) return []
  let known = longhandCache.get(property)
  if (known === undefined) {
    known = []
    try {
      const style = document.createElement('div').style
      style.setProperty(property, 'initial')
      for (let i = 0; i < style.length; i++) {
        const name = style.item(i)
        if (name !== '' && name !== property) known.push(name)
      }
    } catch {
      // Unknown property: no longhands.
    }
    longhandCache.set(property, known)
  }
  return known
}

/** How an element's text flows: what its logical properties (`padding-inline-start`, ...) map to. */
export interface Flow {
  /** `ltr` (default) or `rtl`. */
  direction?: string
  /** A vertical writing mode: logical sides are not mapped (they turn with the text). */
  vertical?: boolean
}

const LOGICAL_SIDE = /^(margin|padding|inset|border|scroll-margin|scroll-padding)-(inline|block)-(start|end)(-(?:width|style|color))?$/
const LOGICAL_SIZE: Record<string, string> = {
  'inline-size': 'width',
  'block-size': 'height',
  'min-inline-size': 'min-width',
  'min-block-size': 'min-height',
  'max-inline-size': 'max-width',
  'max-block-size': 'max-height',
}

/**
 * The physical property a logical one sets on an element with this flow (`padding-inline-start`
 * is `padding-left` in a left-to-right horizontal text); any other property is returned as it is.
 * In a vertical writing mode the sides are left logical.
 */
export function physicalOf(property: string, flow: Flow = {}): string {
  const size = LOGICAL_SIZE[property]
  if (size !== undefined) return flow.vertical === true ? property : size
  const side = LOGICAL_SIDE.exec(property)
  if (side === null || flow.vertical === true) return property
  const [, box, axis, edge, part = ''] = side
  const rtl = flow.direction === 'rtl'
  const physical = axis === 'block' ? (edge === 'start' ? 'top' : 'bottom') : (edge === 'start') !== rtl ? 'left' : 'right'
  return box === 'inset' ? physical : `${box}-${physical}${part}`
}

/** Everything `property` sets, as physical longhands (and itself): `padding-inline` is padding-left and padding-right. */
export function physicalSet(property: string, flow: Flow = {}): Set<string> {
  const out = new Set<string>()
  for (const name of [property, ...longhandsOf(property)]) {
    out.add(name)
    out.add(physicalOf(name, flow))
  }
  return out
}

/** Whether a declaration of `declared` sets (some of) what `property` names, logical and physical names alike. */
export function setsProperty(declared: string, property: string, flow: Flow = {}): boolean {
  if (declared === property) return true
  const wanted = physicalSet(property, flow)
  for (const name of physicalSet(declared, flow)) if (wanted.has(name)) return true
  return false
}

/** The properties to compare for `property`: its longhands, or itself. */
export function comparableProperties(property: string): string[] {
  const longhands = longhandsOf(property)
  return longhands.length > 0 ? longhands : [property]
}

/**
 * Suggestions for a partly typed property name: names that start with it first, then names that
 * contain it; within each group the shorter name first (`padding` before `padding-top` before
 * `padding-block-start`), which puts the common properties at the top.
 */
export function suggestProperties(typed: string, extra: readonly string[] = [], limit = 10): string[] {
  const query = typed.trim().toLowerCase()
  if (query === '') return []
  const starts: string[] = []
  const contains: string[] = []
  for (const name of new Set([...extra, ...supportedProperties()])) {
    const at = name.toLowerCase().indexOf(query)
    if (at === 0) starts.push(name)
    else if (at > 0) contains.push(name)
  }
  const byLength = (a: string, b: string): number => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)
  return [...starts.sort(byLength), ...contains.sort(byLength)].slice(0, limit)
}

/** Computed value of a property; for a shorthand the browser's own serialisation, which is empty when its longhands do not combine. */
export function computedValue(el: Element, property: string, style: CSSStyleDeclaration = getComputedStyle(el)): string {
  return style.getPropertyValue(property).trim()
}

/** Computed values of the longhands of `property`; undefined when it is not a shorthand. */
export function computedLonghands(el: Element, property: string, style: CSSStyleDeclaration = getComputedStyle(el)): Record<string, string> | undefined {
  const longhands = longhandsOf(property)
  if (longhands.length === 0) return undefined
  const out: Record<string, string> = {}
  for (const name of longhands) out[name] = style.getPropertyValue(name).trim()
  return out
}
