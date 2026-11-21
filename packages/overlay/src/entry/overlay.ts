/**
 * The dock bundle: probe, state and UI. Loaded by the head script (`entry/hook.ts`) after
 * DOMContentLoaded, with the head script's nonce.
 *
 * It mounts one `<reglet-root data-reglet-root>` element as the last child of `<html>` and
 * publishes `window.__reglet_test` for end-to-end tests. It runs only in the top window and
 * only once per document.
 *
 * Build: esbuild, IIFE, with JSX set to `automatic` and `jsxImportSource: 'preact'` (esbuild
 * reads both from this package's tsconfig.json).
 */

import { boot } from '../boot.ts'

try {
  if (window.top === window) {
    if (document.body !== null) boot()
    else document.addEventListener('DOMContentLoaded', () => boot(), { once: true })
  }
} catch (error) {
  // The dock failing must not take the page down with it; a developer still wants to know.
  console.warn('[reglet] the dock could not start:', error)
}
