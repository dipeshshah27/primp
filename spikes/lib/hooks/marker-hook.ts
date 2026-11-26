/**
 * The smallest possible head script: it records that it ran and what the
 * document looked like at that moment. Spikes inject it through the proxy to
 * prove injection order without the real hook.
 *
 * Bundle it with `bundleBrowser(MARKER_HOOK_ENTRY)` or pass
 * `{ name: 'hook.js', entry: MARKER_HOOK_ENTRY }` to `startProxy`.
 */

export interface PrimpHookMarker {
  /** `performance.now()` when the script ran. */
  t: number
  /** `document.scripts.length` when it ran; 1 means no other script element had been parsed yet. */
  scriptsAtRun: number
  /** Whether the running script was the first element child of `<head>`. */
  firstInHead: boolean
  /** `src` attribute of the running script. */
  src: string | null
  /** Whether the running script carried a CSP nonce. */
  hasNonce: boolean
  /** `document.readyState` when it ran. */
  readyState: string
  /** Whether `<body>` existed yet. */
  bodyAtRun: boolean
  /** How many times the script ran in this document; anything but 1 is a bug. */
  runs: number
}

declare global {
  interface Window {
    __primp_hook?: PrimpHookMarker
  }
}

const current = document.currentScript as HTMLScriptElement | null

window.__primp_hook = {
  t: performance.now(),
  scriptsAtRun: document.scripts.length,
  firstInHead: current !== null && document.head?.firstElementChild === current,
  src: current?.getAttribute('src') ?? null,
  hasNonce: (current?.nonce ?? '') !== '',
  readyState: document.readyState,
  bodyAtRun: document.body !== null,
  runs: (window.__primp_hook?.runs ?? 0) + 1,
}
