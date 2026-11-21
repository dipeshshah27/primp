/**
 * The layout-shift observer and the self-induced marks.
 *
 * Everything about an entry is copied in the observer callback: the browser
 * hands out live `source.node` references that turn null when the node leaves
 * the document, so a descriptor taken later would be too late.
 */

import type { ShiftEntry, ShiftRecording } from '../../../protocol/src/shift.ts'
import { describe, rectOf, styleOf } from './describe.ts'
import { snapshotFonts } from './fonts.ts'
import { now, ring, round, timed } from './state.ts'

/** A shift that starts within this many ms after `markSelf()` is the tool's own doing. */
export const SELF_WINDOW_MS = 500

export const shifts = ring<ShiftEntry>(200)
export const selfMarks: ShiftRecording['selfMarks'] = []
export const supported = PerformanceObserver.supportedEntryTypes.includes('layout-shift')

type Listener = (entry: ShiftEntry) => void
const listeners = new Set<Listener>()
let count = 0

interface LayoutShiftAttribution {
  node: Node | null
  previousRect: DOMRectReadOnly
  currentRect: DOMRectReadOnly
}
interface LayoutShift extends PerformanceEntry {
  value: number
  hadRecentInput: boolean
  lastInputTime: number
  sources: LayoutShiftAttribution[]
}

/** Called by the overlay right before it changes the page. */
export function markSelf(reason: string): void {
  if (selfMarks.length >= 200) selfMarks.shift()
  selfMarks.push({ t: round(now()), reason: String(reason).slice(0, 80) })
}

function selfMarkFor(startTime: number): ShiftEntry['selfInduced'] {
  for (let i = selfMarks.length - 1; i >= 0; i--) {
    const mark = selfMarks[i]
    if (mark === undefined || mark.t > startTime) continue
    return startTime - mark.t <= SELF_WINDOW_MS ? { reason: mark.reason, markedAt: round(mark.t) } : undefined
  }
  return undefined
}

function onShifts(list: PerformanceObserverEntryList): void {
  snapshotFonts()
  const deliveredAt = round(now())
  for (const raw of list.getEntries() as LayoutShift[]) {
    const entry: ShiftEntry = {
      index: count++,
      value: raw.value,
      startTime: round(raw.startTime),
      hadRecentInput: raw.hadRecentInput,
      lastInputTime: round(raw.lastInputTime),
      sources: raw.sources.map((source) => {
        const node = source.node
        const element = node === null ? null : node.nodeType === 1 ? (node as Element) : node.parentElement
        return {
          node: node === null ? null : describe(node),
          previousRect: rectOf(source.previousRect),
          currentRect: rectOf(source.currentRect),
          // The two rectangles above are clipped to the viewport: a node that was pushed out of it has
          // an empty one. Its own box says where it went. Read-only, and a handful of nodes per entry.
          rect: element !== null && element === node ? rectOf(element.getBoundingClientRect()) : undefined,
          ...(element === null ? {} : { style: styleOf(element, false) }),
        }
      }),
      visibility: document.visibilityState,
      deliveredAt,
    }
    const self = selfMarkFor(raw.startTime)
    if (self !== undefined) entry.selfInduced = self
    shifts.push(entry)
    for (const listener of listeners) {
      try {
        listener(entry)
      } catch {
        // A listener's failure is its own.
      }
    }
  }
}

/** Calls `listener` for every entry from now on. Returns the function that stops it. */
export function onShift(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function installShifts(): void {
  if (!supported) return
  new PerformanceObserver(timed(onShifts, 'shiftMs')).observe({ type: 'layout-shift', buffered: true })
}
