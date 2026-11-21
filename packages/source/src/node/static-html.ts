import { parse, type DefaultTreeAdapterMap } from 'parse5'
import type { ElementContext, PathStep, SourceCandidate } from '../types.ts'
import type { ProjectFiles } from './files.ts'
import { scoreTag } from './score.ts'

/**
 * Static HTML: the document the browser parsed is a file in the project, so the element's
 * structural path (child positions from `<html>` down) leads to the same node in parse5's
 * tree, and parse5 reports where that node's start tag is in the file.
 *
 * The live DOM can differ from the file: scripts insert and remove nodes. The walk therefore
 * counts same-tag siblings and compares the count with the live count at each step; any
 * disagreement, or a final node that does not look like the element, makes the result
 * inexact and the caller falls back to scoring every tag in the file.
 */

type Node = DefaultTreeAdapterMap['node']
type Element = DefaultTreeAdapterMap['element']
type ParentNode = DefaultTreeAdapterMap['parentNode']

const isElement = (node: Node): node is Element => 'tagName' in node

function childElements(node: ParentNode): Element[] {
  // A <template>'s children live in its content fragment; the live DOM path never enters it.
  return node.childNodes.filter(isElement)
}

export interface HtmlLocation {
  /** 1-based line of the `<`. */
  line: number
  /** 1-based column of the `<`. */
  col: number
  /**
   * True when every step of the path matched by tag, position and sibling count, and the node
   * agrees with the element's id and classes.
   */
  exact: boolean
  /** Why it is not exact. */
  notes: string[]
}

function attributesAgree(element: Element, context: ElementContext): boolean {
  const attr = (name: string): string | undefined => element.attrs.find((entry) => entry.name === name)?.value
  if ((attr('id') ?? '') !== (context.id ?? '')) return false
  const written = new Set((attr('class') ?? '').split(/\s+/).filter(Boolean))
  // Scripts add state classes at runtime; every class in the file must still be on the element.
  for (const token of written) if (!context.classes.includes(token)) return false
  return true
}

/** Follows `path` (from `<html>`) through the parsed file. */
export function locateByPath(html: string, path: readonly PathStep[], context: ElementContext): HtmlLocation | undefined {
  const document = parse(html, { sourceCodeLocationInfo: true })
  const notes: string[] = []
  let exact = true
  let current: Element | undefined
  let parent: ParentNode = document

  for (const [depth, step] of path.entries()) {
    const sameTag: Element[] = childElements(parent).filter((child) => child.tagName === step.tag)
    let next: Element | undefined = sameTag[step.ofType]
    if (depth > 0 && sameTag.length !== step.ofTypeCount) {
      exact = false
      notes.push(`<${step.tag}> has ${step.ofTypeCount} same-tag siblings in the page but ${sameTag.length} in the file`)
      const byId = step.id !== undefined ? sameTag.find((child) => child.attrs.some((a) => a.name === 'id' && a.value === step.id)) : undefined
      next = byId ?? next
    }
    if (!next) return undefined
    current = next
    parent = next
  }
  if (!current) return undefined

  const location = current.sourceCodeLocation
  if (!location) {
    // An element the parser created (<tbody>, or <html>/<head>/<body> that were never written).
    return undefined
  }
  if (exact && !attributesAgree(current, context)) {
    exact = false
    notes.push('id or classes of the node in the file differ from the element')
  }
  return { line: location.startLine, col: location.startCol, exact, notes }
}

/** Every `<tag>` in the file, scored against the element. Best first. */
export function searchHtml(html: string, file: string, context: ElementContext, limit = 5): SourceCandidate[] {
  const document = parse(html, { sourceCodeLocationInfo: true })
  const candidates: SourceCandidate[] = []
  const visit = (node: ParentNode): void => {
    for (const child of childElements(node)) {
      const location = child.sourceCodeLocation
      if (child.tagName === context.tag && location?.startTag) {
        const tagText = html.slice(location.startTag.startOffset, location.startTag.endOffset)
        // The element's own content only: text of later siblings must not count as its text.
        const contentEnd = location.endTag?.startOffset ?? location.endOffset
        const after = html.slice(location.startTag.endOffset, Math.min(location.startTag.endOffset + 400, contentEnd))
        const { score, why } = scoreTag(tagText, after, context)
        candidates.push({ file, line: location.startLine, col: location.startCol, score, why })
      }
      visit(child)
    }
  }
  visit(document)
  return candidates.sort((a, b) => b.score - a.score).slice(0, limit)
}

/**
 * The HTML file a page path is served from, when the project holds one: `/` -> `index.html`,
 * `/about.html`, `/docs/` -> `docs/index.html`, `/about` -> `about.html`; also under `public/`.
 */
export function htmlFileForPage(files: ProjectFiles, pagePath: string): string | undefined {
  let path: string
  try {
    path = decodeURIComponent(pagePath)
  } catch {
    path = pagePath
  }
  const clean = path.replace(/^\/+/, '').replace(/\/+$/, '')
  const names = clean === '' ? ['index.html'] : /\.html?$/i.test(clean) ? [clean] : [`${clean}.html`, `${clean}/index.html`]
  for (const base of ['', 'public/', 'static/', 'src/']) {
    for (const name of names) {
      if (files.isFile(base + name)) return base + name
    }
  }
  return undefined
}
