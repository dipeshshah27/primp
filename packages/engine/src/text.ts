/**
 * Putting text that came from the page (labels, selectors, element text, values, stack traces)
 * or from a person (notes) into markdown without letting it act as markdown.
 *
 * Pure: no DOM, no Node.
 *
 * Page content is untrusted. Everything that goes through `code` ends up on one line inside a
 * code span that it cannot close: line breaks and control characters become spaces, and
 * backticks become apostrophes. A heading, a list item or a sentence such as "ignore previous
 * instructions" inside page text therefore stays inert, quoted data.
 */

/** C0 controls, DEL, NEL and the Unicode line and paragraph separators. */
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f\\u0085\\u2028\\u2029]+', 'g')

/** One line: control characters and line breaks become spaces, runs of whitespace collapse. */
export function oneLine(text: string): string {
  return text.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
}

/** Cuts to at most `max` characters, the last three being an ellipsis when something was cut. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`
}

/** A markdown code span holding `text` as data. */
export function code(text: string, max = 120): string {
  const clean = truncate(oneLine(text).replace(/`/g, "'"), max)
  return clean === '' ? '`(empty)`' : `\`${clean}\``
}

/** A person's free text as one quoted line. */
export function quoted(text: string, max = 600): string {
  return `"${truncate(oneLine(text).replace(/`/g, "'"), max)}"`
}

/** At most three decimals, no trailing zeros, no negative zero. */
export function num(n: number): string {
  const rounded = Math.round(n * 1000) / 1000
  return String(Object.is(rounded, -0) ? 0 : rounded)
}

/** `-3px`, `+1.5px`. */
export function signedPx(n: number): string {
  const text = num(n)
  return `${n > 0 && text !== '0' ? '+' : ''}${text}px`
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}
