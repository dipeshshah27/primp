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
 * Reorder: the grip stands on what a drag moves (`controller.moveTarget`): the selection when it
 * is an item of a list, else the nearest ancestor that is (the card around a clicked paragraph,
 * outlined dashed while the grip is hovered); pressing it selects that element. During the drag
 * the element is SHOWN where the drop would put it (`controller.previewMove`, a live move like the
 * live size of a resize), its siblings glide to their new places, and a chip at the pointer says
 * where it lands ("after Team · 2 of 3"). The drop target is computed on the layout as it was
 * when the drag began (probe/order.ts `dropTarget`): over a sibling the element takes its place,
 * over empty space it goes into the nearest gap. The dock's frames fade out of the way, and the
 * page (or the list's own scroll box) scrolls when the pointer nears its edge. The drop calls
 * `reorder`, which puts the live move back and records the move in the same task. Escape
 * cancels and puts it back.
 *
 * Hidden while the controller is busy and without a selection; the resize handles for an element
 * they cannot act on. When nothing around the selection can be moved, a greyed grip says why.
 */

import { motionPaused } from '../probe/page-mode.ts'
import { SWALLOWED } from '../probe/select.ts'
import { dropTarget, elementChildren, positionOf, type Box } from '../probe/order.ts'
import { labelOf } from '../probe/ref.ts'
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
  /** A drag began (its kind) or ended (null): the dock fades its frames out of the way meanwhile. */
  onDrag?(kind: DragState['kind'] | null): void
}

const HANDLE = 14
const GRIP_W = 34
const GRIP_H = 22
/** Within this distance of an edge, a reorder drag scrolls the page (or the list's scroll box). */
const EDGE = 56
/** The fastest scroll, in px per frame, with the pointer at the very edge. */
const SCROLL_MAX = 22
/** How long the siblings take to glide to their new places during a reorder drag. */
const GLIDE_MS = 160
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
  /** Reorder: the layout when the drag began, which the drop target is computed on. */
  origin?: Origin
  /** The pointer's last position, for scrolling at the edges. */
  x: number
  y: number
  /**
   * Scrolling at the edges is on: the pointer has travelled far enough. A grip near the top of the
   * window starts inside the edge zone, and the page must not scroll away at the first move.
   */
  armed: boolean
}

/** How far the pointer travels before a reorder drag may scroll at the edges. */
const ARM_PX = 24

/** The layout a reorder drag targets: the siblings' boxes as they were, and the scroll offsets then. */
interface Origin {
  boxes: (Box | null)[]
  scrollX: number
  scrollY: number
  /** The scroll box the list sits in, when it is not the page. */
  box: Element | null
  boxLeft: number
  boxTop: number
}

const scrolls = (value: string): boolean => value === 'auto' || value === 'scroll' || value === 'overlay'

/** The nearest element at or above `from` that scrolls its content (not the page itself). */
function scrollBoxOf(from: Element): Element | null {
  for (let element: Element | null = from; element !== null; element = element.parentElement) {
    if (element.localName === 'body' || element.localName === 'html') return null
    const style = getComputedStyle(element)
    if ((scrolls(style.overflowY) && element.scrollHeight > element.clientHeight + 1) || (scrolls(style.overflowX) && element.scrollWidth > element.clientWidth + 1)) return element
  }
  return null
}

const shownBox = (element: Element): Box | null => {
  if (element.getClientRects().length === 0) return null
  const r = element.getBoundingClientRect()
  return r.width === 0 && r.height === 0 ? null : { left: r.left, top: r.top, width: r.width, height: r.height }
}

/** A sibling's name in the drag chip: its text when it has some, else its tag and class. */
const shortName = (element: Element): string => {
  const label = labelOf(element)
  const quoted = /"(.*)"$/.exec(label)?.[1]
  const name = quoted !== undefined && quoted !== '' ? `“${quoted.length > 22 ? `${quoted.slice(0, 21)}…` : quoted}”` : label.split(' "')[0]!
  return name
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
  const tag = make('drag-tag')
  /** The element the grip moves, outlined while the grip is hovered when it is not the selection. */
  const targetBox = make('move-target')
  /** A greyed grip when nothing around the selection can be moved; its tooltip says why. */
  const gripOff = make('grip off')
  gripOff.dataset.handleOff = ''
  let gripTarget: Element | null = null
  nodes.grip.addEventListener('pointerenter', () => {
    if (drag !== null || gripTarget === null || gripTarget === store.selection.peek()?.element) return
    const r = gripTarget.getBoundingClientRect()
    targetBox.style.width = `${r.width}px`
    targetBox.style.height = `${r.height}px`
    show(targetBox, r.left, r.top)
  })
  nodes.grip.addEventListener('pointerleave', () => hide(targetBox))
  /** The siblings' glides in progress: finished before anything is measured. */
  let glides: Animation[] = []

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

  /** `controller.moveTarget`, asked again only when the selection or the recorded changes change (it walks up the tree). */
  let known: { element: Element; items: unknown; target: ReturnType<Controller['moveTarget']> } | null = null
  const moveTarget = (): ReturnType<Controller['moveTarget']> => {
    const element = store.selection.peek()?.element
    const items = store.items.peek()
    if (element === undefined) return null
    if (known === null || known.element !== element || known.items !== items) known = { element, items, target: c.moveTarget() }
    return known.target
  }

  /** Where the grip goes for a box: above it, else below it, else just inside its top edge; never over the page's text when there is room. */
  const gripAt = (box: ViewRect): { x: number; y: number } => {
    const x = Math.max(2, Math.min(view.innerWidth - GRIP_W - 2, box.x + box.width / 2 - GRIP_W / 2))
    if (box.y >= GRIP_H + 6) return { x, y: box.y - GRIP_H - 4 }
    if (box.y + box.height + GRIP_H + 6 <= view.innerHeight) return { x, y: box.y + box.height + 4 }
    return { x, y: box.y + 3 }
  }

  const place = (box: ViewRect | null): void => {
    lastBox = box
    const selection = store.selection.peek()
    const dragging = drag !== null && !drag.cancelled
    const visible = box !== null && selection !== null && (dragging || !store.busy.peek())
    const reordering = dragging && drag?.state.kind === 'reorder'
    const resizable = visible && !reordering && (drag?.state.kind === 'resize' || c.resizeRefusal() === null)
    const target = visible && !dragging ? moveTarget() : null
    gripTarget = target?.refusal === null ? target.element : null
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
    // During a reorder drag the grip stays under the pointer's capture but out of sight: the chip shows the drag.
    nodes.grip.style.visibility = reordering ? 'hidden' : ''
    if (reordering) {
      hide(gripOff)
      return
    }
    if (target === null || box === null) {
      hide(nodes.grip)
      hide(gripOff)
      hide(targetBox)
      return
    }
    if (target.refusal !== null) {
      hide(nodes.grip)
      hide(targetBox)
      const at = gripAt(box)
      gripOff.title = /only child|page body/.test(target.refusal) ? `${target.refusal} To move its container instead, select the parent (↑).` : target.refusal
      show(gripOff, at.x, at.y)
      return
    }
    hide(gripOff)
    const own = target.element === selection?.element
    const r = own ? box : rectOf(target.element)
    const at = gripAt(r)
    const name = labelOf(target.element).split(' "')[0]
    nodes.grip.title = own ? 'Drag to move this element among its siblings (Alt+↑ / Alt+↓ moves it one place)' : `Drag to move the ${name} this element is in, among its siblings`
    nodes.grip.classList.toggle('item', !own)
    show(nodes.grip, at.x, at.y)
  }

  /** The chip next to the pointer, kept inside the viewport. */
  const showTag = (text: string, x: number, y: number, beside = true): void => {
    tag.textContent = text
    tag.style.display = 'block'
    const width = tag.offsetWidth
    const height = tag.offsetHeight
    let left = beside ? x + 16 : x
    let top = beside ? y + 18 : y
    if (left + width > view.innerWidth - 4) left = Math.max(4, x - width - 12)
    if (top + height > view.innerHeight - 4) top = Math.max(4, y - height - 12)
    show(tag, left, top)
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
    hide(tag)
    try {
      if (ended !== null && ended.handle.hasPointerCapture(ended.pointerId)) ended.handle.releasePointerCapture(ended.pointerId)
    } catch {
      // Already released.
    }
    ended?.handle.classList.remove('active')
    if (ended?.started === true) options.onDrag?.(null)
    place(lastBox)
    options.redraw()
  }

  /** Ends the siblings' glides at once: a measurement must not see them half way. */
  const settleGlides = (): void => {
    for (const glide of glides) {
      try {
        glide.cancel()
      } catch {
        // Already gone.
      }
    }
    glides = []
  }

  const cancel = (): void => {
    if (drag === null || drag.cancelled) return
    if (drag.state.kind === 'resize') c.previewSize(null)
    else {
      settleGlides()
      c.previewMove(null)
    }
    drag.cancelled = true
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
    showTag(`${Math.round(now.width)} × ${Math.round(now.height)}`, now.x + now.width + 6, now.y + now.height + 4, false)
    options.redraw()
  }

  /** Where the drop would land: computed on the layout of the drag's start, moved by what has scrolled since. */
  const targetAt = (current: Drag, from: number, x: number, y: number) => {
    const origin = current.origin!
    const dx = view.scrollX - origin.scrollX + (origin.box === null ? 0 : origin.box.scrollLeft - origin.boxLeft)
    const dy = view.scrollY - origin.scrollY + (origin.box === null ? 0 : origin.box.scrollTop - origin.boxTop)
    const boxes = origin.boxes.map((box) => (box === null ? null : { left: box.left - dx, top: box.top - dy, width: box.width, height: box.height }))
    return dropTarget(boxes, from, x, y)
  }

  /** Lets the siblings glide from where they were to where the live move put them (First, Last, Invert, Play). */
  const glide = (siblings: readonly Element[], before: Map<Element, DOMRect>, dragged: Element): void => {
    settleGlides()
    if (motionPaused() || view.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    for (const sibling of siblings) {
      const was = before.get(sibling)
      if (was === undefined || sibling === dragged || typeof sibling.animate !== 'function') continue
      const now = sibling.getBoundingClientRect()
      const dx = was.left - now.left
      const dy = was.top - now.top
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue
      try {
        // Added to whatever transform the page gives it, and gone when it ends: no style of the page is touched.
        glides.push(sibling.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], { duration: GLIDE_MS, easing: 'cubic-bezier(0.2, 0, 0, 1)', composite: 'add' }))
      } catch {
        // No Web Animations here: the siblings jump instead.
      }
    }
  }

  const reorderTo = (current: Drag, x: number, y: number): void => {
    if (current.state.kind !== 'reorder' || current.origin === undefined) return
    const from = current.state.fromIndex
    const found = targetAt(current, from, x, y)
    if (found === null) return
    const toIndex = found.toIndex
    if (toIndex !== current.state.toIndex) {
      const parent = current.element.parentElement
      const siblings = parent === null ? [] : elementChildren(parent)
      const before = new Map(siblings.map((sibling) => [sibling, sibling.getBoundingClientRect()] as const))
      c.previewMove(toIndex === from ? null : toIndex)
      glide(siblings, before, current.element)
      options.redraw()
    }
    const shown: ViewRect | null = found.line === null ? null : { x: found.line.left, y: found.line.top, width: found.line.width, height: found.line.height }
    current.state = { kind: 'reorder', fromIndex: from, count: current.state.count, toIndex, line: shown }
    showTag(chipText(current.element, toIndex === from), x, y)
  }

  /** What the drag chip says: where the element now stands, by its neighbours, and its place among the shown siblings. */
  const chipText = (element: Element, unchanged: boolean): string => {
    const parent = element.parentElement
    if (unchanged || parent === null) return 'No change: drop it over another place'
    const shown = elementChildren(parent).filter((sibling) => sibling === element || shownBox(sibling) !== null)
    const at = shown.indexOf(element)
    const where = at > 0 ? `after ${shortName(shown[at - 1]!)}` : shown.length > 1 ? `before ${shortName(shown[1]!)}` : ''
    return `${where} · ${at + 1} of ${shown.length}`
  }

  const begin = (name: HandleName, handle: HTMLElement, event: PointerEvent): void => {
    let element = store.selection.peek()?.element
    if (element === undefined || !element.isConnected) return
    const box = rectOf(element)
    let state: DragState
    let origin: Origin | undefined
    if (name === 'grip') {
      const target = c.moveTarget()
      if (target === null || target.refusal !== null) return
      // The grip may stand on the item around the selection (the card around a paragraph): pressing it selects that.
      if (target.element !== element) c.select(target.element)
      element = target.element
      const position = positionOf(element)
      if (position === null) return
      state = { kind: 'reorder', fromIndex: position.index, count: position.siblings.length, toIndex: null, line: null }
      const box = scrollBoxOf(position.parent)
      origin = { boxes: position.siblings.map(shownBox), scrollX: view.scrollX, scrollY: view.scrollY, box, boxLeft: box?.scrollLeft ?? 0, boxTop: box?.scrollTop ?? 0 }
      hide(targetBox)
    } else {
      if (c.resizeRefusal() !== null) return
      state = { kind: 'resize', handle: name, size: {} }
    }
    drag = { pointerId: event.pointerId, handle, startX: event.clientX, startY: event.clientY, started: false, cancelled: false, element, state, startW: box.width, startH: box.height, x: event.clientX, y: event.clientY, armed: false }
    if (origin !== undefined) drag.origin = origin
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
      else {
        settleGlides()
        c.previewMove(null)
      }
      return
    }
    if (state.kind === 'resize') {
      // The live rule stays until the recorded preview replaces it, in the same task: no frame shows the old size.
      void c.resize(state.size)
      return
    }
    settleGlides()
    // Likewise the live move: `reorder` puts it back and records the move in one task.
    if (state.toIndex !== null && state.toIndex !== state.fromIndex) {
      void c.reorder(state.toIndex).then((result) => {
        // The drop happened on the page: a refusal is said there, as a toast.
        if (!result.ok && result.error !== undefined) store.toast.value = { text: result.error, tone: 'bad', at: performance.now() }
      })
    } else c.previewMove(null)
  }

  // --- scrolling at the edges during a reorder drag -----------------------------------

  /** How fast to scroll for a pointer at `at` within [low, high]: negative near low, positive near high, 0 in between. */
  const speed = (at: number, low: number, high: number): number => {
    const edge = Math.min(EDGE, (high - low) / 4)
    if (at < low + edge) return -Math.ceil(SCROLL_MAX * Math.min(1, (low + edge - at) / edge))
    if (at > high - edge) return Math.ceil(SCROLL_MAX * Math.min(1, (at - (high - edge)) / edge))
    return 0
  }

  const scrollLoop = (): void => {
    const current = drag
    if (current === null || current.cancelled || current.state.kind !== 'reorder' || current.origin === undefined) return
    let moved = false
    const box = current.origin.box
    if (!current.armed) {
      view.requestAnimationFrame(scrollLoop)
      return
    }
    if (box !== null) {
      const r = box.getBoundingClientRect()
      const vx = speed(current.x, r.left, r.right)
      const vy = speed(current.y, r.top, r.bottom)
      if (vx !== 0 || vy !== 0) {
        const left = box.scrollLeft
        const top = box.scrollTop
        box.scrollBy(vx, vy)
        moved = box.scrollLeft !== left || box.scrollTop !== top
      }
    }
    if (!moved) {
      const vx = speed(current.x, 0, view.innerWidth)
      const vy = speed(current.y, 0, view.innerHeight)
      if (vx !== 0 || vy !== 0) {
        const left = view.scrollX
        const top = view.scrollY
        view.scrollBy(vx, vy)
        moved = view.scrollX !== left || view.scrollY !== top
      }
    }
    if (moved) reorderTo(current, current.x, current.y)
    view.requestAnimationFrame(scrollLoop)
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
      current.x = event.clientX
      current.y = event.clientY
      if (!current.armed && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) >= ARM_PX) current.armed = true
      if (!current.started) {
        if (Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < DRAG_THRESHOLD) return
        current.started = true
        options.onDrag?.(current.state.kind)
        if (current.state.kind === 'reorder') {
          place(lastBox)
          scrollLoop()
        }
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
    const first = event.composedPath()[0]
    if (first === gripOff) {
      // A press on the greyed grip asks why nothing moves: it is said, and the press goes no further.
      event.stopImmediatePropagation()
      event.preventDefault()
      if (gripOff.title !== '') store.toast.value = { text: gripOff.title, tone: 'bad', at: performance.now() }
      return
    }
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
      settleGlides()
      for (const node of [...Object.values(nodes), tag, targetBox, gripOff]) node.remove()
    },
  }
}
