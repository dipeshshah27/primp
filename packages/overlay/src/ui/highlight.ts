/**
 * The boxes reglet draws over the page: the element under the pointer in pick mode, the
 * selected element, and rectangles the dock points at (shift victims, side effects).
 *
 * They live in the overlay layer (the dock host's shadow root), never in the page. A box is
 * placed with `transform` and sized with width/height only: neither moves its layout position,
 * so drawing and moving boxes adds no layout-shift entry to the page being measured.
 */

import { effect } from '@preact/signals'
import type { Outline, Store } from '../state/store.ts'

interface Box {
  kind: Outline['kind']
  x: number
  y: number
  width: number
  height: number
  label?: string
}

export interface Highlighter {
  /** Re-reads positions now (after the page changed without scrolling). */
  update(): void
  dispose(): void
}

function boxOf(outline: Outline, view: Window): Box | undefined {
  if (outline.element !== undefined) {
    if (!outline.element.isConnected) return undefined
    const rect = outline.element.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) return undefined
    const box: Box = { kind: outline.kind, x: rect.left, y: rect.top, width: rect.width, height: rect.height }
    if (outline.label !== undefined) box.label = outline.label
    return box
  }
  if (outline.rect === undefined) return undefined
  const { rect } = outline
  const box: Box = {
    kind: outline.kind,
    x: outline.space === 'document' ? rect.x - view.scrollX : rect.x,
    y: outline.space === 'document' ? rect.y - view.scrollY : rect.y,
    width: rect.width,
    height: rect.height,
  }
  if (outline.label !== undefined) box.label = outline.label
  return box
}

export function createHighlighter(layer: HTMLElement, store: Store, view: Window = window): Highlighter {
  const doc = layer.ownerDocument
  const pool: HTMLElement[] = []
  let scheduled = false

  const draw = (): void => {
    scheduled = false
    const outlines: Outline[] = []
    const selection = store.selection.peek()
    if (selection !== null) outlines.push({ kind: 'selected', element: selection.element })
    const hovered = store.hovered.peek()
    if (hovered !== null && hovered !== selection?.element) {
      const rect = hovered.getBoundingClientRect()
      outlines.push({ kind: 'hover', element: hovered, label: `${hovered.localName}  ${Math.round(rect.width)} x ${Math.round(rect.height)}` })
    }
    outlines.push(...store.outlines.peek())

    let used = 0
    for (const outline of outlines) {
      const box = boxOf(outline, view)
      if (box === undefined) continue
      let node = pool[used]
      if (node === undefined) {
        node = doc.createElement('div')
        node.append(doc.createElement('span'))
        pool.push(node)
        layer.append(node)
      }
      used++
      node.className = `box ${box.kind}`
      node.style.display = 'block'
      node.style.transform = `translate(${Math.round(box.x * 2) / 2}px, ${Math.round(box.y * 2) / 2}px)`
      node.style.width = `${Math.max(0, box.width)}px`
      node.style.height = `${Math.max(0, box.height)}px`
      const tag = node.firstElementChild as HTMLElement
      tag.textContent = box.label ?? ''
      tag.style.display = box.label === undefined ? 'none' : 'block'
      // Above the box, or inside it when the box touches the top of the viewport.
      tag.style.transform = box.y < 20 ? 'translate(0, 2px)' : 'translate(0, -100%)'
    }
    for (let i = used; i < pool.length; i++) pool[i]!.style.display = 'none'
  }

  const schedule = (): void => {
    if (scheduled) return
    scheduled = true
    // A timer as well: animation frames do not run in a hidden tab.
    let done = false
    const run = (): void => {
      if (done) return
      done = true
      draw()
    }
    view.requestAnimationFrame(run)
    view.setTimeout(run, 100)
  }

  const stop = effect(() => {
    // Subscribe to everything that changes what is drawn or where.
    void store.selection.value
    void store.hovered.value
    void store.outlines.value
    void store.items.value
    void store.detached.value
    schedule()
  })

  view.addEventListener('scroll', schedule, { capture: true, passive: true })
  view.addEventListener('resize', schedule, { passive: true })
  // The page reflowing under a drawn box (a hot update, a late image) changes the document's size.
  const resized = new ResizeObserver(schedule)
  resized.observe(view.document.documentElement)
  if (view.document.body !== null) resized.observe(view.document.body)

  return {
    update: schedule,
    dispose() {
      stop()
      resized.disconnect()
      view.removeEventListener('scroll', schedule, { capture: true })
      view.removeEventListener('resize', schedule)
      for (const node of pool) node.remove()
    },
  }
}
