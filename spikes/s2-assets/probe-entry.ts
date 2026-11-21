/**
 * In-page half of spike S2. Bundled with esbuild and injected by the proxy after the hook.
 *
 * `data-label` is used HERE, by the spike, to pick which element to ask about. The collector
 * (`collectEvidence`) is handed the element and nothing else; it never reads that attribute.
 */
import { collectEvidence } from '../../packages/source/src/browser/index.ts'
import type { Evidence } from '../../packages/source/src/types.ts'

export interface HookInfo {
  present: boolean
  /** `_instrumentationSource` when bippy's hook is the one installed. */
  source?: string
  renderers: { version?: string; bundleType?: number; packageName?: string }[]
}

export interface PageFacts {
  elements: number
  withFiber: number
  withSvelteMeta: number
}

export interface S2Probe {
  count(label: string): number
  collect(label: string, index: number): Evidence | null
  /** For an element that is only in the DOM for a moment: polls, collects on every sighting, resolves with the richest evidence seen. */
  collectTransient(label: string, timeoutMs: number): Promise<{ evidence: Evidence | null; sightings: number; hadFramework: boolean }>
  /** Evidence for `count` elements spread evenly over everything `selector` matches. */
  sample(selector: string, count: number): { total: number; evidence: Evidence[]; ms: number }
  /** Collects every element `selector` matches and returns timings only. */
  timeAll(selector: string): { total: number; ms: number; maxMs: number; withStack: number; placeholder: number; missing: number }
  hook(): HookInfo
  facts(): PageFacts
}

const byLabel = (label: string): Element[] => [...document.querySelectorAll(`[data-label="${CSS.escape(label)}"]`)]

const hasFiber = (element: Element): boolean => Object.keys(element).some((key) => key.startsWith('__reactFiber$'))
const hasMeta = (element: Element): boolean => (element as Element & { __svelte_meta?: unknown }).__svelte_meta !== undefined

const probe: S2Probe = {
  count: (label) => byLabel(label).length,

  collect(label, index) {
    const element = byLabel(label)[index]
    return element ? collectEvidence(element) : null
  },

  collectTransient(label, timeoutMs) {
    return new Promise((resolve) => {
      const started = performance.now()
      let best: Evidence | null = null
      let sightings = 0
      const tick = (): void => {
        const element = byLabel(label)[0]
        if (element) {
          sightings += 1
          const evidence = collectEvidence(element)
          if (!best || (evidence.react && !best.react) || (evidence.svelte && !best.svelte)) best = evidence
        }
        const hadFramework = best !== null && (best.react !== undefined || best.svelte !== undefined)
        const gone = !element && sightings > 0
        if (hadFramework || gone || performance.now() - started > timeoutMs) resolve({ evidence: best, sightings, hadFramework })
        else setTimeout(tick, 15)
      }
      tick()
    })
  },

  sample(selector, count) {
    const all = [...document.querySelectorAll(selector)]
    const step = Math.max(1, Math.floor(all.length / count))
    const started = performance.now()
    const evidence: Evidence[] = []
    for (let index = 0; index < all.length && evidence.length < count; index += step) {
      const element = all[index]
      if (element) evidence.push(collectEvidence(element))
    }
    return { total: all.length, evidence, ms: performance.now() - started }
  },

  timeAll(selector) {
    const all = document.querySelectorAll(selector)
    let maxMs = 0
    let withStack = 0
    let placeholder = 0
    let missing = 0
    const started = performance.now()
    for (const element of all) {
      const evidence = collectEvidence(element)
      if (evidence.collectMs > maxMs) maxMs = evidence.collectMs
      const state = evidence.react?.stackState
      if (state === 'captured') withStack += 1
      else if (state === 'placeholder') placeholder += 1
      else missing += 1
    }
    return { total: all.length, ms: performance.now() - started, maxMs, withStack, placeholder, missing }
  },

  hook() {
    const hook = (window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: { renderers?: unknown; _instrumentationSource?: unknown } })
      .__REACT_DEVTOOLS_GLOBAL_HOOK__
    const info: HookInfo = { present: hook !== undefined, renderers: [] }
    if (typeof hook?._instrumentationSource === 'string') info.source = hook._instrumentationSource
    if (hook?.renderers instanceof Map) {
      for (const renderer of hook.renderers.values() as Iterable<{ version?: string; bundleType?: number; rendererPackageName?: string }>) {
        info.renderers.push({ version: renderer.version, bundleType: renderer.bundleType, packageName: renderer.rendererPackageName })
      }
    }
    return info
  },

  facts() {
    const all = document.querySelectorAll('body *')
    let withFiber = 0
    let withSvelteMeta = 0
    for (const element of all) {
      if (hasFiber(element)) withFiber += 1
      if (hasMeta(element)) withSvelteMeta += 1
    }
    return { elements: all.length, withFiber, withSvelteMeta }
  },
}

;(window as unknown as { __primpS2: S2Probe }).__primpS2 = probe
