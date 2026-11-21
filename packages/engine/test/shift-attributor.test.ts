import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ShiftRecordingSchema, ShiftReportSchema, type ShiftCause, type ShiftEntry, type ShiftRecording } from '../../protocol/src/shift.ts'
import { attributeShifts, cachedResourcesOf, CONFIDENT, isAncestorPath, isFontResource, nodeLabel } from '../src/shift-attributor.ts'

/**
 * The recordings in `shift-recordings/` were made by the injected hook in
 * Chromium 159 (headless, 1280x800) on the pages of `fixtures/cls-corpus` and
 * `spikes/s7-assets/heldout`, through the primp proxy. Regenerate them with
 * `pnpm spike:s7 -- --record`.
 *
 * The expectations below are the pages' labels (their `expected.json`), written
 * out here: the attributor sees the recording and nothing else.
 */
const DIR = new URL('./shift-recordings/', import.meta.url)
const names = readdirSync(DIR)
  .filter((file) => file.endsWith('.json'))
  .map((file) => file.replace(/\.json$/, ''))
  .sort()
const load = (name: string): ShiftRecording => ShiftRecordingSchema.parse(JSON.parse(readFileSync(new URL(`${name}.json`, DIR), 'utf8')))
const clone = (recording: ShiftRecording): ShiftRecording => structuredClone(recording)
const first = (recording: ShiftRecording): ShiftEntry => {
  const entry = recording.shifts[0]
  if (entry === undefined) throw new Error('recording has no layout-shift entry')
  return entry
}

type Want = [cause: ShiftCause, culprit: string]

/** Positive corpus pages: every shift, in time order. */
const CORPUS: Record<string, Want[]> = {
  'unsized-media__img-block': [['unsized-media', '#hero']],
  'unsized-media__video-metadata': [['unsized-media', '#clip']],
  'unsized-media__iframe-autoheight': [['unsized-media', '#embed']],
  'unsized-media__img-in-flex': [['unsized-media', '#portrait']],
  'unsized-media__img-in-grid': [['unsized-media', '#card-2-img']],
  'font-swap__heading': [['font-swap', '#title']],
  'font-swap__nav': [['font-swap', '#nav']],
  'font-swap__paragraph': [['font-swap', '#lead']],
  'font-swap__sidebar-external-css': [['font-swap', '#side-nav']],
  'font-swap__fontface-api': [['font-swap', '#pull-quote']],
  'injected-content__banner-innerhtml': [['injected-content', '#promo-banner']],
  'injected-content__cookie-bar-insertbefore': [['injected-content', '#cookie-bar']],
  'injected-content__notice-display-flip': [['injected-content', '#service-notice']],
  'injected-content__feed-prepend': [['injected-content', '#new-post']],
  'injected-content__skeleton-replace': [['injected-content', '#weather-panel']],
  'multi__two-causes': [
    ['unsized-media', '#hero'],
    ['injected-content', '#sidebar-ad'],
  ],
  'multi__font-then-banner': [
    ['font-swap', '#title'],
    ['injected-content', '#promo-banner'],
  ],
}

const NEGATIVES = ['negative__transform-animation', 'negative__below-fold-insert', 'negative__reserved-space', 'negative__fixed-overlay-insert']

const scoredInOrder = (recording: ShiftRecording) =>
  attributeShifts(recording)
    .issues.filter((issue) => issue.scored)
    .sort((a, b) => a.startTime - b.startTime)

describe('recordings', () => {
  it('cover the whole corpus', () => {
    for (const name of [...Object.keys(CORPUS), ...NEGATIVES, 'negative__user-click-insert']) expect(names).toContain(name)
  })

  it.each(names)('%s parses, and its report satisfies the protocol schema', (name) => {
    const report = attributeShifts(load(name))
    expect(() => ShiftReportSchema.parse(report)).not.toThrow()
    for (const issue of report.issues) {
      expect(issue.confidence).toBeGreaterThanOrEqual(0)
      expect(issue.confidence).toBeLessThanOrEqual(1)
      // The rule of the house: no confidence at or above the threshold without a geometric match.
      if (issue.confidence >= CONFIDENT && issue.excluded !== 'self-induced') expect(issue.geometricMatch).toBe(true)
      expect(issue.evidence.length).toBeGreaterThan(0)
    }
  })
})

describe('attributeShifts on the corpus (positive pages)', () => {
  it.each(Object.entries(CORPUS))('%s', (name, wanted) => {
    const recording = load(name)
    const report = attributeShifts(recording)
    const issues = scoredInOrder(recording)
    expect(report.status).toBe('ok')
    expect(issues.map((issue) => [issue.cause, issue.culprit?.node.selector])).toEqual(wanted)
    for (const issue of issues) {
      expect(issue.confidence).toBeGreaterThanOrEqual(CONFIDENT)
      expect(issue.geometricMatch).toBe(true)
      // The culprit is what caused the movement, never one of the boxes that moved.
      const victims = issue.victims.map((victim) => victim.node?.uid)
      expect(victims).not.toContain(issue.culprit?.node.uid)
      expect(issue.victims.length).toBeGreaterThan(0)
      expect(issue.victims.some((victim) => victim.explained === 'direct')).toBe(true)
      expect(issue.window).toBe(0)
    }
    // One session window on these pages: the CLS is the sum of the entries.
    const sum = recording.shifts.reduce((total, entry) => total + entry.value, 0)
    expect(report.cls).toBeCloseTo(sum, 12)
    expect(report.windows).toHaveLength(1)
    expect(report.cachedResources).toEqual([])
  })

  it('names what the culprit did, with numbers: an image that grew by the distance the content moved', () => {
    const issue = scoredInOrder(load('unsized-media__img-block'))[0]
    expect(issue?.culprit?.sizeBefore).toEqual({ w: 0, h: 0 })
    expect(issue?.culprit?.sizeAfter.h).toBeCloseTo(266.66, 1)
    expect(issue?.victims[0]).toMatchObject({ dy: 266.66, dx: 0, explained: 'direct' })
    expect(issue?.culprit?.media).toMatchObject({ widthAttr: false, heightAttr: false, aspectRatio: 'auto' })
    expect(issue?.trigger).toMatchObject({ kind: 'resource' })
    expect(issue?.trigger?.url).toMatch(/hero-1200x400\.png$/)
    expect(issue?.evidence.join('\n')).toMatch(/its space was not reserved: no width\/height attribute, no aspect-ratio/)
  })

  it('names the font and the element set in it for a font swap', () => {
    const issue = scoredInOrder(load('font-swap__heading'))[0]
    expect(issue?.trigger).toMatchObject({ kind: 'font', family: 'Press Start 2P' })
    expect(issue?.trigger?.url).toMatch(/press-start-2p.*\.woff2$/)
  })

  it('finds a font swap that fired no loadingdone event (FontFace API), from the snapshot of document.fonts', () => {
    const recording = load('font-swap__fontface-api')
    expect(recording.fonts.filter((font) => font.via === 'event' && font.event === 'loaded')).toHaveLength(0)
    expect(scoredInOrder(recording)[0]).toMatchObject({ cause: 'font-swap' })
  })

  it('keeps two causes on one page apart', () => {
    const issues = scoredInOrder(load('multi__font-then-banner'))
    expect(issues).toHaveLength(2)
    expect(issues[1]?.startTime - (issues[0]?.startTime ?? 0)).toBeGreaterThan(500)
    expect(issues.map((issue) => issue.entries.length)).toEqual([1, 1])
  })

  it('lists scored issues largest first', () => {
    const report = attributeShifts(load('multi__font-then-banner'))
    expect(report.issues.map((issue) => issue.culprit?.node.selector)).toEqual(['#promo-banner', '#title'])
    expect(report.issues[0]?.value).toBeGreaterThan(report.issues[1]?.value ?? 0)
  })
})

describe('attributeShifts on the corpus (negative pages)', () => {
  it.each(NEGATIVES)('%s: nothing to report', (name) => {
    const report = attributeShifts(load(name))
    expect(report).toMatchObject({ status: 'ok', cls: 0, issues: [], windows: [] })
  })

  it('does not turn mutation evidence alone into a culprit', () => {
    // These two pages insert the same nodes as positive pages do; nothing moves.
    for (const name of ['negative__fixed-overlay-insert', 'negative__below-fold-insert']) {
      const recording = load(name)
      expect(recording.mutations.some((mutation) => mutation.kind === 'add')).toBe(true)
      expect(attributeShifts(recording).issues).toEqual([])
    }
  })

  it('excuses a shift within 500 ms of a click: listed, marked, not scored', () => {
    const recording = load('negative__user-click-insert')
    expect(first(recording).hadRecentInput).toBe(true)
    const report = attributeShifts(recording)
    expect(report.cls).toBe(0)
    expect(report.windows).toEqual([])
    expect(report.issues).toHaveLength(1)
    expect(report.issues[0]).toMatchObject({ excluded: 'recent-input', scored: false, confidence: 0, cause: 'unknown', geometricMatch: false })
    expect(report.issues[0]?.culprit).toBeUndefined()
    expect(report.issues[0]?.victims.length).toBeGreaterThan(0)
  })
})

describe('attributeShifts is conservative', () => {
  it('names no culprit when the size ledger is empty: unknown, victims only, still counted', () => {
    const recording = clone(load('unsized-media__img-block'))
    recording.resizes = []
    const report = attributeShifts(recording)
    expect(report.issues).toHaveLength(1)
    expect(report.issues[0]).toMatchObject({ cause: 'unknown', geometricMatch: false, scored: true })
    expect(report.issues[0]?.culprit).toBeUndefined()
    expect(report.issues[0]?.confidence).toBeLessThan(CONFIDENT)
    expect(report.issues[0]?.victims.map((victim) => victim.node?.selector)).toContain('#content')
    // The load event and the resource timing of the image are still on record: not enough without geometry.
    expect(recording.media.length).toBeGreaterThan(0)
    expect(report.cls).toBeCloseTo(first(recording).value, 12)
  })

  it('names no culprit when the element grew by a different amount than the content moved', () => {
    const recording = clone(load('unsized-media__img-block'))
    for (const resize of recording.resizes) {
      // Every element grew 100px more than the 267px the content moved.
      resize.after = { w: resize.after.w, h: resize.after.h + 100 }
      if (resize.rect !== undefined) resize.rect = { ...resize.rect, height: resize.rect.height + 100 }
    }
    const issue = attributeShifts(recording).issues[0]
    expect(issue?.cause).toBe('unknown')
    expect(issue?.culprit).toBeUndefined()
    expect(issue?.confidence).toBeLessThan(CONFIDENT)
  })

  it('names no culprit when the element that grew lies below what moved', () => {
    const recording = clone(load('unsized-media__img-block'))
    for (const resize of recording.resizes) if (resize.rect !== undefined && resize.node.selector === '#hero') resize.rect = { ...resize.rect, y: 700 }
    const issue = attributeShifts(recording).issues[0]
    expect(issue?.culprit?.node.selector).not.toBe('#hero')
    expect(issue?.confidence).toBeLessThan(CONFIDENT)
  })

  it('does not blame an absolutely positioned element that grew in the same frame', () => {
    const recording = load('heldout__decoy-abs-image')
    expect(recording.resizes.some((resize) => resize.node.selector === '#badge' && resize.style?.position === 'absolute')).toBe(true)
    expect(scoredInOrder(recording).map((issue) => issue.culprit?.node.selector)).toEqual(['#promo'])
  })

  it('caps confidence below the threshold when the element is known but the reason is not', () => {
    const issue = scoredInOrder(load('heldout__late-stylesheet'))[0]
    expect(issue).toMatchObject({ cause: 'unknown', geometricMatch: true })
    expect(issue?.culprit?.node.selector).toBe('#site-header')
    expect(issue?.confidence).toBeLessThan(CONFIDENT)
    expect(issue?.evidence.join('\n')).toMatch(/stylesheet .*late\.css finished loading/)
  })
})

describe('attributeShifts on patterns beyond the corpus', () => {
  it('classifies a shift from a dev-server style injection as dev-artifact and does not score it', () => {
    const report = attributeShifts(load('heldout__dev-style-inject'))
    expect(report.cls).toBe(0)
    expect(report.issues).toHaveLength(1)
    expect(report.issues[0]).toMatchObject({ cause: 'dev-artifact', excluded: 'dev-artifact', scored: false })
    expect(report.issues[0]?.evidence.join('\n')).toMatch(/injected by the dev server client/)
  })

  it('treats the same shift as the page\'s own when the stylesheet is not a dev artifact', () => {
    const recording = clone(load('heldout__dev-style-inject'))
    for (const mutation of recording.mutations) delete mutation.node.attrs?.['data-vite-dev-id']
    const report = attributeShifts(recording)
    expect(report.issues[0]).toMatchObject({ cause: 'unknown', scored: true })
    expect(report.cls).toBeGreaterThan(0)
  })

  it('merges the frames of an animation into one issue', () => {
    const recording = load('heldout__height-transition')
    expect(recording.shifts.length).toBeGreaterThan(10)
    const report = attributeShifts(recording)
    expect(report.issues).toHaveLength(1)
    expect(report.issues[0]?.entries).toHaveLength(recording.shifts.length)
    expect(report.issues[0]?.culprit?.node.selector).toBe('#panel')
    expect(report.issues[0]?.value).toBeCloseTo(recording.shifts.reduce((total, entry) => total + entry.value, 0), 12)
  })

  it('explains victims by two elements that grew in the same frame, and names the first as culprit', () => {
    const issue = scoredInOrder(load('heldout__font-swap-two-blocks'))[0]
    expect(issue).toMatchObject({ cause: 'font-swap', geometricMatch: true })
    expect(issue?.culprit?.node.selector).toBe('#h-a')
    expect(issue?.coCulprits?.map((culprit) => culprit.node.selector)).toEqual(['#h-b'])
    expect(issue?.confidence).toBeGreaterThanOrEqual(CONFIDENT)
  })

  it('finds a float behind re-wrapped text', () => {
    const issue = scoredInOrder(load('heldout__img-float'))[0]
    expect(issue).toMatchObject({ cause: 'unsized-media' })
    expect(issue?.culprit?.node.selector).toBe('#thumb')
    expect(issue?.evidence.join('\n')).toMatch(/re-wrapped around img#thumb, which is floated left/)
  })

  it('names a removed element, with cause unknown and confidence under the threshold', () => {
    const issue = scoredInOrder(load('heldout__remove-banner'))[0]
    expect(issue).toMatchObject({ cause: 'unknown', geometricMatch: true })
    expect(issue?.culprit?.node.selector).toBe('#notice')
    expect(issue?.culprit?.sizeAfter).toEqual({ w: 0, h: 0 })
    expect(issue?.trigger).toMatchObject({ kind: 'mutation', detail: 'node removed' })
    expect(issue?.confidence).toBeLessThan(CONFIDENT)
  })

  it('separates two causes that land in neighbouring frames', () => {
    expect(scoredInOrder(load('heldout__same-frame-two-causes')).map((issue) => [issue.cause, issue.culprit?.node.selector])).toEqual([
      ['unsized-media', '#hero'],
      ['injected-content', '#flash'],
    ])
  })

  it.each([
    ['heldout__ad-iframe-insert', 'injected-content', '#ad'],
    ['heldout__text-replace', 'injected-content', '#summary'],
    ['heldout__logo-in-flex-header', 'unsized-media', '#logo'],
  ])('%s: %s %s', (name, cause, culprit) => {
    const issue = scoredInOrder(load(name))[0]
    expect([issue?.cause, issue?.culprit?.node.selector]).toEqual([cause, culprit])
    expect(issue?.confidence).toBeGreaterThanOrEqual(CONFIDENT)
  })
})

/**
 * Pages of `fixtures/cls-heldout`, recorded through the product on 2026-11-21: once with the hook
 * as it was when the set was first run (`cls-heldout-old-hook__*`: no measured box on shift
 * sources, and a frame of the hook's DOM wrapper on top of the stack of `insertAdjacentHTML`), and
 * once with the hook as it is now. The first run got these six pages wrong or left them open; they
 * are regression fixtures since. Expectations are the pages' answer keys.
 */
const HELDOUT: Record<string, Want> = {
  'pricing-ledgerly': ['injected-content', '#promo-strip'],
  'product-tidewell': ['injected-content', '#recs-slot > div:nth-of-type(1)'],
  'recipe-saltwater-kitchen': ['unsized-media', 'body > main:nth-of-type(1) > section:nth-of-type(2) > div:nth-of-type(1) > iframe:nth-of-type(1)'],
  'shop-grid-fernhill': ['unsized-media', '#product-grid > article:nth-of-type(1) > a:nth-of-type(1) > img:nth-of-type(1)'],
  'dashboard-orderdesk': ['font-swap', '#orders > thead:nth-of-type(1) > tr:nth-of-type(1)'],
  'docs-quillstack': ['font-swap', 'body > header:nth-of-type(1)'],
}
const OLD_HOOK = ['pricing-ledgerly', 'product-tidewell', 'recipe-saltwater-kitchen', 'shop-grid-fernhill']
/** The largest scored issue: what the held-out measurement compares with the answer key. */
const top = (recording: ShiftRecording) => attributeShifts(recording).issues.filter((issue) => issue.scored).sort((a, b) => b.value - a.value)[0]

describe('attributeShifts on the first held-out set', () => {
  it.each(Object.entries(HELDOUT))('%s, recorded by the current hook', (name, wanted) => {
    const issue = top(load(`cls-heldout__${name}`))
    expect([issue?.cause, issue?.culprit?.node.selector]).toEqual(wanted)
    expect(issue?.confidence).toBeGreaterThanOrEqual(CONFIDENT)
    expect(issue?.geometricMatch).toBe(true)
  })

  it.each(OLD_HOOK)('%s, recorded by the hook of the first run', (name) => {
    const issue = top(load(`cls-heldout-old-hook__${name}`))
    expect([issue?.cause, issue?.culprit?.node.selector]).toEqual(HELDOUT[name])
    expect(issue?.confidence).toBeGreaterThanOrEqual(CONFIDENT)
  })

  it('a page\'s own insertAdjacentHTML is the page\'s, with or without the hook\'s wrapper frame on its stack', () => {
    const old = load('cls-heldout-old-hook__pricing-ledgerly')
    const stack = old.mutations.find((mutation) => mutation.kind === 'add' && mutation.node.id === 'promo-strip')?.stack ?? ''
    expect(stack.split('\n')[0]).toMatch(/\[as insertAdjacentHTML\] \(http:\/\/localhost:4310\/__primp\/hook\.js/)
    for (const recording of [old, load('cls-heldout__pricing-ledgerly')]) {
      const report = attributeShifts(recording)
      expect(report.cls).toBeGreaterThan(0.03)
      expect(report.issues.every((issue) => issue.cause !== 'dev-artifact' && issue.excluded === undefined)).toBe(true)
      // The source resolver gets the page's statement first.
      expect(top(recording)?.trigger?.stack?.split('\n')[0]).toMatch(/^\s+at http:\/\/localhost:4310\/pricing-ledgerly\/:205:14$/)
    }
    // The current hook leaves none of its frames on the stack.
    expect(JSON.stringify(load('cls-heldout__pricing-ledgerly').mutations)).not.toContain('/__primp/')
  })

  it('a victim pushed below the fold: the measured distance where the hook recorded the box, a least distance where it did not', () => {
    const measured = top(load('cls-heldout__product-tidewell'))
    expect(measured?.victims[0]).toMatchObject({ dx: 0, viewport: 'out', explained: 'direct' })
    expect(measured?.victims[0]?.dy).toBeCloseTo(359.4, 0)
    expect(measured?.evidence.join('\n')).toMatch(/section\.details was pushed down 359\.4px, below the visible area: the same distance, and div\.recs-block is right before it/)
    const bounded = top(load('cls-heldout-old-hook__product-tidewell'))
    expect(bounded?.victims[0]).toMatchObject({ dx: 0, viewport: 'out', distance: 'at-least', explained: 'consistent' })
    expect(bounded?.victims[0]?.dy).toBeCloseTo(207.3, 0)
    expect(bounded?.confidence).toBeLessThan(measured?.confidence ?? 0)
    for (const issue of [measured, bounded]) expect(issue?.evidence.join('\n')).not.toMatch(/moved (up|left)|px (up|left)|and left/)
    // The block inserted above the footer at the same moment is below everything that moved: never named.
    expect(JSON.stringify([measured?.culprit, measured?.coCulprits, bounded?.culprit])).not.toContain('recently-viewed')
  })

  it('an image in a card: the card pushes the next row, the image pushes the card\'s text, and the image is the culprit', () => {
    const issue = top(load('cls-heldout__shop-grid-fernhill'))
    const lines = issue?.evidence.join('\n') ?? ''
    expect(lines).toMatch(/a\.card-media went from 578x0 to 578x385\.3 because .*img.* inside it got its size/)
    expect(lines).toMatch(/its load event fired/)
    expect(issue?.trigger?.url).toMatch(/card-600x400\.png$/)
  })

  it('a font swap of text inside the element that grew names the family and the file', () => {
    const table = top(load('cls-heldout__dashboard-orderdesk'))
    expect(table?.trigger).toMatchObject({ kind: 'font', family: 'Ledger Caps' })
    expect(table?.trigger?.url).toMatch(/press-start-2p.*\.woff2$/)
    expect(table?.evidence.join('\n')).toMatch(/font "Ledger Caps" finished loading at about [\d.]+ ms \(font file press-start-2p-latin-400-normal\.woff2\)/)
    expect(table?.evidence.join('\n')).toMatch(/th.* and 6 more element\(s\) inside tr\.orders-head are set in "Ledger Caps" and changed size in that frame/)
    const header = top(load('cls-heldout__docs-quillstack'))
    expect(header?.trigger).toMatchObject({ kind: 'font', family: 'Quill Grotesk' })
    expect(header?.evidence.join('\n')).toMatch(/nav\.topnav inside header\.site-header is set in "Quill Grotesk" and changed size in that frame/)
  })

  it('a face that loaded earlier is not blamed for a later shift, though the browser lists it again', () => {
    // "Pixel Mark" (a data: URL) is loaded at 25 ms; the loadingdone event at 822 ms lists it beside "Arcade Display".
    const recording = load('cls-heldout__landing-pulsebase')
    const listed = recording.fonts.filter((font) => font.family === 'Pixel Mark' && font.event === 'loaded').map((font) => font.t)
    expect(Math.min(...listed)).toBeLessThan(100)
    expect(Math.max(...listed)).toBeGreaterThan(700)
    const issues = scoredInOrder(recording)
    expect(issues.map((issue) => [issue.cause, issue.trigger?.family, issue.startTime < 100])).toEqual([
      ['font-swap', 'Pixel Mark', true],
      ['font-swap', 'Arcade Display', false],
    ])
    expect(issues[1]?.culprit?.node.selector).toBe('#hero-title')
    expect(issues[1]?.evidence.join('\n')).not.toContain('Pixel Mark')
  })

  it('a font that loads and is never swapped in is not blamed for the insertion that follows it', () => {
    // "Ledgerly Display" is font-display: optional: loaded at about 520 ms, on record again in the frame of the insertion.
    const recording = load('cls-heldout__pricing-ledgerly')
    expect(recording.fonts.some((font) => font.family === 'Ledgerly Display' && font.event === 'loaded')).toBe(true)
    const report = attributeShifts(recording)
    expect(report.issues.map((issue) => issue.cause)).toEqual(['injected-content'])
    expect(JSON.stringify(report.issues)).not.toContain('Ledgerly Display')
  })
})

describe('entries that are not the page\'s fault', () => {
  it('excludes an entry tagged as self-induced', () => {
    const recording = clone(load('unsized-media__img-block'))
    first(recording).selfInduced = { reason: 'preview: margin-top', markedAt: 700 }
    const report = attributeShifts(recording)
    expect(report.cls).toBe(0)
    expect(report.windows).toEqual([])
    expect(report.issues[0]).toMatchObject({ excluded: 'self-induced', scored: false, cause: 'dev-artifact', trigger: { kind: 'self', detail: 'preview: margin-top' } })
    expect(report.issues[0]?.culprit).toBeUndefined()
  })

  it('excludes an entry with recent input even when the geometry would name a culprit', () => {
    const recording = clone(load('unsized-media__img-block'))
    first(recording).hadRecentInput = true
    const report = attributeShifts(recording)
    expect(report.cls).toBe(0)
    expect(report.issues[0]).toMatchObject({ excluded: 'recent-input', scored: false })
    expect(report.issues[0]?.culprit).toBeUndefined()
  })

  it('scores the rest of the page when one of two entries is excluded', () => {
    const recording = clone(load('multi__two-causes'))
    first(recording).hadRecentInput = true
    const report = attributeShifts(recording)
    expect(report.issues.filter((issue) => issue.scored).map((issue) => issue.culprit?.node.selector)).toEqual(['#sidebar-ad'])
    expect(report.cls).toBeCloseTo(recording.shifts[1]?.value ?? NaN, 12)
    expect(report.issues.at(-1)?.excluded).toBe('recent-input')
  })
})

describe('measurement validity in the report', () => {
  it('reports tab_hidden with a null CLS for a background load, never "no shifts"', () => {
    const report = attributeShifts(load('hidden-tab__background-reload'))
    expect(report).toMatchObject({ status: 'tab_hidden', cls: null, issues: [] })
    expect(report.reason).toBeDefined()
  })

  it('still lists what it saw on an invalid measurement, without a score', () => {
    const report = attributeShifts(load('hidden-tab__shown-after-300ms'))
    expect(report.status).toBe('tab_hidden')
    expect(report.cls).toBeNull()
    expect(report.issues.length).toBeGreaterThan(0)
  })

  it('reports not_measurable when the browser has no layout-shift entries', () => {
    const recording = clone(load('negative__reserved-space'))
    recording.supported = false
    expect(attributeShifts(recording)).toMatchObject({ status: 'not_measurable', cls: null })
  })

  it('says so when a resource came from a cache: the load was not cold', () => {
    const recording = clone(load('unsized-media__img-block'))
    const image = recording.resources.find((resource) => resource.url.endsWith('.png'))
    if (image === undefined) throw new Error('fixture has no image resource')
    image.transferSize = 0
    const report = attributeShifts(recording)
    expect(report.cachedResources).toEqual(['/delay/700/assets/img/hero-1200x400.png'])
    expect(report.notes.join('\n')).toMatch(/not a cold load/)
  })

  it('does not count the proxy\'s own script or other origins as cache hits', () => {
    const recording = clone(load('unsized-media__img-block'))
    recording.resources.push(
      { url: 'http://localhost:4310/__primp/hook.js', initiator: 'script', start: 1, end: 2, transferSize: 0 },
      { url: 'https://fonts.example/font.woff2', initiator: 'css', start: 1, end: 2, transferSize: 0 },
    )
    expect(cachedResourcesOf(recording)).toEqual([])
  })

  it('notes overflowed evidence buffers and elements beyond the tracking cap', () => {
    const recording = clone(load('unsized-media__img-block'))
    recording.dropped.resizes = 12
    recording.cost.untracked = 11014
    const notes = attributeShifts(recording).notes.join('\n')
    expect(notes).toMatch(/evidence buffers overflowed/)
    expect(notes).toMatch(/11014 elements .* were not size-tracked/)
  })
})

describe('helpers', () => {
  it('isAncestorPath: a strict prefix', () => {
    expect(isAncestorPath([1], [1, 0, 2])).toBe(true)
    expect(isAncestorPath([1, 0, 2], [1, 0, 2])).toBe(false)
    expect(isAncestorPath([1, 1], [1, 0, 2])).toBe(false)
    expect(isAncestorPath([], [1])).toBe(true)
  })

  it('nodeLabel: id, then first class, then selector', () => {
    const base = { uid: 1, tag: 'div', path: [1, 0], selector: 'body > div:nth-of-type(1)' }
    expect(nodeLabel({ ...base, id: 'hero', classes: ['a'] })).toBe('div#hero')
    expect(nodeLabel({ ...base, classes: ['card', 'wide'] })).toBe('div.card')
    expect(nodeLabel(base)).toBe('body > div:nth-of-type(1)')
    expect(nodeLabel(null)).toBe('(anonymous box)')
  })

  it('isFontResource: by file extension, whatever the initiator', () => {
    expect(isFontResource({ url: 'http://localhost:1/a/b.woff2' })).toBe(true)
    expect(isFontResource({ url: 'http://localhost:1/a/b.woff?v=3' })).toBe(true)
    expect(isFontResource({ url: 'http://localhost:1/a/woff2.png' })).toBe(false)
  })
})
