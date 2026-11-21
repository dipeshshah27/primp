import { forceState, type Forced, type ForcedState } from '../../packages/overlay/src/probe/states.ts'

/** Test entry: the state-forcing module on `window`, for spikes/m5-risks.ts. */
declare global {
  interface Window {
    __force?: (element: Element, state: ForcedState) => Forced
  }
}
window.__force = forceState
