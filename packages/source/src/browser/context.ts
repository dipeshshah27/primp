import type { ElementContext, PathStep } from '../types.ts'

/**
 * Framework-independent facts about an element: what a person would type into a search box
 * to find it in the source, plus its structural path for documents that are served as written.
 */

const TEXT_LIMIT = 160

/**
 * Attributes worth searching the source for. An allowlist, so test-only or tool-only
 * attributes never leak into the evidence.
 */
const ATTRIBUTES = [
  'data-testid',
  'data-test',
  'data-cy',
  'name',
  'href',
  'src',
  'alt',
  'title',
  'role',
  'type',
  'for',
  'placeholder',
  'aria-label',
  'style',
] as const

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim()

function ownText(element: Element): string {
  let text = ''
  for (const node of element.childNodes) {
    if (node.nodeType === 3) text += node.nodeValue ?? ''
    if (text.length > TEXT_LIMIT * 2) break
  }
  return collapse(text).slice(0, TEXT_LIMIT)
}

/** Subtree text without reading `textContent`, which would build the whole string for a large container. */
function subtreeText(element: Element): string {
  const walker = element.ownerDocument.createTreeWalker(element, 4 /* NodeFilter.SHOW_TEXT */)
  let text = ''
  while (text.length < TEXT_LIMIT * 2 && walker.nextNode()) {
    const parent = walker.currentNode.parentElement
    if (parent && (parent.tagName === 'SCRIPT' || parent.tagName === 'STYLE')) continue
    text += `${walker.currentNode.nodeValue ?? ''} `
  }
  return collapse(text).slice(0, TEXT_LIMIT)
}

/** Nodes primp itself added to the page; they are not in anybody's source and must not shift sibling positions. */
function isOwnNode(node: Element): boolean {
  if (node.hasAttribute('data-primp-root')) return true
  if (node.localName !== 'script') return false
  const src = node.getAttribute('src') ?? ''
  return src.startsWith('/__primp/') || src.includes('://') && src.includes('/__primp/')
}

function pathOf(element: Element): PathStep[] {
  const steps: PathStep[] = []
  for (let node: Element | null = element; node; node = node.parentElement) {
    const tag = node.localName
    const parent: Element | null = node.parentElement
    let index = 0
    let ofType = 0
    let ofTypeCount = 1
    if (parent) {
      let seen = false
      ofTypeCount = 0
      for (const sibling of parent.children) {
        if (sibling !== node && isOwnNode(sibling)) continue
        if (sibling === node) seen = true
        else if (!seen) index += 1
        if (sibling.localName === tag) {
          if (!seen) ofType += 1
          ofTypeCount += 1
        }
      }
    }
    const step: PathStep = { tag, index, ofType, ofTypeCount }
    if (node.id) step.id = node.id
    steps.push(step)
  }
  return steps.reverse()
}

export function collectContext(element: Element): ElementContext {
  const attrs: Record<string, string> = {}
  for (const name of ATTRIBUTES) {
    const value = element.getAttribute(name)
    if (value !== null && value !== '') attrs[name] = value.slice(0, 200)
  }
  const context: ElementContext = {
    tag: element.localName,
    classes: [...element.classList].slice(0, 40),
    attrs,
    ownText: ownText(element),
    text: subtreeText(element),
    path: pathOf(element),
    pagePath: location.pathname,
    pageOrigin: location.origin,
    pageLoadedAt: performance.timeOrigin,
  }
  if (element.id) context.id = element.id
  return context
}
