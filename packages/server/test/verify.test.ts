import { describe, expect, it } from 'vitest'
import type { ChangeItem, CheckResult, Expectation } from '@primp/protocol/change'
import type { MeasureOutcome, MeasuredItem, Session, SessionBatch } from '../src/session.ts'
import type { JournalEntry, SettleResult } from '../src/settle.ts'
import { createVerifier, itemStatusAfter, startAutoVerify, stateBlockedReason, toMeasured } from '../src/verify.ts'
import { noteItem, structureItem, styleItem } from './session-helpers.ts'

/** The parts of a Session that verification uses, over a plain list of items. */
function fakeSession(initial: ChangeItem[], measure: (items: readonly ChangeItem[]) => MeasureOutcome | Promise<MeasureOutcome>) {
  const items = new Map(initial.map((item) => [item.id, item]))
  const batches = new Map<string, SessionBatch>()
  const measured: string[][] = []
  const reloads: string[] = []
  const canReload = true
  let docs = ['doc-1']
  const session = {
    items: () => [...items.values()],
    item: (id: string) => items.get(id),
    batch: (id: string) => batches.get(id),
    measure: async (wanted: readonly ChangeItem[]) => {
      measured.push(wanted.map((item) => item.id))
      return measure(wanted)
    },
    documents: () => docs.map((doc) => ({ doc, connectedAt: 1000 })),
    reload: (reason: string) => {
      reloads.push(reason)
      // The tab comes back as a new document.
      docs = [`doc-${reloads.length + 1}`]
      return canReload
    },
    patchItem: (id: string, patch: Partial<ChangeItem>) => {
      const item = items.get(id)
      if (item === undefined) return false
      items.set(id, { ...item, ...patch } as ChangeItem)
      return true
    },
  } as unknown as Session
  return { session, items, batches, measured, reloads }
}

const settled = (over: Partial<SettleResult> = {}): SettleResult => ({
  status: 'settled',
  signal: 'hmr',
  ms: 120,
  filesChanged: ['src/components/Header.tsx'],
  reason: 'the page applied the update and is quiet',
  at: 1_750_000_010_000,
  domChanged: true,
  browser: true,
  ...over,
})

function fakeDetector(result: SettleResult | (() => SettleResult)) {
  const calls: { since: unknown; timeoutMs: number }[] = []
  const entries: JournalEntry[] = []
  return {
    calls,
    entries,
    detector: {
      mark: () => ({ seq: 99, at: 9999 }),
      waitForSettle: async (options: { since?: unknown; timeoutMs: number }) => {
        calls.push({ since: options.since, timeoutMs: options.timeoutMs })
        return typeof result === 'function' ? result() : result
      },
      journal: (since?: unknown) => {
        if (since === undefined) return [...entries]
        if (typeof since === 'number') return entries.filter((entry) => entry.at >= since)
        return entries.filter((entry) => entry.seq > (since as { seq: number }).seq)
      },
    },
  }
}

const rawComputed = (expectation: Expectation, actual: string, status: CheckResult['status'] = 'fail'): CheckResult => ({
  expectation,
  status,
  expected: expectation.type === 'computed' ? expectation.value : '',
  actual,
})

const answer = (item: ChangeItem, checks: CheckResult[], over: Partial<MeasuredItem> = {}): MeasuredItem => ({
  itemId: item.id,
  locatorConfidence: 0.93,
  found: true,
  checks,
  ...over,
})

const measuredWith = (results: MeasuredItem[], visible = true): MeasureOutcome => ({
  status: 'measured',
  doc: 'doc-1',
  url: 'http://localhost:5174/',
  visible,
  results,
})

const noSleep = async (): Promise<void> => {}

// --- a moved list item and a :hover change, as the dock reports them -------------------------

const li = (text: string, index: number) => ({ label: `li "${text}"`, locator: { tag: 'li', text, indexPath: [1, 0, index], ancestors: ['body', 'main', 'ul'] } })
const KIAMABARA = li('Kiamabara', 0)
const GESHA = { ...li('Gesha', 1), self: true }
const YIRGACHEFFE = li('Yirgacheffe', 2)
const ORDER: Extract<Expectation, { type: 'order' }> = { type: 'order', siblings: [KIAMABARA, GESHA, YIRGACHEFFE] }
const WANTED = JSON.stringify([KIAMABARA.label, GESHA.label, YIRGACHEFFE.label])
/** An `order` check as the dock sends it: both lists as JSON arrays of labels. */
const rawOrder = (status: CheckResult['status'], actual: string[] | string, note?: string): CheckResult => ({
  expectation: ORDER,
  status,
  expected: WANTED,
  actual: typeof actual === 'string' ? actual : JSON.stringify(actual),
  ...(note === undefined ? {} : { note }),
})
const reorderItem = (id: string, over: Partial<ChangeItem> = {}): ChangeItem =>
  structureItem(id, 'src/components/BeanGrid.tsx', {
    status: 'claimed',
    batchId: 'b1',
    op: 'reorder',
    move: { fromIndex: 3, toIndex: 1, siblingCount: 6, parent: 'ul.bean-grid', was: { prev: li('Huila', 3), next: li('Sidamo', 4) }, now: { prev: KIAMABARA, next: YIRGACHEFFE } },
    expect: [ORDER],
    ...over,
  } as never)

const HOVER = { ...styleItem('x').condition, state: 'hover' as const }
const hoverExpectation = (media?: string): Extract<Expectation, { type: 'computed' }> => ({
  type: 'computed',
  property: 'background-color',
  value: 'rgb(15, 23, 42)',
  condition: media === undefined ? HOVER : { ...HOVER, media },
})
const hoverItem = (id: string, media?: string, over: Partial<ChangeItem> = {}): ChangeItem =>
  styleItem(id, 'src/components/PricingTable.tsx', {
    status: 'claimed',
    batchId: 'b1',
    property: 'background-color',
    before: { authored: 'var(--ink-700)', computed: 'rgb(30, 41, 59)' },
    after: { authored: '#0f172a', computed: 'rgb(15, 23, 42)' },
    condition: hoverExpectation(media).condition,
    expect: [hoverExpectation(media)],
    ...over,
  } as never)
/** A `computed` check under :hover as the dock sends it. */
const rawHover = (status: CheckResult['status'], actual: string, note = 'measured with :hover emulated', media?: string): CheckResult => ({
  expectation: hoverExpectation(media),
  status,
  expected: 'rgb(15, 23, 42)',
  actual,
  note,
})
const NOT_EMULATED = 'the state could not be emulated: a stylesheet from another origin cannot be read'

describe('itemStatusAfter', () => {
  it('maps what was learned to an item status and leaves the item alone when nothing was learned', () => {
    expect(itemStatusAfter('pass')).toBe('verified')
    expect(itemStatusAfter('drift')).toBe('verified')
    for (const status of ['fail', 'unresolved', 'no_update_observed', 'build_error'] as const) expect(itemStatusAfter(status)).toBe('failed')
    for (const status of ['not_measurable', 'tab_hidden', 'no_browser'] as const) expect(itemStatusAfter(status)).toBeUndefined()
    // A note is neither verified (that reads as done) nor failed (there is nothing to fix).
    expect(itemStatusAfter('not_checkable')).toBeUndefined()
  })
})

describe('toMeasured', () => {
  const item = styleItem('c1')
  const computed = item.expect[0] as Expectation

  it('reads a computed check: actual, the target as computed, and whether the media condition matched', () => {
    const measured = toMeasured(rawComputed(computed, '20px'), answer(item, []))
    expect(measured).toMatchObject({ found: true, actual: '20px', expectedComputed: '24px', mediaMatches: true, locatorConfidence: 0.93 })
    expect(toMeasured(rawComputed(computed, '', 'not_measurable'), answer(item, [])).mediaMatches).toBe(false)
  })

  it('treats an unresolved check or an element that was not found as not found', () => {
    expect(toMeasured(rawComputed(computed, '', 'unresolved'), answer(item, [])).found).toBe(false)
    expect(toMeasured(rawComputed(computed, '24px', 'pass'), answer(item, [], { found: false })).found).toBe(false)
  })

  it('reads a no-move check from the rect JSON and reports a missing element when there is none', () => {
    const noMove: Expectation = { type: 'no-move', label: 'footer', locator: item.target.locator, rect: { x: 0, y: 900, w: 1280, h: 120 }, tolerancePx: 1 }
    const raw: CheckResult = { expectation: noMove, status: 'fail', expected: '{"x":0,"y":900,"w":1280,"h":120}', actual: '{"x":0,"y":924,"w":1280,"h":120}' }
    expect(toMeasured(raw, answer(item, []))).toMatchObject({ found: true, rectNow: { x: 0, y: 924, w: 1280, h: 120 } })
    expect(toMeasured({ ...raw, actual: 'not json' }, answer(item, [])).found).toBe(false)
    expect(toMeasured({ ...raw, status: 'unresolved' }, answer(item, [])).found).toBe(false)
  })

  it('reads an unchanged check: the bystander is found unless its own check says otherwise, whatever became of the target', () => {
    const bystander: Expectation = { type: 'unchanged', label: 'a.btn "Docs"', selector: 'nav > a', locator: { tag: 'a', indexPath: [0, 1], ancestors: ['body', 'nav'] }, property: 'padding-top', value: '10px' }
    const raw: CheckResult = { expectation: bystander, status: 'fail', expected: '10px', actual: '14px' }
    expect(toMeasured(raw, answer(item, []))).toEqual({ found: true, locatorConfidence: 0.93, actual: '14px', expectedComputed: '10px' })
    // The item's own element was not found: that says nothing about the bystander.
    expect(toMeasured({ ...raw, status: 'pass', actual: '10px' }, answer(item, [], { found: false }))).toMatchObject({ found: true, actual: '10px', expectedComputed: '10px' })
    expect(toMeasured({ ...raw, status: 'unresolved', actual: '' }, answer(item, []))).toEqual({ found: false, locatorConfidence: 0.93 })
  })

  it('reads an order check: the labels found, in the order they stand in, and the dock\'s own verdict', () => {
    const moved = reorderItem('r1')
    const inOrder = [KIAMABARA.label, GESHA.label, YIRGACHEFFE.label]
    const behind = [KIAMABARA.label, YIRGACHEFFE.label, GESHA.label]
    expect(toMeasured(rawOrder('pass', inOrder), answer(moved, []))).toEqual({ found: true, locatorConfidence: 0.93, order: { actual: inOrder, inOrder: true } })
    expect(toMeasured(rawOrder('fail', behind), answer(moved, []))).toEqual({ found: true, locatorConfidence: 0.93, order: { actual: behind, inOrder: false } })
    // The labels read in order, the dock says the elements do not stand so: its verdict travels with them.
    expect(toMeasured(rawOrder('fail', inOrder), answer(moved, [])).order).toEqual({ actual: inOrder, inOrder: false })
    // Some neighbours were not found: they are simply not in the list.
    expect(toMeasured(rawOrder('pass', [GESHA.label, YIRGACHEFFE.label]), answer(moved, [])).order).toEqual({ actual: [GESHA.label, YIRGACHEFFE.label], inOrder: true })
    // Found on its own: the judge is told so, and decides.
    expect(toMeasured(rawOrder('unresolved', [GESHA.label]), answer(moved, []))).toEqual({ found: true, locatorConfidence: 0.93, order: { actual: [GESHA.label] } })
    // The check locates its elements itself: what became of the item's recorded target does not decide it.
    expect(toMeasured(rawOrder('pass', inOrder), answer(moved, [], { found: false })).found).toBe(true)
  })

  it('an order check without the moved element, or without two readable lists of the recorded labels, is "not found"', () => {
    const moved = reorderItem('r1')
    const lost = { found: false, locatorConfidence: 0.93 }
    const inOrder = [KIAMABARA.label, GESHA.label, YIRGACHEFFE.label]
    expect(toMeasured(rawOrder('unresolved', [KIAMABARA.label, YIRGACHEFFE.label]), answer(moved, []))).toEqual(lost)
    expect(toMeasured(rawOrder('unresolved', []), answer(moved, []))).toEqual(lost)
    // `unresolved` although the element and a neighbour are listed: the dock was not sure which is which.
    expect(toMeasured(rawOrder('unresolved', inOrder), answer(moved, []))).toEqual(lost)
    for (const actual of ['', 'not json', '{"0":"li"}', '[1,2]', '"li \\"Gesha\\""', JSON.stringify([GESHA.label, 'li "Somebody else"'])]) {
      expect(toMeasured(rawOrder('pass', actual), answer(moved, [])), actual).toEqual(lost)
    }
    for (const expected of ['', 'not json', JSON.stringify([GESHA.label, KIAMABARA.label, YIRGACHEFFE.label]), JSON.stringify([KIAMABARA.label, GESHA.label])]) {
      expect(toMeasured({ ...rawOrder('pass', inOrder), expected }, answer(moved, [])), expected).toEqual(lost)
    }
  })

  it('reads a state that could not be emulated as that, never as a viewport that does not match', () => {
    const hover = hoverItem('h1')
    const blocked = toMeasured(rawHover('not_measurable', '', NOT_EMULATED), answer(hover, []))
    expect(blocked).toEqual({ found: true, locatorConfidence: 0.93, mediaMatches: true, stateBlocked: 'a stylesheet from another origin cannot be read' })
    // The same inside a media query: the dock checked the query first, so it matched.
    expect(toMeasured(rawHover('not_measurable', '', NOT_EMULATED, '(min-width: 768px)'), answer(hoverItem('h2', '(min-width: 768px)'), []))).toMatchObject({ mediaMatches: true, stateBlocked: 'a stylesheet from another origin cannot be read' })
    expect(toMeasured(rawHover('not_measurable', '', 'the state could not be emulated'), answer(hover, [])).stateBlocked).toBe('')
    // A viewport outside the media query keeps its meaning, state or no state.
    const viewport = toMeasured(rawHover('not_measurable', '', 'the viewport (390x844) does not match @media (min-width: 768px)', '(min-width: 768px)'), answer(hover, []))
    expect(viewport.mediaMatches).toBe(false)
    expect(viewport.stateBlocked).toBeUndefined()
    // Measured with the state emulated: an ordinary value.
    expect(toMeasured(rawHover('fail', 'rgb(30, 41, 59)'), answer(hover, []))).toEqual({ found: true, locatorConfidence: 0.93, mediaMatches: true, actual: 'rgb(30, 41, 59)', expectedComputed: 'rgb(15, 23, 42)' })
  })

  it('stateBlockedReason: only a not-measurable computed check under a state, with the agreed start of the note', () => {
    expect(stateBlockedReason(rawHover('not_measurable', '', NOT_EMULATED))).toBe('a stylesheet from another origin cannot be read')
    expect(stateBlockedReason(rawHover('not_measurable', '', 'the state could not be emulated:   2 sheets  '))).toBe('2 sheets')
    expect(stateBlockedReason(rawHover('not_measurable', '', 'the state could not be emulated'))).toBe('')
    expect(stateBlockedReason(rawHover('not_measurable', '', 'the colour scheme is dark'))).toBeUndefined()
    expect(stateBlockedReason(rawHover('not_measurable', '', 'The state could not be emulated: x'))).toBeUndefined()
    expect(stateBlockedReason(rawHover('fail', 'rgb(30, 41, 59)', NOT_EMULATED))).toBeUndefined()
    expect(stateBlockedReason({ ...rawHover('not_measurable', ''), note: undefined })).toBeUndefined()
    // The same note on a check that has no state is not the dock speaking about a state.
    expect(stateBlockedReason({ ...rawComputed(computed, '', 'not_measurable'), note: NOT_EMULATED })).toBeUndefined()
  })

  it('reads absent and hidden checks from the three words the probe sends', () => {
    const gone = structureItem('c2')
    const absent = gone.expect[0] as Expectation
    const make = (actual: string, found = true) => toMeasured({ expectation: absent, status: 'fail', expected: 'absent', actual }, answer(gone, [], { found }))
    expect(make('absent', false)).toMatchObject({ present: false, rendered: false })
    expect(make('hidden')).toMatchObject({ present: true, rendered: false })
    expect(make('rendered')).toMatchObject({ present: true, rendered: true })
  })
})

describe('createVerifier', () => {
  const claimed = (id: string, over: Partial<ChangeItem> = {}): ChangeItem => styleItem(id, 'src/components/Header.tsx', { status: 'claimed', batchId: 'b1', ...over } as never)

  it('passes a change whose computed value is the requested one and marks it verified', async () => {
    const item = claimed('c1')
    const { session, items } = fakeSession([item], (wanted) => measuredWith(wanted.map((it) => answer(it, [rawComputed(it.expect[0] as Expectation, '24px', 'pass')]))))
    const { detector } = fakeDetector(settled())
    const outcome = await createVerifier({ session, detector, sleep: noSleep, now: () => 42 }).verify()
    expect(outcome.results).toHaveLength(1)
    expect(outcome.results[0]).toMatchObject({ itemId: 'c1', status: 'pass', attempt: 1, at: 42 })
    expect(outcome.counts).toEqual({ pass: 1 })
    expect(outcome.fixup).toBe('')
    expect(items.get('c1')?.status).toBe('verified')
    expect(items.get('c1')?.verification?.status).toBe('pass')
  })

  it('a change taken back (a draft again) while it was being checked keeps its draft status: the result is dropped', async () => {
    const item = { ...claimed('c1'), status: 'queued' as const }
    const { session, items } = fakeSession([item], (wanted) => {
      // The person presses Take back while the page is measured.
      const stored = items.get('c1')!
      items.set('c1', { ...stored, status: 'draft' })
      return measuredWith(wanted.map((it) => answer(it, [rawComputed(it.expect[0] as Expectation, '24px', 'pass')])))
    })
    const { detector } = fakeDetector(settled())
    const outcome = await createVerifier({ session, detector, sleep: noSleep }).verify({ ids: ['c1'] })
    expect(outcome.results).toEqual([])
    expect(items.get('c1')?.status).toBe('draft')
    expect(items.get('c1')?.verification).toBeUndefined()
  })

  it('a change taken back and sent again unchanged while it was being checked (the same object, a new batch) is not judged by the old check', async () => {
    const item = { ...claimed('c1'), status: 'queued' as const, batchId: 'batch-a' }
    const { session, items } = fakeSession([item], (wanted) => {
      const stored = items.get('c1')!
      // The session changes its item in place: Take back, then Send again.
      stored.status = 'queued'
      stored.batchId = 'batch-b'
      return measuredWith(wanted.map((it) => answer(it, [rawComputed(it.expect[0] as Expectation, '24px', 'pass')])))
    })
    const { detector } = fakeDetector(settled())
    const outcome = await createVerifier({ session, detector, sleep: noSleep }).verify({ ids: ['c1'] })
    expect(outcome.results).toEqual([])
    expect(items.get('c1')?.verification).toBeUndefined()
  })

  it('fails a change that is unchanged, names expected and actual, and returns a fix-up prompt', async () => {
    const item = claimed('c1')
    const { session, items } = fakeSession([item], (wanted) => measuredWith(wanted.map((it) => answer(it, [rawComputed(it.expect[0] as Expectation, '16px')]))))
    const { detector } = fakeDetector(settled())
    const outcome = await createVerifier({ session, detector, sleep: noSleep }).verify({ ids: ['c1'] })
    expect(outcome.results[0]?.status).toBe('fail')
    expect(outcome.results[0]?.checks[0]).toMatchObject({ status: 'fail', expected: '24px', actual: '16px' })
    expect(outcome.fixup).toContain('c1')
    expect(outcome.fixup).toContain('24px')
    expect(items.get('c1')?.status).toBe('failed')
  })

  it('reports drift when the value landed near the target and still counts the change as verified', async () => {
    const item = claimed('c1', {
      before: { authored: '12px', computed: '12px' },
      after: { authored: '17px', computed: '17px' },
      expect: [{ type: 'computed', property: 'padding-top', value: '17px', condition: styleItem('x').condition }],
    } as never)
    const { session, items } = fakeSession([item], (wanted) => measuredWith(wanted.map((it) => answer(it, [rawComputed(it.expect[0] as Expectation, '16px')]))))
    const { detector } = fakeDetector(settled())
    const outcome = await createVerifier({ session, detector, sleep: noSleep }).verify()
    expect(outcome.results[0]?.status).toBe('drift')
    expect(items.get('c1')?.status).toBe('verified')
    expect(outcome.fixup).not.toBe('')
  })

  it('counts attempts across runs', async () => {
    const item = claimed('c1')
    const { session } = fakeSession([item], (wanted) => measuredWith(wanted.map((it) => answer(it, [rawComputed(it.expect[0] as Expectation, '16px')]))))
    const { detector } = fakeDetector(settled())
    const verifier = createVerifier({ session, detector, sleep: noSleep })
    expect((await verifier.verify()).results[0]?.attempt).toBe(1)
    expect((await verifier.verify()).results[0]?.attempt).toBe(2)
  })

  it('never passes without a browser, and leaves the item claimed', async () => {
    const item = claimed('c1')
    const { session, items } = fakeSession([item], () => ({ status: 'no_browser' }))
    const { detector } = fakeDetector(settled({ browser: false }))
    const outcome = await createVerifier({ session, detector, sleep: noSleep }).verify()
    expect(outcome.results[0]?.status).toBe('no_browser')
    expect(items.get('c1')?.status).toBe('claimed')
    expect(items.get('c1')?.verification?.status).toBe('no_browser')
  })

  it('reports tab_hidden when the tab measured while hidden, even if every value matched', async () => {
    const item = claimed('c1')
    const { session, items } = fakeSession([item], (wanted) =>
      measuredWith(wanted.map((it) => answer(it, [rawComputed(it.expect[0] as Expectation, '24px', 'pass')])), false),
    )
    const { detector } = fakeDetector(settled())
    const outcome = await createVerifier({ session, detector, sleep: noSleep }).verify()
    expect(outcome.results[0]?.status).toBe('tab_hidden')
    expect(items.get('c1')?.status).toBe('claimed')
  })

  it('reports tab_hidden when a hidden tab does not answer, and no_browser when a visible one does not', async () => {
    const run = async (visible: boolean) => {
      const { session } = fakeSession([claimed('c1')], () => ({ status: 'timeout', doc: 'doc-1', visible }))
      const { detector } = fakeDetector(settled())
      return (await createVerifier({ session, detector, sleep: noSleep }).verify()).results[0]?.status
    }
    expect(await run(false)).toBe('tab_hidden')
    expect(await run(true)).toBe('no_browser')
  })

  it('does not measure a broken build and reports build_error with the message in the hint', async () => {
    const item = claimed('c1')
    const { session, items, measured } = fakeSession([item], () => ({ status: 'no_browser' }))
    const { detector } = fakeDetector(
      settled({ status: 'build_error', error: { message: 'Unexpected token (12:4)', file: 'src/components/Header.tsx', line: 12 }, reason: 'the dev server reports an error' }),
    )
    const outcome = await createVerifier({ session, detector, sleep: noSleep }).verify()
    expect(measured).toHaveLength(0)
    expect(outcome.results[0]?.status).toBe('build_error')
    expect(outcome.results[0]?.hint).toContain('Unexpected token')
    expect(items.get('c1')?.status).toBe('failed')
  })

  it('reports no_update_observed when nothing changed and the value is not there, but passes when it already is', async () => {
    const nothing = settled({ status: 'no_update_observed', signal: 'timeout', filesChanged: [], domChanged: false, reason: 'no file changed' })
    const run = async (actual: string) => {
      const { session } = fakeSession([claimed('c1')], (wanted) => measuredWith(wanted.map((it) => answer(it, [rawComputed(it.expect[0] as Expectation, actual)]))))
      const { detector } = fakeDetector(nothing)
      return (await createVerifier({ session, detector, sleep: noSleep }).verify()).results[0]?.status
    }
    expect(await run('16px')).toBe('no_update_observed')
    expect(await run('24px')).toBe('pass')
  })

  it('reloads a page that has no hot reload when the source changed, then measures the new page', async () => {
    const answers = [
      settled({ status: 'no_update_observed', signal: 'timeout', domChanged: false, filesChanged: ['css/site.css'], reason: 'files changed but the page did not' }),
      settled({ signal: 'mutation-quiet', filesChanged: [], reason: 'the page loaded and is quiet' }),
    ]
    const { session, reloads, items } = fakeSession([claimed('c1')], (wanted) => measuredWith(wanted.map((it) => answer(it, [rawComputed(it.expect[0] as Expectation, '24px', 'pass')]))))
    const fake = fakeDetector(() => answers.shift() as SettleResult)
    const outcome = await createVerifier({ session, detector: fake.detector, sleep: noSleep }).verify()
    expect(reloads).toHaveLength(1)
    expect(fake.calls[1]).toEqual({ since: { seq: 99, at: 9999 }, timeoutMs: 1500 })
    expect(outcome.results[0]?.status).toBe('pass')
    expect(outcome.results[0]?.settle?.status).toBe('settled')
    expect(outcome.results[0]?.settle?.filesChanged).toEqual(['css/site.css'])
    expect(items.get('c1')?.status).toBe('verified')
  })

  it('after such a reload a value that is still wrong is a fail, not "no update"', async () => {
    const answers = [settled({ status: 'no_update_observed', signal: 'timeout', domChanged: false, filesChanged: ['css/site.css'] }), settled({ status: 'no_update_observed', signal: 'timeout', domChanged: false, filesChanged: [] })]
    const { session } = fakeSession([claimed('c1')], (wanted) => measuredWith(wanted.map((it) => answer(it, [rawComputed(it.expect[0] as Expectation, '20px')]))))
    const fake = fakeDetector(() => answers.shift() as SettleResult)
    const outcome = await createVerifier({ session, detector: fake.detector, sleep: noSleep }).verify()
    expect(outcome.results[0]?.status).toBe('fail')
  })

  it('on a server without hot reload it reloads at once when a source file is newer than the page, without waiting out the settle timeout', async () => {
    const { session, reloads } = fakeSession([claimed('c1')], (wanted) => measuredWith(wanted.map((it) => answer(it, [rawComputed(it.expect[0] as Expectation, '24px', 'pass')]))))
    const fake = fakeDetector(settled({ signal: 'mutation-quiet', filesChanged: [] }))
    fake.entries.push({ seq: 1, at: 1_750_000_001_000, source: 'fs', event: 'change', path: 'css/site.css', mtimeMs: 1_750_000_000_990 })
    const outcome = await createVerifier({ session, detector: fake.detector, sleep: noSleep, hotReload: () => false }).verify()
    expect(reloads).toHaveLength(1)
    // One wait only: for the reloaded page. The ordinary settle wait was skipped.
    expect(fake.calls).toEqual([{ since: { seq: 99, at: 9999 }, timeoutMs: 1500 }])
    expect(outcome.results[0]?.status).toBe('pass')
    expect(outcome.results[0]?.settle).toMatchObject({ status: 'settled', signal: 'fs', filesChanged: ['css/site.css'] })
  })

  it('on a server without hot reload it does not reload a page that is newer than the last source change', async () => {
    const { session, reloads } = fakeSession([claimed('c1')], (wanted) => measuredWith(wanted.map((it) => answer(it, [rawComputed(it.expect[0] as Expectation, '24px', 'pass')]))))
    const fake = fakeDetector(settled({ signal: 'mutation-quiet' }))
    // Journalled inside the window, but written before the document in the tab connected (at 1000 in this fake).
    fake.entries.push({ seq: 1, at: 1_750_000_001_000, source: 'fs', event: 'change', path: 'css/site.css', mtimeMs: 500 })
    await createVerifier({ session, detector: fake.detector, sleep: noSleep, hotReload: () => false }).verify()
    expect(reloads).toHaveLength(0)
  })

  it('does not reload when no source file changed', async () => {
    const { session, reloads } = fakeSession([claimed('c1')], (wanted) => measuredWith(wanted.map((it) => answer(it, [rawComputed(it.expect[0] as Expectation, '16px')]))))
    const fake = fakeDetector(settled({ status: 'no_update_observed', signal: 'timeout', domChanged: false, filesChanged: [] }))
    const outcome = await createVerifier({ session, detector: fake.detector, sleep: noSleep }).verify()
    expect(reloads).toHaveLength(0)
    expect(outcome.results[0]?.status).toBe('no_update_observed')
  })

  it('reports unresolved when the element was not found again', async () => {
    const { session, items } = fakeSession([claimed('c1')], (wanted) =>
      measuredWith(wanted.map((it) => answer(it, [rawComputed(it.expect[0] as Expectation, '', 'unresolved')], { found: false, locatorConfidence: 0.2 }))),
    )
    const { detector } = fakeDetector(settled())
    const outcome = await createVerifier({ session, detector, sleep: noSleep }).verify()
    expect(outcome.results[0]?.status).toBe('unresolved')
    expect(items.get('c1')?.status).toBe('failed')
  })

  describe('bystanders', () => {
    const secondary = { label: 'a.btn "See this week\'s beans"', selector: 'div.hero-actions > a:nth-of-type(2)', locator: { tag: 'a', indexPath: [1, 0, 2, 1], ancestors: ['body', 'main', 'section', 'div'], text: "See this week's beans" } }
    const unchanged: Expectation = { type: 'unchanged', ...secondary, property: 'padding-top', value: '16px' }
    const withBystander = (): ChangeItem =>
      claimed('c1', {
        scope: 'all-instances',
        origin: { via: 'rule', selector: '.btn', sheet: 'css/site.css', alsoStyles: 1 },
        bystanders: [{ ...secondary, values: { 'padding-top': '16px' } }],
        expect: [styleItem('x').expect[0] as Expectation, unchanged],
      } as never)
    /** The target landed on 24px; the bystander is reported by the dock as given. */
    const run = async (bystander: Pick<CheckResult, 'status' | 'actual'> & { note?: string }) => {
      const state = fakeSession([withBystander()], (wanted) =>
        measuredWith(wanted.map((it) => answer(it, [rawComputed(it.expect[0] as Expectation, '24px', 'pass'), { expectation: unchanged, expected: '16px', ...bystander }]))),
      )
      const { detector } = fakeDetector(settled())
      const outcome = await createVerifier({ session: state.session, detector, sleep: noSleep }).verify()
      return { outcome, result: outcome.results[0], item: state.items.get('c1') }
    }

    it('the target passes but the bystander changed: fail, the item is failed, and the fix-up names the bystander', async () => {
      const { outcome, result, item } = await run({ status: 'fail', actual: '24px' })
      expect(result?.status).toBe('fail')
      expect(result?.checks.map((check) => [check.expectation.type, check.status])).toEqual([
        ['computed', 'pass'],
        ['unchanged', 'fail'],
      ])
      expect(result?.checks[1]).toMatchObject({ expected: '16px', actual: '24px', delta: 8, note: 'changed from 16px to 24px although it was not part of this edit' })
      expect(result?.hint).toBe(
        '`a.btn "See this week\'s beans"` was not part of this change, but its `padding-top` went from `16px` to `24px`. The rule you edited is shared: restore it and make the change with a more specific rule or a class on the changed element(s).',
      )
      expect(item?.status).toBe('failed')
      expect(outcome.counts).toEqual({ fail: 1 })
      expect(outcome.fixup).toContain('### `c1` fail:')
      expect(outcome.fixup).toContain('- Found (1 other check passed): `a.btn "See this week\'s beans"` was not part of this change, but its `padding-top` went from `16px` to `24px`. The rule you edited is shared')
      expect(outcome.fixup).toContain('That rule also styles 1 other element, which is NOT part of this change')
    })

    it('the bystander changed because another sent change edits it on purpose: not held against this change', async () => {
      // The developer changed the primary button, then the secondary one too.
      const other = styleItem('c2', 'index.html', { status: 'claimed', batchId: 'b2', property: 'padding', longhands: { 'padding-top': { before: '16px', after: '24px' } } } as never)
      other.target = { ...other.target, selector: secondary.selector }
      const state = fakeSession([withBystander(), other], (wanted) =>
        measuredWith(wanted.map((it) => (it.id === 'c1' ? answer(it, [rawComputed(it.expect[0] as Expectation, '24px', 'pass'), { expectation: unchanged, status: 'fail', expected: '16px', actual: '24px' }]) : answer(it, [rawComputed(it.expect[0] as Expectation, '24px', 'pass')])))),
      )
      const { detector } = fakeDetector(settled())
      const outcome = await createVerifier({ session: state.session, detector, sleep: noSleep }).verify({ ids: ['c1'] })
      expect(outcome.results[0]?.status).toBe('pass')
      const bystander = outcome.results[0]?.checks.find((check) => check.expectation.type === 'unchanged')
      expect(bystander?.status).toBe('pass')
      expect(bystander?.note).toContain('c2')
    })

    it('a draft or dismissed change on the bystander does not excuse it', async () => {
      const draft = styleItem('c2', 'index.html', { status: 'draft', property: 'padding-top' })
      draft.target = { ...draft.target, selector: secondary.selector }
      const state = fakeSession([withBystander(), draft], (wanted) =>
        measuredWith(wanted.map((it) => answer(it, [rawComputed(it.expect[0] as Expectation, '24px', 'pass'), { expectation: unchanged, status: 'fail', expected: '16px', actual: '24px' }]))),
      )
      const { detector } = fakeDetector(settled())
      const outcome = await createVerifier({ session: state.session, detector, sleep: noSleep }).verify({ ids: ['c1'] })
      expect(outcome.results[0]?.status).toBe('fail')
    })

    it('the bystander kept its value: pass, the item is verified, no fix-up', async () => {
      const { outcome, result, item } = await run({ status: 'pass', actual: '16px' })
      expect(result?.status).toBe('pass')
      expect(result?.checks.map((check) => check.status)).toEqual(['pass', 'pass'])
      expect(result?.checks[1]?.note).toBeUndefined()
      expect(result?.hint).toBe('All 2 checks pass.')
      expect(item?.status).toBe('verified')
      expect(outcome.fixup).toBe('')
    })

    it('a value the dock calls different but the judge calls equal passes (the tolerances are the judge\'s)', async () => {
      const { result } = await run({ status: 'fail', actual: '16.3px' })
      expect(result?.status).toBe('pass')
    })

    it('the bystander was not found again: pass, with the note that it was not checked', async () => {
      const { outcome, result, item } = await run({ status: 'unresolved', actual: '', note: 'a.btn was not found again' })
      expect(result?.status).toBe('pass')
      expect(result?.checks[1]).toMatchObject({ status: 'pass', note: 'not checked: the element could not be found again' })
      expect(result?.hint).toContain('One of them was not measured')
      expect(item?.status).toBe('verified')
      expect(outcome.fixup).toBe('')
    })

    it('a bystander that changed does not hide that the target was not found', async () => {
      const state = fakeSession([withBystander()], (wanted) =>
        measuredWith(
          wanted.map((it) =>
            answer(it, [rawComputed(it.expect[0] as Expectation, '', 'unresolved'), { expectation: unchanged, status: 'fail', expected: '16px', actual: '24px' }], { found: false, locatorConfidence: 0.2 }),
          ),
        ),
      )
      const { detector } = fakeDetector(settled())
      const result = (await createVerifier({ session: state.session, detector, sleep: noSleep }).verify()).results[0]
      expect(result?.status).toBe('unresolved')
      // The bystander was still measured on its own.
      expect(result?.checks[1]).toMatchObject({ status: 'fail', actual: '24px' })
    })
  })

  describe('reorder', () => {
    const run = async (raw: CheckResult, over: Partial<MeasuredItem> = {}) => {
      const state = fakeSession([reorderItem('r1')], (wanted) => measuredWith(wanted.map((it) => answer(it, [raw], over))))
      const { detector } = fakeDetector(settled({ filesChanged: ['src/data/beans.json'] }))
      const outcome = await createVerifier({ session: state.session, detector, sleep: noSleep }).verify()
      return { outcome, result: outcome.results[0], item: state.items.get('r1') }
    }

    it('the element stands between the two neighbours: pass, the item is verified, no fix-up', async () => {
      const { outcome, result, item } = await run(rawOrder('pass', [KIAMABARA.label, GESHA.label, YIRGACHEFFE.label]))
      expect(result?.status).toBe('pass')
      expect(result?.checks[0]).toMatchObject({ status: 'pass', expected: WANTED, actual: WANTED })
      expect(result?.checks[0]?.note).toBeUndefined()
      expect(result?.hint).toBe('The check passes.')
      expect(item?.status).toBe('verified')
      expect(outcome.fixup).toBe('')
    })

    it('one neighbour was not found again, the other is on the right side: pass, and the hint says what it rests on', async () => {
      const { result, item } = await run(rawOrder('pass', [KIAMABARA.label, GESHA.label]))
      expect(result?.status).toBe('pass')
      expect(result?.checks[0]?.note).toBe('1 of 2 neighbours could not be found again')
      expect(result?.hint).toBe('The check passes. The new position was checked against fewer elements than recorded: 1 of 2 neighbours could not be found again.')
      expect(item?.status).toBe('verified')
    })

    it('the element is somewhere else: fail, the item is failed, and the fix-up names both orders', async () => {
      const { outcome, result, item } = await run(rawOrder('fail', [KIAMABARA.label, YIRGACHEFFE.label, GESHA.label]))
      expect(result?.status).toBe('fail')
      expect(result?.checks[0]).toMatchObject({ status: 'fail', expected: WANTED, note: 'the order in the page is li "Kiamabara", then li "Yirgacheffe", then li "Gesha"' })
      expect(result?.hint).toBe(
        'The element is not where it was moved to: the order in the page is `li "Kiamabara"`, `li "Yirgacheffe"`, `li "Gesha"`; the wanted order is `li "Kiamabara"`, `li "Gesha"` (the moved element), `li "Yirgacheffe"`. Change the order in the source; if these elements come from a list or array, reorder the data, not the markup of one item.',
      )
      expect(item?.status).toBe('failed')
      expect(outcome.counts).toEqual({ fail: 1 })
      expect(outcome.fixup).toContain('### `r1` fail: move element')
      expect(outcome.fixup).toContain('- Do: move this element so that it comes after `li "Kiamabara"` and before `li "Yirgacheffe"`.')
      expect(outcome.fixup).toContain('- Found: The element is not where it was moved to')
    })

    it('labels in the wanted order do not pass when the dock says the elements do not stand that way', async () => {
      const { result, item } = await run(rawOrder('fail', [KIAMABARA.label, GESHA.label, YIRGACHEFFE.label]))
      expect(result?.status).toBe('fail')
      expect(result?.checks[0]?.note).toBe('the page does not have these elements in this order under one parent')
      expect(item?.status).toBe('failed')
    })

    it('a wrong order does not pass because the dock said pass', async () => {
      const { result } = await run(rawOrder('pass', [GESHA.label, KIAMABARA.label, YIRGACHEFFE.label]))
      expect(result?.status).toBe('fail')
    })

    it('the moved element was not found again: unresolved, with the sentence about the element', async () => {
      const { result, item } = await run(rawOrder('unresolved', [KIAMABARA.label, YIRGACHEFFE.label], 'the moved element was not found again'), { found: false, locatorConfidence: 0.2 })
      expect(result?.status).toBe('unresolved')
      expect(result?.checks[0]).toMatchObject({ status: 'unresolved', actual: 'element not found' })
      expect(result?.hint).toContain('The element `button.btn "Sign in"` could not be found again after the edit')
      expect(item?.status).toBe('failed')
    })

    it('only the moved element was found: unresolved, and the hint is about the neighbours', async () => {
      const { result, item } = await run(rawOrder('unresolved', [GESHA.label]))
      expect(result?.status).toBe('unresolved')
      expect(result?.checks[0]).toMatchObject({ status: 'unresolved', note: 'none of the siblings it was placed next to could be found again' })
      expect(result?.hint).toBe(
        'The new position of the element could not be checked: none of the 2 siblings it was placed next to could be found again. If you renamed those siblings or changed their content, that is why; otherwise ask the user to check the order by eye.',
      )
      expect(item?.status).toBe('failed')
    })

    it('an answer that is not two lists of labels is unresolved, never pass', async () => {
      for (const raw of [rawOrder('pass', 'not json'), rawOrder('pass', ''), { ...rawOrder('pass', [KIAMABARA.label, GESHA.label, YIRGACHEFFE.label]), expected: '' }]) {
        expect((await run(raw)).result?.status).toBe('unresolved')
      }
    })

    it('nothing changed in the source and the order is not there: no_update_observed', async () => {
      const state = fakeSession([reorderItem('r1')], (wanted) => measuredWith(wanted.map((it) => answer(it, [rawOrder('fail', [KIAMABARA.label, YIRGACHEFFE.label, GESHA.label])]))))
      const { detector } = fakeDetector(settled({ status: 'no_update_observed', signal: 'timeout', filesChanged: [], domChanged: false }))
      const outcome = await createVerifier({ session: state.session, detector, sleep: noSleep }).verify()
      expect(outcome.results[0]?.status).toBe('no_update_observed')
      expect(outcome.fixup).toContain('- Do: move this element so that it comes after')
    })
  })

  describe('a change made for an interaction state', () => {
    const run = async (raw: CheckResult, item: ChangeItem = hoverItem('h1'), others: ChangeItem[] = []) => {
      const state = fakeSession([item, ...others], (wanted) => measuredWith(wanted.map((it) => answer(it, [raw]))))
      const { detector } = fakeDetector(settled({ filesChanged: ['src/styles/site.css'] }))
      const outcome = await createVerifier({ session: state.session, detector, sleep: noSleep }).verify({ ids: [item.id] })
      return { outcome, result: outcome.results[0], item: state.items.get(item.id) }
    }

    it('measured with the state emulated and on target: pass, the item is verified', async () => {
      const { outcome, result, item } = await run(rawHover('pass', 'rgb(15, 23, 42)'))
      expect(result?.status).toBe('pass')
      expect(item?.status).toBe('verified')
      expect(outcome.fixup).toBe('')
    })

    it('measured with the state emulated and still the old value: fail, the item is failed, and the hint is about the state', async () => {
      const { outcome, result, item } = await run(rawHover('fail', 'rgb(30, 41, 59)'))
      expect(result?.status).toBe('fail')
      expect(result?.checks[0]).toMatchObject({ status: 'fail', expected: 'rgb(15, 23, 42)', actual: 'rgb(30, 41, 59)', note: 'unchanged' })
      expect(result?.hint).toContain('`background-color` in the `:hover` state is still `rgb(30, 41, 59)` (unchanged); expected `rgb(15, 23, 42)`.')
      expect(result?.hint).toContain('if you changed the resting style instead, restore it')
      expect(item?.status).toBe('failed')
      expect(outcome.fixup).toContain('### `h1` fail: `background-color` on `:hover`:')
      expect(outcome.fixup).toContain('- Condition: only in the `:hover` state. Do not change the resting style.')
    })

    it('another value than the one asked for: fail, with the state in the advice', async () => {
      const { result, item } = await run(rawHover('fail', 'rgb(239, 68, 68)'))
      expect(result?.status).toBe('fail')
      expect(result?.hint).toContain('Make it compute to `rgb(15, 23, 42)` in the `:hover` state.')
      expect(item?.status).toBe('failed')
    })

    it('the state could not be emulated: not_measurable, the item stays as it was, and nothing is said about the viewport', async () => {
      const { outcome, result, item } = await run(rawHover('not_measurable', '', NOT_EMULATED))
      expect(result?.status).toBe('not_measurable')
      expect(result?.checks[0]).toMatchObject({ status: 'not_measurable', note: NOT_EMULATED })
      expect(result?.hint).toBe(
        'Not checked: primp could not emulate the `:hover` state on this page (reason: `a stylesheet from another origin cannot be read`), so `background-color` in that state was not measured (expected `rgb(15, 23, 42)`). That is a limit of the measurement, not a fault found in your edit, and verifying again will not change it: ask the user to check this state by eye.',
      )
      expect(item?.status).toBe('claimed')
      expect(item?.verification?.status).toBe('not_measurable')
      expect(outcome.counts).toEqual({ not_measurable: 1 })
      expect(outcome.fixup).toContain('### `h1` not measurable:')
      expect(`${result?.hint} ${outcome.fixup}`).not.toMatch(/viewport|Resize the browser|does not match/)
    })

    it('the same inside a media query that matches: still the state, not the viewport', async () => {
      const media = '(min-width: 768px)'
      const { result, item } = await run(rawHover('not_measurable', '', NOT_EMULATED, media), hoverItem('h1', media))
      expect(result?.status).toBe('not_measurable')
      expect(result?.checks[0]?.note).toBe(NOT_EMULATED)
      expect(result?.hint).toContain('could not emulate the `:hover` state')
      expect(result?.hint).not.toMatch(/viewport|Resize/)
      expect(item?.status).toBe('claimed')
    })

    it('a state change outside its media query is the viewport\'s doing, as for any other change', async () => {
      const media = '(min-width: 768px)'
      const { result, item } = await run(rawHover('not_measurable', '', `the viewport (390x844) does not match @media ${media}`, media), hoverItem('h1', media))
      expect(result?.status).toBe('not_measurable')
      expect(result?.checks[0]?.note).toBe('the viewport does not match @media (min-width: 768px)')
      expect(result?.hint).toBe(
        'Could not be checked at the current viewport: `@media (min-width: 768px)` does not match (expected `background-color` `rgb(15, 23, 42)` in the `:hover` state). Resize the browser so that the query matches, then verify again.',
      )
      expect(item?.status).toBe('claimed')
    })

    it('an item that had failed before stays failed when its state cannot be emulated: nothing new was learned', async () => {
      const { result, item } = await run(rawHover('not_measurable', '', NOT_EMULATED), hoverItem('h1', undefined, { status: 'failed' }))
      expect(result?.status).toBe('not_measurable')
      expect(item?.status).toBe('failed')
    })

    it('any other reason the dock gives for not measuring is passed through with its note', async () => {
      const { result, item } = await run(rawHover('not_measurable', '', 'the page is printing'))
      expect(result?.status).toBe('not_measurable')
      expect(result?.checks[0]?.note).toBe('the page is printing')
      expect(item?.status).toBe('claimed')
    })
  })

  describe('bystanders and states', () => {
    const secondary = { label: 'a.btn "Docs"', selector: 'nav > a:nth-of-type(2)', locator: { tag: 'a', indexPath: [0, 1], ancestors: ['body', 'nav'], text: 'Docs' } }
    const unchanged: Expectation = { type: 'unchanged', ...secondary, property: 'background-color', value: 'rgb(255, 255, 255)' }
    /** A resting change of the background whose shared rule also styles `secondary`; the agent's edit dragged it along. */
    const resting = (): ChangeItem =>
      styleItem('c1', 'src/components/Header.tsx', {
        status: 'claimed',
        batchId: 'b1',
        property: 'background-color',
        before: { authored: '#fff', computed: 'rgb(255, 255, 255)' },
        after: { authored: '#0f172a', computed: 'rgb(15, 23, 42)' },
        bystanders: [{ ...secondary, values: { 'background-color': 'rgb(255, 255, 255)' } }],
        expect: [{ type: 'computed', property: 'background-color', value: 'rgb(15, 23, 42)', condition: styleItem('x').condition }, unchanged],
      } as never)
    const onBystander = (over: Partial<ChangeItem>): ChangeItem => {
      const other = styleItem('c2', 'src/components/Header.tsx', { status: 'claimed', batchId: 'b2', property: 'background-color', ...over } as never)
      other.target = { ...other.target, selector: secondary.selector }
      return other
    }
    const run = async (other: ChangeItem) => {
      const state = fakeSession([resting(), other], (wanted) =>
        measuredWith(
          wanted.map((it) =>
            answer(it, [
              { expectation: it.expect[0] as Expectation, status: 'pass', expected: 'rgb(15, 23, 42)', actual: 'rgb(15, 23, 42)' },
              { expectation: unchanged, status: 'fail', expected: 'rgb(255, 255, 255)', actual: 'rgb(15, 23, 42)' },
            ]),
          ),
        ),
      )
      const { detector } = fakeDetector(settled())
      return (await createVerifier({ session: state.session, detector, sleep: noSleep }).verify({ ids: ['c1'] })).results[0]
    }

    it('a resting change of the same property on the bystander explains its new value', async () => {
      const result = await run(onBystander({}))
      expect(result?.status).toBe('pass')
      expect(result?.checks[1]?.note).toContain('c2')
    })

    it('a :hover change of that property does not: the resting value was not meant to move', async () => {
      const result = await run(onBystander({ condition: HOVER } as never))
      expect(result?.status).toBe('fail')
      expect(result?.checks[1]).toMatchObject({ status: 'fail', expected: 'rgb(255, 255, 255)', actual: 'rgb(15, 23, 42)' })
      expect(result?.hint).toContain('`a.btn "Docs"` was not part of this change, but its `background-color` went from `rgb(255, 255, 255)` to `rgb(15, 23, 42)`')
    })
  })

  it('does not take an ambiguous match for a removed element as proof that it is gone', async () => {
    const gone = structureItem('r1', 'src/components/Banner.tsx', { status: 'claimed', batchId: 'b1' })
    const { session, items } = fakeSession([gone], (wanted) =>
      measuredWith(wanted.map((it) => answer(it, [{ expectation: it.expect[0] as Expectation, status: 'unresolved', expected: 'absent', actual: '', note: 'more than one element could be the recorded one' }], { found: false, locatorConfidence: 0.6 }))),
    )
    const { detector } = fakeDetector(settled())
    const outcome = await createVerifier({ session, detector, sleep: noSleep }).verify()
    expect(outcome.results[0]?.status).toBe('unresolved')
    expect(items.get('r1')?.status).toBe('failed')
  })

  it('passes a removed element that is really gone', async () => {
    const gone = structureItem('r1', 'src/components/Banner.tsx', { status: 'claimed', batchId: 'b1' })
    const { session } = fakeSession([gone], (wanted) => measuredWith(wanted.map((it) => answer(it, [{ expectation: it.expect[0] as Expectation, status: 'pass', expected: 'absent', actual: 'absent' }], { found: false, locatorConfidence: 0 }))))
    const { detector } = fakeDetector(settled())
    expect((await createVerifier({ session, detector, sleep: noSleep }).verify()).results[0]?.status).toBe('pass')
  })

  it('reports not_measurable for a media-scoped change outside its viewport and leaves the item claimed', async () => {
    const { session, items } = fakeSession([claimed('c1')], (wanted) =>
      measuredWith(wanted.map((it) => answer(it, [rawComputed(it.expect[0] as Expectation, '', 'not_measurable')]))),
    )
    const { detector } = fakeDetector(settled())
    const outcome = await createVerifier({ session, detector, sleep: noSleep }).verify()
    expect(outcome.results[0]?.status).toBe('not_measurable')
    expect(items.get('c1')?.status).toBe('claimed')
  })

  it('lets the judge explain a media query that does not match', async () => {
    const media = { ...styleItem('x').condition, media: '(min-width: 768px)' }
    const item = claimed('c1', { condition: media, expect: [{ type: 'computed', property: 'padding-top', value: '24px', condition: media }] } as never)
    const { session } = fakeSession([item], (wanted) => measuredWith(wanted.map((it) => answer(it, [rawComputed(it.expect[0] as Expectation, '', 'not_measurable')]))))
    const { detector } = fakeDetector(settled())
    const outcome = await createVerifier({ session, detector, sleep: noSleep }).verify()
    expect(outcome.results[0]?.status).toBe('not_measurable')
    expect(outcome.results[0]?.hint).toContain('768px')
  })

  it('anchors the settle window at the claim mark of the batch, falling back to when it was sent', async () => {
    const first = fakeSession([claimed('c1')], () => ({ status: 'no_browser' }))
    first.batches.set('b1', { batchId: 'b1', itemIds: ['c1'], sentAt: 1000, sentFrom: 'doc-1', claimedAt: 2000, claimMark: { seq: 7, at: 2000 } })
    const withMark = fakeDetector(settled())
    await createVerifier({ session: first.session, detector: withMark.detector, sleep: noSleep }).verify({ waitMs: 800 })
    expect(withMark.calls[0]).toEqual({ since: { seq: 7, at: 2000 }, timeoutMs: 800 })

    const second = fakeSession([styleItem('c2', 'a.tsx', { status: 'queued', batchId: 'b2' })], () => ({ status: 'no_browser' }))
    second.batches.set('b2', { batchId: 'b2', itemIds: ['c2'], sentAt: 5000, sentFrom: 'doc-1' })
    const sentOnly = fakeDetector(settled())
    await createVerifier({ session: second.session, detector: sentOnly.detector, sleep: noSleep }).verify()
    expect(sentOnly.calls[0]).toEqual({ since: 5000, timeoutMs: 5000 })
  })

  it('verifies only what is out: drafts and dismissed changes are skipped, unknown ids are named', async () => {
    const { session, measured } = fakeSession(
      [styleItem('d1'), styleItem('x1', 'a.tsx', { status: 'dismissed' }), claimed('c1')],
      (wanted) => measuredWith(wanted.map((it) => answer(it, [rawComputed(it.expect[0] as Expectation, '24px', 'pass')]))),
    )
    const { detector } = fakeDetector(settled())
    const verifier = createVerifier({ session, detector, sleep: noSleep })
    expect((await verifier.verify()).results.map((result) => result.itemId)).toEqual(['c1'])
    expect(measured).toEqual([['c1']])
    expect((await verifier.verify({ ids: ['d1', 'x1'] })).results).toEqual([])
    const unknown = await verifier.verify({ ids: ['nope'] })
    expect(unknown.results).toEqual([])
    expect(unknown.summary).toContain('nope')
  })

  it('runs one verification at a time', async () => {
    let active = 0
    let peak = 0
    const { session } = fakeSession([claimed('c1')], async (wanted) => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 15))
      active -= 1
      return measuredWith(wanted.map((it) => answer(it, [rawComputed(it.expect[0] as Expectation, '24px', 'pass')])))
    })
    const { detector } = fakeDetector(settled())
    const verifier = createVerifier({ session, detector, sleep: noSleep })
    const outcomes = await Promise.all([verifier.verify(), verifier.verify({ ids: ['c1'] }), verifier.verify()])
    expect(peak).toBe(1)
    expect(outcomes[1]?.results[0]?.attempt).toBe(2)
  })
})

describe('createVerifier: notes', () => {
  const claimedStyle = (id: string): ChangeItem => styleItem(id, 'src/components/Header.tsx', { status: 'claimed', batchId: 'b1' })
  const claimedNote = (id: string, over: Partial<ChangeItem> = {}): ChangeItem => noteItem(id, 'src/components/Header.tsx', { status: 'claimed', batchId: 'b1', ...over } as never)
  const passing = (wanted: readonly ChangeItem[]): MeasureOutcome => measuredWith(wanted.map((it) => answer(it, [rawComputed(it.expect[0] as Expectation, '24px', 'pass')])))

  it('a batch of a style change and notes: the change is measured and passes, the notes are not measured and are not_checkable', async () => {
    const { session, items, measured } = fakeSession([claimedStyle('c1'), claimedNote('n1'), claimedNote('n2', { on: 'page' } as never)], passing)
    const { detector, calls } = fakeDetector(settled())
    const outcome = await createVerifier({ session, detector, sleep: noSleep }).verify()
    expect(measured).toEqual([['c1']])
    expect(calls).toHaveLength(1)
    expect(outcome.results.map((result) => [result.itemId, result.status])).toEqual([
      ['c1', 'pass'],
      ['n1', 'not_checkable'],
      ['n2', 'not_checkable'],
    ])
    expect(outcome.results[1]?.checks).toEqual([])
    expect(outcome.results[1]?.hint).toContain('check it by eye')
    expect(outcome.counts).toEqual({ pass: 1, not_checkable: 2 })
    // Honest: the summary does not read as "all passed", and nothing is left to fix.
    expect(outcome.summary).toBe('Verified 3 changes: 1 pass, 2 not checkable. n1, n2 are notes: nothing to measure, so neither a pass nor a fail; the user checks them by eye.')
    expect(outcome.fixup).toBe('')
    expect(items.get('c1')?.status).toBe('verified')
    // A note stays claimed: never verified, never failed; the result says why.
    expect(items.get('n1')?.status).toBe('claimed')
    expect(items.get('n1')?.verification).toMatchObject({ status: 'not_checkable', attempt: 1 })
    expect(items.get('n2')?.status).toBe('claimed')
  })

  it('a failing change next to a note: the fix-up has the change, and names the note without restating it', async () => {
    const { session, items } = fakeSession([claimedStyle('c1'), claimedNote('n1')], (wanted) =>
      measuredWith(wanted.map((it) => answer(it, [rawComputed(it.expect[0] as Expectation, '16px')]))),
    )
    const { detector } = fakeDetector(settled())
    const outcome = await createVerifier({ session, detector, sleep: noSleep }).verify()
    expect(outcome.counts).toEqual({ fail: 1, not_checkable: 1 })
    expect(outcome.fixup).toContain('`c1` fail')
    expect(outcome.fixup).toContain('the note `n1`')
    expect(outcome.fixup).not.toContain('Make the sign-in button a link')
    expect(outcome.fixup).toContain('again with this id: `c1`.')
    expect(items.get('c1')?.status).toBe('failed')
    expect(items.get('n1')?.status).toBe('claimed')
  })

  it('only notes: the browser is not asked, the settle wait still runs, and the result never passes', async () => {
    const { session, items, measured } = fakeSession([claimedNote('n1')], () => {
      throw new Error('a note must not be measured')
    })
    const { detector, calls } = fakeDetector(settled())
    const outcome = await createVerifier({ session, detector, sleep: noSleep }).verify({ ids: ['n1'] })
    expect(measured).toEqual([])
    expect(calls).toHaveLength(1)
    expect(outcome.results.map((result) => result.status)).toEqual(['not_checkable'])
    expect(outcome.results[0]?.settle).toMatchObject({ status: 'settled' })
    expect(items.get('n1')?.status).toBe('claimed')
  })

  it('a note is not_checkable without a browser and with a build error, which its hint names', async () => {
    const noBrowser = fakeSession([claimedStyle('c1'), claimedNote('n1')], () => ({ status: 'no_browser' }))
    const outcome = await createVerifier({ session: noBrowser.session, detector: fakeDetector(settled({ browser: false })).detector, sleep: noSleep }).verify()
    expect(outcome.results.map((result) => [result.itemId, result.status])).toEqual([
      ['c1', 'no_browser'],
      ['n1', 'not_checkable'],
    ])

    const broken = fakeSession([claimedNote('n1')], () => ({ status: 'no_browser' }))
    const error = { message: 'Unexpected token', file: 'src/components/Header.tsx', line: 3, column: 1 }
    const failed = await createVerifier({ session: broken.session, detector: fakeDetector(settled({ status: 'build_error', error })).detector, sleep: noSleep }).verify()
    expect(failed.results[0]).toMatchObject({ status: 'not_checkable' })
    expect(failed.results[0]?.hint).toContain('also reports a build error')
    expect(failed.results[0]?.hint).toContain('Unexpected token')
  })

  it('a claimed note is verified again by default, and stays not_checkable', async () => {
    const { session } = fakeSession([claimedNote('n1')], passing)
    const verifier = createVerifier({ session, detector: fakeDetector(settled()).detector, sleep: noSleep })
    expect((await verifier.verify()).results.map((result) => [result.status, result.attempt])).toEqual([['not_checkable', 1]])
    expect((await verifier.verify()).results.map((result) => [result.status, result.attempt])).toEqual([['not_checkable', 2]])
  })
})

describe('startAutoVerify', () => {
  const fsEntry = (seq: number): JournalEntry => ({ seq, at: seq, source: 'fs', event: 'change', path: 'src/a.tsx' })

  const setup = (items: ChangeItem[]) => {
    const state = fakeSession(items, () => ({ status: 'no_browser' }))
    const fake = fakeDetector(settled())
    const verified: (readonly string[] | undefined)[] = []
    let clock = 0
    const stop = startAutoVerify({
      session: state.session,
      detector: fake.detector,
      verifier: {
        verify: async (params) => {
          verified.push(params?.ids)
          return { results: [], counts: {}, fixup: '', summary: '' }
        },
      },
      intervalMs: 5,
      quietMs: 40,
      now: () => clock,
    })
    return { ...state, ...fake, verified, stop, advance: (ms: number) => (clock += ms) }
  }
  const ticks = (count = 4): Promise<void> => new Promise((resolve) => setTimeout(resolve, count * 5 + 10))

  it('verifies pasted batches once source files changed and then stayed quiet', async () => {
    const run = setup([styleItem('q1', 'a.tsx', { status: 'queued', batchId: 'b1' })])
    try {
      await ticks()
      expect(run.verified).toEqual([])
      run.entries.push(fsEntry(1))
      await ticks()
      expect(run.verified).toEqual([]) // changed, but not quiet for long enough yet
      run.advance(50)
      await ticks()
      expect(run.verified).toEqual([['q1']])
      await ticks()
      expect(run.verified).toHaveLength(1) // no new change, no new run
    } finally {
      run.stop()
    }
  })

  it('leaves changes an agent claimed over MCP to that agent', async () => {
    const run = setup([styleItem('c1', 'a.tsx', { status: 'claimed', batchId: 'b1', claimedAt: 10 })])
    try {
      run.entries.push(fsEntry(1))
      await ticks()
      run.advance(50)
      await ticks()
      expect(run.verified).toEqual([])
    } finally {
      run.stop()
    }
  })

  it('re-verifies a failed pasted change after the next edit, but not one an agent is fixing', async () => {
    const run = setup([
      styleItem('f1', 'a.tsx', { status: 'failed', batchId: 'b1' }),
      styleItem('f2', 'a.tsx', { status: 'failed', batchId: 'b2', claimedAt: 10 }),
    ])
    try {
      run.entries.push(fsEntry(1))
      await ticks()
      run.advance(50)
      await ticks()
      expect(run.verified).toEqual([['f1']])
    } finally {
      run.stop()
    }
  })

  it('does nothing after it was stopped', async () => {
    const run = setup([styleItem('q1', 'a.tsx', { status: 'queued', batchId: 'b1' })])
    run.stop()
    run.entries.push(fsEntry(1))
    run.advance(100)
    await ticks()
    expect(run.verified).toEqual([])
  })
})
