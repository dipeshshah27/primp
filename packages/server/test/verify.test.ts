import { describe, expect, it } from 'vitest'
import type { ChangeItem, CheckResult, Expectation } from '@reglet/protocol/change'
import type { MeasureOutcome, MeasuredItem, Session, SessionBatch } from '../src/session.ts'
import type { JournalEntry, SettleResult } from '../src/settle.ts'
import { createVerifier, itemStatusAfter, startAutoVerify, toMeasured } from '../src/verify.ts'
import { structureItem, styleItem } from './session-helpers.ts'

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

describe('itemStatusAfter', () => {
  it('maps what was learned to an item status and leaves the item alone when nothing was learned', () => {
    expect(itemStatusAfter('pass')).toBe('verified')
    expect(itemStatusAfter('drift')).toBe('verified')
    for (const status of ['fail', 'unresolved', 'no_update_observed', 'build_error'] as const) expect(itemStatusAfter(status)).toBe('failed')
    for (const status of ['not_measurable', 'tab_hidden', 'no_browser'] as const) expect(itemStatusAfter(status)).toBeUndefined()
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
