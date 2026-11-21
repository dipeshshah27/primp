import type { ElementContext } from '../types.ts'

/**
 * How well an opening tag in a source file matches a DOM element. Pure: no I/O.
 *
 * Used wherever the framework gives no position, or several: the search fallback, picking
 * among JSX calls of one component, and static HTML whose structure changed at runtime.
 */

export interface TagScore {
  score: number
  why: string[]
}

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim()
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function hasWord(haystack: string, word: string): boolean {
  return new RegExp(`(?<![\\w-])${escapeRegExp(word)}(?![\\w-])`).test(haystack)
}

/**
 * Local names a generated class may come from: CSS modules compile `styles.hero` to
 * `page-module__E0kJGG__hero` (Turbopack) or `_hero_1x2y3_5` (Vite).
 */
function localNames(token: string): string[] {
  return token.split(/_+|-{2,}/).filter((part) => part.length >= 3 && !/^\d+$/.test(part))
}

/**
 * @param tagText   the opening tag as written, `<h1 className="title">`
 * @param after     source text following the opening tag
 */
export function scoreTag(rawTagText: string, after: string, context: ElementContext): TagScore {
  // Values of data-* attributes are not class names, ids or text; left in, a class token could
  // match inside one by accident. The identifying ones (data-testid, ...) are compared below.
  const tagText = rawTagText.replace(/\sdata-[\w-]+\s*=\s*(?:"[^"]*"|'[^']*'|\{[^{}]*\})/g, (attribute) =>
    /^\sdata-(?:testid|test|cy)\b/.test(attribute) ? attribute : ' ',
  )
  let score = 1
  const why: string[] = ['tag']

  if (context.id !== undefined && new RegExp(`\\bid\\s*=\\s*[{"'\`]+\\s*${escapeRegExp(context.id)}["'\`]`).test(tagText)) {
    score += 6
    why.push(`id "${context.id}"`)
  }

  let classPoints = 0
  const matched: string[] = []
  for (const token of context.classes) {
    // Svelte's scoping class is derived from the file, not written in it.
    if (/^svelte-[a-z0-9]+$/.test(token)) continue
    if (hasWord(tagText, token)) {
      classPoints += 2
      matched.push(token)
    } else {
      const local = localNames(token).find((name) => new RegExp(`[.\\['"]${escapeRegExp(name)}(?![\\w-])`).test(tagText))
      if (local !== undefined) {
        classPoints += 1.5
        matched.push(`${local} (module)`)
      }
    }
  }
  if (classPoints > 0) {
    score += Math.min(classPoints, 8)
    why.push(`class ${matched.slice(0, 4).join(' ')}`)
  }

  let attributePoints = 0
  for (const [name, value] of Object.entries(context.attrs)) {
    if (value.length < 2) continue
    if (tagText.includes(`"${value}"`) || tagText.includes(`'${value}'`)) {
      attributePoints += name === 'style' || name === 'type' || name === 'role' ? 2 : 3
      why.push(`${name}="${value.slice(0, 30)}"`)
    }
  }
  score += Math.min(attributePoints, 9)

  const text = context.ownText !== '' ? context.ownText : context.text
  if (text.length >= 3) {
    const body = collapse(after.replace(/<[^>]*>/g, ' '))
    const needle = text.slice(0, 40)
    if (body.includes(needle)) {
      score += 5
      why.push(`text "${needle.slice(0, 24)}"`)
    } else {
      const words = text.split(' ').filter((word) => word.length >= 3).slice(0, 4)
      const found = words.filter((word) => hasWord(body.slice(0, 200), word)).length
      if (found > 0) {
        score += Math.min(found, 3)
        why.push(`${found} word${found === 1 ? '' : 's'} of the text`)
      }
    }
  }
  return { score, why }
}
