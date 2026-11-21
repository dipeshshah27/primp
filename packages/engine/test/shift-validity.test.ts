import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ShiftRecordingSchema, type ShiftRecording } from '../../protocol/src/shift.ts'
import { shiftValidity } from '../src/shift-validity.ts'

/** A recording made by the hook in Chromium; see `spikes/s7-shifts.ts --record`. */
const load = (name: string): ShiftRecording => ShiftRecordingSchema.parse(JSON.parse(readFileSync(new URL(`./shift-recordings/${name}.json`, import.meta.url), 'utf8')))
const clone = (recording: ShiftRecording): ShiftRecording => structuredClone(recording)

describe('shiftValidity', () => {
  it('accepts a load that was visible from navigation start to the end', () => {
    const recording = load('unsized-media__img-block')
    expect(recording.visibility).toMatchObject({ initial: 'visible', atNavigationStart: 'visible', changes: [], visibleThroughout: true })
    expect(shiftValidity(recording)).toEqual({ status: 'ok' })
  })

  it('rejects a real background reload: zero entries there mean nothing', () => {
    const recording = load('hidden-tab__background-reload')
    expect(recording.shifts).toHaveLength(0)
    expect(recording.visibility.visibleThroughout).toBe(false)
    const validity = shiftValidity(recording)
    expect(validity.status).toBe('tab_hidden')
    expect(validity.reason).toMatch(/hidden at navigation start/)
  })

  it('rejects a tab that was hidden at the start and shown later, although it recorded entries', () => {
    const recording = load('hidden-tab__shown-after-300ms')
    expect(recording.shifts.length).toBeGreaterThan(0)
    expect(recording.visibility.changes.at(-1)?.state).toBe('visible')
    expect(shiftValidity(recording).status).toBe('tab_hidden')
  })

  it('rejects a tab that became hidden during the window, with the time in the reason', () => {
    const recording = clone(load('unsized-media__img-block'))
    recording.visibility.changes.push({ t: 412.3, state: 'hidden' }, { t: 900, state: 'visible' })
    recording.visibility.visibleThroughout = false
    expect(shiftValidity(recording)).toEqual({ status: 'tab_hidden', reason: 'the tab became hidden at 412 ms, before the measurement ended' })
  })

  it('does not trust the flag alone: a hidden change is caught even if the flag says visible', () => {
    const recording = clone(load('unsized-media__img-block'))
    recording.visibility.changes.push({ t: 50, state: 'hidden' })
    expect(shiftValidity(recording).status).toBe('tab_hidden')
  })

  it('and the other way round: the flag alone is enough', () => {
    const recording = clone(load('unsized-media__img-block'))
    recording.visibility.visibleThroughout = false
    expect(shiftValidity(recording).status).toBe('tab_hidden')
  })

  it('rejects the state when the hook ran, when the browser gave no navigation-start entry', () => {
    const recording = clone(load('unsized-media__img-block'))
    delete recording.visibility.atNavigationStart
    recording.visibility.initial = 'hidden'
    expect(shiftValidity(recording)).toMatchObject({ status: 'tab_hidden', reason: expect.stringContaining('when the page started loading') })
  })

  it('rejects prerendered and back/forward-cache pages', () => {
    const prerendered = clone(load('unsized-media__img-block'))
    prerendered.visibility.prerendered = true
    expect(shiftValidity(prerendered).status).toBe('tab_hidden')
    const restored = clone(load('unsized-media__img-block'))
    restored.visibility.restored = true
    expect(shiftValidity(restored).status).toBe('tab_hidden')
  })

  it('rejects an entry that was delivered while hidden', () => {
    const recording = clone(load('unsized-media__img-block'))
    const first = recording.shifts[0]
    if (first !== undefined) first.visibility = 'hidden'
    expect(shiftValidity(recording).status).toBe('tab_hidden')
  })

  it('reports a browser without layout-shift entries as not measurable, before anything else', () => {
    const recording = clone(load('hidden-tab__background-reload'))
    recording.supported = false
    expect(shiftValidity(recording).status).toBe('not_measurable')
  })
})
