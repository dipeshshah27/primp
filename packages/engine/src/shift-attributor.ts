/**
 * Layout-shift attribution: from what the hook recorded to "this element
 * caused it, for this reason".
 *
 * A layout-shift entry names the VICTIMS, the boxes that moved. The CULPRIT is
 * almost never among them: the image that arrived, the heading that re-wrapped
 * in the web font, the banner that was inserted all change size in place. The
 * hook therefore records every change of an element's size (`resizes`). For
 * each entry the attributor asks which size change of the same frame accounts
 * for the victims' movement:
 *
 *   - direct: the element sits before the victim and grew by the distance the
 *     victim moved (plus its margins, if it has just appeared);
 *   - inside: the victim is a descendant of the element, whose content reflowed.
 *
 * The element that explains the most moved area wins; among equals the deepest
 * one, because growth propagates outwards to every ancestor. When no single
 * element accounts for a victim, up to three that changed in the same frame
 * and lie before it may do so together (two headings that re-wrap at once). Only then is the
 * cause read off the winner: a replaced element is unsized media, a node that
 * was just inserted or shown is injected content, an element that changed size
 * right when a font family of its text, or of text inside it that changed size
 * with it, finished loading is a font swap.
 *
 * The browser reports a victim's two rectangles clipped to the viewport. A box
 * that was pushed out of it has an empty second rectangle, so its rectangles do
 * not show how far it moved, or in which direction. Where the hook measured the
 * box itself (`ShiftSource.rect`) the true distance is used; otherwise only a
 * least distance is known ("it had 207 px to the bottom edge") and an element
 * before it that grew by at least that is `consistent` with it: weaker than a
 * match of the exact distance, and accepted only when no second element could
 * have done the same.
 *
 * The attributor is conservative. Without a geometric match it names no
 * culprit and reports `unknown`; DOM mutations, load events and font events
 * are corroboration, never proof on their own, because the same events happen
 * on pages where nothing moves.
 *
 * Pure: runs on the recorded JSON.
 */

import type {
  NodeDescriptor,
  ResizeRecord,
  ShiftRect,
  ShiftCause,
  ShiftCulprit,
  ShiftEntry,
  ShiftIssue,
  ShiftMutationRecord,
  ShiftRecording,
  ShiftReport,
  ShiftSource,
  ShiftTrigger,
  ShiftVictim,
} from '../../protocol/src/shift.ts'
import { shiftValidity } from './shift-validity.ts'
import { cumulativeLayoutShift, sessionWindows } from './shift-windows.ts'

/** From this confidence on a culprit is shown as the cause. Reached only with a geometric match. */
export const CONFIDENT = 0.7
/** The browser ignores moves under 3 px; rects are rounded, so allow half a pixel. */
const MOVE_MIN = 2.5
/** Entries of one culprit closer together than this are one issue (an image that arrives in two steps). */
const CLUSTER_GAP_MS = 500
/** A mutation leads to a frame within this time unless the main thread is blocked. */
const MUTATION_LEAD_MS = 250
/** A font file ends this long before its glyphs are laid out, at most. */
const FONT_LEAD_MS = 300
/** A stylesheet that finished loading this long before a shift is worth mentioning. */
const STYLESHEET_LEAD_MS = 300
/** Up to this many elements may together account for one victim's movement. */
const GROUP_MAX = 3
/** An explanation that needed several elements, or a float, is one step less direct. */
const INDIRECT_PENALTY = 0.1

const MEDIA_TAGS = new Set(['img', 'video', 'iframe', 'embed', 'object', 'canvas'])
const STYLE_TAGS = new Set(['style', 'link'])
const DEV_TAG = /^(vite-error-overlay|nextjs-portal|astro-dev-toolbar|astro-dev-overlay|svelte-inspector.*|wds-.*|nuxt-devtools.*)$/
const DEV_ID = /^(webpack-dev-server-client-overlay|__next-build-watcher|__next-build-indicator|__nuxt-devtools|vite-plugin-checker|primp)/
/** Scripts of dev servers. primp's own are not in the list: see `callerFrames`. */
const DEV_SCRIPT = /\/@vite\/|\/@react-refresh|\/_next\/static\/chunks\/[^\s)]*(hmr|devtools|react-refresh)|webpack-dev-server|\/@id\/__x00__/i
/** Everything primp serves into the page lives under this path (`RESERVED_PREFIX` of the protocol). */
const OWN_SCRIPT = /\/__primp\//
/** A stack line that names a script: `at f (http://host/a.js:3:1)`, `at http://host/a.js:3:1`, `f@http://host/a.js:3:1`. */
const FRAME_URL = /[a-z][a-z0-9+.-]*:\/\/[^\s()]+/i

const FONT_URL = /\.(woff2?|ttf|otf|eot)(?:[?#]|$)/i

/** A font file: requested from a stylesheet (initiator `css`) or by script, so only the URL tells. */
export const isFontResource = (resource: { url: string }): boolean => FONT_URL.test(resource.url)

/** One way a victim whose distance is not on record can have moved: at least `min` px, down (`sign` 1) or up (-1). */
interface Bound {
  sign: 1 | -1
  min: number
  /** The victim's top on the side of the shift where it was visible: `before` it or `after` it. */
  top: number
  when: 'before' | 'after'
}

interface Victim {
  source: ShiftSource
  /** Movement of the start corner. Zero when `known` is not `exact`. */
  dx: number
  dy: number
  /** Area the victim covered before it moved; the share of the shift it stands for. */
  weight: number
  /** False when the rects show no movement (a text node reported with its line box). */
  moved: boolean
  /**
   * `exact`: `dx`/`dy` are the movement. `at-least`: the box left or entered the viewport and the
   * browser's rectangles do not say how far it went; `bounds` lists what is possible. `unknown`: nothing.
   */
  known: 'exact' | 'at-least' | 'unknown'
  bounds: Bound[]
  viewport?: ShiftVictim['viewport']
  /** Where the box is after the shift: the browser's rectangle, or the measured box when that one is clipped. */
  after: ShiftRect
}

/** What the attributor needs to know about the page besides the entry. */
interface Frame {
  width: number
  height: number
  /** The page was scrolled: a rectangle that starts at the viewport's edge may be cut by it. */
  scrolledX: boolean
  scrolledY: boolean
}

/** One element's net change of size within the frame of an entry. */
interface Candidate {
  record: ResizeRecord
  node: NodeDescriptor
  dw: number
  dh: number
  /** Had no visible box before: inserted, shown from `display: none`, or grown from zero height or width. */
  appeared: boolean
}

interface Scored {
  candidate: Candidate
  /** Share of the moved area whose exact distance the candidate accounts for. */
  direct: number
  /** Share that left or entered the viewport, for which the candidate changed size by enough, and nothing else did. */
  bounded: number
  inside: number
  /**
   * Part of `inside` that is more than "consistent": an element inside the candidate that accounts
   * for the candidate's own change of size (an image in a card) explains the victim's distance.
   */
  innerDirect: number
  explained: ShiftVictim['explained'][]
  /** Other elements that were needed, together with `candidate`, to account for some victims. */
  partners: Candidate[]
}

const fmt = (value: number): string => String(Math.round(value * 10) / 10)
const size = (value: { w: number; h: number } | null): string => (value === null ? 'nothing' : `${fmt(value.w)}x${fmt(value.h)}`)

/** How a person would name the node in one word. */
export function nodeLabel(node: NodeDescriptor | null): string {
  if (node === null) return '(anonymous box)'
  if (node.id !== undefined) return `${node.tag}#${node.id}`
  if (node.classes !== undefined && node.classes.length > 0) return `${node.tag}.${node.classes[0]}`
  return node.selector
}

/** `ancestor` is a strict ancestor of `node`, by element index path. */
export function isAncestorPath(ancestor: readonly number[], node: readonly number[]): boolean {
  if (ancestor.length >= node.length) return false
  for (let i = 0; i < ancestor.length; i++) if (ancestor[i] !== node[i]) return false
  return true
}

const area = (rect: ShiftRect): number => Math.max(0, rect.width) * Math.max(0, rect.height)
/** No visible point: what the browser reports for a box that is outside the viewport. */
const isEmpty = (rect: ShiftRect): boolean => rect.width <= 0 || rect.height <= 0
const EDGE = 0.5

function frameOf(recording: ShiftRecording): Frame {
  return {
    width: recording.viewport.width,
    height: recording.viewport.height,
    scrolledX: recording.scroll.x !== 0 || recording.scrolls.some((scroll) => scroll.x !== 0),
    scrolledY: recording.scroll.y !== 0 || recording.scrolls.some((scroll) => scroll.y !== 0),
  }
}

/** The part of `rect` inside the viewport, as the Layout Instability API would report it. */
function clipToViewport(rect: ShiftRect, frame: Frame): ShiftRect {
  const x = Math.max(0, rect.x)
  const y = Math.max(0, rect.y)
  const width = Math.min(frame.width, rect.x + rect.width) - x
  const height = Math.min(frame.height, rect.y + rect.height) - y
  return width <= 0 || height <= 0 ? { x: 0, y: 0, width: 0, height: 0 } : { x, y, width, height }
}

/**
 * The box the hook measured when the entry was delivered, when it can be trusted: it must show the
 * same visible part as the browser's `currentRect`. It does not when the page changed again between
 * the frame and the measurement, or when an ancestor clips the node (a scroll container).
 */
function measuredBox(source: ShiftSource, frame: Frame): ShiftRect | undefined {
  const box = source.rect
  if (box === undefined || isEmpty(box)) return undefined
  const visible = clipToViewport(box, frame)
  const current = source.currentRect
  if (isEmpty(current)) return isEmpty(visible) ? box : undefined
  const close = (a: number, b: number): boolean => Math.abs(a - b) <= 2
  const same = close(visible.x, current.x) && close(visible.y, current.y) && close(visible.x + visible.width, current.x + current.width) && close(visible.y + visible.height, current.y + current.height)
  return same ? box : undefined
}

/**
 * Reads the movement of one source off its rectangles. The rectangles are clipped to the viewport
 * (https://wicg.github.io/layout-instability/, "visual representation"), so:
 *   - both non-empty: the start corners give the distance, as long as neither is cut by the viewport's edge;
 *   - `currentRect` empty: the box was visible and is now outside the viewport. With the measured box
 *     the distance is exact; without it, only "at least as far as the edge it left through";
 *   - `previousRect` empty: it came into the viewport from somewhere outside it: at least the distance to the edge.
 */
function toVictim(source: ShiftSource, frame: Frame): Victim {
  const previous = source.previousRect
  const current = source.currentRect
  const box = measuredBox(source, frame)
  const weight = Math.max(1, area(previous) || area(current))
  const exact = (dx: number, dy: number, after: ShiftRect, viewport?: Victim['viewport']): Victim => ({
    source, dx, dy, weight, known: 'exact', bounds: [], after,
    moved: Math.abs(dx) >= MOVE_MIN || Math.abs(dy) >= MOVE_MIN,
    ...(viewport === undefined ? {} : { viewport }),
  }) // prettier-ignore
  const atLeast = (bounds: Bound[], viewport: Victim['viewport']): Victim => ({
    source, dx: 0, dy: 0, weight, known: bounds.length > 0 ? 'at-least' : 'unknown', bounds, viewport, moved: true, after: box ?? current,
  }) // prettier-ignore
  // A start edge at the viewport's edge on a scrolled page: the box may begin outside, where the rectangle does not reach.
  const cutTop = frame.scrolledY && previous.y <= EDGE
  const cutLeft = frame.scrolledX && previous.x <= EDGE

  if (isEmpty(previous) && isEmpty(current)) return { source, dx: 0, dy: 0, weight, known: 'unknown', bounds: [], moved: false, after: current }

  if (isEmpty(current)) {
    if (box !== undefined && !cutTop) {
      // A previous rectangle that starts at the viewport's edge while the box now starts beyond that
      // edge was cut there: on that axis the rectangles say nothing.
      const dx = cutLeft || (previous.x <= EDGE && box.x < 0) ? 0 : box.x - previous.x
      const dy = previous.y <= EDGE && box.y < 0 ? 0 : box.y - previous.y
      return exact(dx, dy, box, 'out')
    }
    const bounds: Bound[] = []
    // Pushed below the bottom edge: its top had `height - y` px to go.
    if (box === undefined || box.y >= frame.height - EDGE) bounds.push({ sign: 1, min: (box?.y ?? frame.height) - previous.y, top: previous.y, when: 'before' })
    // Pulled above the top edge, which only a scrolled page allows: its bottom had to pass y = 0.
    if (frame.scrolledY && (box === undefined || box.y + box.height <= EDGE)) bounds.push({ sign: -1, min: previous.y + previous.height, top: previous.y, when: 'before' })
    return atLeast(bounds, 'out')
  }

  if (isEmpty(previous)) {
    // Pulled up from below the bottom edge, or (scrolled page) pushed down from above the top edge.
    const bounds: Bound[] = [{ sign: -1, min: frame.height - current.y, top: current.y, when: 'after' }]
    if (frame.scrolledY) bounds.push({ sign: 1, min: current.y + current.height, top: current.y, when: 'after' })
    return atLeast(bounds, 'in')
  }

  // Both visible. The measured box corrects a current rectangle whose start edge is cut by the
  // viewport (the box moved up or left, partly out of it), when the previous one shows that edge.
  let after = current
  let viewport: Victim['viewport']
  if (box !== undefined) {
    const y = box.y < current.y - 1 && previous.y > EDGE ? box.y : current.y
    const x = box.x < current.x - 1 && previous.x > EDGE ? box.x : current.x
    if (y !== current.y || x !== current.x) {
      after = { x, y, width: current.width + (current.x - x), height: current.height + (current.y - y) }
      viewport = 'cut'
    }
  }
  return exact(after.x - previous.x, after.y - previous.y, after, viewport)
}

/** The resize records that belong to the frame of `entry`, one candidate per element. */
function candidatesFor(recording: ShiftRecording, entry: ShiftEntry, previous: ShiftEntry | undefined, next: ShiftEntry | undefined): Candidate[] {
  // The entry's startTime is the frame's time; the ResizeObserver runs inside that frame and the
  // entry is delivered right after it. Neighbouring entries bound the frame on both sides.
  const from = Math.max(entry.startTime - 40, previous === undefined ? -Infinity : previous.startTime + 5)
  const to = Math.min(entry.deliveredAt + 2, entry.startTime + 120, next === undefined ? Infinity : next.startTime - 5)
  const byUid = new Map<number, Candidate>()
  for (const record of recording.resizes) {
    if (record.t < from || record.t > to) continue
    // An empty path is <html> or a node that was detached when it was described: neither can be placed.
    if (record.node.path.length === 0) continue
    const existing = byUid.get(record.node.uid)
    const before = existing === undefined ? record.before : existing.record.before
    const merged: ResizeRecord = { ...record, before, rect: record.rect ?? existing?.record.rect, style: record.style ?? existing?.record.style }
    byUid.set(record.node.uid, {
      record: merged,
      node: record.node,
      dw: record.after.w - (before?.w ?? 0),
      dh: record.after.h - (before?.h ?? 0),
      // No box before: not in the document, `display: none`, or collapsed to nothing.
      appeared: before === null || before.w === 0 || before.h === 0,
    })
  }
  return [...byUid.values()].filter((candidate) => Math.abs(candidate.dw) >= 0.5 || Math.abs(candidate.dh) >= 0.5)
}

/** Whether a growth of `growth` px (plus margins for a box that just appeared) accounts for a move of `delta` px. */
function amountMatches(delta: number, growth: number, margins: number): boolean {
  if (Math.abs(growth) < 0.5 || Math.sign(growth) !== Math.sign(delta)) return false
  const tolerance = Math.max(1.5, Math.abs(delta) * 0.02)
  return Math.abs(delta) >= Math.abs(growth) - tolerance && Math.abs(delta) <= Math.abs(growth) + margins + tolerance
}

const outOfFlow = (style: { position: string } | undefined): boolean => style !== undefined && (style.position === 'fixed' || style.position === 'absolute')

/** The candidate lies before the victim and its change of size equals the victim's movement, on every axis the victim moved. */
function explainsDirectly(candidate: Candidate, victim: Victim): boolean {
  const { rect, style } = candidate.record
  if (rect === undefined || !victim.moved || victim.known !== 'exact') return false
  if (outOfFlow(style)) return false
  const previous = victim.source.previousRect
  const current = victim.after
  const margin = candidate.appeared && style?.margin !== undefined ? style.margin : [0, 0, 0, 0]
  const slack = 1.5
  if (Math.abs(victim.dy) >= MOVE_MIN) {
    if (!amountMatches(victim.dy, candidate.dh, (margin[0] ?? 0) + (margin[2] ?? 0))) return false
    // Before the victim in the block direction: it starts no lower than the victim did and ends no lower than the victim now starts.
    if (rect.y > previous.y + slack || rect.y + rect.height > current.y + slack) return false
  }
  if (Math.abs(victim.dx) >= MOVE_MIN) {
    if (!amountMatches(victim.dx, candidate.dw, (margin[1] ?? 0) + (margin[3] ?? 0))) return false
    if (rect.x > previous.x + slack || rect.x + rect.width > current.x + slack) return false
  }
  return true
}

/** The victim is content of the candidate: a descendant, or an anonymous box within its rectangle. */
function contains(candidate: Candidate, victim: Victim): boolean {
  const node = victim.source.node
  if (node !== null && node.path.length > 0) return isAncestorPath(candidate.node.path, node.path)
  const rect = candidate.record.rect
  const box = victim.source.currentRect
  // An empty rectangle is "outside the viewport", not a box at the top-left corner.
  if (rect === undefined || isEmpty(box)) return false
  return box.x >= rect.x - 1 && box.y >= rect.y - 1 && box.x + box.width <= rect.x + rect.width + 1 && box.y + box.height <= rect.y + rect.height + 1
}

/**
 * The candidate changed size by at least the distance a victim needed to leave (or enter) the
 * viewport, in the right direction, and lies before the victim: it is not around it, it is in the
 * victim's column, and it ended no lower than the victim's top at the moment that top is on record
 * (so a tall neighbour that reaches past the victim is beside it, not before it). The way the victim moved, or
 * undefined. Weaker than `explainsDirectly`: any large enough change before the victim passes, so
 * the caller must also make sure there is no second one (`consistentWith`).
 */
function reaches(candidate: Candidate, victim: Victim): Bound | undefined {
  const { rect, style } = candidate.record
  if (victim.known !== 'at-least' || rect === undefined || outOfFlow(style) || outOfFlow(victim.source.style)) return undefined
  if (isAncestorPath(candidate.node.path, victim.source.node?.path ?? [])) return undefined
  const margins = candidate.appeared ? (style?.margin?.[0] ?? 0) + (style?.margin?.[2] ?? 0) : 0
  return victim.bounds.find((bound) => {
    if (Math.sign(candidate.dh) !== bound.sign || Math.abs(candidate.dh) + margins < bound.min - 1.5) return false
    // Above the victim and in its column, at the moment the victim's rectangle is on record.
    const seen = bound.when === 'before' ? victim.source.previousRect : victim.source.currentRect
    const bottom = rect.y + rect.height - (bound.when === 'before' ? candidate.dh : 0)
    return rect.y <= bound.top + 1.5 && bottom <= bound.top + 1.5 && rect.x < seen.x + seen.width && rect.x + rect.width > seen.x
  })
}

const onOneChain = (a: Candidate, b: Candidate): boolean => a === b || isAncestorPath(a.node.path, b.node.path) || isAncestorPath(b.node.path, a.node.path)

/** `inner` alone is large enough to be why `outer` changed size, on every axis `outer` changed. */
function covers(outer: Candidate, inner: Candidate): boolean {
  const margin = inner.record.style?.margin ?? [0, 0, 0, 0]
  const h = Math.abs(inner.dh) + (inner.appeared ? (margin[0] ?? 0) + (margin[2] ?? 0) : 0)
  const w = Math.abs(inner.dw) + (inner.appeared ? (margin[1] ?? 0) + (margin[3] ?? 0) : 0)
  return (Math.abs(outer.dh) < MOVE_MIN || h >= Math.abs(outer.dh) - 1.5) && (Math.abs(outer.dw) < MOVE_MIN || w >= Math.abs(outer.dw) - 1.5)
}

/** Everything that changed size in the frame, and which of it has a reason of its own on record. */
interface Matcher {
  candidates: Candidate[]
  /** Those that may be named: not a victim, and not inside one. */
  eligible: Candidate[]
  /** The candidate, or something inside it, was inserted, shown, is replaced content, or was touched by a DOM mutation. */
  hasReason(candidate: Candidate): boolean
}

/**
 * The victim left or entered the viewport and `candidate` is the one change that can have done it:
 *   - it changed size by at least the distance to the viewport's edge (`reaches`);
 *   - the change reached the victim: an element that contains both changed size by that much too
 *     (growth inside a box of fixed height pushes nothing outside it);
 *   - no other change of the frame does the same that has a reason of its own and is not this one
 *     seen at another level (its ancestor or descendant). A plain box that only stretched along
 *     (the neighbour in a grid row) is not a rival.
 */
function consistentWith(candidate: Candidate, victim: Victim, matcher: Matcher): Bound | undefined {
  const bound = reaches(candidate, victim)
  const path = victim.source.node?.path ?? []
  if (bound === undefined || path.length === 0) return undefined
  const propagated = matcher.candidates.some(
    (other) => isAncestorPath(other.node.path, candidate.node.path) && isAncestorPath(other.node.path, path) && Math.sign(other.dh) === bound.sign && Math.abs(other.dh) >= bound.min - 1.5,
  )
  if (!propagated) return undefined
  const rival = matcher.candidates.some((other) => !onOneChain(other, candidate) && reaches(other, victim) !== undefined && matcher.hasReason(other))
  return rival ? undefined : bound
}

/**
 * An element inside `candidate` that is large enough to be why `candidate` changed size and that
 * accounts for the distance of a victim inside `candidate`: the image of a card, for the card's text.
 */
function innerExplainer(candidate: Candidate, victim: Victim, matcher: Matcher): Candidate | undefined {
  return matcher.eligible.find((other) => isAncestorPath(candidate.node.path, other.node.path) && covers(candidate, other) && explainsDirectly(other, victim))
}

function score(candidate: Candidate, victims: Victim[], total: number, matcher: Matcher): Scored {
  let direct = 0
  let bounded = 0
  let inside = 0
  let innerDirect = 0
  const explained = victims.map((victim): ShiftVictim['explained'] => {
    if (explainsDirectly(candidate, victim)) {
      direct += victim.weight
      return 'direct'
    }
    if (consistentWith(candidate, victim, matcher) !== undefined) {
      bounded += victim.weight
      return 'consistent'
    }
    if (contains(candidate, victim)) {
      inside += victim.weight
      if (innerExplainer(candidate, victim, matcher) !== undefined) innerDirect += victim.weight
      return 'inside'
    }
    return 'no'
  })
  return { candidate, direct: direct / total, bounded: bounded / total, inside: inside / total, innerDirect: innerDirect / total, explained, partners: [] }
}

/** Where a change starts: elements that changed size and contain no other element that did. */
function leaves(candidates: Candidate[]): Candidate[] {
  return candidates.filter((candidate) => !candidates.some((other) => other !== candidate && isAncestorPath(candidate.node.path, other.node.path)))
}

/** The candidate is in normal flow, above the victim and in its column. */
function isAbove(candidate: Candidate, victim: Victim): boolean {
  const { rect, style } = candidate.record
  if (rect === undefined || outOfFlow(style)) return false
  const previous = victim.source.previousRect
  const current = victim.after
  if (rect.y > previous.y + 1.5 || rect.y + rect.height > current.y + 1.5) return false
  return rect.x < current.x + current.width && rect.x + rect.width > current.x
}

/** The smallest set of 2 to `GROUP_MAX` candidates above the victim whose growths add up to its vertical move. */
function groupFor(pool: Candidate[], victim: Victim): Candidate[] | undefined {
  if (!victim.moved || victim.known !== 'exact' || Math.abs(victim.dx) >= MOVE_MIN || Math.abs(victim.dy) < MOVE_MIN) return undefined
  const above = pool.filter((candidate) => Math.sign(candidate.dh) === Math.sign(victim.dy) && Math.abs(candidate.dh) >= 0.5 && isAbove(candidate, victim)).slice(0, 10)
  const marginsOf = (candidate: Candidate): number => (candidate.appeared ? (candidate.record.style?.margin?.[0] ?? 0) + (candidate.record.style?.margin?.[2] ?? 0) : 0)
  const search = (start: number, chosen: Candidate[], size: number): Candidate[] | undefined => {
    if (chosen.length === size) {
      const growth = chosen.reduce((sum, candidate) => sum + candidate.dh, 0)
      return amountMatches(victim.dy, growth, chosen.reduce((sum, candidate) => sum + marginsOf(candidate), 0)) ? chosen : undefined
    }
    for (let index = start; index < above.length; index++) {
      const found = search(index + 1, [...chosen, above[index] as Candidate], size)
      if (found !== undefined) return found
    }
    return undefined
  }
  for (let size = 2; size <= GROUP_MAX; size++) {
    const found = search(0, [], size)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Extends the best single explanation with groups: victims that no single element accounts for
 * but several together do. The element that takes part in explaining the most moved area becomes
 * the culprit; the others are its partners.
 */
function withGroups(best: Scored | undefined, eligible: Candidate[], carried: Candidate[], victims: Victim[], total: number, matcher: Matcher): Scored | undefined {
  // A victim that also changed size (a second heading that re-wrapped) was pushed by what is above it
  // and pushes what is below it: it cannot be the culprit, but it can be part of the explanation.
  const pool = leaves([...eligible, ...carried])
  if (pool.length < 2) return best
  const settled = (verdict: ShiftVictim['explained'] | undefined): boolean => verdict === 'direct' || verdict === 'consistent'
  const fits = victims.map((victim, index) => (settled(best?.explained[index]) ? undefined : groupFor(pool, victim)))
  if (fits.every((fit) => fit === undefined)) return best
  // Weight each element by the area of the victims it helps to explain.
  const share = new Map<Candidate, number>()
  const add = (candidate: Candidate, weight: number): void => void share.set(candidate, (share.get(candidate) ?? 0) + weight)
  victims.forEach((victim, index) => {
    if (best !== undefined && settled(best.explained[index])) add(best.candidate, victim.weight)
    for (const member of fits[index] ?? []) add(member, victim.weight)
  })
  // Most area first; among equals the first in document order.
  const order = (a: Candidate, b: Candidate): number => {
    for (let i = 0; i < Math.min(a.node.path.length, b.node.path.length); i++) {
      const difference = (a.node.path[i] ?? 0) - (b.node.path[i] ?? 0)
      if (difference !== 0) return difference
    }
    return a.node.path.length - b.node.path.length
  }
  const primary = [...share.entries()].filter(([candidate]) => !carried.includes(candidate)).sort((a, b) => b[1] - a[1] || order(a[0], b[0]))[0]?.[0]
  if (primary === undefined) return best
  const single = primary === best?.candidate ? best : score(primary, victims, total, matcher)
  const partners = new Set<Candidate>()
  let direct = 0
  let bounded = 0
  let inside = 0
  const explained = victims.map((victim, index): ShiftVictim['explained'] => {
    const fit = fits[index]
    if (single.explained[index] === 'direct' || fit?.includes(primary) === true) {
      for (const member of fit ?? []) if (member !== primary) partners.add(member)
      direct += victim.weight
      return 'direct'
    }
    if (single.explained[index] === 'consistent') bounded += victim.weight
    if (single.explained[index] === 'inside') inside += victim.weight
    return single.explained[index] ?? 'no'
  })
  const grouped: Scored = { candidate: primary, direct: direct / total, bounded: bounded / total, inside: inside / total, innerDirect: single.innerDirect, explained, partners: [...partners] }
  return best === undefined || accounted(grouped) > accounted(best) ? grouped : best
}

/** Share of the moved area the candidate accounts for by its own change of size. */
const accounted = (scored: Scored): number => scored.direct + scored.bounded
/** Reflow inside the culprit counts half: it is consistent with the culprit, not evidence for it. */
const total = (scored: Scored): number => accounted(scored) + scored.inside * 0.5

const isOrigin = (candidate: Candidate): boolean => MEDIA_TAGS.has(candidate.node.tag) || candidate.appeared

/**
 * The candidate that explains the most. Growth propagates outwards, so an element and all its
 * ancestors usually tie; then:
 *   - an element with a reason of its own (replaced content, just appeared) beats plain containers;
 *   - otherwise the deepest one wins;
 *   - unless several siblings tie at that depth (every item of a list re-wrapped): then their
 *     common container is the answer, not an arbitrary one of them.
 */
function pickBest(scored: Scored[]): Scored | undefined {
  const explaining = scored.filter((item) => accounted(item) > 0)
  if (explaining.length === 0) return undefined
  const top = Math.max(...explaining.map(total))
  const tied = explaining.filter((item) => total(item) >= top - 0.02)
  const origins = tied.filter((item) => isOrigin(item.candidate))
  const pool = origins.length > 0 ? origins : tied
  const depth = Math.max(...pool.map((item) => item.candidate.node.path.length))
  const deepest = pool.filter((item) => item.candidate.node.path.length === depth)
  if (deepest.length === 1) return deepest[0]
  const containers = tied
    .filter((item) => deepest.every((leaf) => isAncestorPath(item.candidate.node.path, leaf.candidate.node.path)))
    .sort((a, b) => b.candidate.node.path.length - a.candidate.node.path.length)
  return containers[0] ?? deepest[0]
}

const isStyleNode = (node: NodeDescriptor): boolean =>
  STYLE_TAGS.has(node.tag) && (node.tag === 'style' || (node.attrs?.rel ?? '').toLowerCase().includes('stylesheet'))

function isDevNode(node: NodeDescriptor): boolean {
  return (
    DEV_TAG.test(node.tag) ||
    (node.id !== undefined && DEV_ID.test(node.id)) ||
    node.attrs?.['data-primp-root'] !== undefined ||
    node.attrs?.['data-vite-dev-id'] !== undefined
  )
}

/**
 * The frames of a recorded DOM-call stack that say who made the call: the stack without primp's
 * own frames on top of it. The hook records the stack from inside the wrapper it puts around DOM
 * methods, and a wrapper's frame (a script under `/__primp/`) is on every such stack, whoever
 * called; hooks before 2026-11-21 left one in for `insertAdjacentHTML`. Frames that name no
 * script (`at Array.forEach (<anonymous>)`) are skipped as well.
 */
export function callerFrames(stack: string | undefined): string[] {
  const lines = (stack ?? '').split('\n').filter((line) => FRAME_URL.test(line))
  let start = 0
  while (start < lines.length && OWN_SCRIPT.test(FRAME_URL.exec(lines[start] ?? '')?.[0] ?? '')) start++
  return lines.slice(start)
}

/** The stack as recorded, minus primp's own frames at its top. Undefined when nothing is left. */
function callerStack(stack: string | undefined): string | undefined {
  if (stack === undefined) return undefined
  const first = callerFrames(stack)[0]
  if (first === undefined) return undefined
  const lines = stack.split('\n')
  return lines.slice(lines.indexOf(first)).join('\n')
}

/**
 * Development tooling made the change: the node is a dev overlay or a dev-server stylesheet, or
 * the script that called the DOM method is a dev client. Decided on the first frame that is not
 * primp's own; a stack with no such frame says nothing.
 */
function isDevMutation(mutation: ShiftMutationRecord): boolean {
  if (isDevNode(mutation.node)) return true
  const caller = callerFrames(mutation.stack)[0]
  return caller !== undefined && DEV_SCRIPT.test(caller)
}

interface FontEvidence {
  family?: string
  url?: string
  /** Dated to within a frame or two of the shift, not just "some time before". */
  precise: boolean
  detail: string
}

/** How long before a frame a face may have been reported as loaded and still be the news of that frame. */
const FONT_FRESH_MS = 60

const fileName = (url: string): string => (url.split(/[?#]/)[0] ?? url).split('/').pop() ?? url

function fontEvidenceFor(recording: ShiftRecording, entry: ShiftEntry): FontEvidence[] {
  const ts = entry.startTime
  const end = entry.deliveredAt
  const file = recording.resources
    .filter((resource) => isFontResource(resource) && resource.end >= ts - FONT_LEAD_MS && resource.end <= end + 10)
    .sort((a, b) => b.end - a.end)[0]
  // Neither source of font records can be taken at its word about WHEN a face loaded:
  //   - a `loadingdone` event lists every face of its loading period, also one that finished long
  //     before (measured: a face from a data: URL, there at 25 ms, is listed again at 822 ms when
  //     another face ends the period). The snapshot that saw that face turn `loaded` back then
  //     shows the listing is a repeat;
  //   - a snapshot dates a face to the first frame in which something changed size after it
  //     loaded, which may be much later (a `font-display: optional` face that never swaps in is
  //     "found" in the frame of the next insertion). The face's own event, earlier in the interval
  //     the snapshot covers, shows that.
  // A face that loaded before this frame is not what changed in this frame. Faces are counted, not
  // only named: one family has several faces with the same weight and style (unicode-range subsets).
  const loaded = recording.fonts.filter((font) => font.event === 'loaded')
  const faceOf = (font: { family: string; weight?: string; style?: string }): string => `${font.family.toLowerCase()}|${font.weight ?? ''}|${font.style ?? ''}`
  const count = (face: string, via: 'event' | 'snapshot', when: (t: number) => boolean): number => loaded.filter((other) => other.via === via && faceOf(other) === face && when(other.t)).length
  const isNews = (font: (typeof loaded)[number]): boolean => {
    const face = faceOf(font)
    const here = count(face, font.via, (t) => t === font.t)
    return font.via === 'event'
      ? here > count(face, 'snapshot', (t) => t < font.t - FONT_FRESH_MS)
      : here > count(face, 'event', (t) => t > (font.since ?? -Infinity) && t < font.t - FONT_FRESH_MS)
  }
  const found = new Map<string, FontEvidence>()
  let reported = false
  for (const font of loaded) {
    const viaEvent = font.via === 'event' && font.t >= ts - FONT_FRESH_MS && font.t <= end + 60
    const viaSnapshot = font.via === 'snapshot' && font.t >= ts - 5 && font.t <= end + 5
    if (!viaEvent && !viaSnapshot) continue
    reported = true
    if (!isNews(font)) continue
    // A snapshot only says "loaded since the last look". It is precise when the last look was recent,
    // or when a font file finished downloading just before the shift.
    const precise = viaEvent || file !== undefined || font.t - (font.since ?? 0) <= FONT_LEAD_MS
    const key = font.family.toLowerCase()
    const known = found.get(key)
    if (known !== undefined && (known.precise || !precise)) continue
    found.set(key, {
      family: font.family,
      url: file?.url,
      precise,
      detail: `font "${font.family}" finished loading at about ${fmt(file?.end ?? font.t)} ms` + (file === undefined ? '' : ` (font file ${fileName(file.url)})`),
    })
  }
  // A font file with no face on record at all (the face list overflowed, or the browser reported none).
  // Not when faces were reported and none of them is news: then the file belongs to one of those.
  if (found.size === 0 && !reported && file !== undefined) {
    found.set('', { url: file.url, precise: true, detail: `font file ${file.url} finished loading at ${fmt(file.end)} ms` })
  }
  return [...found.values()]
}

function usesFamily(fontFamily: string | undefined, family: string): boolean {
  if (fontFamily === undefined) return false
  const wanted = family.toLowerCase()
  return fontFamily.split(',').some((name) => name.trim().replace(/^["']|["']$/g, '').toLowerCase() === wanted)
}

/** Text of the element itself is set in `family`: its own computed font, or that of an inline child the hook noted. */
const setIn = (candidate: Candidate, family: string): boolean =>
  usesFamily(candidate.record.style?.fontFamily, family) || (candidate.record.inlineFonts ?? []).some((list) => usesFamily(list, family))

interface Classified {
  cause: ShiftCause
  culprit: Candidate
  /** The culprit acts on the victims through another element (a float beside re-wrapped text). */
  indirect?: boolean
  /** Nothing was inserted: the element got its box through styling (an attribute, a class, or a stylesheet). */
  viaStyle?: boolean
  /** Independent evidence agrees with the geometry (a load event, a mutation record, a font event). */
  corroborated: boolean
  /** The cause class itself is established, not a fallback. */
  specific: boolean
  trigger?: ShiftTrigger
  evidence: string[]
}

const intersects = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y

function classify(recording: ShiftRecording, entry: ShiftEntry, best: Candidate, candidates: Candidate[], mutations: ShiftMutationRecord[]): Classified {
  const state = { indirect: false }
  const classified = classifyCulprit(recording, entry, best, candidates, mutations, state)
  return state.indirect ? { ...classified, indirect: true } : classified
}

function classifyCulprit(
  recording: ShiftRecording,
  entry: ShiftEntry,
  best: Candidate,
  candidates: Candidate[],
  mutations: ShiftMutationRecord[],
  state: { indirect: boolean },
): Classified {
  const evidence: string[] = []
  let culprit = best
  const within = (node: NodeDescriptor, root: NodeDescriptor): boolean => node.uid === root.uid || isAncestorPath(root.path, node.path)

  /** Put into the document in this frame. */
  const inserted = (candidate: Candidate): boolean => candidate.record.before === null || mutations.some((m) => m.kind === 'add' && m.node.uid === candidate.node.uid)
  /** Inserted, or given its box by a change of an attribute (its own or an ancestor's): an origin whatever is inside it. */
  const arrived = (candidate: Candidate): boolean =>
    inserted(candidate) || mutations.some((m) => m.kind === 'attr' && (m.node.uid === candidate.node.uid || isAncestorPath(m.node.path, candidate.node.path)))

  // A plain container that changed size because something inside it arrived: an inserted node, an
  // image that got its dimensions. The container's growth moved the victims; what is inside is why.
  if (!isOrigin(best)) {
    const inner = candidates
      .filter((candidate) => isOrigin(candidate) && isAncestorPath(best.node.path, candidate.node.path) && covers(best, candidate))
      // Outermost first (a banner, not the paragraph inside it), then the largest.
      .sort((a, b) => a.node.path.length - b.node.path.length || b.record.after.w * b.record.after.h - a.record.after.w * a.record.after.h)[0]
    if (inner !== undefined) {
      const removed = mutations.filter((m) => m.kind === 'remove' && m.parent?.uid === best.node.uid)
      evidence.push(
        `${nodeLabel(best.node)} went from ${size(best.record.before)} to ${size(best.record.after)} because of ${nodeLabel(inner.node)} inside it` +
          (removed.length > 0 ? `, which replaced ${removed.map((m) => `${nodeLabel(m.node)} (${size(m.lastSize ?? null)})`).join(', ')}` : ''),
      )
      culprit = inner
    } else {
      // A float is not inside the block it disturbs: it sits beside the text and makes it re-wrap.
      const bestRect = best.record.rect
      const float = candidates.find(
        (candidate) =>
          isOrigin(candidate) && candidate.record.style?.float !== undefined && candidate.record.rect !== undefined && bestRect !== undefined && intersects(candidate.record.rect, bestRect),
      )
      if (float !== undefined) {
        evidence.push(
          `${nodeLabel(best.node)} went from ${size(best.record.before)} to ${size(best.record.after)}: its text re-wrapped around ${nodeLabel(float.node)}, which is floated ${float.record.style?.float} and went from ${size(float.record.before)} to ${size(float.record.after)}`,
        )
        culprit = float
        state.indirect = true
      }
    }
  }

  // A wrapper that had no height (or no width) and got one in the frame in which the image, video or
  // frame inside it got its size did not "appear": its content arrived, and the replaced element is
  // the origin. Not when the wrapper was inserted, and not when it had no box at all (`display: none`)
  // and an attribute changed on it or around it: then it was shown, with whatever is in it.
  const collapsed = culprit.record.before !== null && (culprit.record.before.w > 0 || culprit.record.before.h > 0)
  if (culprit.appeared && !MEDIA_TAGS.has(culprit.node.tag) && (collapsed ? !inserted(culprit) : !arrived(culprit))) {
    const wrapper = culprit
    // An attribute of the wrapper itself changed (a script gave it a height, or a class): then only
    // media whose own load event is on record for this frame is the reason, not media that followed the wrapper.
    const ownAttribute = mutations.some((m) => m.kind === 'attr' && m.node.uid === wrapper.node.uid)
    const justLoaded = (candidate: Candidate): boolean => recording.media.some((event) => event.node.uid === candidate.node.uid && Math.abs(event.t - entry.startTime) <= 150)
    const media = candidates
      .filter((candidate) => MEDIA_TAGS.has(candidate.node.tag) && isAncestorPath(wrapper.node.path, candidate.node.path) && covers(wrapper, candidate) && (!ownAttribute || justLoaded(candidate)))
      .sort((a, b) => b.record.after.w * b.record.after.h - a.record.after.w * a.record.after.h)[0]
    if (media !== undefined) {
      evidence.push(`${nodeLabel(wrapper.node)} went from ${size(wrapper.record.before)} to ${size(wrapper.record.after)} because ${nodeLabel(media.node)} inside it got its size`)
      culprit = media
    }
  }

  const own = mutations.filter((m) => within(m.node, culprit.node) || m.parent?.uid === culprit.node.uid)
  const addRecord = mutations.find((m) => m.kind === 'add' && m.node.uid === culprit.node.uid)
  const describeChange = `${nodeLabel(culprit.node)} went from ${size(culprit.record.before)} to ${size(culprit.record.after)} at ${fmt(culprit.record.t)} ms`

  if (isDevNode(culprit.node) || (addRecord !== undefined && isDevMutation(addRecord))) {
    evidence.push(describeChange, 'it belongs to development tooling, not to the page')
    return { cause: 'dev-artifact', culprit, corroborated: true, specific: true, evidence, trigger: { kind: 'mutation', stack: callerStack(addRecord?.stack), t: addRecord?.t } }
  }

  if (addRecord !== undefined || (culprit.appeared && !MEDIA_TAGS.has(culprit.node.tag))) {
    const shownBy = mutations.find((m) => m.kind === 'attr' && (m.node.uid === culprit.node.uid || isAncestorPath(m.node.path, culprit.node.path)))
    if (addRecord !== undefined) {
      evidence.push(`${nodeLabel(culprit.node)} (${size(culprit.record.after)}) was inserted into ${nodeLabel(addRecord.parent ?? null)} at ${fmt(addRecord.t)} ms, after the page had painted`)
    } else {
      evidence.push(
        describeChange,
        shownBy === undefined
          ? 'it was in the document without a box and then got one'
          : `it was shown by a change of the ${shownBy.attr} attribute on ${nodeLabel(shownBy.node)} at ${fmt(shownBy.t)} ms`,
      )
    }
    const record = addRecord ?? shownBy
    return {
      cause: 'injected-content',
      culprit,
      corroborated: record !== undefined,
      specific: true,
      viaStyle: addRecord === undefined,
      evidence,
      trigger: record === undefined ? undefined : { kind: 'mutation', stack: callerStack(record.stack), t: record.t, detail: record.kind === 'attr' ? `${record.attr} attribute changed` : 'node inserted' },
    }
  }

  if (MEDIA_TAGS.has(culprit.node.tag)) {
    evidence.push(describeChange)
    const hints = culprit.record.media
    if (hints !== undefined) {
      const missing = [
        hints.widthAttr && hints.heightAttr ? '' : `no ${[hints.widthAttr ? '' : 'width', hints.heightAttr ? '' : 'height'].filter(Boolean).join('/')} attribute`,
        hints.aspectRatio === 'auto' ? 'no aspect-ratio' : '',
      ].filter(Boolean)
      if (missing.length > 0) evidence.push(`its space was not reserved: ${missing.join(', ')}`)
    }
    const loaded = recording.media
      .filter((event) => event.node.uid === culprit.node.uid && Math.abs(event.t - entry.startTime) <= 150)
      .sort((a, b) => Math.abs(a.t - entry.startTime) - Math.abs(b.t - entry.startTime))[0]
    const url = loaded?.url ?? culprit.node.attrs?.src
    const resource = url === undefined ? undefined : recording.resources.find((r) => r.url === url || r.url.endsWith(url))
    if (loaded !== undefined) {
      evidence.push(`its ${loaded.event} event fired at ${fmt(loaded.t)} ms` + (loaded.natural === undefined ? '' : ` (intrinsic size ${size(loaded.natural)})`))
    }
    const styled = own.find((m) => m.kind === 'attr' && m.node.uid === culprit.node.uid)
    if (styled !== undefined) evidence.push(`its ${styled.attr} attribute was set by script at ${fmt(styled.t)} ms`)
    return {
      cause: 'unsized-media',
      culprit,
      corroborated: loaded !== undefined || styled !== undefined,
      specific: true,
      evidence,
      trigger: { kind: 'resource', url, t: resource?.end ?? loaded?.t, stack: callerStack(styled?.stack) },
    }
  }

  evidence.push(describeChange)
  const contentChanged = own.filter((m) => m.kind !== 'attr' || m.node.uid !== culprit.node.uid)
  if (contentChanged.length === 0) {
    const inside = candidates.filter((candidate) => isAncestorPath(culprit.node.path, candidate.node.path))
    // Something else in the element has a reason of its own to change size: not the font's doing, or not only.
    const otherReason = inside.some(isOrigin)
    for (const font of fontEvidenceFor(recording, entry)) {
      const family = font.family
      const fontTrigger: ShiftTrigger = { kind: 'font', family, url: font.url }
      if (family === undefined || setIn(culprit, family)) {
        const own = family === undefined || usesFamily(culprit.record.style?.fontFamily, family)
        evidence.push(
          font.detail,
          family === undefined
            ? 'no DOM change touched the element in that frame'
            : `${own ? '' : 'inline text of '}${nodeLabel(culprit.node)} is set in "${family}" and nothing else about it changed in that frame`,
        )
        return { cause: 'font-swap', culprit, corroborated: font.precise && family !== undefined, specific: font.precise, evidence, trigger: fontTrigger }
      }
      // The text is further in: the element that accounts for the movement is the header, the table
      // row, the card; what re-wrapped in the new font are the links, cells or headings inside it.
      // They must have changed size in this frame themselves (a face that loads and changes nothing
      // is not a swap), by enough between them to be why the element did, and nothing else in the
      // element may have changed.
      if (otherReason) continue
      const users = inside.filter((candidate) => setIn(candidate, family))
      const outermost = users.filter((user) => !users.some((other) => isAncestorPath(other.node.path, user.node.path)))
      const sum = (pick: (candidate: Candidate) => number): number => outermost.reduce((all, user) => all + Math.abs(pick(user)), 0)
      const enough = (Math.abs(culprit.dh) < MOVE_MIN || sum((user) => user.dh) >= Math.abs(culprit.dh) - 1.5) && (Math.abs(culprit.dw) < MOVE_MIN || sum((user) => user.dw) >= Math.abs(culprit.dw) - 1.5)
      if (outermost.length === 0 || !enough) continue
      const first = outermost[0] as Candidate
      evidence.push(
        font.detail,
        `${nodeLabel(first.node)}${outermost.length > 1 ? ` and ${outermost.length - 1} more element(s)` : ''} inside ${nodeLabel(culprit.node)} ${outermost.length > 1 ? 'are' : 'is'} set in "${family}" and changed size in that frame ` +
          `(${nodeLabel(first.node)} from ${size(first.record.before)} to ${size(first.record.after)}); nothing else in ${nodeLabel(culprit.node)} changed`,
      )
      return { cause: 'font-swap', culprit, corroborated: font.precise, specific: font.precise, evidence, trigger: fontTrigger }
    }
  }

  const textChange = own.find((m) => m.kind === 'text' || m.kind === 'add' || m.kind === 'remove')
  if (textChange !== undefined) {
    evidence.push(`its content was changed by script at ${fmt(textChange.t)} ms`)
    return { cause: 'injected-content', culprit, corroborated: true, specific: true, evidence, trigger: { kind: 'mutation', stack: callerStack(textChange.stack), t: textChange.t, detail: 'content changed' } }
  }
  const attrChange = own.find((m) => m.kind === 'attr')
  if (attrChange !== undefined) evidence.push(`its ${attrChange.attr} attribute changed at ${fmt(attrChange.t)} ms`)
  else evidence.push('nothing on record says why it changed size')
  return { cause: 'unknown', culprit, corroborated: false, specific: false, evidence }
}

function toCulprit(candidate: Candidate): ShiftCulprit {
  return {
    node: candidate.node,
    sizeBefore: candidate.record.before,
    sizeAfter: candidate.record.after,
    rect: candidate.record.rect,
    media: candidate.record.media,
  }
}

/** Direction and distance in words: `down 17.6px`, `down 12px and right 4px`. */
function distanceWords(dx: number, dy: number): string {
  const parts: string[] = []
  if (Math.abs(dy) >= MOVE_MIN) parts.push(`${dy > 0 ? 'down' : 'up'} ${fmt(Math.abs(dy))}px`)
  if (Math.abs(dx) >= MOVE_MIN) parts.push(`${dx > 0 ? 'right' : 'left'} ${fmt(Math.abs(dx))}px`)
  return parts.join(' and ')
}

/**
 * What happened to a victim, in plain words. A box that left the viewport has no second rectangle:
 * never "moved up and left" to the zero rectangle the browser reports for it. `bound` is the way
 * it moved according to the culprit that is consistent with it, when there is one.
 */
function describeMove(victim: Victim, bound?: Bound): string {
  const label = nodeLabel(victim.source.node)
  if (victim.known === 'exact') {
    const words = distanceWords(victim.dx, victim.dy)
    if (words === '') return `${label} moved (distance not visible in its rects)`
    if (victim.viewport !== 'out') return `${label} moved ${words}`
    // Out of sight in the direction it mostly went.
    const vertical = Math.abs(victim.dy) >= Math.abs(victim.dx)
    const where = vertical ? (victim.dy > 0 ? 'below' : 'above') : victim.dx > 0 ? 'to the right of' : 'to the left of'
    return `${label} was pushed ${words}, ${where} the visible area`
  }
  if (victim.viewport === 'in') {
    return bound === undefined
      ? `${label} came into the visible area (the browser reports no position for it before the shift, so how far it moved is not on record)`
      : `${label} was ${bound.sign > 0 ? 'pushed down' : 'pulled up'} into the visible area (at least ${fmt(bound.min)}px)`
  }
  return bound === undefined
    ? `${label} left the visible area (the browser reports no position for it after the shift, so how far it moved is not on record)`
    : `${label} was ${bound.sign > 0 ? 'pushed below' : 'pulled above'} the visible area (at least ${fmt(bound.min)}px ${bound.sign > 0 ? 'down' : 'up'})`
}

type EntryIssue = Omit<ShiftIssue, 'id' | 'window'>

const isStylesheetUrl = (url: string): boolean => /\.css(?:[?#]|$)/i.test(url)

function attributeEntry(recording: ShiftRecording, entry: ShiftEntry, previous: ShiftEntry | undefined, next: ShiftEntry | undefined): EntryIssue {
  const frame = frameOf(recording)
  const victims = entry.sources.map((source) => toVictim(source, frame))
  /** `bounds`: per victim, the way it left or entered the viewport according to the culprit that is consistent with it. */
  const toVictims = (explained?: ShiftVictim['explained'][], bounds?: (Bound | undefined)[]): ShiftVictim[] =>
    victims.map((victim, index) => {
      const bound = bounds?.[index]
      return {
        node: victim.source.node,
        previousRect: victim.source.previousRect,
        currentRect: victim.source.currentRect,
        dx: Math.round(victim.dx * 100) / 100,
        dy: Math.round((victim.known === 'exact' ? victim.dy : bound === undefined ? 0 : bound.sign * bound.min) * 100) / 100,
        ...(victim.viewport === undefined ? {} : { viewport: victim.viewport }),
        ...(victim.known === 'exact' ? {} : { distance: bound === undefined ? ('unknown' as const) : ('at-least' as const) }),
        explained: explained?.[index] ?? 'no',
      }
    })
  const base = { entries: [entry.index], startTime: entry.startTime, endTime: entry.startTime, value: entry.value }
  const moves = victims.slice(0, 3).map((victim) => describeMove(victim))

  if (entry.hadRecentInput) {
    return {
      ...base, cause: 'unknown', confidence: 0, geometricMatch: false, victims: toVictims(), scored: false, excluded: 'recent-input',
      evidence: [`within 500 ms of user input (last input at ${fmt(entry.lastInputTime)} ms): an expected shift, not counted`, ...moves],
    } // prettier-ignore
  }
  if (entry.selfInduced !== undefined) {
    return {
      ...base, cause: 'dev-artifact', confidence: 1, geometricMatch: false, victims: toVictims(), scored: false, excluded: 'self-induced',
      trigger: { kind: 'self', detail: entry.selfInduced.reason, t: entry.selfInduced.markedAt },
      evidence: [`caused by primp itself: "${entry.selfInduced.reason}" at ${fmt(entry.selfInduced.markedAt)} ms`, ...moves],
    } // prettier-ignore
  }

  const moved = victims.filter((victim) => victim.moved)
  const movedIndex = victims.map((victim, index) => (victim.moved ? index : -1)).filter((index) => index !== -1)
  /** Per-victim verdicts of the moved victims, spread back over all victims. */
  const spread = (explained: ShiftVictim['explained'][]): ShiftVictim['explained'][] => {
    const all: ShiftVictim['explained'][] = victims.map(() => 'no')
    movedIndex.forEach((victimIndex, index) => (all[victimIndex] = explained[index] ?? 'no'))
    return all
  }
  const weight = moved.reduce((sum, victim) => sum + victim.weight, 0)
  const candidates = candidatesFor(recording, entry, previous, next)
  const mutations = recording.mutations.filter((m) => m.t >= entry.startTime - MUTATION_LEAD_MS && m.t <= entry.deliveredAt + 2)
  const victimUids = new Set(victims.map((victim) => victim.source.node?.uid).filter((uid) => uid !== undefined))
  const victimPaths = victims.map((victim) => victim.source.node?.path ?? []).filter((path) => path.length > 0)
  // What moved, and what is inside something that moved, was carried along: a consequence, not a cause.
  const eligible = candidates.filter(
    (candidate) => !victimUids.has(candidate.node.uid) && !victimPaths.some((path) => isAncestorPath(path, candidate.node.path)),
  )
  const reasons = new Map<Candidate, boolean>()
  const matcher: Matcher = {
    candidates,
    eligible,
    hasReason(candidate) {
      let known = reasons.get(candidate)
      if (known === undefined) {
        const inIt = (node: NodeDescriptor): boolean => node.uid === candidate.node.uid || isAncestorPath(candidate.node.path, node.path)
        known = candidates.some((other) => isOrigin(other) && inIt(other.node)) || mutations.some((m) => inIt(m.node) || m.parent?.uid === candidate.node.uid)
        reasons.set(candidate, known)
      }
      return known
    },
  }
  const scored = weight === 0 ? [] : eligible.map((candidate) => score(candidate, moved, weight, matcher))
  const single = pickBest(scored)
  // Only when one element does not account for (nearly) everything is a group of them considered.
  const carried = candidates.filter((candidate) => victimUids.has(candidate.node.uid))
  const best = weight === 0 || (single !== undefined && accounted(single) >= 0.9) ? single : withGroups(single, eligible, carried, moved, weight, matcher)

  // A stylesheet that arrived right before the shift: inserted by script, or a late <link>.
  const styleMutation = mutations.find((m) => m.kind !== 'remove' && (isStyleNode(m.node) || (m.parent !== undefined && isStyleNode(m.parent))))
  const styleIsDev = styleMutation !== undefined && (isDevMutation(styleMutation) || (styleMutation.parent !== undefined && isDevNode(styleMutation.parent)))
  const styleResource = recording.resources
    .filter((resource) => isStylesheetUrl(resource.url) && resource.end >= entry.startTime - STYLESHEET_LEAD_MS && resource.end <= entry.deliveredAt)
    .sort((a, b) => b.end - a.end)[0]
  const styleEvidence: string[] = []
  if (styleMutation !== undefined) {
    styleEvidence.push(`a stylesheet (${nodeLabel(styleMutation.node)}) was ${styleMutation.kind === 'add' ? 'inserted' : 'changed'} at ${fmt(styleMutation.t)} ms, right before the shift`)
    if (styleIsDev) styleEvidence.push('it was injected by the dev server client; a production build ships this CSS in the document')
  } else if (styleResource !== undefined) {
    styleEvidence.push(`stylesheet ${styleResource.url} finished loading at ${fmt(styleResource.end)} ms, right before the shift`)
  }
  const devArtifact = { cause: 'dev-artifact' as const, scored: false, excluded: 'dev-artifact' as const }

  // The culprit's own change of size must account for half of the moved area. Content inside it counts
  // when an element in it that is large enough to be why it changed size accounts for that content's
  // distance (an image in a card: the card pushes the next row, the image pushes the text of the card).
  if (best === undefined || accounted(best) + best.innerDirect < 0.5) {
    // Nothing that changed size explains the movement. Something that was taken away might.
    // A victim that was pulled up into the viewport needed at least the distance to the bottom edge.
    const byRemoval = (victim: Victim, height: number): boolean =>
      victim.known === 'exact'
        ? Math.abs(victim.dx) < MOVE_MIN && amountMatches(victim.dy, -height, 0)
        : victim.viewport === 'in' && !outOfFlow(victim.source.style) && victim.bounds.some((bound) => bound.sign === -1 && height >= bound.min - 1.5)
    const removed = mutations
      .filter((m) => m.kind === 'remove' && m.lastSize !== undefined && m.lastSize.h > 0)
      .map((m) => ({
        mutation: m,
        share: weight === 0 ? 0 : moved.filter((victim) => byRemoval(victim, m.lastSize?.h ?? 0)).reduce((sum, victim) => sum + victim.weight, 0) / weight,
      }))
      .sort((a, b) => b.share - a.share)[0]
    if (removed !== undefined && removed.share >= 0.5 && removed.mutation.lastSize !== undefined) {
      const gone = removed.mutation
      const lastSize = removed.mutation.lastSize
      return {
        ...base,
        // Removed content has no cause class of its own; the element and the reason are named in the evidence.
        cause: 'unknown',
        confidence: 0.6,
        geometricMatch: true,
        culprit: { node: gone.node, sizeBefore: lastSize, sizeAfter: { w: 0, h: 0 } },
        trigger: { kind: 'mutation', stack: callerStack(gone.stack), t: gone.t, detail: 'node removed' },
        victims: toVictims(
          spread(moved.map((victim) => (byRemoval(victim, lastSize.h) ? (victim.known === 'exact' ? 'direct' : 'consistent') : 'no'))),
          victims.map((victim) => (victim.known !== 'exact' && byRemoval(victim, lastSize.h) ? victim.bounds.find((bound) => bound.sign === -1) : undefined)),
        ),
        evidence: [
          `${nodeLabel(gone.node)} (${size(lastSize)}) was removed from ${nodeLabel(gone.parent ?? null)} at ${fmt(gone.t)} ms, after the page had painted`,
          ...moved.filter((victim) => victim.known === 'exact' && byRemoval(victim, lastSize.h)).slice(0, 1).map((victim) => `${describeMove(victim)}: the height of the removed element`),
          `${Math.round(removed.share * 100)}% of the moved area is explained by the removal`,
        ],
        scored: true,
      }
    }

    const evidence = [...moves, ...styleEvidence]
    if (candidates.length === 0) evidence.push('no tracked element changed size in that frame')
    else evidence.push(`${candidates.length} element(s) changed size in that frame, but none accounts for the movement`)
    if (styleIsDev) return { ...base, ...devArtifact, confidence: 0.6, geometricMatch: false, victims: toVictims(), evidence }
    return { ...base, cause: 'unknown', confidence: 0.2, geometricMatch: false, victims: toVictims(), scored: true, evidence }
  }

  const classified = classify(recording, entry, best.candidate, candidates, mutations)
  // The classifier may have moved from a container to the node that was put into it: the geometry is the container's.
  const explained = spread(best.explained)
  const bounds = victims.map((victim, index) => (explained[index] === 'consistent' ? consistentWith(best.candidate, victim, matcher) : undefined))
  const share = Math.min(1, total(best))
  const indirect = best.partners.length > 0 || classified.indirect === true
  // No victim's distance was measured: every one of them left (or entered) the viewport, and the
  // culprit is the one change that was large enough. That stands only with independent evidence.
  const boundOnly = best.direct === 0 && best.innerDirect === 0
  let confidence = CONFIDENT + 0.15 * share + (classified.corroborated ? 0.1 : 0) - (indirect || boundOnly ? INDIRECT_PENALTY : 0)
  if (!classified.specific || (boundOnly && !classified.corroborated)) confidence = Math.min(confidence, 0.6)
  confidence = Math.round(Math.min(0.97, confidence) * 100) / 100

  const evidence = [...classified.evidence]
  const directVictim = moved.find((_, index) => best.explained[index] === 'direct')
  if (best.partners.length > 0) {
    evidence.push(
      `${best.partners.map((partner) => `${nodeLabel(partner.node)} (${size(partner.record.before)} to ${size(partner.record.after)})`).join(' and ')} changed size in the same frame; ` +
        `together with ${nodeLabel(best.candidate.node)} they account for how far the content below moved`,
    )
  } else if (directVictim !== undefined) {
    evidence.push(`${describeMove(directVictim)}: the same distance, and ${nodeLabel(best.candidate.node)} is right before it`)
  }
  const boundedIndex = victims.findIndex((_, index) => bounds[index] !== undefined)
  const boundedVictim = victims[boundedIndex]
  if (boundedVictim !== undefined) {
    const grew = best.candidate.dh
    evidence.push(
      `${describeMove(boundedVictim, bounds[boundedIndex])}: ${nodeLabel(best.candidate.node)}, before it, ${grew > 0 ? 'grew' : 'shrank'} by ${fmt(Math.abs(grew))}px, ` +
        `and nothing else that changed size in that frame could have moved it that far`,
    )
  }
  if (best.innerDirect > 0) {
    for (const [index, victim] of moved.entries()) {
      const inner = best.explained[index] === 'inside' ? innerExplainer(best.candidate, victim, matcher) : undefined
      if (inner === undefined) continue
      evidence.push(`${describeMove(victim)}: inside ${nodeLabel(best.candidate.node)}, by the distance ${nodeLabel(inner.node)} ${inner.dh > 0 || inner.dw > 0 ? 'grew' : 'shrank'}`)
      break
    }
  }
  const unexplained = moved.filter((_, index) => best.explained[index] === 'no').length
  evidence.push(
    `${Math.round(best.direct * 100)}% of the moved area is explained directly` +
      (best.bounded > 0 ? `, ${Math.round(best.bounded * 100)}% left or entered the visible area as the culprit's change of size requires` : '') +
      (best.inside > 0 ? `, ${Math.round(best.inside * 100)}% is content inside the culprit` : '') +
      (unexplained > 0 ? `; ${unexplained} moved box(es) are not explained` : ''),
  )
  const coCulprits = best.partners.map(toCulprit)
  const issue: EntryIssue = {
    ...base,
    cause: classified.cause,
    confidence,
    geometricMatch: true,
    culprit: toCulprit(classified.culprit),
    ...(coCulprits.length > 0 ? { coCulprits } : {}),
    trigger: classified.trigger,
    victims: toVictims(explained, bounds),
    evidence,
    scored: true,
  }
  if (classified.cause === 'dev-artifact') return { ...issue, ...devArtifact }
  // Explanations that a change of CSS would produce just as well: an element whose size changed for no
  // recorded reason, one that got its box without being inserted, media that resized without loading.
  const styleDependent = !classified.specific || classified.viaStyle === true || (classified.cause === 'unsized-media' && !classified.corroborated)
  if (styleDependent && styleEvidence.length > 0) {
    issue.evidence.push(...styleEvidence)
    if (styleIsDev) {
      // The dev server's client rewrote a stylesheet in the open page (first injection, or a hot update).
      return { ...issue, ...devArtifact, confidence: Math.max(confidence, 0.75), trigger: { kind: 'mutation', stack: callerStack(styleMutation?.stack), t: styleMutation?.t, detail: 'stylesheet injected by the dev server client' } }
    }
    if (classified.viaStyle === true && !classified.corroborated) {
      // Shown by nothing on record, right after a stylesheet arrived: late CSS, which has no cause class.
      return { ...issue, cause: 'unknown', confidence: Math.min(confidence, 0.6), trigger: undefined }
    }
  }
  return issue
}

/** Entries of the same culprit in quick succession are one issue: an animation, or an image that arrives in two steps. */
function cluster(issues: EntryIssue[]): EntryIssue[] {
  const merged: EntryIssue[] = []
  for (const issue of issues) {
    const last = merged[merged.length - 1]
    const sameCulprit =
      last !== undefined &&
      last.excluded === issue.excluded &&
      last.culprit !== undefined &&
      last.culprit.node.uid === issue.culprit?.node.uid &&
      // The same element for two different, established reasons stays two issues.
      (last.cause === issue.cause || last.cause === 'unknown' || issue.cause === 'unknown') &&
      issue.startTime - last.endTime <= CLUSTER_GAP_MS
    if (last === undefined || !sameCulprit) {
      merged.push({ ...issue, entries: [...issue.entries], evidence: [...issue.evidence] })
      continue
    }
    last.entries.push(...issue.entries)
    last.endTime = issue.endTime
    last.value += issue.value
    if (issue.confidence > last.confidence) {
      // The better-founded frame speaks for the group.
      last.confidence = issue.confidence
      last.cause = issue.cause
      last.trigger = issue.trigger
      last.evidence = [...issue.evidence]
    }
    last.scored = last.scored && issue.scored
    last.geometricMatch = last.geometricMatch || issue.geometricMatch
    if (issue.culprit !== undefined && last.culprit !== undefined) last.culprit.sizeAfter = issue.culprit.sizeAfter
    const seen = new Set(last.victims.map((victim) => victim.node?.uid))
    for (const victim of issue.victims) if (!seen.has(victim.node?.uid)) last.victims.push(victim)
  }
  for (const issue of merged) {
    if (issue.entries.length > 1) issue.evidence.push(`${issue.entries.length} layout-shift entries over ${fmt(issue.endTime - issue.startTime)} ms belong to this change`)
  }
  return merged
}

/**
 * Attributes every layout shift of a recording.
 *
 * `status` is `ok` only when the recording is a valid measurement; with
 * `tab_hidden` or `not_measurable` the issues that were seen are still listed,
 * but `cls` is null and an empty list proves nothing.
 */
export function attributeShifts(recording: ShiftRecording): ShiftReport {
  const validity = shiftValidity(recording)
  const notes: string[] = []
  const dropped = recording.dropped
  if (dropped.shifts + dropped.resizes + dropped.mutations > 0) {
    notes.push(`evidence buffers overflowed (shifts ${dropped.shifts}, resizes ${dropped.resizes}, mutations ${dropped.mutations}); early entries may lack a culprit`)
  }
  if (recording.cost.untracked > 0) {
    notes.push(`${recording.cost.untracked} elements beyond the first ${recording.cost.tracked} were not size-tracked; a culprit among them cannot be found`)
  }
  if (recording.scrolls.length > 0 || recording.scroll.y !== 0) notes.push('the page was scrolled during the measurement')
  if (recording.viewportChanges.length > 0) notes.push('the viewport was resized during the measurement')
  const cachedResources = cachedResourcesOf(recording)
  if (cachedResources.length > 0) {
    notes.push(`${cachedResources.length} resource(s) came from a cache, so this was not a cold load: ${cachedResources.slice(0, 3).join(', ')}${cachedResources.length > 3 ? ', ...' : ''}`)
  }

  const entries = [...recording.shifts].sort((a, b) => a.startTime - b.startTime)
  const perEntry = entries.map((entry, index) => attributeEntry(recording, entry, entries[index - 1], entries[index + 1]))
  const clustered = cluster(perEntry)

  const scoredEntries = entries.filter((entry) => perEntry.find((issue) => issue.entries[0] === entry.index)?.scored === true)
  const windows = sessionWindows(scoredEntries)
  const windowOf = (entryIndex: number | undefined): number | undefined => {
    const found = windows.findIndex((window) => entryIndex !== undefined && window.entries.includes(entryIndex))
    return found === -1 ? undefined : found
  }
  const issues: ShiftIssue[] = clustered
    .map((issue, index) => ({ ...issue, id: `shift-${index + 1}`, ...(issue.scored ? { window: windowOf(issue.entries[0]) } : {}) }))
    .sort((a, b) => Number(b.scored) - Number(a.scored) || b.value - a.value)

  return {
    status: validity.status,
    ...(validity.reason === undefined ? {} : { reason: validity.reason }),
    cls: validity.status === 'ok' ? cumulativeLayoutShift(windows) : null,
    windows,
    issues,
    cachedResources,
    notes,
  }
}

/**
 * Same-origin resources the page received without any transfer: cache hits. A load with any of
 * them was not cold, and a late image or font may have been there at once. (A cross-origin
 * resource reports 0 too unless it sends Timing-Allow-Origin, so those cannot be judged.)
 */
export function cachedResourcesOf(recording: ShiftRecording): string[] {
  const origin = /^[a-z]+:\/\/[^/]+/i.exec(recording.url)?.[0]
  if (origin === undefined) return []
  return recording.resources
    .filter((resource) => resource.transferSize === 0 && resource.url.startsWith(origin + '/') && !resource.url.includes('/__primp/'))
    .map((resource) => resource.url.slice(origin.length))
}
