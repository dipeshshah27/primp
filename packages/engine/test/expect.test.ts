import { describe, expect, it } from 'vitest'
import type { Expectation } from '@primp/protocol/change'
import { ExpectationSchema } from '@primp/protocol/change'
import { NO_MOVE_TOLERANCE_PX, deriveExpectations } from '../src/expect.ts'
import { bystander, condition, locator, move, rect, ref, sibling, sideEffect, structure, style } from './change-fixtures.ts'

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

describe('deriveExpectations: a change made for an interaction state', () => {
  it('every computed expectation carries the state, alone or with a media query', () => {
    const hover = condition({ state: 'hover' })
    expect(deriveExpectations(style({ property: 'background-color', after: { authored: '#0f172a', computed: 'rgb(15, 23, 42)' }, condition: hover }))).toEqual<Expectation[]>([
      { type: 'computed', property: 'background-color', value: 'rgb(15, 23, 42)', condition: hover },
    ])
    const both = condition({ state: 'focus-visible', media: '(min-width: 768px)' })
    const item = style({ property: 'padding', condition: both, longhands: { 'padding-left': { before: '12px', after: '24px' }, 'padding-top': { before: '12px', after: '16px' } } })
    expect(deriveExpectations(item)).toEqual<Expectation[]>([
      { type: 'computed', property: 'padding-left', value: '24px', condition: both },
      { type: 'computed', property: 'padding-top', value: '16px', condition: both },
    ])
  })
})

describe('deriveExpectations: structural changes', () => {
  it('absent for remove, hidden for hide', () => {
    expect(deriveExpectations(structure({ op: 'remove' }))).toEqual<Expectation[]>([{ type: 'absent' }])
    expect(deriveExpectations(structure({ op: 'hide' }))).toEqual<Expectation[]>([{ type: 'hidden' }])
  })

  describe('reorder', () => {
    const gesha = ref({ uid: 'u_gesha', label: 'li "Gesha"', locator: sibling('li "Gesha"', 1).locator })
    const self = { label: 'li "Gesha"', locator: gesha.locator, self: true }
    const kiamabara = sibling('li "Kiamabara"', 0)
    const yirgacheffe = sibling('li "Yirgacheffe"', 2)

    it('checks every recorded sibling around the element, not only its two neighbours', () => {
      const a = sibling('li "A"', 0)
      const b = sibling('li "B"', 2)
      const c = sibling('li "C"', 3)
      const derived = deriveExpectations(structure({ op: 'reorder', target: gesha, move: move({ toIndex: 1, now: { prev: a, next: b }, around: { before: [a], after: [b, c] } }) }))
      expect(derived).toEqual<Expectation[]>([{ type: 'order', siblings: [a, self, b, c] }])
    })


    it('one `order` from where the element stands now: the neighbour before, the element itself, the neighbour after', () => {
      const derived = deriveExpectations(structure({ op: 'reorder', target: gesha, move: move() }))
      expect(derived).toEqual<Expectation[]>([{ type: 'order', siblings: [kiamabara, self, yirgacheffe] }])
      for (const e of derived) expect(ExpectationSchema.safeParse(e).success).toBe(true)
    })

    it('a first child has only the neighbour after it, a last child only the one before', () => {
      expect(deriveExpectations(structure({ op: 'reorder', target: gesha, move: move({ toIndex: 0, now: { next: kiamabara } }) }))).toEqual<Expectation[]>([{ type: 'order', siblings: [self, kiamabara] }])
      expect(deriveExpectations(structure({ op: 'reorder', target: gesha, move: move({ toIndex: 5, now: { prev: yirgacheffe } }) }))).toEqual<Expectation[]>([{ type: 'order', siblings: [yirgacheffe, self] }])
    })

    it('where it WAS plays no part, and nothing but label and locator is copied from an anchor', () => {
      const extra = { ...kiamabara, selector: 'ul > li:first-child' } as typeof kiamabara
      const derived = deriveExpectations(structure({ op: 'reorder', target: gesha, move: move({ was: { prev: sibling('li "Other"', 4) }, now: { prev: extra, next: yirgacheffe } }) }))
      expect(derived).toEqual<Expectation[]>([{ type: 'order', siblings: [kiamabara, self, yirgacheffe] }])
    })

    it('nothing to check without a neighbour (an only child) or without `move`; never `hidden`', () => {
      expect(deriveExpectations(structure({ op: 'reorder', target: gesha, move: move({ fromIndex: 0, toIndex: 0, siblingCount: 1, was: {}, now: {} }) }))).toEqual([])
      expect(deriveExpectations(structure({ op: 'reorder', target: gesha }))).toEqual([])
      for (const item of [structure({ op: 'reorder', move: move() }), structure({ op: 'reorder' })]) {
        expect(deriveExpectations(item).some((e) => e.type === 'hidden' || e.type === 'absent')).toBe(false)
      }
    })

    it('an unwanted side effect still adds its no-move, after the order', () => {
      const item = structure({ op: 'reorder', target: gesha, move: move(), sideEffects: [sideEffect({ verdict: 'unwanted' }), sideEffect({ selector: 'x' })] })
      expect(deriveExpectations(item).map((e) => e.type)).toEqual(['order', 'no-move'])
      expect(deriveExpectations(structure({ op: 'reorder', target: gesha, sideEffects: [sideEffect({ verdict: 'unwanted' })] })).map((e) => e.type)).toEqual(['no-move'])
    })
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

describe('deriveExpectations: bystanders', () => {
  const secondary = bystander()
  const plan = bystander({
    label: 'a.btn "Choose a plan"',
    selector: '#plans > a',
    locator: locator({ tag: 'a', text: 'Choose a plan', indexPath: [1, 3, 0], ancestors: ['body', 'main', 'section'] }),
    // Recorded in another order than the first one.
    values: { 'padding-left': '18px', 'padding-bottom': '10px', 'padding-right': '18px', 'padding-top': '10px' },
  })
  const padding = (longhands: Record<string, [string, string]>, bystanders = [secondary, plan]) =>
    style({
      property: 'padding',
      scope: 'all-instances',
      before: { authored: '10px 18px', computed: '10px 18px' },
      after: { authored: '14px 18px', computed: '14px 18px' },
      longhands: Object.fromEntries(Object.entries(longhands).map(([name, [before, after]]) => [name, { before, after }])),
      origin: { via: 'rule', selector: '.btn', alsoStyles: 2 },
      sideEffects: [sideEffect({ verdict: 'unwanted' })],
      bystanders,
    })
  const unchanged = (who: typeof secondary, property: string): Expectation => ({ type: 'unchanged', label: who.label, selector: who.selector, locator: who.locator, property, value: who.values[property] ?? '' })

  it('one `unchanged` per bystander per longhand the edit changes, after everything else, bystanders in recorded order and properties by name', () => {
    const item = padding({ 'padding-top': ['10px', '14px'], 'padding-right': ['18px', '18px'], 'padding-bottom': ['10px', '14px'], 'padding-left': ['18px', '18px'] })
    const derived = deriveExpectations(item)
    expect(derived.map((e) => e.type)).toEqual(['computed', 'computed', 'no-move', 'unchanged', 'unchanged', 'unchanged', 'unchanged'])
    expect(derived.slice(3)).toEqual<Expectation[]>([unchanged(secondary, 'padding-bottom'), unchanged(secondary, 'padding-top'), unchanged(plan, 'padding-bottom'), unchanged(plan, 'padding-top')])
    for (const e of derived) expect(ExpectationSchema.safeParse(e).success).toBe(true)
  })

  it('a property without longhands: its one recorded value', () => {
    const item = style({ property: 'padding-left', bystanders: [bystander({ values: { 'padding-left': '18px' } })], origin: { via: 'rule', selector: '.btn', alsoStyles: 1 } })
    expect(deriveExpectations(item)).toEqual<Expectation[]>([
      { type: 'computed', property: 'padding-left', value: '16px', condition: condition() },
      { type: 'unchanged', label: secondary.label, selector: secondary.selector, locator: secondary.locator, property: 'padding-left', value: '18px' },
    ])
  })

  it('when the edit changes no computed value, every recorded value is checked', () => {
    // 1em -> 16px on a 16px element: nothing computes differently there, but a bystander with another font size would move.
    const item = padding({ 'padding-top': ['10px', '10px'], 'padding-left': ['18px', ' 18px '] }, [secondary])
    expect(deriveExpectations(item).map((e) => (e.type === 'unchanged' ? e.property : e.type))).toEqual(['computed', 'no-move', 'padding-bottom', 'padding-left', 'padding-right', 'padding-top'])
  })

  it('a bystander that recorded none of the changed longhands adds nothing; a structural change has no bystanders', () => {
    const item = padding({ 'padding-top': ['10px', '14px'] }, [bystander({ values: { 'padding-left': '18px' } }), bystander({ values: {} })])
    expect(deriveExpectations(item).map((e) => e.type)).toEqual(['computed', 'no-move'])
    expect(deriveExpectations(structure({ op: 'hide' })).map((e) => e.type)).toEqual(['hidden'])
  })

  it('is deterministic and does not mutate its input', () => {
    const { expect: _ignored, ...withoutExpect } = padding({ 'padding-top': ['10px', '14px'], 'padding-bottom': ['10px', '14px'] })
    void _ignored
    const frozen = JSON.stringify(withoutExpect)
    const first = deriveExpectations(withoutExpect)
    expect(deriveExpectations(withoutExpect)).toEqual(first)
    expect(JSON.stringify(withoutExpect)).toBe(frozen)
  })
})
