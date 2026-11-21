/**
 * Node descriptors: enough to find an element again and to order two nodes,
 * captured at the moment something happens, because the node may be detached
 * or garbage-collected by the time anyone asks.
 */

import type { MediaHints, NodeDescriptor, NodeStyle, ShiftRect } from '../../../protocol/src/shift.ts'
import { round } from './state.ts'

const uids = new WeakMap<Node, number>()
let nextUid = 1

/** The number this hook gave a node; assigned on first use, never written to the DOM. */
export function uidOf(node: Node): number {
  let uid = uids.get(node)
  if (uid === undefined) uids.set(node, (uid = nextUid++))
  return uid
}

const KEPT_ATTRS = 'src href rel data-vite-dev-id data-n-href data-primp-root'.split(' ')

function pathOf(element: Element | null): number[] {
  if (element === null || !element.isConnected) return []
  const path: number[] = []
  for (let el = element; el.parentElement !== null; el = el.parentElement) {
    let index = 0
    for (let sibling = el.previousElementSibling; sibling !== null; sibling = sibling.previousElementSibling) index++
    path.push(index)
  }
  return path.reverse()
}

function selectorOf(element: Element | null): string {
  const parts: string[] = []
  for (let el = element; el !== null && parts.length < 5; el = el.parentElement) {
    if (el.id !== '') {
      parts.push('#' + CSS.escape(el.id))
      break
    }
    const tag = el.localName
    if (el.parentElement === null || tag === 'body') {
      parts.push(tag)
      break
    }
    let nth = 1
    for (let sibling = el.previousElementSibling; sibling !== null; sibling = sibling.previousElementSibling) {
      if (sibling.localName === tag) nth++
    }
    parts.push(`${tag}:nth-of-type(${nth})`)
  }
  return parts.reverse().join(' > ')
}

/** The first run of real text at or below `node`, looking at no more than 30 nodes. */
function textOf(node: Node): string | undefined {
  let budget = 30
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
  for (let text = node.nodeType === 3 ? node : walker.nextNode(); text !== null && budget-- > 0; text = walker.nextNode()) {
    const value = (text.nodeValue ?? '').replace(/\s+/g, ' ').trim()
    if (value !== '') return value.slice(0, 48)
  }
  return undefined
}

export function describe(node: Node): NodeDescriptor {
  const isElement = node.nodeType === 1
  const element = isElement ? (node as Element) : node.parentElement
  const descriptor: NodeDescriptor = {
    uid: uidOf(node),
    tag: isElement ? (node as Element).localName : '#text',
    path: pathOf(element),
    selector: selectorOf(element),
  }
  if (isElement && element !== null) {
    if (element.id !== '') descriptor.id = element.id
    if (element.classList.length > 0) descriptor.classes = [...element.classList].slice(0, 4)
    for (const name of KEPT_ATTRS) {
      const value = element.getAttribute(name)
      if (value !== null) (descriptor.attrs ??= {})[name] = value.slice(0, 200)
    }
  }
  const text = textOf(node)
  if (text !== undefined) descriptor.text = text
  return descriptor
}

export function rectOf(rect: DOMRectReadOnly): ShiftRect {
  return { x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height) }
}

/**
 * Layout facts of an element. `withLayout` adds used margins, which need a clean
 * layout: only pass it from inside a ResizeObserver callback.
 */
export function styleOf(element: Element, withLayout: boolean): NodeStyle {
  const computed = getComputedStyle(element)
  const style: NodeStyle = { position: computed.position, display: computed.display, fontFamily: computed.fontFamily }
  if (computed.float !== 'none') style.float = computed.float
  if (withLayout) {
    style.margin = [
      parseFloat(computed.marginTop) || 0,
      parseFloat(computed.marginRight) || 0,
      parseFloat(computed.marginBottom) || 0,
      parseFloat(computed.marginLeft) || 0,
    ]
  }
  return style
}

export const MEDIA_SELECTOR = 'img,video,iframe,embed,object,canvas'
const MEDIA_TAGS = new Set(MEDIA_SELECTOR.split(','))
export const isMedia = (element: Element): boolean => MEDIA_TAGS.has(element.localName)

/** Whether a replaced element's box was reserved. Computed values, so `auto` means "not specified". */
export function mediaHints(element: Element): MediaHints {
  const map = element.computedStyleMap()
  const value = (property: string): string => String(map.get(property) ?? 'auto')
  return {
    widthAttr: element.hasAttribute('width'),
    heightAttr: element.hasAttribute('height'),
    cssWidth: value('width'),
    cssHeight: value('height'),
    aspectRatio: value('aspect-ratio'),
  }
}
