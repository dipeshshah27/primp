/**
 * Reading and comparing COMPUTED style strings (`getComputedStyle` output).
 *
 * Pure: no DOM, no Node.
 *
 * A value is flattened into a list of leaves: lengths (computed lengths are px), plain numbers,
 * percentages, other dimensions (`0.3s`, `45deg`), colours, keywords and quoted strings.
 * Structure is kept as keyword leaves (`,`, `/`, `name(` and `)`), so two values have the same
 * shape exactly when their leaf lists have the same length and the same kinds in the same order.
 * That makes `4px 8px`, shadows, gradients, transitions and transform lists comparable leaf by
 * leaf without knowing the grammar of each property.
 *
 * Three cases get their own treatment:
 *   - `font-family`: a list of names compared case-insensitively and ignoring quotes;
 *   - transforms: `none`, `matrix()` and `matrix3d()` are compared as matrices, entry by entry
 *     (translations as lengths, the rest as numbers), so `none` equals the identity matrix;
 *   - a bare `0` equals `0px`.
 */

import { colorDistance, isColorFunction, parseColor } from './color.ts'
import type { RGBA } from './color.ts'

/** What counts as equal. Lengths in px, numbers and percentages as plain differences, colours as `colorDistance`. */
export const TOLERANCE = {
  lengthPx: 0.5,
  number: 0.01,
  percent: 0.01,
  color: 1,
} as const

export type LeafKind = 'length' | 'number' | 'percent' | 'dimension' | 'color' | 'keyword' | 'string' | 'font-family'

export interface Leaf {
  kind: LeafKind
  /** The text of this leaf as it appeared (keywords lower-cased). */
  text: string
  /** Lengths (px), numbers, percentages and dimensions. */
  num?: number
  /** Dimensions only: `s`, `deg`, `em`, ... */
  unit?: string
  color?: RGBA
  /** `font-family` only: names without quotes, lower case. */
  families?: string[]
}

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i
const DIMENSION = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z]+|%)$/i

/** Trimmed, with runs of whitespace collapsed to one space. */
export function normalizeValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

/** `12px` (or a bare `0`) to 12. Null for anything else, including other units. */
export function parseLength(value: string): number | null {
  const text = value.trim().toLowerCase()
  if (NUMBER.test(text)) return Number(text) === 0 ? 0 : null
  const match = DIMENSION.exec(text)
  return match !== null && match[2] === 'px' ? Number(match[1]) : null
}

/** A plain number such as a unitless line-height, an opacity or a font weight. */
export function parseNumber(value: string): number | null {
  const text = value.trim()
  return NUMBER.test(text) ? Number(text) : null
}

/** `50%` to 50. */
export function parsePercent(value: string): number | null {
  const match = DIMENSION.exec(value.trim())
  return match !== null && match[2] === '%' ? Number(match[1]) : null
}

/**
 * Splits at `separator` (a single character, or `' '` for any whitespace) where it is outside
 * parentheses and quotes. Empty pieces are dropped for whitespace, kept (trimmed) for others.
 */
export function splitTopLevel(value: string, separator: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote = ''
  let current = ''
  const isSpace = separator === ' '
  for (let i = 0; i < value.length; i++) {
    const ch = value[i] as string
    if (quote !== '') {
      current += ch
      if (ch === '\\' && i + 1 < value.length) current += value[++i] as string
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
    } else if (ch === '(') {
      depth++
      current += ch
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1)
      current += ch
    } else if (depth === 0 && (isSpace ? /\s/.test(ch) : ch === separator)) {
      if (!isSpace || current !== '') out.push(isSpace ? current : current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  if (!isSpace || current !== '') out.push(isSpace ? current : current.trim())
  return out
}

const unquote = (text: string): string => {
  const t = text.trim()
  const first = t[0]
  return t.length >= 2 && (first === '"' || first === "'") && t.endsWith(first) ? t.slice(1, -1) : t
}

/** A `font-family` list as names without quotes, lower case, inner whitespace collapsed. */
export function parseFontFamily(value: string): string[] {
  return splitTopLevel(value, ',')
    .map((name) => normalizeValue(unquote(name)).toLowerCase())
    .filter((name) => name !== '')
}

/**
 * `none`, `matrix(a, b, c, d, e, f)` or `matrix3d(16 numbers)` as a column-major 4x4 matrix
 * (16 numbers). Null for anything else.
 */
export function parseMatrix(value: string): number[] | null {
  const text = value.trim().toLowerCase()
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  if (text === 'none') return identity
  const match = /^(matrix|matrix3d)\(([^()]*)\)$/.exec(text)
  if (match === null) return null
  const parts = (match[2] ?? '').split(',').map((part) => part.trim())
  if (!parts.every((part) => NUMBER.test(part))) return null
  const n = parts.map(Number)
  if (match[1] === 'matrix3d') return n.length === 16 ? n : null
  if (n.length !== 6) return null
  const [a, b, c, d, e, f] = n as [number, number, number, number, number, number]
  return [a, b, 0, 0, c, d, 0, 0, 0, 0, 1, 0, e, f, 0, 1]
}

/** Indexes of the translation entries of a column-major 4x4 matrix: they are lengths, the rest are numbers. */
const MATRIX_LENGTHS = new Set([12, 13, 14])

const keyword = (text: string): Leaf => ({ kind: 'keyword', text })

function tokenLeaves(token: string, out: Leaf[]): void {
  const lower = token.toLowerCase()
  const first = token[0]
  if (first === '"' || first === "'") {
    out.push({ kind: 'string', text: unquote(token) })
    return
  }
  const open = token.indexOf('(')
  if (open > 0 && token.endsWith(')')) {
    const name = lower.slice(0, open)
    if (isColorFunction(name)) {
      const color = parseColor(token)
      if (color !== null) {
        out.push({ kind: 'color', text: lower, color })
        return
      }
    }
    if (name === 'url') {
      out.push({ kind: 'string', text: token })
      return
    }
    out.push(keyword(`${name}(`))
    valueLeaves(token.slice(open + 1, -1), out)
    out.push(keyword(')'))
    return
  }
  if (first === '#' || lower === 'transparent') {
    const color = parseColor(lower)
    if (color !== null) {
      out.push({ kind: 'color', text: lower, color })
      return
    }
  }
  if (NUMBER.test(token)) {
    out.push({ kind: 'number', text: lower, num: Number(token) })
    return
  }
  const dim = DIMENSION.exec(token)
  if (dim !== null) {
    const num = Number(dim[1])
    const unit = (dim[2] ?? '').toLowerCase()
    if (unit === 'px') out.push({ kind: 'length', text: lower, num })
    else if (unit === '%') out.push({ kind: 'percent', text: lower, num })
    else if (unit === 'ms') out.push({ kind: 'dimension', text: lower, num: num / 1000, unit: 's' })
    else out.push({ kind: 'dimension', text: lower, num, unit })
    return
  }
  // Named colours are not recognised here on purpose: computed values never contain them, and
  // `red` or `navy` can just as well be an animation or grid-area name.
  out.push(keyword(lower))
}

function valueLeaves(value: string, out: Leaf[]): void {
  const groups = splitTopLevel(value, ',')
  groups.forEach((group, index) => {
    if (index > 0) out.push(keyword(','))
    for (const piece of splitTopLevel(group, ' ')) {
      // A slash separates values in `font`, `grid-area`, `aspect-ratio`, `border-radius`.
      const parts = piece.includes('(') || piece[0] === '"' || piece[0] === "'" ? [piece] : piece.split(/(\/)/)
      for (const part of parts) {
        if (part === '') continue
        if (part === '/') out.push(keyword('/'))
        else tokenLeaves(part, out)
      }
    }
  })
}

/** Flattens a computed value into leaves. `property` switches on the `font-family` rule. */
export function flattenValue(value: string, property?: string): Leaf[] {
  const text = normalizeValue(value)
  if (property?.toLowerCase() === 'font-family') {
    return [{ kind: 'font-family', text, families: parseFontFamily(text) }]
  }
  const out: Leaf[] = []
  valueLeaves(text, out)
  return out
}

export interface LeafDiff {
  kind: LeafKind
  expected: Leaf
  actual: Leaf
  equal: boolean
  /** `actual - expected` for numeric kinds, `colorDistance` for colours. */
  delta?: number
}

export interface Comparison {
  /** Every leaf is equal within `TOLERANCE` and the shapes match. */
  equal: boolean
  /** False when the two values do not have the same shape (then `leaves` is empty). */
  sameShape: boolean
  leaves: LeafDiff[]
}

/** A bare `0` may stand for a length, a percentage or a dimension. */
function reconcile(a: Leaf, b: Leaf): [Leaf, Leaf] | null {
  if (a.kind === b.kind) return [a, b]
  const zeroLike = (zero: Leaf, other: Leaf): Leaf | null =>
    zero.kind === 'number' && zero.num === 0 && (other.kind === 'length' || other.kind === 'percent' || other.kind === 'dimension')
      ? { ...other, text: zero.text, num: 0 }
      : null
  const asB = zeroLike(a, b)
  if (asB !== null) return [asB, b]
  const asA = zeroLike(b, a)
  if (asA !== null) return [a, asA]
  return null
}

function diffLeaf(expected: Leaf, actual: Leaf): LeafDiff {
  const base = { kind: expected.kind, expected, actual }
  switch (expected.kind) {
    case 'length':
    case 'number':
    case 'percent': {
      const delta = (actual.num ?? 0) - (expected.num ?? 0)
      const limit = expected.kind === 'length' ? TOLERANCE.lengthPx : expected.kind === 'number' ? TOLERANCE.number : TOLERANCE.percent
      return { ...base, equal: Math.abs(delta) <= limit, delta }
    }
    case 'dimension': {
      const delta = (actual.num ?? 0) - (expected.num ?? 0)
      return { ...base, equal: expected.unit === actual.unit && Math.abs(delta) <= TOLERANCE.number, delta: expected.unit === actual.unit ? delta : undefined }
    }
    case 'color': {
      const delta = expected.color !== undefined && actual.color !== undefined ? colorDistance(expected.color, actual.color) : Number.POSITIVE_INFINITY
      return { ...base, equal: delta < TOLERANCE.color, delta }
    }
    case 'font-family': {
      const a = expected.families ?? []
      const b = actual.families ?? []
      return { ...base, equal: a.length === b.length && a.every((name, i) => name === b[i]) }
    }
    case 'keyword':
      return { ...base, equal: expected.text === actual.text }
    case 'string':
      return { ...base, equal: expected.text === actual.text }
  }
}

function matrixLeaves(matrix: readonly number[]): Leaf[] {
  return matrix.map((num, index) =>
    MATRIX_LENGTHS.has(index) ? { kind: 'length', text: `${round(num)}px`, num } : { kind: 'number', text: String(round(num)), num },
  )
}

const round = (n: number): number => Math.round(n * 1000) / 1000

/**
 * The leaves two values are compared on: the plain flattening, or matrix entries when both are
 * transforms (`none` / `matrix()` / `matrix3d()`). Null when the shapes differ.
 */
export function alignLeaves(expected: string, actual: string, property?: string): [Leaf, Leaf][] | null {
  const mExpected = parseMatrix(expected)
  const mActual = parseMatrix(actual)
  // `none` is a matrix only next to a real matrix; `none` against `none` is two keywords.
  const isMatrixPair = mExpected !== null && mActual !== null && !(isNone(expected) && isNone(actual))
  const a = isMatrixPair ? matrixLeaves(mExpected) : flattenValue(expected, property)
  const b = isMatrixPair ? matrixLeaves(mActual) : flattenValue(actual, property)
  if (a.length !== b.length) return null
  const pairs: [Leaf, Leaf][] = []
  for (let i = 0; i < a.length; i++) {
    const pair = reconcile(a[i] as Leaf, b[i] as Leaf)
    if (pair === null) return null
    pairs.push(pair)
  }
  return pairs
}

const isNone = (value: string): boolean => value.trim().toLowerCase() === 'none'

/** Compares two computed values of the same property. */
export function compareComputed(expected: string, actual: string, property?: string): Comparison {
  const pairs = alignLeaves(expected, actual, property)
  if (pairs === null) return { equal: false, sameShape: false, leaves: [] }
  const leaves = pairs.map(([e, a]) => diffLeaf(e, a))
  return { equal: leaves.every((leaf) => leaf.equal), sameShape: true, leaves }
}

/** Shorthand for `compareComputed(...).equal`. */
export function computedEqual(expected: string, actual: string, property?: string): boolean {
  return compareComputed(expected, actual, property).equal
}
