import type { Expectation } from '@primp/protocol/change'
import { describe, expect, it } from 'vitest'
import { isNeighboursLost, judgeCheck, ORDER_NEIGHBOURS_LOST, ORDER_NOT_AS_LABELLED } from '@primp/engine/judge'
import { toMeasured } from '../../server/src/verify.ts'
import { emulatedNote, STATE_NOT_EMULATED, toCheck, type Measured } from '../src/probe/measure.ts'

const view = { innerWidth: 600, innerHeight: 800 } as Window
const condition = { viewport: { w: 1280, h: 800, dpr: 1 }, colorScheme: 'light' as const }
const found = (extra: Partial<Measured> = {}): Measured => ({ found: true, locatorConfidence: 1, ...extra })
const missing: Measured = { found: false, locatorConfidence: 0.3 }

describe('toCheck: a raw measurement on the wire', () => {
  const padding: Expectation = { type: 'computed', property: 'padding-top', value: '1.75rem', condition }

  it('computed: expected is the value as computed on the element, compared by plain equality', () => {
    expect(toCheck(padding, found({ mediaMatches: true, actual: '28px', expectedComputed: '28px' }), view)).toMatchObject({ status: 'pass', expected: '28px', actual: '28px' })
    expect(toCheck(padding, found({ mediaMatches: true, actual: '24px', expectedComputed: '28px' }), view)).toMatchObject({ status: 'fail', expected: '28px', actual: '24px' })
  })

  it('computed: without a resolved value the recorded one is compared as it is, and the check says so', () => {
    const check = toCheck(padding, found({ mediaMatches: true, actual: '28px' }), view)
    expect(check).toMatchObject({ status: 'fail', expected: '1.75rem', actual: '28px' })
    expect(check.note).toContain('could not be resolved')
  })

  it('computed: outside the media query nothing is measured; a missing element is unresolved', () => {
    const scoped: Expectation = { ...padding, condition: { ...condition, media: '(min-width: 768px)' } }
    const check = toCheck(scoped, found({ mediaMatches: false }), view)
    expect(check.status).toBe('not_measurable')
    expect(check.note).toContain('600x800')
    expect(toCheck(padding, { ...missing, mediaMatches: true }, view).status).toBe('unresolved')
  })

  it('computed in a state: measured results say that the state was emulated', () => {
    const hover: Expectation = { type: 'computed', property: 'background-color', value: '#2563eb', condition: { ...condition, state: 'hover' } }
    const pass = toCheck(hover, found({ mediaMatches: true, actual: 'rgb(37, 99, 235)', expectedComputed: 'rgb(37, 99, 235)' }), view)
    expect(pass).toMatchObject({ status: 'pass', expected: 'rgb(37, 99, 235)', actual: 'rgb(37, 99, 235)', note: 'measured with :hover emulated' })
    const fail = toCheck(hover, found({ mediaMatches: true, actual: 'rgb(30, 41, 59)', expectedComputed: 'rgb(37, 99, 235)' }), view)
    expect(fail).toMatchObject({ status: 'fail', actual: 'rgb(30, 41, 59)', note: emulatedNote('hover') })
    // Both notes when the expected value could not be resolved; the state comes first.
    const raw = toCheck(hover, found({ mediaMatches: true, actual: 'rgb(30, 41, 59)' }), view)
    expect(raw.note?.startsWith('measured with :hover emulated; ')).toBe(true)
    expect(raw.note).toContain('could not be resolved')
    // A resting check carries no such note.
    expect(toCheck(padding, found({ mediaMatches: true, actual: '28px', expectedComputed: '28px' }), view).note).toBeUndefined()
  })

  it('computed in a state that could not be emulated: not_measurable with the agreed start of the note, whatever was read', () => {
    const focus: Expectation = { type: 'computed', property: 'outline-color', value: 'red', condition: { ...condition, state: 'focus-visible' } }
    const blocked = toCheck(focus, found({ mediaMatches: true, actual: 'rgb(255, 0, 0)', expectedComputed: 'rgb(255, 0, 0)', stateBlocked: '2 stylesheets from another origin cannot be read' }), view)
    expect(blocked.status).toBe('not_measurable')
    expect(blocked.note).toBe('the state could not be emulated: 2 stylesheets from another origin cannot be read')
    expect(blocked.note?.startsWith(`${STATE_NOT_EMULATED}: `)).toBe(true)
    expect(toCheck(focus, found({ mediaMatches: true, stateBlocked: 'forcing :focus-visible failed (boom)' }), view)).toMatchObject({ status: 'not_measurable', actual: '' })
    // The media condition is checked first, and a missing element is still unresolved.
    const scoped: Expectation = { ...focus, condition: { ...focus.condition, media: '(min-width: 768px)' } }
    expect(toCheck(scoped, found({ mediaMatches: false, stateBlocked: 'x' }), view).note).toContain('does not match @media')
    expect(toCheck(focus, { ...missing, mediaMatches: true }, view).status).toBe('unresolved')
  })

  describe('order: the wire convention of packages/server/src/verify.ts', () => {
    const locator = { tag: 'li', indexPath: [0], ancestors: ['body'] }
    // Wanted: B, then the moved A, then C.
    const order: Expectation = { type: 'order', siblings: [{ label: 'li "B"', locator }, { label: 'li "A"', locator, self: true }, { label: 'li "C"', locator }] }
    const wanted = JSON.stringify(['li "B"', 'li "A"', 'li "C"'])
    const item = { itemId: 'x', locatorConfidence: 1, found: true, checks: [] }
    const judged = (measured: Measured) => {
      const raw = toCheck(order, measured, view)
      return { raw, judged: judgeCheck(order, toMeasured(raw, item)) }
    }

    it('pass: every listed element found, in the wanted order under one parent; expected and actual are JSON label arrays', () => {
      const { raw, judged: result } = judged(found({ order: { actual: ['li "B"', 'li "A"', 'li "C"'], inOrder: true } }))
      expect(raw).toMatchObject({ status: 'pass', expected: wanted, actual: wanted })
      expect(result.status).toBe('pass')
    })

    it('pass with a neighbour missing: the ones found are in order', () => {
      const { raw, judged: result } = judged(found({ order: { actual: ['li "A"', 'li "C"'], inOrder: true } }))
      expect(raw).toMatchObject({ status: 'pass', actual: JSON.stringify(['li "A"', 'li "C"']) })
      expect(result.status).toBe('pass')
      expect(result.note).toContain('1 of 2 neighbours')
    })

    it('fail: found in another order (the page still has the old order)', () => {
      const { raw, judged: result } = judged(found({ order: { actual: ['li "A"', 'li "B"', 'li "C"'], inOrder: false } }))
      expect(raw).toMatchObject({ status: 'fail', expected: wanted, actual: JSON.stringify(['li "A"', 'li "B"', 'li "C"']) })
      expect(result.status).toBe('fail')
    })

    it('fail although the labels read in order: the probe compares elements and parents, not labels', () => {
      const { raw, judged: result } = judged(found({ order: { actual: ['li "B"', 'li "A"', 'li "C"'], inOrder: false } }))
      expect(raw.status).toBe('fail')
      expect(result).toMatchObject({ status: 'fail', note: ORDER_NOT_AS_LABELLED })
    })

    it('unresolved: the moved element itself was not found', () => {
      const { raw, judged: result } = judged({ found: false, locatorConfidence: 0.2, order: { actual: ['li "B"', 'li "C"'], inOrder: true } })
      expect(raw).toMatchObject({ status: 'unresolved', expected: wanted, actual: JSON.stringify(['li "B"', 'li "C"']) })
      expect(result.status).toBe('unresolved')
      expect(isNeighboursLost(result)).toBe(false)
    })

    it('unresolved: the moved element was found but fewer than two listed elements were', () => {
      const { raw, judged: result } = judged(found({ order: { actual: ['li "A"'], inOrder: true } }))
      expect(raw).toMatchObject({ status: 'unresolved', actual: JSON.stringify(['li "A"']), note: ORDER_NEIGHBOURS_LOST })
      expect(result.status).toBe('unresolved')
      expect(isNeighboursLost(result)).toBe(true)
    })
  })

  it('absent and hidden report absent | hidden | rendered', () => {
    const absent: Expectation = { type: 'absent' }
    const hidden: Expectation = { type: 'hidden' }
    expect(toCheck(absent, { ...missing, present: false }, view)).toMatchObject({ status: 'pass', actual: 'absent' })
    expect(toCheck(absent, found({ present: true, rendered: true }), view)).toMatchObject({ status: 'fail', actual: 'rendered' })
    expect(toCheck(absent, found({ present: true, rendered: false }), view)).toMatchObject({ status: 'fail', actual: 'hidden' })
    expect(toCheck(hidden, found({ present: true, rendered: false }), view)).toMatchObject({ status: 'pass', actual: 'hidden' })
    expect(toCheck(hidden, found({ present: true, rendered: true }), view)).toMatchObject({ status: 'fail', actual: 'rendered' })
    expect(toCheck(hidden, { ...missing, present: false }, view)).toMatchObject({ status: 'unresolved', actual: 'absent' })
  })

  it('an ambiguous element is neither absent nor present', () => {
    expect(toCheck({ type: 'absent' }, missing, view).status).toBe('unresolved')
    expect(toCheck({ type: 'hidden' }, missing, view).status).toBe('unresolved')
  })

  it('no-move carries both rectangles as JSON', () => {
    const constraint: Expectation = { type: 'no-move', label: 'section#pricing', locator: { tag: 'section', indexPath: [0], ancestors: ['body'] }, rect: { x: 0, y: 960.5, w: 992, h: 723 }, tolerancePx: 1 }
    const same = toCheck(constraint, found({ rectNow: { x: 0, y: 961, w: 992, h: 723 } }), view)
    expect(same.status).toBe('pass')
    expect(JSON.parse(same.expected)).toEqual({ x: 0, y: 960.5, w: 992, h: 723 })
    expect(JSON.parse(same.actual)).toEqual({ x: 0, y: 961, w: 992, h: 723 })
    const moved = toCheck(constraint, found({ rectNow: { x: 0, y: 976.5, w: 992, h: 723 } }), view)
    expect(moved).toMatchObject({ status: 'fail', delta: 16 })
    expect(toCheck(constraint, missing, view).status).toBe('unresolved')
  })

  it('unchanged carries the recorded value and the value now, compared by plain equality', () => {
    const bystander: Expectation = { type: 'unchanged', label: 'a.btn "See this week\'s beans"', selector: 'div.hero-actions > a:nth-of-type(2)', locator: { tag: 'a', indexPath: [0, 1], ancestors: ['body', 'div'] }, property: 'padding-top', value: '10px' }
    expect(toCheck(bystander, found({ actual: '10px', expectedComputed: '10px' }), view)).toEqual({ expectation: bystander, status: 'pass', expected: '10px', actual: '10px' })
    expect(toCheck(bystander, found({ actual: '14px', expectedComputed: '10px' }), view)).toEqual({ expectation: bystander, status: 'fail', expected: '10px', actual: '14px' })
    // Without the probe's copy the recorded value is the expected one.
    expect(toCheck(bystander, found({ actual: '10.2px' }), view)).toMatchObject({ status: 'fail', expected: '10px', actual: '10.2px' })
    const gone = toCheck(bystander, missing, view)
    expect(gone).toMatchObject({ status: 'unresolved', expected: '10px', actual: '' })
    expect(gone.note).toContain('was not found again')
  })
})
