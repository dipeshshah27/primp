/**
 * Starts the dock: controller, UI and test handle, on top of the bus the head script published.
 * Called once by `entry/overlay.ts`.
 */

import { createController, type Controller } from './state/controller.ts'
import { installTestHandle } from './test-handle.ts'
import { mountDock, type DockHandle } from './ui/mount.ts'

export interface PrimpOverlay {
  controller: Controller
  dock: DockHandle
}

declare global {
  interface Window {
    __primp_overlay?: PrimpOverlay
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
  const overlay: PrimpOverlay = { controller, dock }
  window.__primp_overlay = overlay
  return overlay
}
