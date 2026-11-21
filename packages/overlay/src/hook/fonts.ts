/**
 * Font evidence: which faces finished loading, and when.
 *
 * `document.fonts` fires `loadingdone` for faces that CSS requested, but not
 * for a face loaded with `new FontFace().load()` and added afterwards
 * (measured on Chromium 159). So besides listening, the hook compares the
 * state of `document.fonts` between two moments: whatever became `loaded` in
 * between is recorded with the interval it happened in.
 */

import type { FontRecord } from '../../../protocol/src/shift.ts'
import { now, ring, timed } from './state.ts'

export const fonts = ring<FontRecord>(120)

const known = new WeakMap<FontFace, string>()
let lastSnapshot: number | undefined
const MAX_FACES = 400

const family = (face: FontFace): string => face.family.replace(/^["']|["']$/g, '')

/** Records every face that became `loaded` since the previous call. Cheap: one pass over `document.fonts`. */
export function snapshotFonts(): void {
  const t = now()
  let count = 0
  for (const face of document.fonts) {
    if (++count > MAX_FACES) break
    const status = face.status
    const previous = known.get(face)
    if (previous === status) continue
    known.set(face, status)
    if (status === 'loaded' && lastSnapshot !== undefined) {
      fonts.push({ t, since: lastSnapshot, event: 'loaded', family: family(face), weight: face.weight, style: face.style, via: 'snapshot' })
    }
  }
  lastSnapshot = t
}

export function installFonts(): void {
  const events: [string, FontRecord['event']][] = [['loading', 'loading'], ['loadingdone', 'loaded'], ['loadingerror', 'error']] // prettier-ignore
  for (const [type, event] of events) {
    document.fonts.addEventListener(
      type,
      timed((e: Event) => {
        const t = now()
        for (const face of (e as FontFaceSetLoadEvent).fontfaces) {
          fonts.push({ t, event, family: family(face), weight: face.weight, style: face.style, via: 'event' })
        }
      }),
    )
  }
}
