/**
 * Starts the dock: controller, UI and test handle, on top of the bus the head script published.
 * Called once by `entry/overlay.ts`.
 */

import { createController, type Controller } from './state/controller.ts'
import { installTestHandle } from './test-handle.ts'
import { mountDock, type DockHandle } from './ui/mount.ts'

export interface RegletOverlay {
  controller: Controller
  dock: DockHandle
}

declare global {
  interface Window {
    __reglet_overlay?: RegletOverlay
  }
}

export function boot(): RegletOverlay | undefined {
  const bus = window.__reglet_bus
  // Without the head script there is no socket, and a second copy of this bundle must not mount a second dock.
  if (bus === undefined || window.__reglet_overlay !== undefined) return window.__reglet_overlay
  const controller = createController({ bus })
  const dock = mountDock(controller)
  controller.setCopy(dock.copy)
  installTestHandle(controller, dock)
  const overlay: RegletOverlay = { controller, dock }
  window.__reglet_overlay = overlay
  return overlay
}
