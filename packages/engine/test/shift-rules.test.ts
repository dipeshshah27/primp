import { describe, expect, it } from 'vitest'
import {
  ShiftRecordingSchema,
  ShiftReportSchema,
  type FontRecord,
  type MediaEvent,
  type NodeDescriptor,
  type ResizeRecord,
  type ResourceRecord,
  type ShiftEntry,
  type ShiftIssue,
  type ShiftMutationRecord,
  type ShiftRecording,
  type ShiftRect,
  type ShiftSource,
} from '../../protocol/src/shift.ts'
import { renderPrompt } from '../src/prompt.ts'
import { attributeShifts, callerFrames, CONFIDENT } from '../src/shift-attributor.ts'

/**
 * The rules added after the first run on the held-out pages (2026-11-21), each on a small
 * recording written by hand, so that one rule is under test at a time:
 *
 *   1. who made a DOM call: the first frame of its stack that is not primp's own;
 *   2. victims that left or entered the viewport: their rectangles are clipped, not moved;
 *   3. a font swap of text INSIDE the element that grew;
 * and the two that the second one exposed: a wrapper that only "appeared" because the image in it
 * loaded, and a container whose content was moved by the element inside it that made it grow.
 *
 * The page of every recording: 1280x800, `<body>` at path [1]. T is the frame of the shift.
 */

const T = 800
const ARIAL = 'Arial, sans-serif'

const rect = (x: number, y: number, width: number, height: number): ShiftRect => ({ x, y, width, height })
const EMPTY = rect(0, 0, 0, 0)

function node(uid: number, tag: string, path: number[], extra: Partial<NodeDescriptor> = {}): NodeDescriptor {
  return { uid, tag, path, selector: extra.id === undefined ? `${tag}-${uid}` : `#${extra.id}`, ...extra }
}

function source(of: NodeDescriptor | null, previousRect: ShiftRect, currentRect: ShiftRect, extra: Partial<ShiftSource> = {}): ShiftSource {
  return { node: of, previousRect, currentRect, style: { position: 'static', display: 'block', fontFamily: ARIAL }, ...extra }
}

function shift(sources: ShiftSource[], extra: Partial<ShiftEntry> = {}): ShiftEntry {
  return { index: 0, value: 0.05, startTime: T, hadRecentInput: false, lastInputTime: 0, sources, visibility: 'visible', deliveredAt: T + 1, ...extra }
}

/** A change of size in the frame of the shift. `at` is the element's viewport rectangle after the change. */
function resize(of: NodeDescriptor, before: [number, number] | null, after: [number, number], at: [number, number], extra: Partial<ResizeRecord> = {}): ResizeRecord {
  return {
    t: T + 0.1,
    node: of,
    before: before === null ? null : { w: before[0], h: before[1] },
    after: { w: after[0], h: after[1] },
    rect: rect(at[0], at[1], after[0], after[1]),
    style: { position: 'static', display: 'block', fontFamily: ARIAL, margin: [0, 0, 0, 0] },
    ...extra,
  }
}

interface Parts {
  shifts: ShiftEntry[]
  resizes?: ResizeRecord[]
  mutations?: ShiftMutationRecord[]
  media?: MediaEvent[]
  fonts?: FontRecord[]
  resources?: ResourceRecord[]
  scroll?: { x: number; y: number }
}

function recording(parts: Parts): ShiftRecording {
  return ShiftRecordingSchema.parse({
    version: 1,
    url: 'http://localhost:4310/page/',
    capturedAt: 3000,
    hookStartedAt: 5,
    supported: true,
    viewport: { width: 1280, height: 800, dpr: 1 },
    viewportChanges: [],
    scroll: parts.scroll ?? { x: 0, y: 0 },
    scrolls: [],
    navigation: { type: 'navigate', domInteractive: 20, domContentLoaded: 20, load: 30, firstPaint: 25, firstContentfulPaint: 25, firstFrame: 22 },
    visibility: { initial: 'visible', atNavigationStart: 'visible', changes: [], prerendered: false, restored: false, visibleThroughout: true },
    shifts: parts.shifts,
    resizes: parts.resizes ?? [],
    mutations: parts.mutations ?? [],
    media: parts.media ?? [],
    resources: parts.resources ?? [],
    fonts: parts.fonts ?? [],
    selfMarks: [],
    dropped: { shifts: 0, resizes: 0, mutations: 0, media: 0, resources: 0 },
    cost: { topLevelMs: 0.4, shiftMs: 0, mutationMs: 0.5, resizeMs: 0.5, otherMs: 0.1, mutationCallbacks: 3, resizeCallbacks: 2, tracked: 40, untracked: 0 },
  })
}

/** The one issue of a recording, checked against the report schema. */
function only(parts: Parts): ShiftIssue {
  const report = attributeShifts(recording(parts))
  expect(() => ShiftReportSchema.parse(report)).not.toThrow()
  expect(report.issues).toHaveLength(1)
  const issue = report.issues[0] as ShiftIssue
  // The rule of the house.
  if (issue.confidence >= CONFIDENT) expect(issue.geometricMatch).toBe(true)
  return issue
}

const text = (issue: ShiftIssue): string => issue.evidence.join('\n')
const named = (issue: ShiftIssue): [string, string | undefined] => [issue.cause, issue.culprit?.node.selector]

const BODY = node(1, 'body', [1])
const MAIN = node(2, 'main', [1, 1], { id: 'main' })

// ---------------------------------------------------------------------------
// 1. Who made the DOM call
// ---------------------------------------------------------------------------

const PAGE_FRAMES = '    at showPromo (http://localhost:4310/page/:205:14)\n    at http://localhost:4310/page/:210:3'
const HOOK = 'http://localhost:4310/__primp/hook.js?v=a06967e3c1c1'

/** A strip inserted between the header and `main` by a script: `main` moves down by its height. */
function inserted(stack: string | undefined, strip: Partial<NodeDescriptor> = {}): Parts {
  const promo = node(10, 'aside', [1, 1], { id: 'promo', ...strip })
  const main = node(2, 'main', [1, 2], { id: 'main' })
  return {
    shifts: [shift([source(main, rect(0, 60, 1280, 740), rect(0, 110, 1280, 690))])],
    resizes: [resize(BODY, [1280, 1600], [1280, 1650], [0, 0]), resize(promo, null, [1280, 50], [0, 60])],
    mutations: [{ t: T - 8, kind: 'add', node: promo, parent: BODY, ...(stack === undefined ? {} : { stack }) }],
  }
}

describe('1. a DOM call belongs to the first frame of its stack that is not primp\'s own', () => {
  it.each([
    ['insertAdjacentHTML as the hook recorded it before 2026-11-21', `    at e.<computed> [as insertAdjacentHTML] (${HOOK}:3:111)\n${PAGE_FRAMES}`],
    ['a property setter', `    at HTMLElement.set [as innerHTML] (${HOOK}:3:400)\n${PAGE_FRAMES}`],
    ['an anonymous wrapper, no parentheses', `    at ${HOOK}:3:95\n${PAGE_FRAMES}`],
    ['two frames of the hook', `    at capture (${HOOK}:3:50)\n    at Element.<anonymous> (${HOOK}:3:111)\n${PAGE_FRAMES}`],
    ['a wrapper called by the browser on behalf of the page', `    at Node.appendChild (${HOOK}:3:111)\n    at Array.forEach (<anonymous>)\n${PAGE_FRAMES}`],
    ['no frame of primp at all (a hook that drops its own frames)', PAGE_FRAMES],
  ])('%s: the page inserted the node, and the shift counts', (_name, stack) => {
    const issue = only(inserted(stack))
    expect(named(issue)).toEqual(['injected-content', '#promo'])
    expect(issue).toMatchObject({ scored: true, geometricMatch: true })
    expect(issue.excluded).toBeUndefined()
    expect(issue.confidence).toBeGreaterThanOrEqual(CONFIDENT)
    // What is handed on (to the source resolver, to the dock) starts at the page's statement.
    expect(issue.trigger?.stack?.split('\n')[0]).toBe('    at showPromo (http://localhost:4310/page/:205:14)')
    expect(issue.trigger?.stack).not.toContain('/__primp/')
    expect(attributeShifts(recording(inserted(stack))).cls).toBeCloseTo(0.05, 12)
  })

  it.each([
    ['the dev client called', '    at updateStyle (http://localhost:4310/@vite/client:412:9)\n    at http://localhost:4310/src/app.css:3:1'],
    ['the dev client called, under a frame of the hook', `    at e.<computed> [as insertAdjacentHTML] (${HOOK}:3:111)\n    at updateStyle (http://localhost:4310/@vite/client:412:9)`],
  ])('%s: development tooling, not scored', (_name, stack) => {
    const issue = only(inserted(stack))
    expect(issue).toMatchObject({ cause: 'dev-artifact', excluded: 'dev-artifact', scored: false })
    expect(attributeShifts(recording(inserted(stack))).cls).toBe(0)
  })

  it('a page script that calls through the dev client is not development tooling: only the caller counts', () => {
    const issue = only(inserted(`${PAGE_FRAMES}\n    at http://localhost:4310/@vite/client:90:3`))
    expect(named(issue)).toEqual(['injected-content', '#promo'])
  })

  it('a stack of primp\'s frames only says nothing about the caller: the node is the page\'s', () => {
    const issue = only(inserted(`    at e.<computed> [as insertAdjacentHTML] (${HOOK}:3:111)`))
    expect(named(issue)).toEqual(['injected-content', '#promo'])
    expect(issue.scored).toBe(true)
    expect(issue.trigger?.stack).toBeUndefined()
  })

  it('no stack at all (a hook built without stack capture): the page\'s', () => {
    expect(named(only(inserted(undefined)))).toEqual(['injected-content', '#promo'])
  })

  it('a node that is development tooling by itself stays so, whoever inserted it', () => {
    const issue = only(inserted(PAGE_FRAMES, { tag: 'vite-error-overlay' }))
    expect(issue).toMatchObject({ cause: 'dev-artifact', scored: false })
  })

  it('callerFrames: primp\'s frames on top and frames without a script are dropped', () => {
    expect(callerFrames(undefined)).toEqual([])
    expect(callerFrames('')).toEqual([])
    expect(callerFrames(`    at e.<computed> [as insertAdjacentHTML] (${HOOK}:3:111)\n    at Array.forEach (<anonymous>)\n${PAGE_FRAMES}`)).toEqual(PAGE_FRAMES.split('\n'))
    // Only the frames on top: a frame of primp further down is part of the caller's story.
    expect(callerFrames(`${PAGE_FRAMES}\n    at boot (${HOOK}:3:9)`)).toHaveLength(3)
    // Firefox and Safari write frames as name@url.
    expect(callerFrames(`wrap/proto[name]@${HOOK}:3:111\nshowPromo@http://localhost:4310/page/:205:14`)).toEqual(['showPromo@http://localhost:4310/page/:205:14'])
  })
})

// ---------------------------------------------------------------------------
// 2. Victims that left or entered the viewport
// ---------------------------------------------------------------------------

const HERO = node(20, 'img', [1, 1, 0], { id: 'hero', attrs: { src: '/hero.png' } })
const DETAILS = node(21, 'section', [1, 1, 1], { id: 'details' })
const INTRO = node(22, 'section', [1, 1, 2], { id: 'intro' })

const LOADED: MediaEvent = { t: T - 2, event: 'load', node: HERO, url: 'http://localhost:4310/hero.png', natural: { w: 1280, h: 600 } }
const MEDIA_HINTS = { widthAttr: false, heightAttr: false, cssWidth: 'auto', cssHeight: 'auto', aspectRatio: 'auto' }

/**
 * An image at y=300 goes from no height to `grow` px; `#details` right under it was visible from
 * y=300 to the bottom edge and ends below the viewport when `grow` is 500 or more.
 * `box`: what a hook that measures the box itself would have recorded for `#details`.
 */
function pushedOut(grow: number, options: { box?: ShiftRect; media?: MediaEvent[]; extraSources?: ShiftSource[]; extraResizes?: ResizeRecord[]; mainGrows?: boolean } = {}): Parts {
  return {
    shifts: [shift([source(DETAILS, rect(0, 300, 1280, 500), EMPTY, options.box === undefined ? {} : { rect: options.box }), ...(options.extraSources ?? [])])],
    resizes: [
      resize(BODY, [1280, 2000], [1280, 2000 + grow], [0, 0]),
      ...(options.mainGrows === false ? [] : [resize(MAIN, [1280, 1900], [1280, 1900 + grow], [0, 100])]),
      resize(HERO, [1280, 0], [1280, grow], [0, 300], { media: MEDIA_HINTS }),
      ...(options.extraResizes ?? []),
    ],
    media: options.media ?? [LOADED],
  }
}

describe('2. a victim that left the viewport has no second rectangle: its distance is measured, bounded or unknown, never read off the empty one', () => {
  it('with the box the hook measured: the exact distance, matched like any other', () => {
    const issue = only(pushedOut(600, { box: rect(0, 900, 1280, 700) }))
    expect(named(issue)).toEqual(['unsized-media', '#hero'])
    expect(issue.confidence).toBeGreaterThanOrEqual(0.9)
    expect(issue.victims[0]).toMatchObject({ dx: 0, dy: 600, viewport: 'out', explained: 'direct' })
    expect(issue.victims[0]?.distance).toBeUndefined()
    expect(text(issue)).toMatch(/section#details was pushed down 600px, below the visible area: the same distance, and img#hero is right before it/)
    expect(text(issue)).not.toMatch(/moved (up|left)|px (up|left)|and left/)
  })

  it('with the measured box, an element that grew by another amount is not the culprit, however large', () => {
    // The box says 600px; the image grew 700px. A bound ("at least 500px") would have let it pass.
    const issue = only(pushedOut(700, { box: rect(0, 900, 1280, 700) }))
    expect(issue.culprit).toBeUndefined()
    expect(issue).toMatchObject({ cause: 'unknown', geometricMatch: false })
    expect(issue.confidence).toBeLessThan(CONFIDENT)
    expect(text(issue)).toMatch(/section#details was pushed down 600px, below the visible area/)
  })

  it('without the box (an older hook): consistent with the one element above it that grew by at least the distance to the edge', () => {
    const issue = only(pushedOut(600))
    expect(named(issue)).toEqual(['unsized-media', '#hero'])
    expect(issue.geometricMatch).toBe(true)
    expect(issue.victims[0]).toMatchObject({ dx: 0, dy: 500, viewport: 'out', distance: 'at-least', explained: 'consistent' })
    // Confident, because the load event of the image is on record, but less so than a measured distance.
    expect(issue.confidence).toBeGreaterThanOrEqual(CONFIDENT)
    expect(issue.confidence).toBeLessThan(only(pushedOut(600, { box: rect(0, 900, 1280, 700) })).confidence)
    expect(text(issue)).toMatch(/section#details was pushed below the visible area \(at least 500px down\): img#hero, before it, grew by 600px/)
    expect(text(issue)).not.toMatch(/moved (up|left)|px (up|left)|and left/)
  })

  it('without the box and without independent evidence (no load event): the element is named, but not with confidence', () => {
    const issue = only(pushedOut(600, { media: [] }))
    expect(issue.culprit?.node.selector).toBe('#hero')
    expect(issue.confidence).toBeLessThan(CONFIDENT)
  })

  it('an element that grew by less than the distance to the edge cannot have pushed it out: no culprit, and no "moved up and left"', () => {
    const issue = only(pushedOut(200))
    expect(issue.culprit).toBeUndefined()
    expect(issue).toMatchObject({ cause: 'unknown', geometricMatch: false, scored: true })
    expect(issue.confidence).toBeLessThan(CONFIDENT)
    expect(issue.victims[0]).toMatchObject({ dx: 0, dy: 0, viewport: 'out', distance: 'unknown', explained: 'no' })
    expect(text(issue)).toMatch(/section#details left the visible area/)
    expect(text(issue)).not.toMatch(/moved (up|left)|px (up|left)|and left|300px/)
  })

  it('two unrelated elements that could each have pushed it out: neither is named', () => {
    const banner = node(30, 'aside', [1, 0], { id: 'banner' })
    const parts = pushedOut(600, { extraResizes: [resize(banner, null, [1280, 550], [0, 0])] })
    parts.mutations = [{ t: T - 5, kind: 'add', node: banner, parent: BODY }]
    const issue = only(parts)
    expect(issue.culprit).toBeUndefined()
    expect(issue.confidence).toBeLessThan(CONFIDENT)
  })

  it('a second element that only stretched along, with no reason of its own, is not a rival', () => {
    // The neighbouring card of a grid row grows with the row: nothing was inserted into it, it holds
    // no media, no DOM change touched it. A plain box that grew is a consequence, not a second cause.
    const neighbour = node(31, 'article', [1, 1, 3], { id: 'neighbour' })
    const plain = only(pushedOut(600, { extraResizes: [resize(neighbour, [300, 10], [300, 610], [900, 290])] }))
    expect(named(plain)).toEqual(['unsized-media', '#hero'])
    // The same box, but it had no height before: it "appeared", which is a reason of its own. A rival.
    const appeared = only(pushedOut(600, { extraResizes: [resize(neighbour, [300, 0], [300, 600], [900, 300])] }))
    expect(appeared.culprit).toBeUndefined()
  })

  it('growth that did not reach the victim (no element around both grew) pushed nothing', () => {
    // <main> has no record (not size-tracked, say), but <body>, which is around both, grew: the growth got out.
    expect(only(pushedOut(600, { mainGrows: false })).culprit?.node.selector).toBe('#hero')
    // Nothing around both grew: the image grew inside a box of fixed height.
    const parts = pushedOut(600, { mainGrows: false })
    parts.resizes = (parts.resizes ?? []).filter((record) => record.node.uid !== BODY.uid)
    const contained = only(parts)
    expect(contained.culprit).toBeUndefined()
    expect(contained.confidence).toBeLessThan(CONFIDENT)
  })

  it('an element around the victim is not "before" it: at most the victim is content inside it', () => {
    const parts = pushedOut(600)
    // Only <main> and <body> grew; the image did not.
    parts.resizes = (parts.resizes ?? []).filter((record) => record.node.uid !== HERO.uid)
    const issue = only(parts)
    expect(issue.culprit).toBeUndefined()
    expect(issue.victims[0]?.explained).toBe('no')
  })

  it('an element that starts above the victim but reached below it before the shift is beside it, not before it', () => {
    const sidebar = node(32, 'aside', [1, 0], { id: 'sidebar' })
    const parts: Parts = {
      shifts: [shift([source(DETAILS, rect(300, 300, 980, 500), EMPTY)])],
      resizes: [resize(BODY, [1280, 2000], [1280, 2600], [0, 0]), resize(sidebar, [300, 700], [300, 1300], [0, 100])],
      mutations: [{ t: T - 5, kind: 'text', node: sidebar }],
    }
    expect(only(parts).culprit).toBeUndefined()
  })

  it('an element in another column is not before the victim', () => {
    // The image sits in a 300px column on the left; #details is in the column beside it.
    const parts: Parts = {
      shifts: [shift([source(DETAILS, rect(320, 300, 960, 500), EMPTY)])],
      resizes: [resize(BODY, [1280, 2000], [1280, 2600], [0, 0]), resize(MAIN, [1280, 1900], [1280, 2500], [0, 100]), resize(HERO, [300, 0], [300, 600], [0, 300], { media: MEDIA_HINTS })],
      media: [LOADED],
    }
    expect(only(parts).culprit).toBeUndefined()
    // In the same column it is.
    ;(parts.shifts[0] as ShiftEntry).sources = [source(DETAILS, rect(0, 300, 300, 500), EMPTY)]
    expect(only(parts).culprit?.node.selector).toBe('#hero')
  })

  it('a removed element pulls what was below the fold into the viewport: consistent with the removal, never confident', () => {
    const notice = node(41, 'div', [], { id: 'notice' })
    const parts: Parts = {
      shifts: [shift([source(DETAILS, EMPTY, rect(0, 740, 1280, 60)), source(INTRO, rect(0, 400, 1280, 300), rect(0, 320, 1280, 300))])],
      mutations: [{ t: T - 4, kind: 'remove', node: notice, parent: BODY, lastSize: { w: 1280, h: 80 } }],
    }
    const issue = only(parts)
    expect(issue.culprit?.node.selector).toBe('#notice')
    expect(issue.confidence).toBeLessThan(CONFIDENT)
    expect(issue.victims.map((victim) => [victim.explained, victim.dy])).toEqual([
      ['consistent', -60],
      ['direct', -80],
    ])
    expect(issue.victims[0]).toMatchObject({ viewport: 'in', distance: 'at-least' })
    expect(text(issue)).toMatch(/section#intro moved up 80px: the height of the removed element/)
  })

  it('an absolutely positioned victim is not pushed by what grows above it', () => {
    const parts = pushedOut(600)
    ;(parts.shifts[0] as ShiftEntry).sources = [source(DETAILS, rect(0, 300, 1280, 500), EMPTY, { style: { position: 'absolute', display: 'block' } })]
    expect(only(parts).culprit).toBeUndefined()
  })

  it('a measured box that contradicts the browser\'s rectangle is not used (the page changed again before it was read)', () => {
    // currentRect is empty, but the box is in the middle of the viewport: fall back to the bound.
    const issue = only(pushedOut(600, { box: rect(0, 350, 1280, 500) }))
    expect(issue.victims[0]).toMatchObject({ viewport: 'out', distance: 'at-least', explained: 'consistent' })
  })

  it('victims with two full rectangles give the exact distance; one that left the viewport joins them when it is consistent', () => {
    // The image is at y=100 here. #intro, under it, stays visible and its rectangles say 600px: what the image grew.
    const intro = source(INTRO, rect(0, 100, 600, 150), rect(0, 700, 600, 100))
    const parts = pushedOut(600, { extraSources: [intro] })
    ;(parts.resizes ?? []).splice(2, 1, resize(HERO, [1280, 0], [1280, 600], [0, 100], { media: MEDIA_HINTS }))
    const issue = only(parts)
    expect(named(issue)).toEqual(['unsized-media', '#hero'])
    expect(issue.victims.map((victim) => victim.explained)).toEqual(['consistent', 'direct'])
    expect(issue.confidence).toBeGreaterThanOrEqual(0.9)
    expect(text(issue)).toMatch(/section#intro moved down 600px: the same distance/)
  })

  it('an exact victim that contradicts the element is not outvoted by one that left the viewport', () => {
    // #intro moved 80px; the image grew 600px. The bounded victim is the larger one, and it is consistent.
    const intro = source(INTRO, rect(0, 600, 1280, 30), rect(0, 680, 1280, 30))
    const issue = only(pushedOut(600, { extraSources: [intro] }))
    expect(issue.victims.map((victim) => victim.explained)).toEqual(['consistent', 'no'])
    // Half or more of the area is accounted for, so the image is named; the unexplained box is in the evidence.
    expect(issue.culprit?.node.selector).toBe('#hero')
    expect(text(issue)).toMatch(/1 moved box\(es\) are not explained/)
  })

  it('a victim that came into the viewport: pulled up by an element above it that shrank by at least the distance to the edge', () => {
    const panel = node(40, 'div', [1, 1, 0], { id: 'panel' })
    const parts: Parts = {
      shifts: [shift([source(DETAILS, EMPTY, rect(0, 500, 1280, 300))])],
      resizes: [resize(BODY, [1280, 2000], [1280, 1600], [0, 0]), resize(MAIN, [1280, 1900], [1280, 1500], [0, 100]), resize(panel, [1280, 500], [1280, 100], [0, 300])],
      mutations: [{ t: T - 4, kind: 'text', node: panel }],
    }
    const issue = only(parts)
    expect(named(issue)).toEqual(['injected-content', '#panel'])
    expect(issue.victims[0]).toMatchObject({ dy: -300, viewport: 'in', distance: 'at-least', explained: 'consistent' })
    expect(text(issue)).toMatch(/section#details was pulled up into the visible area \(at least 300px\)/)
  })

  it('a victim that came into the viewport for no reason on record: said so, in words', () => {
    const issue = only({ shifts: [shift([source(DETAILS, EMPTY, rect(0, 500, 1280, 300))])] })
    expect(issue.culprit).toBeUndefined()
    expect(issue.victims[0]).toMatchObject({ dx: 0, dy: 0, viewport: 'in', distance: 'unknown' })
    expect(text(issue)).toMatch(/section#details came into the visible area/)
  })

  it('a current rectangle cut by the top edge: the measured box gives the distance the rectangle hides', () => {
    // #details moved up 400px, from y=300 to y=-100; the browser's rectangle starts at 0.
    const panel = node(40, 'div', [1, 1, 0], { id: 'panel' })
    const cut = (box: ShiftRect | undefined): Parts => ({
      shifts: [shift([source(DETAILS, rect(0, 300, 1280, 500), rect(0, 0, 1280, 600), box === undefined ? {} : { rect: box })])],
      resizes: [resize(BODY, [1280, 2000], [1280, 1600], [0, -500]), resize(MAIN, [1280, 1900], [1280, 1500], [0, -400]), resize(panel, [1280, 500], [1280, 100], [0, -200])],
      mutations: [{ t: T - 4, kind: 'text', node: panel }],
    })
    const measured = only(cut(rect(0, -100, 1280, 700)))
    expect(measured.culprit?.node.selector).toBe('#panel')
    expect(measured.victims[0]).toMatchObject({ dy: -400, viewport: 'cut', explained: 'direct' })
    // Without the box the rectangles say 300px, which nothing accounts for: no culprit.
    expect(only(cut(undefined)).culprit).toBeUndefined()
  })

  it('on a scrolled page a previous rectangle at the top edge may be cut: its distance is a bound even with the box', () => {
    const parts = pushedOut(900, { box: rect(0, 900, 1280, 700) })
    ;(parts.shifts[0] as ShiftEntry).sources = [source(DETAILS, rect(0, 0, 1280, 500), EMPTY, { rect: rect(0, 900, 1280, 700) })]
    parts.resizes = [resize(BODY, [1280, 2000], [1280, 2900], [0, -400]), resize(MAIN, [1280, 1900], [1280, 2800], [0, -300]), resize(HERO, [1280, 0], [1280, 900], [0, -100], { media: MEDIA_HINTS })]
    expect(only(parts).victims[0]).toMatchObject({ dy: 900, viewport: 'out', explained: 'direct' })
    expect(only({ ...parts, scroll: { x: 0, y: 400 } }).victims[0]).toMatchObject({ viewport: 'out', distance: 'at-least', explained: 'consistent' })
  })

  it('an anonymous box with an empty rectangle is not "content inside" whatever covers the top-left corner', () => {
    const parts = inserted(PAGE_FRAMES)
    ;(parts.shifts[0] as ShiftEntry).sources.push(source(null, EMPTY, rect(500, 380, 100, 20)), source(null, rect(500, 380, 100, 20), EMPTY))
    const issue = only(parts)
    expect(named(issue)).toEqual(['injected-content', '#promo'])
    expect(issue.victims.map((victim) => victim.explained)).toEqual(['direct', 'no', 'no'])
  })

  it('the hand-off prompt says what happened to such victims, with the distance only when it is known', () => {
    const prompt = (issue: ShiftIssue): string => renderPrompt([], { batchId: 'b', channel: 'mcp' }, { shifts: [issue], includeUncertainShifts: true })
    expect(prompt(only(pushedOut(600, { box: rect(0, 900, 1280, 700) })))).toContain('`#details` 600px down, out of the visible area')
    expect(prompt(only(pushedOut(600)))).toContain('`#details` at least 500px down, out of the visible area')
    expect(prompt(only(pushedOut(200)))).toContain('`#details` moved out of the visible area')
    expect(prompt(only(pushedOut(200)))).not.toMatch(/px up|px left/)
  })
})

// ---------------------------------------------------------------------------
// 3. A font swap of text inside the element that grew
// ---------------------------------------------------------------------------

const WEB = '"Web Sans", Arial, sans-serif'
const HEADER = node(50, 'header', [1, 0], { id: 'site-header' })
const NAV = node(51, 'nav', [1, 0, 1], { id: 'nav' })
const LINK_A = node(52, 'a', [1, 0, 1, 0])
const LINK_B = node(53, 'a', [1, 0, 1, 1])
const LOGO = node(54, 'img', [1, 0, 0], { id: 'logo' })
const CONTENT = node(55, 'main', [1, 1], { id: 'content' })

const FONT_FILE: ResourceRecord = { url: 'http://localhost:4310/fonts/web-sans.woff2', initiator: 'css', start: 30, end: T - 4, transferSize: 9000 }
const loadedNow = (family: string, extra: Partial<FontRecord> = {}): FontRecord => ({ t: T + 0.1, since: 400, event: 'loaded', family, weight: '400', style: 'normal', via: 'snapshot', ...extra })
const web = { style: { position: 'static', display: 'block', fontFamily: WEB, margin: [0, 0, 0, 0] as [number, number, number, number] } }

/**
 * A flex header that grows 60 -> 100 because the links of its `<nav>` wrap onto a second row in the
 * web font; the `<nav>` itself grows 30 -> 76 (the header centres it, so the two differ) and only
 * the header's growth equals the distance the content moved. The header's own font is Arial.
 */
function headerGrew(options: { navFont?: boolean; navResized?: boolean; fonts?: FontRecord[]; resources?: ResourceRecord[]; extraResizes?: ResizeRecord[]; mutations?: ShiftMutationRecord[]; navGrowth?: number } = {}): Parts {
  const family = options.navFont === false ? {} : web
  const nav = 30 + (options.navGrowth ?? 46)
  return {
    shifts: [shift([source(CONTENT, rect(0, 60, 1280, 740), rect(0, 100, 1280, 700))])],
    resizes: [
      resize(BODY, [1280, 2000], [1280, 2040], [0, 0]),
      resize(HEADER, [1280, 60], [1280, 100], [0, 0]),
      ...(options.navResized === false ? [] : [resize(NAV, [600, 30], [600, nav], [200, 12], family), resize(LINK_A, [60, 30], [120, 30], [200, 12], family), resize(LINK_B, [70, 30], [130, 30], [200, 58], family)]),
      ...(options.extraResizes ?? []),
    ],
    mutations: options.mutations ?? [],
    fonts: options.fonts ?? [loadedNow('Web Sans')],
    resources: options.resources ?? [FONT_FILE],
  }
}

describe('3. an element that grew when a web font used by text inside it finished loading is a font swap', () => {
  it('links the font to the element that accounts for the movement, and names family and file', () => {
    const issue = only(headerGrew())
    expect(named(issue)).toEqual(['font-swap', '#site-header'])
    expect(issue.confidence).toBeGreaterThanOrEqual(CONFIDENT)
    expect(issue.trigger).toEqual({ kind: 'font', family: 'Web Sans', url: 'http://localhost:4310/fonts/web-sans.woff2' })
    expect(text(issue)).toMatch(/font "Web Sans" finished loading at about 796 ms \(font file web-sans\.woff2\)/)
    expect(text(issue)).toMatch(/nav#nav inside header#site-header is set in "Web Sans" and changed size in that frame \(nav#nav from 600x30 to 600x76\); nothing else in header#site-header changed/)
  })

  it('still names the text element itself when it is the one that accounts for the movement', () => {
    // The <nav> grows by exactly the distance: it wins over the header, as before.
    const issue = only(headerGrew({ navGrowth: 40 }))
    expect(named(issue)).toEqual(['font-swap', '#nav'])
    expect(text(issue)).toMatch(/nav#nav is set in "Web Sans" and nothing else about it changed in that frame/)
  })

  it('a font that loads and changes nothing is not blamed (font-display: optional): the text set in it kept its size', () => {
    // The header grew for a reason that is not on record; the <nav> is in the document, in the web font, unchanged.
    const issue = only(headerGrew({ navResized: false }))
    expect(issue).toMatchObject({ cause: 'unknown', geometricMatch: true })
    expect(issue.culprit?.node.selector).toBe('#site-header')
    expect(issue.confidence).toBeLessThan(CONFIDENT)
    expect(text(issue)).toMatch(/nothing on record says why it changed size/)
  })

  it('a font that is not used inside the element is not blamed', () => {
    const issue = only(headerGrew({ navFont: false }))
    expect(issue.cause).toBe('unknown')
    expect(issue.confidence).toBeLessThan(CONFIDENT)
    // Used elsewhere on the page, by something that did change size: still not inside the header.
    const footer = node(60, 'footer', [1, 2, 0])
    const elsewhere = only(headerGrew({ navFont: false, extraResizes: [resize(footer, [1280, 40], [1280, 90], [0, 1900], web)] }))
    expect(elsewhere.cause).toBe('unknown')
  })

  it('another font that finished loading in that frame is not blamed either', () => {
    const issue = only(headerGrew({ fonts: [loadedNow('Other Display')] }))
    expect(issue.cause).toBe('unknown')
    expect(issue.confidence).toBeLessThan(CONFIDENT)
  })

  it('media that grew inside the element is another explanation: not a font swap', () => {
    // The logo got 4px taller in the same frame: not enough to be the header's reason, but a reason.
    const issue = only(headerGrew({ extraResizes: [resize(LOGO, [40, 28], [40, 32], [20, 14])] }))
    expect(issue.cause).not.toBe('font-swap')
    expect(issue.confidence).toBeLessThan(CONFIDENT)
  })

  it('a DOM change inside the element is another explanation: not a font swap', () => {
    const issue = only(headerGrew({ mutations: [{ t: T - 3, kind: 'text', node: LINK_A }] }))
    expect(named(issue)).toEqual(['injected-content', '#site-header'])
    expect(text(issue)).toMatch(/its content was changed by script/)
  })

  it('text in the font that changed by too little to be why the element grew is not enough', () => {
    // The links got wider but the <nav> gained 4px of height; the header gained 40.
    const issue = only(headerGrew({ navGrowth: 4 }))
    expect(issue.cause).toBe('unknown')
    expect(issue.confidence).toBeLessThan(CONFIDENT)
  })

  it('a face that was on record as loaded long before the frame is not what changed in it, whatever lists it again', () => {
    // A `loadingdone` event lists every face of the loading period, also one that was ready at 30 ms.
    const again: FontRecord[] = [
      { t: 30, since: 22, event: 'loaded', family: 'Web Sans', weight: '400', style: 'normal', via: 'snapshot' },
      { t: T + 1, event: 'loaded', family: 'Web Sans', weight: '400', style: 'normal', via: 'event' },
    ]
    expect(only(headerGrew({ fonts: again, resources: [] })).cause).toBe('unknown')
    // A snapshot dates a face to the first frame in which anything changed size after it loaded:
    // here the face's own event came 300 ms earlier.
    const late: FontRecord[] = [{ t: T - 300, event: 'loaded', family: 'Web Sans', weight: '400', style: 'normal', via: 'event' }, loadedNow('Web Sans', { since: 22 })]
    expect(only(headerGrew({ fonts: late, resources: [] })).cause).toBe('unknown')
    // With the font file of another family ending right before the frame it is still not this face.
    expect(only(headerGrew({ fonts: late })).cause).toBe('unknown')
  })

  it('another face of the same family that loaded earlier does not hide the one that loaded now', () => {
    const early: FontRecord = { t: 30, since: 22, event: 'loaded', family: 'Web Sans', weight: '400', style: 'normal', via: 'snapshot' }
    // The bold face, after the regular one.
    expect(named(only(headerGrew({ fonts: [early, loadedNow('Web Sans', { weight: '700' })] })))).toEqual(['font-swap', '#site-header'])
    // A second unicode-range subset: same family, weight and style, another face. Seen by the snapshot of this frame...
    expect(named(only(headerGrew({ fonts: [early, loadedNow('Web Sans')] })))).toEqual(['font-swap', '#site-header'])
    // ...and listed by a loadingdone event together with the first one.
    const both: FontRecord[] = [early, { ...early, t: T + 1, since: undefined, via: 'event' }, { ...early, t: T + 1, since: undefined, via: 'event' }]
    expect(named(only(headerGrew({ fonts: both })))).toEqual(['font-swap', '#site-header'])
    // Two faces found by one snapshot, of which one had its own event long before: the other is news.
    const one: FontRecord[] = [{ ...early, t: T - 300, since: undefined, via: 'event' }, loadedNow('Web Sans', { since: 22 }), loadedNow('Web Sans', { since: 22 })]
    expect(named(only(headerGrew({ fonts: one })))).toEqual(['font-swap', '#site-header'])
  })

  it('text in the font that sits in an inline child (noted by the hook on the block) links the block', () => {
    // An <h1> in Arial whose words are in a <span> set in the web font: the span has no size of its own on record.
    const title = node(70, 'h1', [1, 0], { id: 'title' })
    const parts = (inlineFonts: string[] | undefined): Parts => ({
      shifts: [shift([source(CONTENT, rect(0, 60, 1280, 740), rect(0, 100, 1280, 700))])],
      resizes: [resize(BODY, [1280, 2000], [1280, 2040], [0, 0]), resize(title, [1280, 60], [1280, 100], [0, 0], inlineFonts === undefined ? {} : { inlineFonts })],
      fonts: [loadedNow('Web Sans')],
      resources: [FONT_FILE],
    })
    const issue = only(parts([WEB]))
    expect(named(issue)).toEqual(['font-swap', '#title'])
    expect(text(issue)).toMatch(/inline text of h1#title is set in "Web Sans"/)
    // Not noted (an older hook), or noted in another font: not linked.
    expect(only(parts(undefined)).cause).toBe('unknown')
    expect(only(parts(['"Icons", sans-serif'])).cause).toBe('unknown')
  })
})

// ---------------------------------------------------------------------------
// What the second rule exposed
// ---------------------------------------------------------------------------

const CARD = node(80, 'article', [1, 1, 0], { id: 'card' })
const MEDIA_LINK = node(81, 'a', [1, 1, 0, 0], { id: 'media-link' })
const CARD_IMG = node(82, 'img', [1, 1, 0, 0, 0], { id: 'card-img', attrs: { src: '/card.png' } })
const CARD_TEXT = node(83, 'div', [1, 1, 0, 1], { id: 'card-text' })
const NEXT_ROW = node(84, 'article', [1, 1, 1], { id: 'next-row' })

/**
 * A card in a grid row: its image goes from no height to 380px, the text under it moves down 380px,
 * but the card only grows by 250px (it was stretched to the row before), and the next row moves 250px.
 */
function card(options: { linkBefore?: [number, number]; mutations?: ShiftMutationRecord[]; media?: MediaEvent[]; textShare?: boolean } = {}): Parts {
  return {
    shifts: [
      shift([
        source(CARD_TEXT, rect(0, 100, 600, options.textShare === false ? 10 : 300), rect(0, 480, 600, options.textShare === false ? 10 : 170)),
        source(NEXT_ROW, rect(0, 420, 1280, 250), rect(0, 670, 1280, 130)),
      ]),
    ],
    resizes: [
      resize(BODY, [1280, 2000], [1280, 2250], [0, 0]),
      resize(MAIN, [1280, 1900], [1280, 2150], [0, 100]),
      resize(CARD, [600, 320], [600, 570], [0, 100]),
      resize(MEDIA_LINK, options.linkBefore ?? [600, 0], [600, 380], [0, 100]),
      resize(CARD_IMG, [600, 0], [600, 380], [0, 100], { media: MEDIA_HINTS }),
    ],
    mutations: options.mutations ?? [],
    media: options.media ?? [{ t: T + 2, event: 'load', node: CARD_IMG, url: 'http://localhost:4310/card.png', natural: { w: 600, h: 380 } }],
  }
}

describe('a wrapper that got its height when the image inside it arrived did not "appear"', () => {
  it('names the image, as unsized media, not the link around it as injected content', () => {
    const issue = only(card())
    expect(named(issue)).toEqual(['unsized-media', '#card-img'])
    expect(issue.confidence).toBeGreaterThanOrEqual(CONFIDENT)
    expect(text(issue)).toMatch(/a#media-link went from 600x0 to 600x380 because img#card-img inside it got its size/)
  })

  it('also when a class changed on the card in that frame (a "loaded" class set by the load handler)', () => {
    const issue = only(card({ mutations: [{ t: T - 1, kind: 'attr', node: CARD, attr: 'class', value: 'card loaded' }] }))
    expect(named(issue)).toEqual(['unsized-media', '#card-img'])
  })

  it('a wrapper that had no box at all and was shown by an attribute stays the culprit: it was revealed, with the image in it', () => {
    const issue = only(card({ linkBefore: [0, 0], mutations: [{ t: T - 1, kind: 'attr', node: MEDIA_LINK, attr: 'hidden', oldValue: '' }] }))
    expect(named(issue)).toEqual(['injected-content', '#media-link'])
    expect(text(issue)).toMatch(/it was shown by a change of the hidden attribute/)
  })

  it('a wrapper that a script gave its height stays the culprit, unless the image in it has just loaded', () => {
    const styled: ShiftMutationRecord = { t: T - 1, kind: 'attr', node: MEDIA_LINK, attr: 'style', value: 'height: 380px' }
    // No load event of the image in this frame: the image followed the wrapper.
    expect(named(only(card({ mutations: [styled], media: [] })))).toEqual(['injected-content', '#media-link'])
    // The image loaded in this frame (and its handler set a class on the wrapper): the image.
    expect(named(only(card({ mutations: [{ ...styled, attr: 'class', value: 'loaded' }] })))).toEqual(['unsized-media', '#card-img'])
  })

  it('a wrapper that was inserted with the image in it stays the culprit', () => {
    const parts = card({ mutations: [{ t: T - 1, kind: 'add', node: MEDIA_LINK, parent: CARD, stack: PAGE_FRAMES }] })
    ;(parts.resizes ?? []).splice(3, 1, resize(MEDIA_LINK, null, [600, 380], [0, 100]))
    expect(named(only(parts))).toEqual(['injected-content', '#media-link'])
  })
})

describe('content inside the culprit that an element in it accounts for counts towards the match', () => {
  it('the card explains the next row, the image in the card explains the card\'s text: together more than half', () => {
    // By area: the text 180,000 of 500,000 (36%, inside the card), the next row 64% directly.
    const issue = only(card())
    expect(issue.victims.map((victim) => victim.explained)).toEqual(['inside', 'direct'])
    expect(text(issue)).toMatch(/div#card-text moved down 380px: inside article#card, by the distance a#media-link grew/)
  })

  it('names the culprit when its own share is under half but the element inside it accounts for the rest', () => {
    // Shrink the next row's visible part so that the card's direct share falls under 50%.
    const parts = card()
    ;(parts.shifts[0] as ShiftEntry).sources[1] = source(NEXT_ROW, rect(0, 420, 400, 250), rect(0, 670, 400, 130))
    const issue = only(parts)
    expect(named(issue)).toEqual(['unsized-media', '#card-img'])
    expect(issue.confidence).toBeGreaterThanOrEqual(CONFIDENT)
    expect(text(issue)).toMatch(/36% of the moved area is explained directly, 64% is content inside the culprit/)
  })

  it('but not when nothing inside it accounts for that content\'s distance', () => {
    const parts = card()
    ;(parts.shifts[0] as ShiftEntry).sources[1] = source(NEXT_ROW, rect(0, 420, 400, 250), rect(0, 670, 400, 130))
    // The text moved 200px: not the 380px of the image, not the 250px of the card.
    ;(parts.shifts[0] as ShiftEntry).sources[0] = source(CARD_TEXT, rect(0, 100, 600, 300), rect(0, 300, 600, 300))
    const issue = only(parts)
    expect(issue.culprit).toBeUndefined()
    expect(issue.confidence).toBeLessThan(CONFIDENT)
  })
})
