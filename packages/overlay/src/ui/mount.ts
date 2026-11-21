/**
 * Puts the dock on the page.
 *
 *   <reglet-root data-reglet-root popover="manual">      one custom element, appended to <html>
 *     #shadow-root
 *       <div class="layer">     highlight boxes (see highlight.ts)
 *       <iframe>                the dock itself: its own document, rendered by Preact
 *
 * Why the dock has a document of its own: an element that moves inside a shadow tree is a layout
 * shift of the page as far as the Layout Instability API is concerned (measured: a row inserted
 * above another inside a top-layer shadow tree produced an entry with a null source node). A tool
 * that measures the page's layout shifts must not add to them every time its own list grows.
 * Shifts inside a frame are reported to the frame, not to the page. The frame has no `src`
 * (`about:blank`), so no request is made and no Content-Security-Policy applies to loading it;
 * its styles are a constructable stylesheet. As a side benefit, page styles and dock styles
 * cannot reach each other at all.
 *
 * The host is a 0 x 0 fixed box in the top layer (popover API, manual mode; a very high z-index
 * where that is missing). The frame and the boxes are placed with `transform` and sized with
 * width/height, neither of which is a layout shift, so opening, collapsing and dragging the dock
 * leave the page's measurements alone. Nothing here takes focus.
 */

import { signal } from '@preact/signals'
import { h, render } from 'preact'
import { OVERLAY_ROOT_ATTR } from '../probe/snapshot.ts'
import type { Controller } from '../state/controller.ts'
import type { TabName } from '../state/store.ts'
import { DOCK_CSS, HOST_CSS } from './css.ts'
import { Dock, type DockUi } from './dock.tsx'
import { createHighlighter, type Highlighter } from './highlight.ts'

export const HOST_TAG = 'reglet-root'

const WIDTH = 376
const HEIGHT = 700
const COLLAPSED = 44
const MARGIN = 12
const STORAGE_KEY = 'reglet:dock'

type Horizontal = 'left' | 'right'
type Vertical = 'top' | 'middle' | 'bottom'
interface Saved {
  h: Horizontal
  v: Vertical
  collapsed: boolean
  tab: TabName
}

/** The dock's resting places, in the order the move button walks them. */
const PLACES: [Horizontal, Vertical][] = [
  ['right', 'bottom'],
  ['left', 'bottom'],
  ['left', 'middle'],
  ['left', 'top'],
  ['right', 'top'],
  ['right', 'middle'],
]

export interface DockHandle {
  host: HTMLElement
  frame: HTMLIFrameElement
  highlighter: Highlighter
  /** True once the dock has rendered into its document. */
  mounted(): boolean
  /** Writes to the clipboard from whichever document is allowed to. */
  copy(text: string): Promise<boolean>
  setCollapsed(collapsed: boolean): void
}

function load(): Saved {
  const fallback: Saved = { h: 'right', v: 'bottom', collapsed: false, tab: 'edits' }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return fallback
    const saved = JSON.parse(raw) as Partial<Saved>
    return {
      h: saved.h === 'left' ? 'left' : 'right',
      v: saved.v === 'top' || saved.v === 'middle' ? saved.v : 'bottom',
      collapsed: saved.collapsed === true,
      tab: saved.tab === 'shifts' || saved.tab === 'verify' ? saved.tab : 'edits',
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

export function mountDock(c: Controller): DockHandle {
  const state = load()
  const collapsed = signal(state.collapsed)
  c.store.tab.value = state.tab

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
  const frame = document.createElement('iframe')
  frame.title = 'reglet'
  frame.setAttribute('data-reglet-dock', '')
  shadow.append(layer, frame)

  // --- geometry: transform and size only ------------------------------------
  let x = 0
  let y = 0
  let width = 0
  let height = 0
  const viewport = (): { w: number; h: number } => ({
    w: document.documentElement.clientWidth || innerWidth,
    h: Math.min(innerHeight, document.documentElement.clientHeight || innerHeight),
  })
  const moveTo = (nx: number, ny: number): void => {
    x = nx
    y = ny
    frame.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
  }
  const place = (): void => {
    const view = viewport()
    width = collapsed.value ? COLLAPSED : Math.max(240, Math.min(WIDTH, view.w - 2 * MARGIN))
    height = collapsed.value ? COLLAPSED : Math.max(200, Math.min(HEIGHT, view.h - 2 * MARGIN))
    frame.style.width = `${width}px`
    frame.style.height = `${height}px`
    frame.classList.toggle('collapsed', collapsed.value)
    moveTo(state.h === 'left' ? MARGIN : view.w - width - MARGIN, state.v === 'top' ? MARGIN : state.v === 'middle' ? (view.h - height) / 2 : view.h - height - MARGIN)
  }
  place()
  addEventListener('resize', place, { passive: true })

  const ui: DockUi = {
    collapsed,
    setCollapsed(next) {
      collapsed.value = next
      state.collapsed = next
      save(state)
      place()
    },
    nextPosition() {
      const index = PLACES.findIndex(([horizontal, vertical]) => horizontal === state.h && vertical === state.v)
      const next = PLACES[(index + 1) % PLACES.length] ?? PLACES[0]!
      state.h = next[0]
      state.v = next[1]
      save(state)
      place()
    },
    startDrag(event) {
      if (event.button !== 0) return
      const handle = event.currentTarget as HTMLElement
      const startX = event.screenX
      const startY = event.screenY
      const fromX = x
      const fromY = y
      let dragging = false
      const onMove = (move: PointerEvent): void => {
        const dx = move.screenX - startX
        const dy = move.screenY - startY
        if (!dragging && Math.hypot(dx, dy) < 4) return
        if (!dragging) {
          dragging = true
          frame.classList.remove('settled')
          handle.classList.add('dragging')
        }
        const view = viewport()
        moveTo(Math.max(0, Math.min(view.w - width, fromX + dx)), Math.max(0, Math.min(view.h - height, fromY + dy)))
      }
      const onUp = (): void => {
        handle.removeEventListener('pointermove', onMove)
        handle.removeEventListener('pointerup', onUp)
        handle.removeEventListener('pointercancel', onUp)
        handle.classList.remove('dragging')
        if (!dragging) return
        // Rest at the nearest side or corner.
        const view = viewport()
        state.h = x + width / 2 < view.w / 2 ? 'left' : 'right'
        const middle = y + height / 2
        state.v = middle < view.h / 3 ? 'top' : middle > (view.h * 2) / 3 ? 'bottom' : 'middle'
        save(state)
        frame.classList.add('settled')
        place()
      }
      try {
        handle.setPointerCapture(event.pointerId)
      } catch {
        // Without capture the drag ends when the pointer leaves the header.
      }
      handle.addEventListener('pointermove', onMove)
      handle.addEventListener('pointerup', onUp)
      handle.addEventListener('pointercancel', onUp)
    },
  }

  // --- the dock's document ---------------------------------------------------
  let mountedIn: Document | null = null
  const mountInto = (): void => {
    const doc = frame.contentDocument
    const view = frame.contentWindow
    if (doc === null || view === null || doc === mountedIn || doc.body === null) return
    mountedIn = doc
    doc.documentElement.lang = 'en'
    doc.title = 'reglet'
    const sheet = new (view as Window & typeof globalThis).CSSStyleSheet()
    sheet.replaceSync(DOCK_CSS)
    doc.adoptedStyleSheets = [sheet]

    doc.addEventListener('keydown', (event) => {
      const target = event.target as HTMLElement | null
      const typing = target !== null && (target.localName === 'input' || target.localName === 'textarea' || target.localName === 'select')
      const mod = event.metaKey || event.ctrlKey
      if (mod && !event.altKey && event.key.toLowerCase() === 'z') {
        // A field with text the user has not committed keeps the browser's own undo.
        if (typing && target.dataset.dirty === '1') return
        event.preventDefault()
        if (event.shiftKey) c.redo()
        else c.undo()
        return
      }
      if (mod || event.altKey || event.defaultPrevented || !c.store.pickMode.value) return
      if (event.key === 'Escape') {
        event.preventDefault()
        c.setPickMode(false)
      } else if (event.key.startsWith('Arrow') && !typing) {
        event.preventDefault()
        c.navigate(event.key)
      }
    })
    render(h(Dock, { c, ui }), doc.body)
  }
  // Chromium and Safari keep the frame's first about:blank document; Firefox may swap it for
  // a new one when the frame "loads". Render into whichever document is current.
  frame.addEventListener('load', mountInto)

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
  mountInto()
  // Transitions only after the first placement.
  setTimeout(() => frame.classList.add('settled'), 0)

  c.store.tab.subscribe((tab) => {
    if (state.tab === tab) return
    state.tab = tab
    save(state)
  })

  const highlighter = createHighlighter(layer, c.store)

  const copy = async (text: string): Promise<boolean> => {
    // The click that asked for the copy happened in the dock's document; try it first.
    for (const view of [frame.contentWindow, window]) {
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
    frame,
    highlighter,
    mounted: () => mountedIn !== null,
    copy,
    setCollapsed: ui.setCollapsed,
  }
}
