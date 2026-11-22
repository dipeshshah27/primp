/**
 * Puts the dock on the page.
 *
 *   <primp-root data-primp-root popover="manual">      one custom element, appended to <html>
 *     #shadow-root
 *       <div class="layer">     outlines, pins and the label chip (highlight.ts), the handles on the selection (handles.ts)
 *       <iframe class="pop">    the popover: inspector or a panel (pop.tsx), its own document
 *       <iframe class="bar">    the launcher or the toolbar (bar.tsx), its own document
 *       <div class="over">      tooltips, the toast, the resize note: above the frames
 *
 * Why the toolbar and the popover each have a document of their own: an element that moves
 * inside a shadow tree is a layout shift of the page as far as the Layout Instability API is
 * concerned (measured: a row inserted above another inside a top-layer shadow tree produced an
 * entry with a null source node). A tool that measures the page's layout shifts must not add to
 * them every time its own list grows. Shifts inside a frame are reported to the frame, not to the
 * page. The frames have no `src` (`about:blank`), so no request is made and no
 * Content-Security-Policy applies to loading them; their styles are constructable stylesheets. As
 * a side benefit, page styles and dock styles cannot reach each other at all.
 *
 * The host is a 0 x 0 fixed box in the top layer (popover API, manual mode; a very high z-index
 * where that is missing). Frames, boxes, pins and tooltips are placed with `transform` and sized
 * with width/height, neither of which is a layout shift, so opening, closing, dragging and
 * re-anchoring leave the page's measurements alone. Nothing here takes focus on load.
 *
 * The dock starts closed on every load: a round launcher in its corner. ⌘⇧E (Ctrl+Shift+E)
 * toggles it from anywhere. Open, the page's clicks select (probe/select.ts) and the popover is
 * anchored next to the selection (flipped and shifted to stay in the viewport; a bottom sheet
 * below 480 px). Escape closes the popover first, then the dock.
 */

import { effect, signal } from '@preact/signals'
import { h, render, type ComponentChild } from 'preact'
import { labelOf } from '../probe/ref.ts'
import { OVERLAY_ROOT_ATTR } from '../probe/snapshot.ts'
import type { Controller } from '../state/controller.ts'
import { pinGroups } from '../state/pins.ts'
import type { PanelName, ThemeSetting } from '../state/store.ts'
import { Bar, type DockUi } from './bar.tsx'
import { FRAME_CSS, HOST_CSS } from './css.ts'
import { createHandles, type Handles } from './handles.ts'
import { createHighlighter, type Highlighter, type PinSpec, type ViewBox } from './highlight.ts'
import { basename } from './parts.tsx'
import { Pop } from './pop.tsx'

export const HOST_TAG = 'primp-root'

const MARGIN = 16
/** Gap between the selection and the popover next to it. */
const GAP = 12
const POP_WIDTH = 340
/** Below this viewport width the popover is a bottom sheet. */
const SHEET_BELOW = 480
const STORAGE_KEY = 'primp:dock'
const TOAST_MS = 2400

type Horizontal = 'left' | 'right'
type Vertical = 'top' | 'middle' | 'bottom'
interface Saved {
  h: Horizontal
  v: Vertical
  theme: ThemeSetting
}

/** The toolbar's resting places, in the order "Next corner" walks them. */
const PLACES: [Horizontal, Vertical][] = [
  ['right', 'bottom'],
  ['left', 'bottom'],
  ['left', 'top'],
  ['right', 'top'],
]

export interface DockHandle {
  host: HTMLElement
  /** The popover's frame (inspector and panels). */
  frame: HTMLIFrameElement
  /** The toolbar's frame (launcher when closed). */
  bar: HTMLIFrameElement
  highlighter: Highlighter
  /** The resize handles and the reorder grip on the selection. */
  handles: Handles
  /** True once both frames have rendered. */
  mounted(): boolean
  /** Writes to the clipboard from whichever document is allowed to. */
  copy(text: string): Promise<boolean>
  setOpen(open: boolean): void
  /** The open panel's frame rect and the toolbar's, in viewport coordinates (null: not shown). */
  geometry(): { bar: ViewBox; pop: (ViewBox & { sheet: boolean }) | null }
}

function load(): Saved {
  const fallback: Saved = { h: 'right', v: 'bottom', theme: 'auto' }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return fallback
    const saved = JSON.parse(raw) as Partial<Saved>
    return {
      h: saved.h === 'left' ? 'left' : 'right',
      v: saved.v === 'top' || saved.v === 'middle' ? saved.v : 'bottom',
      theme: saved.theme === 'dark' || saved.theme === 'light' ? saved.theme : 'auto',
    }
  } catch {
    return fallback
  }
}

function save(state: Saved): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Storage is blocked: the dock just starts in its default place next time.
  }
}

const isTyping = (target: EventTarget | null): boolean => {
  if (!(target instanceof Element)) return false
  const tag = target.localName
  return tag === 'input' || tag === 'textarea' || tag === 'select' || (target as HTMLElement).isContentEditable
}

export function mountDock(c: Controller): DockHandle {
  const { store } = c
  const state = load()
  const theme = signal<ThemeSetting>(state.theme)
  store.theme.value = state.theme
  const page = location.pathname + location.search

  try {
    if (customElements.get(HOST_TAG) === undefined) customElements.define(HOST_TAG, class extends HTMLElement {})
  } catch {
    // An unknown element works as a host just as well.
  }
  const host = document.createElement(HOST_TAG)
  host.setAttribute(OVERLAY_ROOT_ATTR, '')
  const shadow = host.attachShadow({ mode: 'open' })
  const hostSheet = new CSSStyleSheet()
  hostSheet.replaceSync(HOST_CSS)
  shadow.adoptedStyleSheets = [hostSheet]

  const layer = document.createElement('div')
  layer.className = 'layer'
  layer.setAttribute('aria-hidden', 'true')
  const pop = document.createElement('iframe')
  pop.title = 'primp inspector'
  pop.className = 'pop hidden'
  pop.setAttribute('data-primp-dock', 'pop')
  const bar = document.createElement('iframe')
  bar.title = 'primp'
  bar.className = 'bar'
  bar.setAttribute('data-primp-dock', 'bar')
  const over = document.createElement('div')
  over.className = 'over'
  over.setAttribute('aria-hidden', 'true')
  const tipNode = document.createElement('div')
  tipNode.className = 'tip'
  const toastNode = document.createElement('div')
  toastNode.className = 'toast'
  toastNode.setAttribute('role', 'status')
  const noteNode = document.createElement('div')
  noteNode.className = 'note-chip'
  over.append(tipNode, toastNode, noteNode)
  shadow.append(layer, pop, bar, over)

  const viewport = (): { w: number; h: number } => ({
    w: document.documentElement.clientWidth || innerWidth,
    h: Math.min(innerHeight, document.documentElement.clientHeight || innerHeight),
  })
  const place = (node: HTMLElement, x: number, y: number): void => {
    node.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
  }

  // --- the toolbar's frame -------------------------------------------------------
  const barBox = { x: 0, y: 0, w: 44, h: 44 }
  let dragging = false
  const placeBar = (): void => {
    if (dragging) return
    const view = viewport()
    bar.style.width = `${barBox.w}px`
    bar.style.height = `${barBox.h}px`
    barBox.x = state.h === 'left' ? MARGIN : view.w - barBox.w - MARGIN
    barBox.y = state.v === 'top' ? MARGIN : state.v === 'middle' ? (view.h - barBox.h) / 2 : view.h - barBox.h - MARGIN
    barBox.x = Math.max(4, Math.min(view.w - barBox.w - 4, barBox.x))
    place(bar, barBox.x, barBox.y)
    placePop()
  }

  // --- the popover's frame ---------------------------------------------------------
  let selectedBox: ViewBox | null = null
  let popHeight = 0
  let popShown: (ViewBox & { sheet: boolean }) | null = null
  const placePop = (): void => {
    const panel = store.panel.peek()
    const view = viewport()
    const doc = pop.contentDocument
    const anchoredToSelection = panel === 'inspector'
    if (panel === null || (anchoredToSelection && store.selection.peek() === null) || doc === null) {
      if (!pop.classList.contains('hidden')) pop.classList.add('hidden')
      popShown = null
      popHeight = 0
      return
    }
    const sheet = view.w < SHEET_BELOW
    const width = sheet ? view.w : Math.min(POP_WIDTH, view.w - 2 * 8)
    const barTop = barBox.y
    const barBottom = barBox.y + barBox.h
    const barAtBottom = barBox.y + barBox.h / 2 > view.h / 2
    const box = selectedBox ?? { x: view.w / 2, y: view.h / 3, width: 0, height: 0 }
    // Across: the inspector beside the selection (right, else left, else over its right edge); a panel at the toolbar's outer edge.
    let x: number
    if (sheet) x = 0
    else if (!anchoredToSelection) x = state.h === 'left' ? barBox.x : barBox.x + barBox.w - width
    else {
      const right = box.x + box.width + GAP
      const left = box.x - GAP - width
      x = right + width <= view.w - 8 ? right : left >= 8 ? left : Math.max(8, Math.min(view.w - width - 8, box.x + box.width - width))
    }
    x = Math.max(0, Math.min(view.w - width, x))
    // Down: the band the popover may use. Never over the toolbar.
    let top = 8
    let bottom = view.h - 8
    const overBar = x < barBox.x + barBox.w && x + width > barBox.x
    if (sheet || !anchoredToSelection || overBar) {
      if (barAtBottom) bottom = Math.min(bottom, barTop - (sheet ? 8 : GAP))
      else top = Math.max(top, barBottom + (sheet ? 8 : GAP))
    }
    if (sheet && !barAtBottom) bottom = view.h
    let maxHeight = bottom - top
    if (sheet) maxHeight = Math.round(maxHeight * 0.85)
    else if (anchoredToSelection) maxHeight = Math.min(720, maxHeight)
    maxHeight = Math.max(160, maxHeight)
    doc.documentElement.style.setProperty('--w', `${width}px`)
    doc.documentElement.style.setProperty('--max-h', `${maxHeight}px`)
    doc.documentElement.classList.toggle('sheet', sheet)
    // Read now, under the max-height just set (the observer reports it a frame later).
    const content = doc.getElementById('root')?.firstElementChild
    // Layout size, not the box on screen: the opening animation scales it for a moment.
    const measured = content !== null && content !== undefined && 'offsetHeight' in content ? (content as HTMLElement).offsetHeight : 0
    if (measured > 0) popHeight = measured
    const height = Math.min(popHeight || maxHeight, maxHeight)
    let y: number
    if (sheet) y = barAtBottom ? bottom - height : view.h - height
    else if (!anchoredToSelection) y = barAtBottom ? bottom - height : top
    else {
      const beside = x + width <= box.x || x >= box.x + box.width
      if (beside) y = box.y
      else {
        // No room at the sides: below the element, else above it, else at the bottom of the band.
        const below = box.y + box.height + GAP
        const above = box.y - GAP - height
        y = below + height <= bottom ? below : above >= top ? above : bottom - height
      }
      y = Math.max(top, Math.min(bottom - height, y))
    }
    x = Math.max(0, Math.min(view.w - width, x))
    pop.classList.toggle('sheet', sheet)
    pop.style.width = `${width}px`
    pop.style.height = `${height}px`
    place(pop, x, y)
    popShown = { x, y, width, height, sheet }
    // Shown once its content has been measured: no frame of the wrong size.
    pop.style.visibility = popHeight === 0 ? 'hidden' : ''
    if (pop.classList.contains('hidden')) pop.classList.remove('hidden')
  }

  // --- tooltips, toast, resize note -----------------------------------------------
  const frameOffset = (which: 'bar' | 'pop'): { x: number; y: number } => (which === 'bar' ? { x: barBox.x, y: barBox.y } : { x: popShown?.x ?? 0, y: popShown?.y ?? 0 })
  const showTip = (text: string | null, anchor?: { x: number; y: number; width: number; height: number }, keys?: string, sub?: string): void => {
    if (text === null || anchor === undefined) {
      tipNode.style.display = 'none'
      return
    }
    tipNode.textContent = text
    tipNode.classList.toggle('wrap', sub !== undefined)
    if (keys !== undefined) {
      const kbd = document.createElement('kbd')
      kbd.textContent = keys
      tipNode.append(kbd)
    }
    if (sub !== undefined) {
      const line = document.createElement('span')
      line.className = 'sub'
      line.textContent = sub
      tipNode.append(line)
    }
    tipNode.style.display = 'block'
    const view = viewport()
    const width = tipNode.offsetWidth
    const height = tipNode.offsetHeight
    let x = anchor.x + anchor.width / 2 - width / 2
    let y = anchor.y - height - 8
    if (y < 4) y = anchor.y + anchor.height + 8
    x = Math.max(4, Math.min(view.w - width - 4, x))
    place(tipNode, x, y)
  }

  let toastTimer: number | undefined
  effect(() => {
    const toast = store.toast.value
    if (toastTimer !== undefined) clearTimeout(toastTimer)
    if (toast === null) {
      toastNode.style.display = 'none'
      return
    }
    toastNode.textContent = toast.text
    toastNode.className = `toast${toast.tone === 'bad' ? ' bad' : ''}`
    toastNode.style.display = 'block'
    const view = viewport()
    const width = toastNode.offsetWidth
    const height = toastNode.offsetHeight
    const x = Math.max(4, Math.min(view.w - width - 4, barBox.x + barBox.w / 2 - width / 2))
    const y = barBox.y + barBox.h / 2 > view.h / 2 ? barBox.y - height - 10 : barBox.y + barBox.h + 10
    place(toastNode, x, y)
    toastTimer = window.setTimeout(() => (store.toast.value = null), TOAST_MS)
  })

  /** The resize refusal, next to the handles of the selection, after a resize was tried. */
  const placeNote = (): void => {
    const note = store.resizeNote.peek()
    if (note === null || selectedBox === null) {
      noteNode.style.display = 'none'
      return
    }
    if (noteNode.textContent !== note) noteNode.textContent = note
    noteNode.style.display = 'block'
    const view = viewport()
    const width = noteNode.offsetWidth
    const height = noteNode.offsetHeight
    let x = selectedBox.x + selectedBox.width - width
    let y = selectedBox.y + selectedBox.height + 10
    if (y + height > view.h - 4) y = selectedBox.y + selectedBox.height - height - 10
    x = Math.max(4, Math.min(view.w - width - 4, x))
    place(noteNode, x, Math.max(4, y))
  }
  let noteTimer: number | undefined
  effect(() => {
    const note = store.resizeNote.value
    if (noteTimer !== undefined) clearTimeout(noteTimer)
    placeNote()
    if (note !== null) noteTimer = window.setTimeout(() => (noteNode.style.display = 'none'), 6000)
  })

  // --- theme ----------------------------------------------------------------------------
  const applyTheme = (): void => {
    const value = theme.value
    for (const root of [host, bar.contentDocument?.documentElement, pop.contentDocument?.documentElement]) {
      if (root === undefined || root === null) continue
      if (value === 'auto') root.removeAttribute('data-theme')
      else root.setAttribute('data-theme', value)
    }
  }

  // --- the UI both frames render with ---------------------------------------------------
  const toggle = (panel: PanelName): void => {
    if (store.panel.peek() === panel) {
      store.panel.value = null
      return
    }
    if (store.panel.peek() === 'inspector') c.select(null)
    store.outlines.value = []
    store.panel.value = panel
  }

  const ui: DockUi = {
    tip(text, anchor, keys) {
      if (text === null || anchor === undefined) return showTip(null)
      const offset = frameOffset(anchor.frame)
      showTip(text, { x: offset.x + anchor.rect.left, y: offset.y + anchor.rect.top, width: anchor.rect.width, height: anchor.rect.height }, keys)
    },
    theme,
    setTheme(next) {
      theme.value = next
      store.theme.value = next
      state.theme = next
      save(state)
      applyTheme()
    },
    toggle,
    mod: /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl',
    nextPosition() {
      const index = PLACES.findIndex(([horizontal, vertical]) => horizontal === state.h && vertical === state.v)
      const next = PLACES[(index + 1) % PLACES.length] ?? PLACES[0]!
      state.h = next[0]
      state.v = next[1]
      save(state)
      placeBar()
    },
    startDrag(event) {
      if (event.button !== 0) return
      const handle = event.currentTarget as HTMLElement
      const startX = event.screenX
      const startY = event.screenY
      const fromX = barBox.x
      const fromY = barBox.y
      let moved = false
      const onMove = (move: PointerEvent): void => {
        const dx = move.screenX - startX
        const dy = move.screenY - startY
        if (!moved && Math.hypot(dx, dy) < 4) return
        if (!moved) {
          moved = true
          dragging = true
          showTip(null)
          bar.classList.remove('settled')
          handle.classList.add('dragging')
        }
        const view = viewport()
        barBox.x = Math.max(0, Math.min(view.w - barBox.w, fromX + dx))
        barBox.y = Math.max(0, Math.min(view.h - barBox.h, fromY + dy))
        place(bar, barBox.x, barBox.y)
        placePop()
      }
      const onUp = (): void => {
        handle.removeEventListener('pointermove', onMove)
        handle.removeEventListener('pointerup', onUp)
        handle.removeEventListener('pointercancel', onUp)
        handle.classList.remove('dragging')
        dragging = false
        if (!moved) return
        // Rest at the nearest corner (or the middle of a side).
        const view = viewport()
        state.h = barBox.x + barBox.w / 2 < view.w / 2 ? 'left' : 'right'
        const middle = barBox.y + barBox.h / 2
        state.v = middle < view.h / 3 ? 'top' : middle > (view.h * 2) / 3 ? 'bottom' : 'middle'
        save(state)
        bar.classList.add('settled')
        placeBar()
      }
      try {
        handle.setPointerCapture(event.pointerId)
      } catch {
        // Without capture the drag ends when the pointer leaves the grip.
      }
      handle.addEventListener('pointermove', onMove)
      handle.addEventListener('pointerup', onUp)
      handle.addEventListener('pointercancel', onUp)
    },
  }

  // --- keyboard -------------------------------------------------------------------------
  const shortcut = (event: KeyboardEvent, inFrame: boolean): void => {
    const mod = event.metaKey || event.ctrlKey
    const key = event.key.toLowerCase()
    if (mod && event.shiftKey && !event.altKey && (key === 'e' || event.code === 'KeyE')) {
      event.preventDefault()
      event.stopPropagation()
      c.setOpen(!store.open.peek())
      return
    }
    if (!store.open.peek() || event.defaultPrevented) return
    const typing = isTyping(event.target)
    if (inFrame && mod && !event.altKey && key === 'z') {
      // A field with text the user has not committed keeps the browser's own undo.
      if (typing && (event.target as HTMLElement).dataset.dirty === '1') return
      event.preventDefault()
      if (event.shiftKey) c.redo()
      else c.undo()
      return
    }
    if (mod || event.altKey) return
    if (inFrame && event.key === 'Escape') {
      event.preventDefault()
      c.escape()
      return
    }
    if (typing) return
    if (inFrame && event.key.startsWith('Arrow') && store.selection.peek() !== null) {
      event.preventDefault()
      c.navigate(event.key)
      return
    }
    if (event.shiftKey) return
    let handled = true
    if (key === 'c') void c.copyPrompt()
    else if (key === 's') {
      if (store.allDrafts.peek().length > 0) void c.send().catch(() => undefined)
    } else if (key === 'h') store.pinsHidden.value = !store.pinsHidden.peek()
    else if (key === 'p') c.setPaused(!store.paused.peek())
    else handled = false
    if (handled) {
      event.preventDefault()
      event.stopPropagation()
    }
  }
  // Before the selection's own key listener (which starts later, when the dock opens).
  addEventListener('keydown', (event) => shortcut(event, false), true)

  // --- the frames' documents --------------------------------------------------------------
  const mountedIn = new Map<HTMLIFrameElement, Document>()
  const sizeObservers = new Map<HTMLIFrameElement, ResizeObserver>()
  const mountInto = (frame: HTMLIFrameElement, app: ComponentChild, onSize: (width: number, height: number) => void): void => {
    const doc = frame.contentDocument
    const view = frame.contentWindow as (Window & typeof globalThis) | null
    if (doc === null || view === null || mountedIn.get(frame) === doc || doc.body === null) return
    mountedIn.set(frame, doc)
    doc.documentElement.lang = 'en'
    doc.title = frame.title
    const sheet = new view.CSSStyleSheet()
    sheet.replaceSync(FRAME_CSS)
    doc.adoptedStyleSheets = [sheet]
    doc.addEventListener('keydown', (event) => shortcut(event, true))
    render(app, doc.body)
    // The frame is as big as what it shows.
    sizeObservers.get(frame)?.disconnect()
    const observer = new view.ResizeObserver(() => {
      const root = doc.getElementById('root')
      const content = root?.firstElementChild as HTMLElement | null | undefined
      if (content === null || content === undefined) onSize(0, 0)
      // Layout size, not the box on screen: the opening animation scales it for a moment.
      else onSize(content.offsetWidth, content.offsetHeight)
    })
    const root = doc.getElementById('root')
    if (root !== null) observer.observe(root)
    // The root keeps its box when what is inside changes shape; watch the content too.
    const watch = new view.MutationObserver(() => {
      const content = doc.getElementById('root')?.firstElementChild
      if (content !== null && content !== undefined) observer.observe(content)
    })
    watch.observe(doc.body, { childList: true, subtree: false })
    if (root !== null) watch.observe(root, { childList: true })
    const content = root?.firstElementChild
    if (content !== null && content !== undefined) observer.observe(content)
    sizeObservers.set(frame, observer)
    applyTheme()
  }
  const mountBar = (): void =>
    mountInto(bar, h(Bar, { c, ui }), (width, height) => {
      if (width === 0 || height === 0) return
      if (width === barBox.w && height === barBox.h) return
      barBox.w = width
      barBox.h = height
      placeBar()
    })
  const mountPop = (): void =>
    mountInto(pop, h(Pop, { c, ui }), (_width, height) => {
      if (height === popHeight) return
      popHeight = height
      placePop()
    })
  // Chromium and Safari keep the frame's first about:blank document; Firefox may swap it for
  // a new one when the frame "loads". Render into whichever document is current.
  bar.addEventListener('load', mountBar)
  pop.addEventListener('load', mountPop)

  let popover = false
  try {
    host.setAttribute('popover', 'manual')
    popover = typeof host.showPopover === 'function'
    if (!popover) host.removeAttribute('popover')
  } catch {
    popover = false
  }
  // A child of <html>, after <body>: outside what frameworks render and what `body > *` rules match.
  document.documentElement.append(host)
  if (popover) {
    try {
      host.showPopover()
    } catch {
      host.removeAttribute('popover')
    }
  }
  mountBar()
  mountPop()
  placeBar()
  addEventListener('resize', placeBar, { passive: true })
  // Transitions only after the first placement.
  setTimeout(() => bar.classList.add('settled'), 0)

  // The popover follows the panel, the selection and its own size.
  effect(() => {
    void store.panel.value
    void store.selection.value
    void store.open.value
    showTip(null)
    placePop()
  })

  // --- pointer, for the label chip ----------------------------------------------------------
  let pointer: { x: number; y: number } | null = null
  let redraw = (): void => undefined
  addEventListener(
    'pointermove',
    (event) => {
      pointer = { x: event.clientX, y: event.clientY }
      if (store.open.peek() && store.hovered.peek() !== null) redraw()
    },
    { capture: true, passive: true },
  )

  // --- outlines, pins, handles ----------------------------------------------------------------
  const pinSpecs = (): PinSpec[] => {
    if (!store.open.peek() || store.pinsHidden.peek()) return []
    const selected = store.selection.peek()?.ref.uid
    return pinGroups(store.items.peek(), page).map((group) => {
      const first = group.items[0]!
      const lines = group.items.map((item) => (item.kind === 'style' ? `${item.property}${item.condition.state === undefined ? '' : ` :${item.condition.state}`} → ${item.after.authored}` : item.kind === 'note' ? `note: ${item.text}` : item.op))
      return {
        uid: group.uid,
        number: group.number,
        status: group.status,
        element: c.elementOf(first),
        summary: `${group.target.label.split(' "')[0]}: ${lines.join(', ')}`,
        current: group.uid === selected,
      }
    })
  }
  const STATUS_WORD = { draft: 'not sent yet', pending: 'sent, not verified yet', pass: 'verified', drift: 'landed with a nearby value', fail: 'verification failed' } as const

  const handles = createHandles(layer, c, { redraw: () => redraw(), keyTargets: () => [bar.contentWindow, pop.contentWindow] })
  const highlighter = createHighlighter(layer, store, window, {
    onSelection(box) {
      handles.place(box)
      selectedBox = box
      placePop()
      placeNote()
    },
    label(element) {
      const name = labelOf(element).split(' "')[0] ?? element.localName
      const source = c.knownSource(element)
      return source?.file === undefined ? { name } : { name, source: `${basename(source.file)}${source.line === undefined ? '' : `:${source.line}`}` }
    },
    pointer: () => pointer,
    pins: pinSpecs,
    onPinHover(pin, rect) {
      if (pin === null || rect === null) return showTip(null)
      const lines = pin.summary
      showTip(`${pin.number} · ${STATUS_WORD[pin.status]}`, rect, undefined, lines)
    },
    onPinClick(pin) {
      showTip(null)
      if (pin.element === null) return
      c.select(pin.element)
      store.panel.value = 'inspector'
    },
  })
  redraw = highlighter.update

  const copy = async (text: string): Promise<boolean> => {
    // The click that asked for the copy happened in one of the frames; try them first.
    for (const view of [bar.contentWindow, pop.contentWindow, window]) {
      try {
        if (view === null) continue
        await view.navigator.clipboard.writeText(text)
        return true
      } catch {
        // Not focused, not permitted, or not a secure context: try the next one.
      }
    }
    return false
  }

  return {
    host,
    frame: pop,
    bar,
    highlighter,
    handles,
    mounted: () => mountedIn.get(bar) !== undefined && mountedIn.get(pop) !== undefined,
    copy,
    setOpen: (open) => c.setOpen(open),
    geometry: () => ({ bar: { x: barBox.x, y: barBox.y, width: barBox.w, height: barBox.h }, pop: popShown }),
  }
}
