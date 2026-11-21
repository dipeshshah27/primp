/**
 * Pick mode: choosing an element of the page with the pointer or the keyboard.
 *
 * While pick mode is on, capture-phase listeners on the window see every pointer and mouse
 * event before the app does and stop it there, so a click selects the element instead of
 * pressing the app's button, following its link or moving focus. When pick mode is off no
 * listener is installed and the app gets every event.
 *
 * Keys in pick mode: Escape leaves, Enter picks the hovered element, ArrowUp goes to the
 * parent, ArrowDown to the first child, ArrowLeft / ArrowRight to the previous / next sibling.
 *
 * This module draws nothing. The caller is told what is hovered and what was picked, and
 * draws the highlight box in the overlay layer.
 */

import { isOwn } from './ref.ts'

export interface PickerCallbacks {
  /** The element under the pointer changed (null: nothing pickable there). */
  onHover(element: Element | null): void
  /** An element was chosen (click, Enter, or an arrow key moving the selection). */
  onPick(element: Element, how: 'pointer' | 'keyboard'): void
  /** Escape was pressed. */
  onCancel(): void
  /** The element the arrow keys start from: the current selection. */
  current(): Element | null
  /** Undo / redo shortcut pressed while picking. */
  onHistory?(direction: 'undo' | 'redo'): void
}

export interface Picker {
  start(): void
  stop(): void
  active(): boolean
}

const SWALLOWED = [
  'pointerdown',
  'pointerup',
  'mousedown',
  'mouseup',
  'click',
  'auxclick',
  'dblclick',
  'contextmenu',
  'touchstart',
  'touchend',
  'pointerover',
  'pointerout',
  'pointerenter',
  'pointerleave',
  'mouseover',
  'mouseout',
  'mouseenter',
  'mouseleave',
  'mousemove',
  'pointermove',
  'dragstart',
] as const

/** Elements nobody means when they point at the page. */
function pickable(element: Element | null): element is Element {
  if (element === null || isOwn(element)) return false
  const tag = element.localName
  return tag !== 'html' && tag !== 'body' && tag !== 'head'
}

function targetOf(event: Event, doc: Document): Element | null {
  const path = event.composedPath()
  const first = path[0]
  if (first instanceof Element) return first
  if (first instanceof Node) return first.parentElement
  if (event instanceof MouseEvent) return doc.elementFromPoint(event.clientX, event.clientY)
  return null
}

/** The neighbour an arrow key leads to, skipping reglet's own nodes and elements without a box. */
export function neighbour(element: Element, key: string): Element | null {
  const step = (from: Element | null, next: (el: Element) => Element | null): Element | null => {
    for (let el = from; el !== null; el = next(el)) if (pickable(el)) return el
    return null
  }
  switch (key) {
    case 'ArrowUp':
      return pickable(element.parentElement) ? element.parentElement : null
    case 'ArrowDown':
      return step(element.firstElementChild, (el) => el.nextElementSibling)
    case 'ArrowLeft':
      return step(element.previousElementSibling, (el) => el.previousElementSibling)
    case 'ArrowRight':
      return step(element.nextElementSibling, (el) => el.nextElementSibling)
    default:
      return null
  }
}

export function createPicker(callbacks: PickerCallbacks, doc: Document = document): Picker {
  const view = doc.defaultView ?? window
  let on = false
  let hovered: Element | null = null

  const hover = (element: Element | null): void => {
    if (element === hovered) return
    hovered = element
    callbacks.onHover(element)
  }

  const onPointer = (event: Event): void => {
    const target = targetOf(event, doc)
    // Events inside the dock are the dock's.
    if (target !== null && isOwn(target)) return
    event.stopImmediatePropagation()
    if (event.cancelable && event.type !== 'pointermove' && event.type !== 'mousemove') event.preventDefault()
    const element = pickable(target) ? target : null
    if (event.type === 'pointerout' || event.type === 'mouseout') {
      // Left the page: out of the window, or onto the dock.
      const to = (event as MouseEvent).relatedTarget
      if (to === null || (to instanceof Node && isOwn(to))) hover(null)
    } else if (event.type === 'pointermove' || event.type === 'mousemove' || event.type === 'pointerover') hover(element)
    else if (event.type === 'click' && element !== null && (event as MouseEvent).button === 0) callbacks.onPick(element, 'pointer')
  }

  const onKey = (event: KeyboardEvent): void => {
    if (event.defaultPrevented) return
    const mod = event.metaKey || event.ctrlKey
    if (mod && !event.altKey && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      event.stopImmediatePropagation()
      callbacks.onHistory?.(event.shiftKey ? 'redo' : 'undo')
      return
    }
    if (mod || event.altKey) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopImmediatePropagation()
      callbacks.onCancel()
      return
    }
    if (event.key === 'Enter' && hovered !== null) {
      event.preventDefault()
      event.stopImmediatePropagation()
      callbacks.onPick(hovered, 'keyboard')
      return
    }
    if (!event.key.startsWith('Arrow')) return
    const from = callbacks.current() ?? hovered
    if (from === null) return
    // The arrow keys belong to pick mode now, not to the page's scrolling or widgets.
    event.preventDefault()
    event.stopImmediatePropagation()
    const next = neighbour(from, event.key)
    if (next !== null) callbacks.onPick(next, 'keyboard')
  }

  return {
    start() {
      if (on) return
      on = true
      for (const type of SWALLOWED) view.addEventListener(type, onPointer, { capture: true, passive: false })
      view.addEventListener('keydown', onKey, true)
    },
    stop() {
      if (!on) return
      on = false
      for (const type of SWALLOWED) view.removeEventListener(type, onPointer, { capture: true })
      view.removeEventListener('keydown', onKey, true)
      hover(null)
    },
    active: () => on,
  }
}
