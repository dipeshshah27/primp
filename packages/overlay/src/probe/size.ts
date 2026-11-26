/**
 * Resizing: from the border-box size a handle drag produces to the CSS `width` / `height` that
 * gives the element that size, and whether a size can apply to the element at all.
 *
 * `cssSizeFor` is pure, so the conversion is tested without a browser.
 */

export interface BoxModel {
  /** `content-box` or `border-box`. */
  boxSizing: string
  /** Padding plus border along the axis, in px (left + right for width, top + bottom for height). */
  paddingAndBorder: number
}

/**
 * The CSS length, in whole px, that gives the element a border box of `borderBox` px along one
 * axis. `content-box` (the CSS default): the padding and the border are added by the browser, so
 * they are taken off. `border-box`: the value is the border box itself, but never below padding
 * plus border, which the browser would not go under anyway.
 */
export function cssSizeFor(borderBox: number, box: BoxModel): number {
  const extra = Number.isFinite(box.paddingAndBorder) ? Math.max(0, box.paddingAndBorder) : 0
  const wanted = Math.max(0, borderBox)
  if (box.boxSizing === 'border-box') return Math.round(Math.max(wanted, extra))
  return Math.max(0, Math.round(wanted - extra))
}

const num = (value: string): number => {
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? n : 0
}

/** Padding and border along `axis`, from a computed style. */
export function boxModelOf(style: CSSStyleDeclaration, axis: 'width' | 'height'): BoxModel {
  const sides = axis === 'width' ? (['left', 'right'] as const) : (['top', 'bottom'] as const)
  let paddingAndBorder = 0
  for (const side of sides) paddingAndBorder += num(style.getPropertyValue(`padding-${side}`)) + num(style.getPropertyValue(`border-${side}-width`))
  return { boxSizing: style.boxSizing, paddingAndBorder }
}

/** Elements whose box is the content they show: `width` and `height` apply to them even when they are inline. */
const REPLACED = new Set(['img', 'video', 'canvas', 'iframe', 'embed', 'object', 'input', 'textarea', 'select', 'audio', 'svg', 'picture', 'meter', 'progress'])

/** Why `width` / `height` cannot apply to `element`, in words; null when they can. */
export function resizeRefusal(element: Element, style: CSSStyleDeclaration = getComputedStyle(element)): string | null {
  const display = style.display
  if (display === 'none' || display === 'contents' || element.getClientRects().length === 0) return 'This element has no box on the page to resize.'
  if ((display === 'inline' || display === 'ruby' || display === 'ruby-text') && !REPLACED.has(element.localName)) {
    return `This ${element.localName} is an inline element: width and height do not apply to it. Make it inline-block or block first (display), or resize its container.`
  }
  return null
}
