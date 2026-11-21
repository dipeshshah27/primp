/**
 * On-disk verification. Pure: works on source text, the caller does the reading.
 *
 * A position that came out of a source map or a debug field is a claim. Before primp shows
 * `file:line` as exact, or puts it in a prompt, the file must hold an opening tag there.
 */

export interface TagExpectation {
  /**
   * Tag name of the DOM element (`h1`). Omit when any opening tag is acceptable, which is the
   * case for a component usage (`<Card`, `<motion.div`).
   */
  tag?: string
  /** Lines searched above and below the claimed line when it does not hold the tag. Default 3. */
  window?: number
  /**
   * The source is JavaScript or TypeScript with JSX. When the claimed column holds no tag and
   * the line (or a nearby line) is searched, a `<` straight after an identifier, `)` or `]` is
   * then skipped: it is far more often a type argument list or a comparison (`useState<Item>(`,
   * `Card<T extends X>`) than a tag after text (`text<br />`). At the claimed column itself any
   * opening tag is accepted. In HTML-like files `text<b>` is common, so the default is false.
   */
  jsx?: boolean
}

export interface TagMatch {
  /** 1-based line of the `<`. */
  line: number
  /** 1-based column of the `<`. */
  col: number
  /**
   * `exact`: an acceptable opening tag starts exactly at the claimed line and column.
   * `same-line`: the claimed line holds the tag, at another column.
   * `nearby`: the tag was found within the window, on another line.
   */
  kind: 'exact' | 'same-line' | 'nearby'
  /** The tag name found in the source. */
  name: string
  /** True when `name` is not the DOM tag but a component or member expression that can render it. */
  dynamic: boolean
}

const NAME = /[A-Za-z_$][\w$.:-]*/y

/** The tag name of an opening tag starting at `index` in `line` (0-based), if there is one. */
function openingTagAt(line: string, index: number, jsx = false): string | undefined {
  if (line[index] !== '<') return undefined
  if (jsx && index > 0 && /[\w$)\]]/.test(line[index - 1] ?? '')) return undefined
  NAME.lastIndex = index + 1
  const match = NAME.exec(line)
  if (!match) return undefined
  const next = line[index + 1 + match[0].length]
  // `<T,>(x: T) =>`, `a < b`, `Array<string>` and friends are not tags.
  if (next !== undefined && !/[\s/>]/.test(next)) return undefined
  return match[0]
}

/**
 * Whether source tag `name` can be the element `tag`. Host tags must be equal. A capitalised
 * or member name (`Tag`, `motion.div`, `svelte:element`) is a component or a dynamic tag and
 * can render anything.
 */
function accepts(name: string, tag: string | undefined): { ok: boolean; dynamic: boolean } {
  if (tag === undefined) return { ok: true, dynamic: false }
  if (name === tag) return { ok: true, dynamic: false }
  if (name.toLowerCase() === tag.toLowerCase() && !/[.:]/.test(name) && name === name.toLowerCase()) {
    return { ok: true, dynamic: false }
  }
  const dynamic = /^[A-Z]/.test(name) || name.includes('.') || name === 'svelte:element'
  return { ok: dynamic, dynamic }
}

function tagsOnLine(line: string, tag: string | undefined, hostOnly: boolean, jsx: boolean): { index: number; name: string; dynamic: boolean }[] {
  const found: { index: number; name: string; dynamic: boolean }[] = []
  for (let index = line.indexOf('<'); index !== -1; index = line.indexOf('<', index + 1)) {
    const name = openingTagAt(line, index, jsx)
    if (name === undefined) continue
    const verdict = accepts(name, tag)
    if (verdict.ok && !(hostOnly && verdict.dynamic)) found.push({ index, name, dynamic: verdict.dynamic })
  }
  return found
}

/**
 * Looks for the opening tag at `line`/`col` (both 1-based) of `source`.
 * Returns undefined when neither the position nor its surroundings hold an acceptable tag.
 */
export function findOpeningTag(source: string, line: number, col: number | undefined, expectation: TagExpectation = {}): TagMatch | undefined {
  const lines = source.split('\n')
  const text = lines[line - 1]
  const { tag } = expectation
  const jsx = expectation.jsx === true

  if (text !== undefined) {
    if (col !== undefined && col >= 1) {
      const name = openingTagAt(text, col - 1)
      if (name !== undefined) {
        const verdict = accepts(name, tag)
        if (verdict.ok) return { line, col, kind: 'exact', name, dynamic: verdict.dynamic }
      }
    }
    // Same line, other column: source maps often point at the tag name or at the expression start.
    const sameLine = tagsOnLine(text, tag, true, jsx)
    const candidates = sameLine.length > 0 ? sameLine : tagsOnLine(text, tag, false, jsx)
    if (candidates.length > 0) {
      const target = (col ?? 1) - 1
      const best = candidates.reduce((a, b) => (Math.abs(b.index - target) < Math.abs(a.index - target) ? b : a))
      return { line, col: best.index + 1, kind: 'same-line', name: best.name, dynamic: best.dynamic }
    }
  }

  // Nearby lines, nearest first; only a real host-tag match counts here, a component name would match anything.
  if (tag === undefined) return undefined
  const window = expectation.window ?? 3
  for (let distance = 1; distance <= window; distance += 1) {
    for (const candidate of [line - distance, line + distance]) {
      const nearby = lines[candidate - 1]
      if (nearby === undefined) continue
      const first = tagsOnLine(nearby, tag, true, jsx)[0]
      if (first) return { line: candidate, col: first.index + 1, kind: 'nearby', name: first.name, dynamic: false }
    }
  }
  return undefined
}

/** Offset of 1-based `line`/`col` in `source`. */
export function offsetOf(source: string, line: number, col: number): number {
  let offset = 0
  for (let current = 1; current < line; current += 1) {
    const next = source.indexOf('\n', offset)
    if (next === -1) return source.length
    offset = next + 1
  }
  return Math.min(source.length, offset + col - 1)
}

/** The text of the opening tag whose `<` is at `start`, up to its closing `>`; at most `limit` characters. */
export function openingTagTextAt(source: string, start: number, limit = 1200): string {
  const end = Math.min(source.length, start + limit)
  let quote: string | undefined
  let braces = 0
  for (let index = start + 1; index < end; index += 1) {
    const char = source[index]
    if (quote !== undefined) {
      if (char === quote) quote = undefined
    } else if (char === '"' || char === "'" || char === '`') quote = char
    else if (char === '{') braces += 1
    else if (char === '}') braces = Math.max(0, braces - 1)
    else if (char === '>' && braces === 0 && source[index - 1] !== '=') return source.slice(start, index + 1)
  }
  return source.slice(start, end)
}

/** The same for a 1-based `line`/`col`. */
export function openingTagText(source: string, line: number, col: number, limit = 1200): string {
  return openingTagTextAt(source, offsetOf(source, line, col), limit)
}

/**
 * Cuts `rest` (the text after an opening `<name ...>`) at that element's closing tag, counting
 * nested elements of the same name. Returns `rest` unchanged when the closing tag is not in it.
 */
export function untilClosingTag(rest: string, name: string): string {
  const tags = new RegExp(`<(/?)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\s/>])`, 'g')
  let depth = 0
  for (let match = tags.exec(rest); match; match = tags.exec(rest)) {
    if (match[1] === '/') {
      if (depth === 0) return rest.slice(0, match.index)
      depth -= 1
    } else {
      depth += 1
    }
  }
  return rest
}

/**
 * What the element whose opening tag `tagText` starts at `start` contains, roughly: the source
 * between its opening and its closing tag, at most `limit` characters. Empty for a self-closing
 * tag. Text of later siblings is left out, so it cannot be mistaken for the element's own.
 */
export function contentAfterTagAt(source: string, start: number, tagText: string, limit = 400): string {
  if (/\/\s*>$/.test(tagText)) return ''
  const from = start + tagText.length
  const rest = source.slice(from, from + limit)
  NAME.lastIndex = 1
  const name = NAME.exec(tagText)?.[0]
  return name === undefined ? rest : untilClosingTag(rest, name)
}

/** The same for a 1-based `line`/`col`. */
export function textAfterTag(source: string, line: number, col: number, limit = 400): string {
  const start = offsetOf(source, line, col)
  return contentAfterTagAt(source, start, openingTagTextAt(source, start), limit)
}

/** Whether a file is JavaScript or TypeScript, where `<` after an identifier is not a tag. */
export function isJsxFile(file: string): boolean {
  return /\.(?:[cm]?[jt]sx?)$/i.test(file)
}
