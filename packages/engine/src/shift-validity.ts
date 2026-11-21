/**
 * Whether a recording can say anything about layout shifts at all.
 *
 * A tab that is not visible produces no frames and therefore no layout-shift
 * entries, however the page behaves. So a recording only counts as a
 * measurement when the tab was visible from navigation start until the
 * recording was read. Anything else is `tab_hidden`, never "no shifts".
 *
 * Pure.
 */

import type { ShiftRecording, ShiftStatus } from '../../protocol/src/shift.ts'

export interface Validity {
  status: ShiftStatus
  reason?: string
}

export function shiftValidity(recording: ShiftRecording): Validity {
  if (!recording.supported) {
    return { status: 'not_measurable', reason: 'this browser has no layout-shift performance entries (Chromium only)' }
  }
  const visibility = recording.visibility
  if (visibility.prerendered) {
    return { status: 'tab_hidden', reason: 'the page was prerendered before it was shown' }
  }
  if (visibility.atNavigationStart !== undefined && visibility.atNavigationStart !== 'visible') {
    return { status: 'tab_hidden', reason: `the tab was ${visibility.atNavigationStart} at navigation start` }
  }
  if (visibility.initial !== 'visible') {
    return { status: 'tab_hidden', reason: `the tab was ${visibility.initial} when the page started loading` }
  }
  const change = visibility.changes.find((entry) => entry.state !== 'visible')
  if (change !== undefined) {
    return { status: 'tab_hidden', reason: `the tab became ${change.state} at ${Math.round(change.t)} ms, before the measurement ended` }
  }
  if (visibility.restored) {
    return { status: 'tab_hidden', reason: 'the page was restored from the back/forward cache, so it was hidden in between' }
  }
  const hiddenEntry = recording.shifts.find((entry) => entry.visibility !== 'visible')
  if (hiddenEntry !== undefined) {
    return { status: 'tab_hidden', reason: `a layout-shift entry was delivered while the tab was ${hiddenEntry.visibility}` }
  }
  // The hook's own verdict covers the state at the moment the recording was read.
  if (!visibility.visibleThroughout) {
    return { status: 'tab_hidden', reason: 'the tab was not visible when the measurement ended' }
  }
  return { status: 'ok' }
}
