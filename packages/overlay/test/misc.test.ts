import { pickBest } from '@reglet/engine/locator'
import type { Locator, SideEffect } from '@reglet/protocol/change'
import { describe, expect, it } from 'vitest'
import { describeEffect, summarizeRecorded } from '../src/probe/effects.ts'
import { ruleOrder, ruleText, type PreviewSpec } from '../src/probe/preview.ts'
import { contradicts, readableClass } from '../src/probe/ref.ts'
import { isModuleClass, isUtilityClass } from '../src/probe/styles.ts'
import { nudge } from '../src/ui/nudge.ts'

describe('nudge', () => {
  it('steps the number under the caret', () => {
    expect(nudge('12px', 1, 1)?.text).toBe('13px')
    expect(nudge('12px', 4, -1)?.text).toBe('11px')
    expect(nudge('10px 20px', 7, 10)?.text).toBe('10px 30px')
    expect(nudge('10px 20px', 0, 10)?.text).toBe('20px 20px')
  })

  it('keeps decimals and handles negative numbers', () => {
    expect(nudge('1.5rem', 2, 1)?.text).toBe('2.5rem')
    expect(nudge('0.1', 0, 0.2)?.text).toBe('0.3')
    expect(nudge('-4px', 1, 1)?.text).toBe('-3px')
    expect(nudge('0', 0, -1)?.text).toBe('-1')
    expect(nudge('calc(100% - 8px)', 14, 1)?.text).toBe('calc(100% - 9px)')
  })

  it('leaves colours and words alone', () => {
    expect(nudge('#e2e8f0', 3, 1)).toBeNull()
    expect(nudge('auto', 2, 1)).toBeNull()
    expect(nudge('1px solid #e2e8f0', 14, 1)?.text).toBe('2px solid #e2e8f0')
    expect(nudge('h1', 1, 1)).toBeNull()
  })

  it('returns where the new number is', () => {
    expect(nudge('9px', 0, 1)).toEqual({ text: '10px', start: 0, end: 2 })
  })
})

describe('preview rules', () => {
  const spec = { itemId: 'i', uid: 'a', locator: { tag: 'div', indexPath: [], ancestors: [] }, scope: 'instance' as const, declarations: [{ property: 'padding', value: '28px' }], seq: 0 }

  it('writes one important rule keyed by the mark', () => {
    expect(ruleText(spec, ['a'])).toBe('[data-reglet-id="a"] { padding: 28px !important }')
  })

  it('lists every instance and wraps the rule in its media query', () => {
    expect(ruleText({ ...spec, media: '(min-width: 768px)' }, ['a', 'b'])).toBe(
      '@media (min-width: 768px) { [data-reglet-id="a"],[data-reglet-id="b"] { padding: 28px !important } }',
    )
  })

  it('writes nothing for an element that is not in the page', () => {
    expect(ruleText(spec, [])).toBe('')
  })

  it('a rule for a state applies in the real state and in the forced one', () => {
    expect(ruleText({ ...spec, state: 'hover' }, ['a'])).toBe('[data-reglet-id="a"]:hover, [data-reglet-id="a"][data-reglet-force~="hover"] { padding: 28px !important }')
    expect(ruleText({ ...spec, state: 'focus-visible' }, ['a'])).toBe(
      '[data-reglet-id="a"]:focus-visible, [data-reglet-id="a"][data-reglet-force~="focus-visible"] { padding: 28px !important }',
    )
  })

  it('a rule for a state lists both selectors for every instance', () => {
    expect(ruleText({ ...spec, state: 'active', scope: 'all-instances' }, ['a', 'b'])).toBe(
      '[data-reglet-id="a"]:active, [data-reglet-id="a"][data-reglet-force~="active"], [data-reglet-id="b"]:active, [data-reglet-id="b"][data-reglet-force~="active"] { padding: 28px !important }',
    )
  })

  it('a rule for a state goes inside its media query like any other', () => {
    expect(ruleText({ ...spec, state: 'hover', media: '(min-width: 768px)' }, ['a'])).toBe(
      '@media (min-width: 768px) { [data-reglet-id="a"]:hover, [data-reglet-id="a"][data-reglet-force~="hover"] { padding: 28px !important } }',
    )
    expect(ruleText({ ...spec, state: 'hover' }, [])).toBe('')
  })

  it('a resting rule stays out of the states where the page has its own rule, without weighing more', () => {
    expect(ruleText({ ...spec, exceptIn: ['hover', 'active'] }, ['a'])).toBe(
      '[data-reglet-id="a"]:not(:where(:hover, [data-reglet-force~="hover"], :active, [data-reglet-force~="active"])) { padding: 28px !important }',
    )
    // Only a resting rule; a rule for a state ignores it.
    expect(ruleText({ ...spec, state: 'hover', exceptIn: ['hover'] }, ['a'])).toBe('[data-reglet-id="a"]:hover, [data-reglet-id="a"][data-reglet-force~="hover"] { padding: 28px !important }')
    expect(ruleText({ ...spec, exceptIn: [] }, ['a'])).toBe(ruleText(spec, ['a']))
  })

  it('orders the sheet: resting rules, then the states with :active last; unscoped before @media; then by seq', () => {
    const of = (name: string, extra: Partial<PreviewSpec>): PreviewSpec => ({ ...spec, itemId: name, ...extra })
    const specs = [
      of('active', { state: 'active', seq: 0 }),
      of('hover-media', { state: 'hover', media: '(min-width: 768px)', seq: 1 }),
      of('hover', { state: 'hover', seq: 7 }),
      of('rest-media', { media: '(min-width: 768px)', seq: 2 }),
      of('focus-visible', { state: 'focus-visible', seq: 3 }),
      of('rest-late', { seq: 9 }),
      of('focus', { state: 'focus', seq: 8 }),
      of('rest', { seq: 4 }),
    ]
    expect([...specs].sort(ruleOrder).map((entry) => entry.itemId)).toEqual(['rest', 'rest-late', 'rest-media', 'hover', 'hover-media', 'focus', 'focus-visible', 'active'])
  })
})

describe('class name shapes', () => {
  it('recognises CSS-modules class names and leaves BEM alone', () => {
    for (const name of ['_card_1x2y3_1', 'page-module__E0kJGG__hero', 'Card_card__x7s9K', 'card_1a2b3']) expect(isModuleClass(name), name).toBe(true)
    for (const name of ['card', 'banner__dismiss', 'plan--featured', 'site-nav', 'text-2xl', 'col_md', 'btn_primary']) expect(isModuleClass(name), name).toBe(false)
  })

  it('recognises utility classes', () => {
    for (const name of ['px-4', 'md:grid-cols-3', 'text-slate-900', 'hover:bg-indigo-500', 'flex', 'mt-6', 'max-w-5xl', 'sm:grid-cols-2', '-mt-2', 'w-1/2']) expect(isUtilityClass(name), name).toBe(true)
    for (const name of ['card', 'banner__text', 'site-nav', '_card_1x2y3_1', 'plan']) expect(isUtilityClass(name), name).toBe(false)
  })

  it('shows the authored name of a hashed class', () => {
    expect(readableClass('_card_1x2y3_1')).toBe('card')
    expect(readableClass('page-module__E0kJGG__hero')).toBe('hero')
    expect(readableClass('Card_card__x7s9K')).toBe('card')
    expect(readableClass('banner')).toBe('banner')
  })
})

describe('re-finding an element', () => {
  // Six cards in a grid; a card has no text of its own, its name is what it says.
  const card = (index: number, name: string, count = 6): Locator => ({
    tag: 'article',
    role: 'article',
    accName: name,
    indexPath: [0, 1, 1, 1, index],
    ancestors: ['body', 'div', 'main', 'section', 'div'],
    ...(index > 0 ? { prevAnchor: 'article' } : {}),
    ...(index < count - 1 ? { nextAnchor: 'article' } : {}),
  })
  const names = ['RD Rect diff every edit is measured', 'SE Side effects see what else moved', 'LS Layout shifts name the culprit', 'VF Verification pass drift or fail', 'SM Source maps file and line', 'MC MCP tools for any agent']
  const cards = names.map((name, index) => card(index, name))

  it('the engine scorer finds an unchanged card among its siblings', () => {
    const pick = pickBest(cards[2]!, cards)
    expect(pick?.index).toBe(2)
    expect(contradicts(cards[2]!, cards[pick!.index]!)).toBe(false)
  })

  it('a removed card is not mistaken for the sibling that took its place', () => {
    const want = cards[2]!
    // The third card is gone: the fourth is now at index 2, with the same structure around it.
    const after = names.filter((_, index) => index !== 2).map((name, index) => card(index, name, 5))
    const pick = pickBest(want, after)
    // On structure alone the engine names the card that slid into the slot ...
    expect(pick?.index).toBe(2)
    // ... which says something else entirely, so the probe refuses it.
    expect(contradicts(want, after[pick!.index]!)).toBe(true)
  })

  it('an id or test id overrides a change of text', () => {
    const want: Locator = { tag: 'h1', id: 'title', text: 'Ship the layout you meant', indexPath: [0], ancestors: ['body'] }
    expect(contradicts(want, { ...want, text: 'Completely different words here' })).toBe(false)
    expect(contradicts({ ...want, id: undefined }, { ...want, id: undefined, text: 'Completely different words here' })).toBe(true)
  })

  it('a one-word text may change (a counter is still the counter)', () => {
    const want: Locator = { tag: 'output', text: '3', accName: '3', indexPath: [0, 1], ancestors: ['body', 'div'] }
    expect(contradicts(want, { ...want, text: '4', accName: '4' })).toBe(false)
  })
})

describe('describing recorded effects', () => {
  const locator: Locator = { tag: 'main', indexPath: [0], ancestors: ['body'] }
  const effect = (over: Partial<SideEffect>): SideEffect => ({
    label: 'main.page "Hello"',
    selector: 'main',
    locator,
    type: 'moved',
    before: { x: 0, y: 100, w: 800, h: 400 },
    after: { x: 0, y: 52, w: 800, h: 400 },
    subtreeCount: 13,
    verdict: 'unreviewed',
    ...over,
  })

  it('phrases movement and resizing from the rectangles', () => {
    expect(describeEffect(effect({}))).toBe('moved up 48px')
    expect(describeEffect(effect({ after: { x: 16, y: 100, w: 800, h: 400 } }))).toBe('moved right 16px')
    expect(describeEffect(effect({ type: 'resized', after: { x: 0, y: 100, w: 800, h: 416 } }))).toBe('became 16px taller')
    expect(describeEffect(effect({ type: 'resized', after: { x: 0, y: 100, w: 0, h: 0 } }))).toBe('disappeared')
    expect(describeEffect(effect({ type: 'overflow' }))).toBe('now overflows')
  })

  it('summarises a list in one line', () => {
    expect(summarizeRecorded([])).toBe('no side effects')
    expect(summarizeRecorded([effect({})])).toBe('14 elements moved up 48px')
    expect(summarizeRecorded([effect({ subtreeCount: 0 })])).toBe('main.page moved up 48px')
  })
})
