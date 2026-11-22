/**
 * What primp draws over the page: the element under the pointer (outline, tint, and a label
 * chip with its name next to the pointer), the selected element, rectangles the dock points at
 * (shift victims, side effects), and a numbered pin on every changed element.
 *
 * They live in the overlay layer (the dock host's shadow root), never in the page, and carry
 * primp's mark through the host (`data-primp-root`), so selection ignores them and layout-shift
 * attribution never counts them. Everything is placed with `transform` and sized with
 * width/height only: neither moves its layout position, so drawing, moving and numbering adds no
 * layout-shift entry to the page being measured.
 *
 * The handles on the selection (handles.ts) are placed on every draw from the selected box:
 * `onSelection` gets it in viewport coordinates, or null when there is nothing to put them on.
 */

import { effect } from '@preact/signals'
import type { PinStatus } from '../state/pins.ts'
import type { Outline, Store } from '../state/store.ts'

interface Box {
  kind: Outline['kind']
  x: number
  y: number
  width: number
  height: number
  label?: string
}

export interface ViewBox {
  x: number
  y: number
  width: number
  height: number
}

export interface Highlighter {
  /** Re-reads positions on the next frame (after the page changed without scrolling). */
  update(): void
  /** Draws now, synchronously (for tests that read what is drawn). */
  flush(): void
  /** Viewport rects of the pins shown now, by number. */
  pins(): { number: number; status: PinStatus; uid: string; x: number; y: number; width: number; height: number }[]
  dispose(): void
}

export interface PinSpec {
  uid: string
  number: number
  status: PinStatus
  element: Element | null
  /** Tooltip: what changed. */
  summary: string
  current: boolean
}

export interface HighlighterOptions {
  /** Called on every draw with the selected element's box (viewport coordinates), or null. */
  onSelection?(box: ViewBox | null): void
  /** Text of the label chip for the hovered element (`button.btn · index.html:24`). */
  label?(element: Element): { name: string; source?: string }
  /** Where the pointer is (viewport), for the label chip. */
  pointer?(): { x: number; y: number } | null
  /** The pins to draw; [] when they are hidden. */
  pins?(): PinSpec[]
  onPinHover?(pin: PinSpec | null, rect: ViewBox | null): void
  onPinClick?(pin: PinSpec): void
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

const PIN = 22

export function createHighlighter(layer: HTMLElement, store: Store, view: Window = window, options: HighlighterOptions = {}): Highlighter {
  const doc = layer.ownerDocument
  const pool: HTMLElement[] = []
  const pinPool: HTMLElement[] = []
  let shownPins: { spec: PinSpec; rect: ViewBox }[] = []
  let scheduled = false

  const chip = doc.createElement('div')
  chip.className = 'label-chip'
  layer.append(chip)

  const viewport = (): { w: number; h: number } => ({ w: view.document.documentElement.clientWidth || view.innerWidth, h: view.innerHeight })

  const pinNode = (index: number): HTMLElement => {
    let node = pinPool[index]
    if (node !== undefined) return node
    node = doc.createElement('div')
    node.className = 'pin'
    node.setAttribute('role', 'button')
    const find = (): { spec: PinSpec; rect: ViewBox } | undefined => shownPins.find((shown) => shown.spec.uid === node!.dataset.uid)
    node.addEventListener('pointerenter', () => {
      const found = find()
      options.onPinHover?.(found?.spec ?? null, found?.rect ?? null)
    })
    node.addEventListener('pointerleave', () => options.onPinHover?.(null, null))
    node.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const found = find()
      if (found !== undefined) options.onPinClick?.(found.spec)
    })
    pinPool.push(node)
    layer.append(node)
    return node
  }

  const drawPins = (): void => {
    const specs = options.pins?.() ?? []
    const { w, h } = viewport()
    const next: { spec: PinSpec; rect: ViewBox }[] = []
    let used = 0
    for (const spec of specs) {
      const element = spec.element
      if (element === null || !element.isConnected) continue
      const r = element.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) continue
      // On the top-left corner of the element, kept inside the viewport.
      const x = Math.max(2, Math.min(w - PIN - 2, r.left - PIN / 2))
      const y = Math.max(2, Math.min(h - PIN - 2, r.top - PIN / 2))
      if (r.bottom < 0 || r.top > h || r.right < 0 || r.left > w) continue
      const node = pinNode(used++)
      node.dataset.uid = spec.uid
      node.dataset.status = spec.status
      node.dataset.number = String(spec.number)
      node.textContent = String(spec.number)
      node.classList.toggle('current', spec.current)
      node.setAttribute('aria-label', `Change ${spec.number}: ${spec.summary}`)
      node.style.display = 'block'
      node.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
      next.push({ spec, rect: { x, y, width: PIN, height: PIN } })
    }
    for (let i = used; i < pinPool.length; i++) pinPool[i]!.style.display = 'none'
    shownPins = next
  }

  const drawChip = (): void => {
    const hovered = store.hovered.peek()
    const pointer = options.pointer?.() ?? null
    const text = hovered === null || options.label === undefined ? null : options.label(hovered)
    if (text === null || pointer === null || !store.open.peek()) {
      chip.style.display = 'none'
      return
    }
    chip.textContent = text.name
    if (text.source !== undefined) {
      const source = doc.createElement('span')
      source.className = 'src'
      source.textContent = ` · ${text.source}`
      chip.append(source)
    }
    chip.style.display = 'block'
    const { w, h } = viewport()
    const width = chip.offsetWidth
    const height = chip.offsetHeight
    let x = pointer.x + 14
    let y = pointer.y + 18
    if (x + width > w - 4) x = pointer.x - width - 10
    if (y + height > h - 4) y = pointer.y - height - 10
    chip.style.transform = `translate(${Math.round(Math.max(4, x))}px, ${Math.round(Math.max(4, y))}px)`
  }

  const draw = (): void => {
    scheduled = false
    const outlines: Outline[] = []
    const selection = store.selection.peek()
    if (selection !== null) {
      // The state the element is held in is said on the page too: it is why it looks hovered with no pointer on it.
      const state = store.state.peek()
      outlines.push(state === null ? { kind: 'selected', element: selection.element } : { kind: 'selected', element: selection.element, label: `:${state}` })
    }
    const hovered = store.hovered.peek()
    if (hovered !== null && hovered !== selection?.element) outlines.push({ kind: 'hover', element: hovered })
    outlines.push(...store.outlines.peek())

    let used = 0
    let selected: Box | undefined
    for (const outline of outlines) {
      const box = boxOf(outline, view)
      if (box === undefined) continue
      if (outline.kind === 'selected' && outline.element === selection?.element) selected = box
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
    drawPins()
    drawChip()
    options.onSelection?.(selected === undefined ? null : { x: selected.x, y: selected.y, width: selected.width, height: selected.height })
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
    // A forced :hover or :focus can change the size of the selected element.
    void store.state.value
    void store.open.value
    void store.pinsHidden.value
    void store.panel.value
    // The handles on the selection are hidden while an action runs.
    void store.busy.value
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
    flush: draw,
    pins: () => shownPins.map(({ spec, rect }) => ({ number: spec.number, status: spec.status, uid: spec.uid, ...rect })),
    dispose() {
      stop()
      resized.disconnect()
      view.removeEventListener('scroll', schedule, { capture: true })
      view.removeEventListener('resize', schedule)
      for (const node of [...pool, ...pinPool, chip]) node.remove()
    },
  }
}
