/**
 * Arrow-key nudging of a number inside a CSS value: `12px` -> `13px`, `0 auto` -> `1 auto`,
 * `1.5rem` -> `2.5rem`. Pure.
 */

export interface Nudged {
  text: string
  /** Range of the changed number in `text`, for keeping it selected. */
  start: number
  end: number
}

// A number that is not part of a word, a hex colour or a longer number.
const NUMBER = /(?<![\w#.])-?(?:\d+\.?\d*|\.\d+)/g

/**
 * Adds `delta` to the number under the caret, or to the nearest number when the caret is not on
 * one. Returns null when the value contains no number.
 */
export function nudge(text: string, caret: number, delta: number): Nudged | null {
  let best: RegExpExecArray | undefined
  let bestDistance = Infinity
  for (const match of text.matchAll(NUMBER)) {
    const start = match.index
    const end = start + match[0].length
    const distance = caret < start ? start - caret : caret > end ? caret - end : 0
    if (distance < bestDistance) {
      best = match
      bestDistance = distance
    }
  }
  if (best === undefined) return null
  const raw = best[0]
  const decimals = raw.includes('.') ? raw.length - raw.indexOf('.') - 1 : 0
  const value = Number(raw) + delta
  if (!Number.isFinite(value)) return null
  // Rounding removes binary noise (0.1 + 0.2); trailing zeros of a decimal step are not kept.
  const next = decimals === 0 ? String(Math.round(value)) : String(Number(value.toFixed(decimals)))
  const start = best.index
  return { text: text.slice(0, start) + next + text.slice(start + raw.length), start, end: start + next.length }
}
