/**
 * Load events of replaced elements (images, video, frames) and resource timing.
 *
 * `load`, `error` and `loadedmetadata` do not bubble, but a capturing listener
 * on the document sees them for every element without touching any of them.
 */

import type { MediaEvent, ResourceRecord } from '../../../protocol/src/shift.ts'
import { describe, isMedia } from './describe.ts'
import { lastSize } from './ledger.ts'
import { frame, now, ring, round, timed } from './state.ts'

export const media = ring<MediaEvent>(100)
export const resources = ring<ResourceRecord>(200)

function onMediaEvent(event: Event): void {
  const element = event.target
  // An image that finished before the first frame was never seen without its size.
  if (!frame.seen || !(element instanceof Element) || !isMedia(element)) return
  const record: MediaEvent = {
    t: now(),
    event: event.type,
    node: describe(element),
    url: String((element as HTMLImageElement).currentSrc || (element as HTMLImageElement).src || element.getAttribute('data') || '').slice(0, 300),
  }
  const image = element as HTMLImageElement
  const video = element as HTMLVideoElement
  if (image.naturalWidth > 0) record.natural = { w: image.naturalWidth, h: image.naturalHeight }
  else if (video.videoWidth > 0) record.natural = { w: video.videoWidth, h: video.videoHeight }
  const size = lastSize(element)
  if (size !== undefined) record.size = size
  media.push(record)
}

function onResources(list: PerformanceObserverEntryList): void {
  for (const entry of list.getEntries() as PerformanceResourceTiming[]) {
    // What kind of resource it is (image, font, script) is worked out later, from the initiator and the URL.
    resources.push({
      url: entry.name.slice(0, 300),
      initiator: entry.initiatorType,
      start: round(entry.startTime),
      end: round(entry.responseEnd),
      transferSize: entry.transferSize,
    })
  }
}

export function installMedia(): void {
  const listener = timed(onMediaEvent)
  for (const type of ['load', 'error', 'loadedmetadata']) document.addEventListener(type, listener, true)
  new PerformanceObserver(timed(onResources)).observe({ type: 'resource', buffered: true })
}
