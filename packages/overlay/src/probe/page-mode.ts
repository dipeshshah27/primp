/**
 * What primp does to the page as a whole while the dock is open, as opposed to one element:
 *
 *   - the selection cursor: a crosshair over the page while clicks select;
 *   - pausing motion: every running animation of the page (CSS animations, transitions, Web
 *     Animations) is paused, and a rule stops new transitions and animations from starting, so
 *     a moving element can be selected and measured. Resuming plays exactly the animations
 *     that were paused here and takes the rule away.
 *
 * Both are constructable stylesheets in `document.adoptedStyleSheets` (no DOM node, so no
 * mutation the page or the settle detector sees, and no Content-Security-Policy question). They
 * do not reach into primp's own shadow root. Changes are announced with `markSelf` first: a
 * paused or resumed animation can move things, and that is primp's doing, not the page's.
 */

import { isOwn } from './ref.ts'
import { ignoreSheet } from './styles.ts'

const markSelf = (reason: string): void => {
  try {
    window.__primp?.markSelf(reason)
  } catch {
    // The recorder is optional.
  }
}

function attach(doc: Document, sheet: CSSStyleSheet, on: boolean): void {
  try {
    const has = doc.adoptedStyleSheets.includes(sheet)
    if (on && !has) doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet]
    else if (!on && has) doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((one) => one !== sheet)
  } catch {
    // No constructable stylesheets: the cursor stays the page's own and motion is paused by the animations alone.
  }
}

let cursorSheet: CSSStyleSheet | undefined

/** The crosshair over the page while the dock selects. primp's own host keeps its cursors (the handles set theirs). */
export function setSelectCursor(on: boolean, doc: Document = document): void {
  if (cursorSheet === undefined) {
    try {
      cursorSheet = new CSSStyleSheet()
      cursorSheet.replaceSync('html, html *:not([data-primp-root]) { cursor: crosshair !important; }')
      // primp's own: never listed as a rule of the page, never read as the element's style.
      ignoreSheet(cursorSheet)
    } catch {
      return
    }
  }
  attach(doc, cursorSheet, on)
}

let pauseSheet: CSSStyleSheet | undefined
let paused: Animation[] = []

export function motionPaused(): boolean {
  return paused.length > 0 || (pauseSheet !== undefined && document.adoptedStyleSheets.includes(pauseSheet))
}

/**
 * Pauses every running animation of the page and stops new ones. Returns how many were paused.
 * `paused` CSS animations are held by the rule too, so a framework re-rendering the element does not restart them.
 */
export function pauseMotion(doc: Document = document): number {
  if (pauseSheet === undefined) {
    try {
      pauseSheet = new CSSStyleSheet()
      pauseSheet.replaceSync('html *:not([data-primp-root]), html *:not([data-primp-root])::before, html *:not([data-primp-root])::after { animation-play-state: paused !important; transition: none !important; }')
      ignoreSheet(pauseSheet)
    } catch {
      pauseSheet = undefined
    }
  }
  markSelf('pause animations')
  const running: Animation[] = []
  try {
    for (const animation of doc.getAnimations()) {
      const target = (animation.effect as KeyframeEffect | null)?.target ?? null
      if (target !== null && isOwn(target)) continue
      if (animation.playState !== 'running') continue
      animation.pause()
      running.push(animation)
    }
  } catch {
    // getAnimations is missing: the rule alone pauses CSS animations.
  }
  paused = running
  if (pauseSheet !== undefined) attach(doc, pauseSheet, true)
  return running.length
}

/** Undoes `pauseMotion`: plays the animations it paused and takes the rule away. */
export function resumeMotion(doc: Document = document): void {
  markSelf('resume animations')
  if (pauseSheet !== undefined) attach(doc, pauseSheet, false)
  for (const animation of paused) {
    try {
      // A finished or cancelled animation stays as it is.
      if (animation.playState === 'paused') animation.play()
    } catch {
      // The animation's element is gone.
    }
  }
  paused = []
}
