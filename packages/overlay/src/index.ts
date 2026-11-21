/**
 * @primp/overlay: what primp injects into the page.
 *
 * The two bundles are built from `src/entry/hook.ts` (head script) and `src/entry/overlay.ts`
 * (the dock). Everything else is imported by those two; the types below are for tests and for
 * the server's end of the socket.
 */

export type { BusEvent, BusSignal, PrimpBus } from './bus.ts'
export { OVERLAY_PATH, SOCKET_PATH } from './bus.ts'
export type { PrimpHook } from './hook/install.ts'
export type { PrimpTestHandle, TestEditResult, TestState } from './test-handle.ts'
export type { MeasureRequest, Measurement } from './probe/measure.ts'
export type { ShiftState, TabName } from './state/store.ts'
