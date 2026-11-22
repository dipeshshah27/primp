/**
 * Starts the dock: controller, UI and test handle, on top of the bus the head script published.
 * Called once by `entry/overlay.ts`.
 */

import { createController, type Controller } from './state/controller.ts'
import { installTestHandle } from './test-handle.ts'
import { mountDock, type DockHandle } from './ui/mount.ts'

/**
 * `window.__primp_dock`: the dock's small public API, for a page that wants a button of its own
 * ("Try it on this page"). It does what the launcher, the toolbar and Escape do; for tests there
 * is `window.__primp_test`.
 */
export interface PrimpDockApi {
  /** Opens the dock: the toolbar is shown and clicks on the page select. */
  open(): void
  /** Closes the dock (and its popover); the page gets its clicks again. */
  close(): void
  /** Opens a closed dock, closes an open one. Returns whether it is open now. */
  toggle(): boolean
  /** Opens the dock with a panel of the toolbar shown (`changes`, `shifts`, `verify`, `settings`); null closes the popover. */
  panel(name: 'changes' | 'shifts' | 'verify' | 'settings' | null): void
  isOpen(): boolean
}

export interface PrimpOverlay {
  controller: Controller
  dock: DockHandle
}

declare global {
  interface Window {
    __primp_overlay?: PrimpOverlay
    __primp_dock?: PrimpDockApi
  }
}

export function boot(): PrimpOverlay | undefined {
  const bus = window.__primp_bus
  // Without the head script there is no socket, and a second copy of this bundle must not mount a second dock.
  if (bus === undefined || window.__primp_overlay !== undefined) return window.__primp_overlay
  const controller = createController({ bus })
  const dock = mountDock(controller)
  controller.setCopy(dock.copy)
  installTestHandle(controller, dock)
  const { store } = controller
  window.__primp_dock = {
    open: () => controller.setOpen(true),
    close: () => controller.setOpen(false),
    toggle() {
      controller.setOpen(!store.open.peek())
      return store.open.peek()
    },
    panel(name) {
      if (name === null) {
        if (store.panel.peek() !== null) controller.escape()
        return
      }
      if (!store.open.peek()) controller.setOpen(true)
      if (store.panel.peek() === 'inspector') controller.select(null)
      store.outlines.value = []
      store.panel.value = name
    },
    isOpen: () => store.open.peek(),
  }
  const overlay: PrimpOverlay = { controller, dock }
  window.__primp_overlay = overlay
  return overlay
}
