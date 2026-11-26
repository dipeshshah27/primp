/**
 * Page-level state a shift measurement depends on: tab visibility, viewport
 * size and scroll position.
 *
 * Visibility decides whether a measurement means anything. A hidden tab
 * produces no frames, so it reports no layout shifts however badly the page
 * behaves; "no entries" from such a load must never be read as "no shifts".
 */

import type { ShiftRecording, VisibilityRecord } from '../../../protocol/src/shift.ts'
import { now, round, timed } from './state.ts'

type Changes<K extends 'viewportChanges' | 'scrolls'> = ShiftRecording[K]

export const visibility: Omit<VisibilityRecord, 'visibleThroughout'> = {
  initial: document.visibilityState,
  changes: [],
  prerendered: (document as Document & { prerendering?: boolean }).prerendering === true,
  restored: false,
}

/**
 * The validity flag of a shift measurement: visible at navigation start, when the hook ran, at
 * every change since and right now. Anything else and "no entries" does not mean "no shifts".
 */
export function visibleThroughout(): boolean {
  const visible = (state: string | undefined): boolean => state === undefined || state === 'visible'
  return (
    !visibility.prerendered &&
    !visibility.restored &&
    visible(visibility.atNavigationStart) &&
    visible(visibility.initial) &&
    visible(document.visibilityState) &&
    visibility.changes.every((change) => visible(change.state))
  )
}
export const viewportChanges: Changes<'viewportChanges'> = []
export const scrolls: Changes<'scrolls'> = []

const MAX_CHANGES = 60
let lastScrollAt = -Infinity

export function installPage(): void {
  document.addEventListener(
    'visibilitychange',
    timed(() => {
      if (visibility.changes.length < MAX_CHANGES) visibility.changes.push({ t: round(now()), state: document.visibilityState })
    }),
    true,
  )
  addEventListener('pageshow', (event) => {
    if (event.persisted) visibility.restored = true
  })
  addEventListener(
    'resize',
    timed(() => {
      if (viewportChanges.length < MAX_CHANGES) viewportChanges.push({ t: round(now()), width: innerWidth, height: innerHeight })
    }),
  )
  addEventListener(
    'scroll',
    timed(() => {
      const t = now()
      if (t - lastScrollAt < 100 || scrolls.length >= MAX_CHANGES) return
      lastScrollAt = t
      scrolls.push({ t: round(t), x: scrollX, y: scrollY })
    }),
    { passive: true },
  )
  // The browser's own record reaches back to navigation start, before this script existed.
  if (PerformanceObserver.supportedEntryTypes.includes('visibility-state')) {
    const started = now()
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.startTime === 0) visibility.atNavigationStart = entry.name
        // A change between navigation start and this script: no event listener existed yet.
        else if (entry.startTime < started && visibility.changes.length < MAX_CHANGES) {
          visibility.changes.push({ t: round(entry.startTime), state: entry.name })
        }
      }
    }).observe({ type: 'visibility-state', buffered: true })
  }
}
