import type { Expectation } from '@reglet/protocol/change'
import { describe, expect, it } from 'vitest'
import { toCheck, type Measured } from '../src/probe/measure.ts'

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
