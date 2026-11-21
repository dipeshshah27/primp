import type { Evidence } from '../types.ts'
import { collectContext } from './context.ts'
import { collectHints } from './hints.ts'
import { collectReact } from './react.ts'
import { collectSvelte } from './svelte.ts'

/**
 * Everything the node resolver needs to know about one element, as plain JSON.
 * Reads the DOM and framework debug fields; never writes to either.
 */
export function collectEvidence(element: Element): Evidence {
  const started = performance.now()
  const evidence: Evidence = { context: collectContext(element), hints: collectHints(element), collectMs: 0 }
  try {
    const react = collectReact(element)
    if (react) evidence.react = react
  } catch {
    // Debug fields are private API; a shape we do not know must degrade to "no React evidence".
  }
  try {
    const svelte = collectSvelte(element)
    if (svelte) evidence.svelte = svelte
  } catch {
    // Same for Svelte.
  }
  evidence.collectMs = performance.now() - started
  return evidence
}
