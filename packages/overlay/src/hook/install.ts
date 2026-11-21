/**
 * The primp hook: the first script in `<head>`, synchronous, and small.
 *
 * It starts observing before the page has built anything, so that when a
 * layout shift happens the evidence about its cause is already on record:
 * which element changed size and by how much, what was inserted, which image
 * or font had just arrived, and whether the tab was visible at all.
 *
 * It reads and records. It never writes to the DOM, and no callback of it can
 * throw into the page. Later-loaded primp code talks to it through
 * `window.__primp`.
 *
 * This module only defines the recorder; `installHook()` starts it. `hook/index.ts` starts it on
 * import (the bare hook, as spikes S3 and S7 inject it); `entry/hook.ts` starts it together with
 * the overlay socket, and only in the top window.
 */

import type { HookCost, SHIFT_RECORDING_VERSION, ShiftEntry, ShiftRecording } from '../../../protocol/src/shift.ts'
import { fonts, installFonts, snapshotFonts } from './fonts.ts'
import { installLedger, mutations, resizes } from './ledger.ts'
import { installMedia, media, resources } from './media.ts'
import { installPage, scrolls, viewportChanges, visibility, visibleThroughout } from './page.ts'
import { installShifts, markSelf, onShift, selfMarks, shifts, supported } from './shifts.ts'
import { installStacks } from './stacks.ts'
import { cost, frame, now, round } from './state.ts'

/**
 * Must equal `SHIFT_RECORDING_VERSION`. The protocol module is imported for its types only:
 * importing the value would pull the schema library into this script.
 */
const VERSION: typeof SHIFT_RECORDING_VERSION = 1

/** Replaced at build time; `true` compiles in the DOM-call stack capture (see stacks.ts). */
declare const __PRIMP_HOOK_STACKS__: boolean | undefined

export interface PrimpHook {
  version: typeof SHIFT_RECORDING_VERSION
  /**
   * The overlay calls this right before it changes the page (a style preview,
   * hiding an element). Layout shifts that start within 500 ms after the call
   * are tagged `selfInduced` with `reason`.
   */
  markSelf(reason: string): void
  /** A JSON-safe copy of everything recorded so far. */
  recording(): ShiftRecording
  /** Calls `listener` for each new layout-shift entry; returns the function that stops it. */
  onShift(listener: (entry: ShiftEntry) => void): () => void
  /** Time the hook has spent on the main thread so far. */
  cost(): HookCost
}

declare global {
  interface Window {
    __primp?: PrimpHook
  }
}

const hookCost = (): HookCost => ({ ...cost })

function recording(): ShiftRecording {
  snapshotFonts()
  const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
  const paint = (name: string): number | undefined => {
    const entry = performance.getEntriesByName(name)[0]
    return entry === undefined ? undefined : round(entry.startTime)
  }
  return {
    version: VERSION,
    url: location.href,
    capturedAt: round(now()),
    hookStartedAt: round(startedAt),
    supported,
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    viewportChanges: [...viewportChanges],
    scroll: { x: scrollX, y: scrollY },
    scrolls: [...scrolls],
    navigation: {
      type: navigation?.type ?? 'unknown',
      domInteractive: round(navigation?.domInteractive ?? 0),
      domContentLoaded: round(navigation?.domContentLoadedEventEnd ?? 0),
      load: round(navigation?.loadEventEnd ?? 0),
      firstPaint: paint('first-paint'),
      firstContentfulPaint: paint('first-contentful-paint'),
      firstFrame: frame.at,
    },
    visibility: { ...visibility, changes: [...visibility.changes].sort((a, b) => a.t - b.t), visibleThroughout: visibleThroughout() },
    shifts: [...shifts.items],
    resizes: [...resizes.items],
    mutations: [...mutations.items],
    media: [...media.items],
    resources: [...resources.items],
    fonts: [...fonts.items],
    selfMarks: [...selfMarks],
    dropped: {
      shifts: shifts.dropped,
      resizes: resizes.dropped,
      mutations: mutations.dropped,
      media: media.dropped,
      resources: resources.dropped,
    },
    cost: hookCost(),
  }
}

const startedAt = now()

/**
 * Starts the recorder and publishes `window.__primp`. Idempotent: a second copy of the script
 * (a proxy in front of a proxy) must not observe twice.
 */
export function installHook(): void {
  if (window.__primp !== undefined) return
  window.__primp = { version: VERSION, markSelf, recording, onShift, cost: hookCost }
  try {
    installShifts()
    installPage()
    installLedger()
    installMedia()
    installFonts()
    if (typeof __PRIMP_HOOK_STACKS__ !== 'undefined' && __PRIMP_HOOK_STACKS__) installStacks()
    requestAnimationFrame(() => {
      frame.seen = true
      frame.at = round(now())
      snapshotFonts()
    })
  } catch {
    // An unsupported browser gets a hook that records nothing; `recording().supported` says so.
  }
  cost.topLevelMs = now() - startedAt
}
