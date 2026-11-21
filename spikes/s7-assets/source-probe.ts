/**
 * Browser entry for spike S7, section E: exposes packages/source's element
 * context collector, so that a culprit the attributor named can be handed to
 * the static-HTML resolver.
 */

import { collectContext } from '../../packages/source/src/browser/context.ts'
import type { ElementContext } from '../../packages/source/src/types.ts'

declare global {
  interface Window {
    __s7Context?: (selector: string) => ElementContext | null
  }
}

window.__s7Context = (selector) => {
  const element = document.querySelector(selector)
  return element === null ? null : collectContext(element)
}
