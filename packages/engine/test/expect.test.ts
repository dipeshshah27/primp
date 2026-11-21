import { describe, expect, it } from 'vitest'
import type { Expectation } from '@reglet/protocol/change'
import { ExpectationSchema } from '@reglet/protocol/change'
import { NO_MOVE_TOLERANCE_PX, deriveExpectations } from '../src/expect.ts'
import { condition, locator, rect, sideEffect, structure, style } from './change-fixtures.ts'

describe('deriveExpectations: style changes', () => {
  it('one computed expectation for the property when there are no longhands', () => {
    const item = style({ property: 'padding-left', after: { authored: '1rem', computed: '16px' } })
    expect(deriveExpectations(item)).toEqual<Expectation[]>([{ type: 'computed', property: 'padding-left', value: '16px', condition: condition() }])
  })

  it('one per CHANGED longhand, sorted by name, each with the item condition', () => {
    const media = condition({ media: '(min-width: 768px)' })
    const item = style({
      property: 'padding',
      before: { authored: '12px', computed: '12px' },
      after: { authored: '12px 24px', computed: '12px 24px' },
      condition: media,
      longhands: {
        'padding-top': { before: '12px', after: '12px' },
        'padding-right': { before: '12px', after: '24px' },
        'padding-bottom': { before: '12px', after: '12px' },
        'padding-left': { before: '12px', after: '24px' },
      },
    })
    expect(deriveExpectations(item)).toEqual<Expectation[]>([
      { type: 'computed', property: 'padding-left', value: '24px', condition: media },
      { type: 'computed', property: 'padding-right', value: '24px', condition: media },
    ])
  })

  it('falls back to the property when no longhand changed', () => {
    const item = style({
      property: 'margin',
      before: { authored: '1rem', computed: '16px' },
      after: { authored: '16px', computed: '16px' },
      longhands: { 'margin-top': { before: '16px', after: '16px' }, 'margin-left': { before: '16px', after: ' 16px ' } },
    })
    expect(deriveExpectations(item)).toEqual<Expectation[]>([{ type: 'computed', property: 'margin', value: '16px', condition: condition() }])
  })

  it('the order does not depend on the order of the longhands record', () => {
    const a = style({ property: 'inset', longhands: { top: { before: '0px', after: '4px' }, left: { before: '0px', after: '8px' } } })
    const b = style({ property: 'inset', longhands: { left: { before: '0px', after: '8px' }, top: { before: '0px', after: '4px' } } })
    expect(deriveExpectations(a)).toEqual(deriveExpectations(b))
    expect(deriveExpectations(a).map((e) => (e.type === 'computed' ? e.property : e.type))).toEqual(['left', 'top'])
  })
})

describe('deriveExpectations: structural changes', () => {
  it('absent for remove, hidden for hide', () => {
    expect(deriveExpectations(structure({ op: 'remove' }))).toEqual<Expectation[]>([{ type: 'absent' }])
    expect(deriveExpectations(structure({ op: 'hide' }))).toEqual<Expectation[]>([{ type: 'hidden' }])
  })
})

describe('deriveExpectations: unwanted side effects', () => {
  const footer = sideEffect({ verdict: 'unwanted' })
  const sidebar = sideEffect({
    label: 'aside.sidebar',
    selector: 'body > aside.sidebar',
    locator: locator({ tag: 'aside', indexPath: [1], ancestors: ['body'] }),
    type: 'resized',
    before: rect(0, 80, 240, 600),
    after: rect(0, 80, 260, 600),
    verdict: 'unwanted',
  })

  it('a no-move with the BEFORE rect, label, locator and 1px tolerance, after the main expectation', () => {
    const item = style({ sideEffects: [sideEffect({ label: 'h3.title', selector: 'h3.title', verdict: 'expected' }), footer, sideEffect({ label: 'p', selector: 'p' }), sidebar] })
    const derived = deriveExpectations(item)
    expect(NO_MOVE_TOLERANCE_PX).toBe(1)
    expect(derived).toEqual<Expectation[]>([
      { type: 'computed', property: 'padding-left', value: '16px', condition: condition() },
      { type: 'no-move', label: 'footer.site-footer', locator: footer.locator, rect: rect(0, 900, 1280, 120), tolerancePx: 1 },
      { type: 'no-move', label: 'aside.sidebar', locator: sidebar.locator, rect: rect(0, 80, 240, 600), tolerancePx: 1 },
    ])
  })

  it('also on structural changes; unreviewed and expected effects add nothing; a selector counts once', () => {
    const item = structure({ op: 'hide', sideEffects: [footer, footer, sideEffect({ selector: 'x', verdict: 'unreviewed' }), sideEffect({ selector: 'y', verdict: 'expected' })] })
    expect(deriveExpectations(item).map((e) => e.type)).toEqual(['hidden', 'no-move'])
  })

  it('accepts an item without `expect`, is deterministic, does not mutate, and produces valid expectations', () => {
    const { expect: _ignored, ...withoutExpect } = style({ sideEffects: [footer] })
    void _ignored
    const frozen = JSON.stringify(withoutExpect)
    const first = deriveExpectations(withoutExpect)
    expect(deriveExpectations(withoutExpect)).toEqual(first)
    expect(JSON.stringify(withoutExpect)).toBe(frozen)
    for (const e of first) expect(ExpectationSchema.safeParse(e).success).toBe(true)
  })
})
