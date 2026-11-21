import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { attributeShifts } from '../../engine/src/shift-attributor.ts'
import type { ShiftRecording, ShiftReport } from '../../protocol/src/shift.ts'
import type { SessionShifts } from '../src/session.ts'
import { createShiftTools, matchesKnown } from '../src/shift-tools.ts'

const RECORDINGS = fileURLToPath(new URL('../../engine/test/shift-recordings/', import.meta.url))
const load = (name: string): ShiftRecording => {
  const data = JSON.parse(readFileSync(`${RECORDINGS}${name}.json`, 'utf8')) as { recording?: ShiftRecording } & ShiftRecording
  return data.recording ?? data
}
/** A real recording of a page with one unsized image, and the same page with nothing moving. */
const SHIFTING = load('unsized-media__img-block')
const quiet = (recording: ShiftRecording): ShiftRecording => ({ ...recording, shifts: [] })

const shiftsOf = (recording: ShiftRecording, doc: string, at: number, over: Partial<ShiftReport> = {}): SessionShifts => ({
  doc,
  at,
  recording,
  report: { ...attributeShifts(recording), ...over },
  culpritSources: {},
})

/** A session whose tab answers each reload with the next scripted recording. */
function fakeSession(first: SessionShifts | undefined, replays: (SessionShifts | 'none' | 'refuse')[] = []) {
  let clock = 1000
  let latest = first
  let reloads = 0
  const reasons: string[] = []
  return {
    reasons,
    reloads: () => reloads,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms
    },
    session: {
      shifts: () => latest,
      documents: () => (first === undefined ? [] : [{ doc: 'doc-0' }]),
      reload: (reason: string) => {
        const next = replays[reloads]
        reloads += 1
        reasons.push(reason)
        if (next === 'refuse' || next === undefined) return false
        if (next !== 'none') latest = { ...next, at: clock + 50 }
        return true
      },
    } as never,
  }
}

describe('matchesKnown', () => {
  const issue = attributeShifts(SHIFTING).issues[0]!
  const victims = issue.victims.map((victim) => victim.node).filter((node) => node !== null)

  it('recognises the same culprit and the same moved elements, and nothing else', () => {
    expect(matchesKnown(issue, { culprit: issue.culprit?.node, victims: [] })).toBe(true)
    expect(matchesKnown(issue, { culprit: undefined, victims })).toBe(true)
    const other = { uid: 99, tag: 'div', path: [0, 1, 7], selector: '#somewhere-else' }
    expect(matchesKnown(issue, { culprit: other, victims: [other] })).toBe(false)
  })

  it('does not rely on the per-document uid', () => {
    const culprit = issue.culprit!.node
    expect(matchesKnown(issue, { culprit: { ...culprit, uid: culprit.uid + 1000 }, victims: [] })).toBe(true)
  })
})

describe('getLayoutShifts', () => {
  it('lists scored issues with culprit, cause and a prompt that names the verify tool', () => {
    const fake = fakeSession(shiftsOf(SHIFTING, 'doc-0', 500))
    const result = createShiftTools({ session: fake.session }).getLayoutShifts()
    expect(result.status).toBe('ok')
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]).toMatchObject({ id: 'shift-1', cause: 'unsized-media' })
    expect(result.issues[0]?.culprit?.label).toContain('img')
    expect(result.cls).toBeGreaterThan(0.05)
    expect(result.prompt).toContain('verify_layout_shift')
    expect(result.prompt).toContain('shift-1')
  })

  it('says no shifts only when the load was measured', () => {
    const none = createShiftTools({ session: fakeSession(shiftsOf(quiet(SHIFTING), 'doc-0', 500)).session }).getLayoutShifts()
    expect(none).toMatchObject({ status: 'ok', issues: [], prompt: '' })
    expect(none.message).toContain('No layout shifts')

    const hidden = createShiftTools({ session: fakeSession(shiftsOf(quiet(SHIFTING), 'doc-0', 500, { status: 'tab_hidden', cls: null })).session }).getLayoutShifts()
    expect(hidden.status).toBe('tab_hidden')
    expect(hidden.cls).toBeNull()
    expect(hidden.message).toContain('not "no shifts"')

    expect(createShiftTools({ session: fakeSession(undefined).session }).getLayoutShifts().status).toBe('no_report')
  })

  it('filters by minValue', () => {
    const fake = fakeSession(shiftsOf(SHIFTING, 'doc-0', 500))
    expect(createShiftTools({ session: fake.session }).getLayoutShifts({ minValue: 0.9 }).issues).toEqual([])
  })
})

describe('verifyLayoutShift', () => {
  const tools = (fake: ReturnType<typeof fakeSession>) => createShiftTools({ session: fake.session, now: fake.now, sleep: fake.sleep, graceMs: 300, replayTimeoutMs: 3000 })

  it('passes when the shift stays away in three cold reloads, and is cold only while replaying', async () => {
    const gone = quiet(SHIFTING)
    const fake = fakeSession(shiftsOf(SHIFTING, 'doc-0', 500), [shiftsOf(gone, 'doc-1', 0), shiftsOf(gone, 'doc-2', 0), shiftsOf(gone, 'doc-3', 0)])
    const shift = tools(fake)
    shift.getLayoutShifts()
    expect(shift.cold()).toBe(false)
    const running = shift.verifyLayoutShift({ id: 'shift-1' })
    expect(shift.cold()).toBe(true)
    const result = await running
    expect(shift.cold()).toBe(false)
    expect(result.status).toBe('pass')
    expect(result.replays.map((replay) => replay.remaining)).toEqual([0, 0, 0])
    expect(fake.reloads()).toBe(3)
    expect(fake.reasons[0]).toContain('1 of 3')
  })

  it('fails when the shift comes back in any reload', async () => {
    const gone = quiet(SHIFTING)
    const fake = fakeSession(shiftsOf(SHIFTING, 'doc-0', 500), [shiftsOf(gone, 'doc-1', 0), shiftsOf(SHIFTING, 'doc-2', 0), shiftsOf(gone, 'doc-3', 0)])
    const shift = tools(fake)
    shift.getLayoutShifts()
    const result = await shift.verifyLayoutShift({ id: 'shift-1' })
    expect(result.status).toBe('fail')
    expect(result.hint).toContain('still there')
    expect(result.replays[1]?.remaining).toBeGreaterThan(0.05)
  })

  it('never passes a replay that ran in a hidden tab, and stops reloading', async () => {
    const fake = fakeSession(shiftsOf(SHIFTING, 'doc-0', 500), [shiftsOf(quiet(SHIFTING), 'doc-1', 0, { status: 'tab_hidden', cls: null })])
    const shift = tools(fake)
    shift.getLayoutShifts()
    const result = await shift.verifyLayoutShift({ id: 'shift-1' })
    expect(result.status).toBe('tab_hidden')
    expect(fake.reloads()).toBe(1)
  })

  it('reports no_browser when no tab can be reloaded and not_measurable when the page does not report back', async () => {
    const refused = fakeSession(shiftsOf(SHIFTING, 'doc-0', 500), ['refuse'])
    const a = tools(refused)
    a.getLayoutShifts()
    expect((await a.verifyLayoutShift({ id: 'shift-1' })).status).toBe('no_browser')

    const silent = fakeSession(shiftsOf(SHIFTING, 'doc-0', 500), ['none'])
    const b = tools(silent)
    b.getLayoutShifts()
    const result = await b.verifyLayoutShift({ id: 'shift-1' })
    expect(result.status).toBe('not_measurable')
    expect(b.cold()).toBe(false)
  })

  it('does not take the report that was there before the reload for the answer', async () => {
    // The tab reloads but reports under the old document id: that is the old page, not a replay.
    const fake = fakeSession(shiftsOf(SHIFTING, 'doc-0', 500), [shiftsOf(quiet(SHIFTING), 'doc-0', 0)])
    const shift = tools(fake)
    shift.getLayoutShifts()
    expect((await shift.verifyLayoutShift({ id: 'shift-1' })).status).toBe('not_measurable')
  })

  it('says so when a replay was not fully cold', async () => {
    const warm = shiftsOf(quiet(SHIFTING), 'doc-1', 0, { cachedResources: ['/assets/img/hero.png'] })
    const fake = fakeSession(shiftsOf(SHIFTING, 'doc-0', 500), [warm, { ...warm, doc: 'doc-2' }, { ...warm, doc: 'doc-3' }])
    const shift = tools(fake)
    shift.getLayoutShifts()
    const result = await shift.verifyLayoutShift({ id: 'shift-1' })
    expect(result.status).toBe('pass')
    expect(result.hint).toContain('not fully cold')
  })

  it('answers unknown_id for an id that the last get_layout_shifts did not return', async () => {
    const fake = fakeSession(shiftsOf(SHIFTING, 'doc-0', 500))
    const result = await tools(fake).verifyLayoutShift({ id: 'shift-9' })
    expect(result.status).toBe('unknown_id')
    expect(fake.reloads()).toBe(0)
  })
})
