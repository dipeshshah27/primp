import type { ElementContext, SourceCandidate } from '../types.ts'
import type { ProjectFiles } from './files.ts'
import { scoreTag } from './score.ts'
import { contentAfterTagAt, openingTagTextAt } from './verify.ts'

/**
 * Last resort: every opening tag with the element's tag name in the project's markup files,
 * ranked by how many of the element's class names, attributes and words it carries.
 * The result is a list of guesses and is always reported at level `candidates`.
 */

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export interface GrepOptions {
  /** Candidates returned. Default 5. */
  limit?: number
  /** Only these files (project-relative). Default: every markup file in the project. */
  files?: readonly string[]
}

export function grepCandidates(files: ProjectFiles, context: ElementContext, options: GrepOptions = {}): SourceCandidate[] {
  const opening = new RegExp(`<${escapeRegExp(context.tag)}(?=[\\s/>])`, 'g')
  const candidates: SourceCandidate[] = []
  for (const file of options.files ?? files.list()) {
    const source = files.read(file)
    if (source === undefined || !source.includes(`<${context.tag}`)) continue
    const lineStarts = [0]
    for (let index = source.indexOf('\n'); index !== -1; index = source.indexOf('\n', index + 1)) lineStarts.push(index + 1)
    opening.lastIndex = 0
    let line = 0
    for (let match = opening.exec(source); match; match = opening.exec(source)) {
      while (line + 1 < lineStarts.length && (lineStarts[line + 1] ?? Infinity) <= match.index) line += 1
      const col = match.index - (lineStarts[line] ?? 0) + 1
      const tagText = openingTagTextAt(source, match.index)
      const after = contentAfterTagAt(source, match.index, tagText)
      const { score, why } = scoreTag(tagText, after, context)
      candidates.push({ file, line: line + 1, col, score, why })
    }
  }
  return candidates.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line).slice(0, options.limit ?? 5)
}

/** Markup files that define something called `name`: `function Card`, `const Card =`, `class Card`. */
export function filesDefining(files: ProjectFiles, name: string): string[] {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return []
  const definition = new RegExp(`(?:function\\*?|const|let|var|class)\\s+${escapeRegExp(name)}(?![\\w$])`)
  return files.list().filter((file) => /\.(?:[jt]sx?|mjs)$/.test(file) && definition.test(files.read(file) ?? ''))
}
