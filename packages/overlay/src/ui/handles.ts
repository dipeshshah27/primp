/**
 * The handles on the selected element: three resize handles (right edge, bottom edge,
 * bottom-right corner) and a grip to drag the element to another place among its siblings.
 *
 * They are drawn in the highlight layer (highlight.ts) and are its only elements with
 * `pointer-events: auto`. Like the boxes they are placed with `transform` and sized with
 * width/height, so showing and moving them adds no layout shift to the page.
 *
 * Events. One capture-phase `pointerdown` listener on the window is always there; it acts only
 * when the press is on one of the handles (and then the page never sees it). While a drag is in
 * progress, and until the click that follows the drop, every pointer, mouse and click event is
 * stopped at the window in the capture phase, with the same list pick mode uses (select.ts), so
 * the app's own handlers do not run: dragging over a button does not press it. The handle holds
 * pointer capture for the drag.
 *
 * Resize: the drag updates one preview rule (`controller.previewSize`), with no side-effect
 * measurement, no history and no message to the server; the release records one `resize`.
 * Shift on the corner keeps the aspect ratio. Escape cancels and restores.
 *
 * Reorder: the grip shows an insertion line in the gap between siblings nearest to the pointer
 * (probe/order.ts `dropSlot`: rows, columns and grids alike); the drop calls `reorder`. Escape
 * cancels.
 *
 * Hidden while the controller is busy, without a selection, and each for an
 * element it cannot act on: the resize handles for an inline element, the grip for an element
 * that has no siblings (or is hidden by a recorded change).
 */

import { SWALLOWED } from '../probe/select.ts'
import { dropSlot, positionOf, toIndexOf, type Box } from '../probe/order.ts'
import type { Controller, SizeRequest } from '../state/controller.ts'

export interface ViewRect {
  x: number
  y: number
  width: number
  height: number
}

export type HandleName = 'e' | 's' | 'se' | 'grip'

export type DragState =
  | { kind: 'resize'; handle: 'e' | 's' | 'se'; size: SizeRequest }
  | { kind: 'reorder'; fromIndex: number; count: number; toIndex: number | null; line: ViewRect | null }

export interface Handles {
  /** The selected element's box in viewport coordinates (null: none to show). Called by the highlighter on every draw. */
  place(box: ViewRect | null): void
  /** Client rects of the handles that are shown now. */
  rects(): Partial<Record<HandleName, ViewRect>>
  /** The drag in progress, if any. */
  drag(): DragState | null
  dispose(): void
}

export interface HandlesOptions {
  /** Redraws the boxes (the selection changes size during a resize drag). */
  redraw(): void
  /** Other windows that may hold the keyboard focus during a drag (the dock's frame): Escape there cancels too. */
  keyTargets?(): (Window | null)[]
}

const HANDLE = 14
const GRIP_W = 26
const GRIP_H = 16
/** A press that moves less than this is a click, not a drag. */
const DRAG_THRESHOLD = 3
/** How long the click that follows a drop is waited for. */
const CLICK_WAIT_MS = 400

const rectOf = (element: Element): ViewRect => {
  const r = element.getBoundingClientRect()
  return { x: r.left, y: r.top, width: r.width, height: r.height }
}

const boxOf = (element: Element): Box => {
  const r = element.getBoundingClientRect()
  return { left: r.left, top: r.top, width: r.width, height: r.height }
}

const at = (node: HTMLElement, x: number, y: number): void => {
  node.style.transform = `translate(${Math.round(x * 2) / 2}px, ${Math.round(y * 2) / 2}px)`
}

interface Drag {
  pointerId: number
  handle: HTMLElement
  startX: number
  startY: number
  started: boolean
  cancelled: boolean
  element: Element
  state: DragState
  /** Resize: the border box when the drag began. */
  startW: number
  startH: number
}

export function createHandles(layer: HTMLElement, c: Controller, options: HandlesOptions, view: Window = window): Handles {
  const doc = layer.ownerDocument
  const { store } = c
  const make = (className: string, title?: string): HTMLElement => {
    const node = doc.createElement('div')
    node.className = className
    if (title !== undefined) node.title = title
    node.style.display = 'none'
    layer.append(node)
    return node
  }
  const nodes: Record<HandleName, HTMLElement> = {
    e: make('handle e', 'Drag to change the width'),
    s: make('handle s', 'Drag to change the height'),
    se: make('handle se', 'Drag to change the size (Shift keeps the proportions)'),
    grip: make('grip', 'Drag to move this element among its siblings'),
  }
  for (const [name, node] of Object.entries(nodes)) node.dataset.handle = name
  const line = make('insert')
  const tag = make('drag-tag')

  let drag: Drag | null = null
  let swallowing = false
  let clickTimer: number | undefined
  let lastBox: ViewRect | null = null

  const hide = (node: HTMLElement): void => {
    node.style.display = 'none'
  }
  const show = (node: HTMLElement, x: number, y: number): void => {
    node.style.display = 'block'
    at(node, x, y)
  }

  const place = (box: ViewRect | null): void => {
    lastBox = box
    const selection = store.selection.peek()
    const dragging = drag !== null && !drag.cancelled
    const visible = box !== null && selection !== null && (dragging || !store.busy.peek())
    const resizable = visible && (drag?.state.kind === 'resize' || c.resizeRefusal() === null)
    const movable = visible && (drag?.state.kind === 'reorder' || c.reorderRefusal() === null)
    if (!resizable || box === null) {
      hide(nodes.e)
      hide(nodes.s)
      hide(nodes.se)
    } else {
      const half = HANDLE / 2
      // A box too small for three handles keeps the corner.
      if (box.height >= HANDLE * 2) show(nodes.e, box.x + box.width - half, box.y + box.height / 2 - half)
      else hide(nodes.e)
      if (box.width >= HANDLE * 2) show(nodes.s, box.x + box.width / 2 - half, box.y + box.height - half)
      else hide(nodes.s)
      show(nodes.se, box.x + box.width - half, box.y + box.height - half)
    }
    if (!movable || box === null) hide(nodes.grip)
    // Centred above the top edge; inside the box when that edge is at the top of the viewport.
    else show(nodes.grip, box.x + box.width / 2 - GRIP_W / 2, box.y < GRIP_H + 4 ? box.y + 3 : box.y - GRIP_H - 3)
  }

  const showTag = (text: string, x: number, y: number): void => {
    tag.textContent = text
    show(tag, x, y)
  }

  // --- swallowing the page's events ------------------------------------------

  const stopSwallowing = (): void => {
    if (clickTimer !== undefined) view.clearTimeout(clickTimer)
    clickTimer = undefined
    if (!swallowing) return
    swallowing = false
    for (const type of SWALLOWED) view.removeEventListener(type, onSwallow, { capture: true })
    view.removeEventListener('pointercancel', onCancelEvent, { capture: true })
    for (const target of options.keyTargets?.() ?? []) target?.removeEventListener('keydown', onKey, true)
  }

  const startSwallowing = (): void => {
    if (clickTimer !== undefined) view.clearTimeout(clickTimer)
    clickTimer = undefined
    if (swallowing) return
    swallowing = true
    for (const type of SWALLOWED) view.addEventListener(type, onSwallow, { capture: true, passive: false })
    view.addEventListener('pointercancel', onCancelEvent, { capture: true })
    for (const target of options.keyTargets?.() ?? []) target?.addEventListener('keydown', onKey, true)
  }

  /** After the drop: the click the browser sends for the press still belongs to the drag. */
  const awaitClick = (): void => {
    if (clickTimer !== undefined) view.clearTimeout(clickTimer)
    clickTimer = view.setTimeout(stopSwallowing, CLICK_WAIT_MS)
  }

  const finish = (): void => {
    const ended = drag
    drag = null
    hide(line)
    hide(tag)
    try {
      if (ended !== null && ended.handle.hasPointerCapture(ended.pointerId)) ended.handle.releasePointerCapture(ended.pointerId)
    } catch {
      // Already released.
    }
    ended?.handle.classList.remove('active')
    place(lastBox)
    options.redraw()
  }

  const cancel = (): void => {
    if (drag === null || drag.cancelled) return
    if (drag.state.kind === 'resize') c.previewSize(null)
    drag.cancelled = true
    hide(line)
    hide(tag)
    options.redraw()
  }

  // --- the drags ---------------------------------------------------------------

  const resizeTo = (current: Drag, x: number, y: number, keepRatio: boolean): void => {
    if (current.state.kind !== 'resize') return
    const handle = current.state.handle
    const dx = x - current.startX
    const dy = y - current.startY
    let width = handle === 's' ? undefined : Math.max(1, current.startW + dx)
    let height = handle === 'e' ? undefined : Math.max(1, current.startH + dy)
    if (handle === 'se' && keepRatio && current.startW > 0 && current.startH > 0 && width !== undefined && height !== undefined) {
      const scale = Math.max(width / current.startW, height / current.startH)
      width = Math.max(1, current.startW * scale)
      height = Math.max(1, current.startH * scale)
    }
    const size: SizeRequest = {}
    if (width !== undefined) size.width = Math.round(width)
    if (height !== undefined) size.height = Math.round(height)
    current.state = { kind: 'resize', handle, size }
    c.previewSize(size)
    const now = rectOf(current.element)
    showTag(`${Math.round(now.width)} × ${Math.round(now.height)}`, now.x + now.width + 6, now.y + now.height + 4)
    options.redraw()
  }

  const reorderTo = (current: Drag, x: number, y: number): void => {
    if (current.state.kind !== 'reorder') return
    const position = positionOf(current.element)
    if (position === null) return
    const slot = dropSlot(position.siblings.map(boxOf), x, y)
    if (slot === null) return
    const toIndex = toIndexOf(slot.slot, position.index)
    const shown: ViewRect | null = toIndex === position.index ? null : { x: slot.line.left, y: slot.line.top, width: slot.line.width, height: slot.line.height }
    current.state = { kind: 'reorder', fromIndex: position.index, count: position.siblings.length, toIndex, line: shown }
    if (shown === null) {
      hide(line)
      hide(tag)
      return
    }
    line.style.width = `${shown.width}px`
    line.style.height = `${shown.height}px`
    show(line, shown.x, shown.y)
    // Above a vertical line, below the start of a horizontal one.
    const across = shown.width > shown.height
    showTag(`position ${toIndex + 1} of ${position.siblings.length}`, across ? shown.x : shown.x - 8, across ? shown.y + 6 : shown.y - 22)
  }

  const begin = (name: HandleName, handle: HTMLElement, event: PointerEvent): void => {
    const element = store.selection.peek()?.element
    if (element === undefined || !element.isConnected) return
    const box = rectOf(element)
    let state: DragState
    if (name === 'grip') {
      const position = positionOf(element)
      if (position === null || c.reorderRefusal() !== null) return
      state = { kind: 'reorder', fromIndex: position.index, count: position.siblings.length, toIndex: null, line: null }
    } else {
      if (c.resizeRefusal() !== null) return
      state = { kind: 'resize', handle: name, size: {} }
    }
    drag = { pointerId: event.pointerId, handle, startX: event.clientX, startY: event.clientY, started: false, cancelled: false, element, state, startW: box.width, startH: box.height }
    handle.classList.add('active')
    try {
      handle.setPointerCapture(event.pointerId)
    } catch {
      // Without capture the window listeners still see every move.
    }
    startSwallowing()
  }

  const drop = (current: Drag): void => {
    const state = current.state
    const same = store.selection.peek()?.element === current.element
    finish()
    if (current.cancelled || !current.started || !same) {
      if (state.kind === 'resize') c.previewSize(null)
      return
    }
    if (state.kind === 'resize') {
      // The live rule stays until the recorded preview replaces it, in the same task: no frame shows the old size.
      void c.resize(state.size)
    } else if (state.toIndex !== null && state.toIndex !== state.fromIndex) {
      void c.reorder(state.toIndex)
    }
  }

  // --- listeners -----------------------------------------------------------------

  const handleOf = (event: Event): HandleName | undefined => {
    const first = event.composedPath()[0]
    if (!(first instanceof HTMLElement)) return undefined
    const name = first.dataset.handle as HandleName | undefined
    return name !== undefined && nodes[name] === first ? name : undefined
  }

  function onSwallow(event: Event): void {
    event.stopImmediatePropagation()
    if (event.cancelable && event.type !== 'pointermove' && event.type !== 'mousemove') event.preventDefault()
    const current = drag
    if (current === null) {
      // The release's own boundary events (the pointer now over a page element) come with it, in the same task.
      if (event.type === 'click' || event.type === 'auxclick' || event.type === 'contextmenu') {
        if (clickTimer !== undefined) view.clearTimeout(clickTimer)
        clickTimer = view.setTimeout(stopSwallowing, 0)
      }
      return
    }
    if (!(event instanceof PointerEvent) || event.pointerId !== current.pointerId) return
    if (event.type === 'pointermove') {
      if (current.cancelled) return
      if (!current.started) {
        if (Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < DRAG_THRESHOLD) return
        current.started = true
      }
      if (current.state.kind === 'resize') resizeTo(current, event.clientX, event.clientY, event.shiftKey)
      else reorderTo(current, event.clientX, event.clientY)
    } else if (event.type === 'pointerup') {
      drop(current)
      awaitClick()
    }
  }

  function onCancelEvent(event: Event): void {
    if (drag === null || (event instanceof PointerEvent && event.pointerId !== drag.pointerId)) return
    cancel()
    finish()
    awaitClick()
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || drag === null) return
    event.preventDefault()
    event.stopImmediatePropagation()
    // The button is still down: its release and click are still swallowed.
    cancel()
  }

  const onDown = (event: PointerEvent): void => {
    const name = handleOf(event)
    if (name === undefined) return
    event.stopImmediatePropagation()
    event.preventDefault()
    if (event.button !== 0 || drag !== null) return
    begin(name, nodes[name], event)
  }
  view.addEventListener('pointerdown', onDown, { capture: true })
  // Always there, and so before the selection's own key listener (added when the dock opens): an
  // Escape during a drag cancels the drag and nothing else.
  view.addEventListener('keydown', onKey, true)

  return {
    place,
    rects() {
      const out: Partial<Record<HandleName, ViewRect>> = {}
      for (const [name, node] of Object.entries(nodes) as [HandleName, HTMLElement][]) if (node.style.display !== 'none') out[name] = rectOf(node)
      return out
    },
    drag: () => (drag === null || drag.cancelled ? null : drag.state),
    dispose() {
      cancel()
      finish()
      stopSwallowing()
      view.removeEventListener('pointerdown', onDown, { capture: true })
      view.removeEventListener('keydown', onKey, true)
      for (const node of [...Object.values(nodes), line, tag]) node.remove()
    },
  }
}
