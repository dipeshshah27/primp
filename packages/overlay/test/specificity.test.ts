import { describe, expect, it } from 'vitest'
import {
  compareCascade,
  compareSpecificity,
  hasDynamicState,
  hasPseudoElement,
  activeStates,
  atRest,
  inStates,
  kebab,
  parseDeclarations,
  pickWinner,
  replaceState,
  resolveNested,
  specificityOf,
  splitSelectorList,
  statesOf,
  withoutStates,
  type CascadeRank,
} from '../src/probe/specificity.ts'
import { restingSelectors } from '../src/probe/bystanders.ts'

describe('splitSelectorList', () => {
  it('splits at top-level commas only', () => {
    expect(splitSelectorList('.a, .b')).toEqual(['.a', '.b'])
    expect(splitSelectorList(':is(.a, .b) .c, [title="x, y"], .d')).toEqual([':is(.a, .b) .c', '[title="x, y"]', '.d'])
    expect(splitSelectorList('.sm\\:grid-cols-2')).toEqual(['.sm\\:grid-cols-2'])
  })
})

describe('withoutStates', () => {
  it.each<[string, string]>([
    ['.btn', '.btn'],
    ['.btn:hover', '.btn'],
    ['.btn:focus-visible', '.btn'],
    ['.btn::before', '.btn'],
    ['.btn:after', '.btn'],
    ['.btn:hover::before', '.btn'],
    ['a.btn:hover > span', 'a.btn > span'],
    ['.site-nav a:hover', '.site-nav a'],
    ['.menu > :hover', '.menu > *'],
    ['.menu :focus-within .item', '.menu * .item'],
    [':hover.a', '.a'],
    [':hover', '*'],
    ['::selection', '*'],
    ['li:first-child:hover', 'li:first-child'],
    ['li:nth-child(2n + 1):not(.x)', 'li:nth-child(2n + 1):not(.x)'],
    ['.btn:not(:hover)', '.btn'],
    ['.btn:not(:hover, .off)', '.btn:not(.off)'],
    ['.btn:not(*)', '.btn:not(*)'],
    ['.btn:is(:hover, .active)', '.btn:is(*, .active)'],
    ['.card:has(> img:hover)', '.card:has(> img)'],
    [':where(.a:focus, .b) p', ':where(.a, .b) p'],
    ['[title="a:hover"]', '[title="a:hover"]'],
    ['.sm\\:hover\\:p-2:hover', '.sm\\:hover\\:p-2'],
    ['input::placeholder', 'input'],
  ])('%s -> %s', (selector, expected) => {
    expect(withoutStates(selector)).toBe(expected)
  })
})

describe('replaceState', () => {
  const MARK = '[data-primp-force~="hover"]'
  it.each<[string, string | null]>([
    // simple
    ['.btn:hover', `.btn${MARK}`],
    ['a.btn:hover > span', `a.btn${MARK} > span`],
    ['.card:hover .btn:hover', `.card${MARK} .btn${MARK}`],
    [':hover', MARK],
    ['.BTN:HOVER', `.BTN${MARK}`],
    // inside :is(), :where(), :not() and :has()
    ['.btn:is(:hover, .on)', `.btn:is(${MARK}, .on)`],
    [':where(.a:hover, .b) p', `:where(.a${MARK}, .b) p`],
    ['.btn:not(:hover)', `.btn:not(${MARK})`],
    ['.card:has(> img:hover)', `.card:has(> img${MARK})`],
    ['.btn:not(:is(:hover, :focus))', `.btn:not(:is(${MARK}, :focus))`],
    // with pseudo-elements, which stay where they are
    ['.btn:hover::before', `.btn${MARK}::before`],
    ['.btn:hover:after', `.btn${MARK}:after`],
    ['a:hover::first-line', `a${MARK}::first-line`],
    // escaped colons are part of a class name, not a pseudo-class
    ['.hover\\:bg:hover', `.hover\\:bg${MARK}`],
    ['.sm\\:hover\\:p-2:hover', `.sm\\:hover\\:p-2${MARK}`],
    ['.group:hover .group-hover\\:underline', `.group${MARK} .group-hover\\:underline`],
    // other states and other pseudo-classes are left alone
    ['.btn:hover:focus-visible', `.btn${MARK}:focus-visible`],
    ['li:nth-child(2n + 1):hover', `li:nth-child(2n + 1)${MARK}`],
    // no match
    ['.btn', null],
    ['.btn:focus', null],
    ['.hover\\:bg', null],
    ['[title="a:hover"]', null],
    ['.btn::hover', null],
    ['.btn:hoverable', null],
    ['.btn:not(.on)', null],
  ])('%s -> %s', (selector, expected) => {
    expect(replaceState(selector, 'hover', MARK)).toBe(expected)
  })

  it('tells :focus from :focus-visible and :focus-within', () => {
    expect(replaceState('.a:focus-visible', 'focus', '[f]')).toBeNull()
    expect(replaceState('.a:focus-within', 'focus', '[f]')).toBeNull()
    expect(replaceState('.a:focus:focus-visible', 'focus', '[f]')).toBe('.a[f]:focus-visible')
    expect(replaceState('.a:focus:focus-visible', 'focus-visible', '[v]')).toBe('.a:focus[v]')
  })
})

describe('statesOf', () => {
  it.each<[string, string[], boolean]>([
    ['.btn', [], false],
    ['.btn:hover', ['hover'], false],
    ['.card:hover .btn', ['hover'], false],
    ['.btn:focus-visible', ['focus-visible'], false],
    ['.btn:active:hover', ['hover', 'active'], false],
    ['.btn:hover:focus', ['hover', 'focus'], false],
    [':is(.a:hover, .b) p', ['hover'], false],
    [':where(.a:focus) p', ['focus'], false],
    ['.btn:hover:not(:disabled)', ['hover'], false],
    ['.hover\\:underline', [], false],
    // beyond what the dock models
    ['.btn:not(:hover)', [], true],
    ['.card:has(:focus)', [], true],
    ['.field:focus-within label', [], true],
    ['.btn:hover:not(:focus)', ['hover'], true],
  ])('%s needs %j (beyond: %s)', (selector, states, beyond) => {
    const needs = statesOf(selector)
    expect(needs.states).toEqual(states)
    expect(needs.beyond).toBe(beyond)
    expect(needs.any).toBe(states.length > 0 || beyond)
  })
})

describe('activeStates', () => {
  it(':active is reached through :hover, a visible focus is a focus', () => {
    expect(activeStates(null)).toEqual([])
    expect(activeStates(undefined)).toEqual([])
    expect(activeStates('hover')).toEqual(['hover'])
    expect(activeStates('active')).toEqual(['hover', 'active'])
    expect(activeStates('focus')).toEqual(['focus'])
    expect(activeStates('focus-visible')).toEqual(['focus', 'focus-visible'])
  })
})

describe('atRest and inStates: selectors that do not depend on where the pointer is', () => {
  it('at rest no state holds anywhere', () => {
    expect(atRest('.btn')).toBe('.btn')
    expect(atRest('.btn:hover')).toBe('.btn:not(*)')
    expect(atRest('.btn:not(:hover)')).toBe('.btn:not(:not(*))')
    expect(atRest(':is(.on, :focus-visible)')).toBe(':is(.on, :not(*))')
    expect(atRest('.field:focus-within label')).toBe('.field:not(*) label')
  })

  it('in a state, :hover and :active hold for the element and above, :focus and :focus-visible for the element', () => {
    expect(inStates('.btn:hover', ['hover'])).toBe('.btn:is(:scope, :has(:scope))')
    expect(inStates('.card:hover .btn', ['hover'])).toBe('.card:is(:scope, :has(:scope)) .btn')
    expect(inStates('.btn:focus-visible', ['focus-visible'])).toBe('.btn:scope')
    expect(inStates('.btn:hover:focus', ['hover'])).toBe('.btn:is(:scope, :has(:scope)):not(*)')
    expect(inStates('.btn:active', ['hover'])).toBe('.btn:not(*)')
    expect(inStates('.field:focus-within .btn:focus', ['focus'])).toBe('.field:is(:scope, :has(:scope)) .btn:scope')
  })
})

describe('restingSelectors', () => {
  it('one entry per part of the list, at rest, without repeats', () => {
    expect(restingSelectors('.btn')).toEqual(['.btn'])
    expect(restingSelectors('.btn, .btn:hover, a.btn::before')).toEqual(['.btn', 'a.btn'])
    expect(restingSelectors('.compare th, .compare td')).toEqual(['.compare th', '.compare td'])
    expect(restingSelectors(':is(.card, .panel) .title, h2')).toEqual([':is(.card, .panel) .title', 'h2'])
  })

  it('a part that is nothing but a state or a pseudo-element would match everything and is left out', () => {
    expect(restingSelectors('.btn, ::selection')).toEqual(['.btn'])
    expect(restingSelectors(':hover')).toEqual([])
    expect(restingSelectors('*')).toEqual(['*'])
  })
})

describe('specificityOf', () => {
  const cases: [string, [number, number, number]][] = [
    ['*', [0, 0, 0]],
    ['li', [0, 0, 1]],
    ['ul li', [0, 0, 2]],
    ['.card', [0, 1, 0]],
    ['article.card:hover', [0, 2, 1]],
    ['#main .card > h3', [1, 1, 1]],
    ['a[href^="http"]', [0, 1, 1]],
    ['.compare thead th', [0, 1, 2]],
    ['p::first-line', [0, 0, 2]],
    ['li:before', [0, 0, 2]],
    [':where(.a, #b) p', [0, 0, 1]],
    [':is(.a, #b) p', [1, 0, 1]],
    ['.a:not(.b, #c)', [1, 1, 0]],
    ['li:nth-child(2n + 1)', [0, 1, 1]],
    ['.sm\\:grid-cols-2', [0, 1, 0]],
    ['.site-nav a[aria-current="page"]', [0, 2, 1]],
    [':is(.card) .title', [0, 2, 0]],
  ]
  for (const [selector, expected] of cases) {
    it(`${selector} -> ${expected.join(',')}`, () => {
      expect(specificityOf(selector)).toEqual(expected)
    })
  }

  it('orders ids above classes above types', () => {
    expect(compareSpecificity([1, 0, 0], [0, 9, 9])).toBeGreaterThan(0)
    expect(compareSpecificity([0, 1, 0], [0, 0, 9])).toBeGreaterThan(0)
    expect(compareSpecificity([0, 1, 1], [0, 1, 1])).toBe(0)
  })
})

describe('pseudo-elements and transient states', () => {
  it('recognises selectors that style a pseudo-element', () => {
    expect(hasPseudoElement('.a::before')).toBe(true)
    expect(hasPseudoElement('.a:after')).toBe(true)
    expect(hasPseudoElement('input::placeholder')).toBe(true)
    expect(hasPseudoElement('.a:hover')).toBe(false)
    expect(hasPseudoElement('.a\\:\\:b')).toBe(false)
  })

  it('recognises selectors that only apply in a transient state', () => {
    expect(hasDynamicState('.card:hover')).toBe(true)
    expect(hasDynamicState('.btn:focus-visible')).toBe(true)
    expect(hasDynamicState(':is(.a:hover, .b) p')).toBe(true)
    expect(hasDynamicState('.card:not(:hover)')).toBe(false)
    expect(hasDynamicState('.hover\\:underline')).toBe(false)
    expect(hasDynamicState('.card')).toBe(false)
  })
})

describe('resolveNested', () => {
  it('substitutes & and treats a bare nested selector as a descendant', () => {
    expect(resolveNested('.card', '&:hover')).toBe(':is(.card):hover')
    expect(resolveNested('.card', '.title')).toBe(':is(.card) .title')
    expect(resolveNested('.card', '> .title, & + &')).toBe(':is(.card) > .title, :is(.card) + :is(.card)')
    expect(resolveNested('.a, .b', '.c &')).toBe('.c :is(.a, .b)')
    expect(resolveNested('.a', '[data-x="&"]')).toBe(':is(.a) [data-x="&"]')
  })
})

describe('parseDeclarations', () => {
  it('reads a declaration block', () => {
    expect(parseDeclarations('padding: 20px; border: 1px solid rgb(226, 232, 240); color: red !important;')).toEqual([
      { property: 'padding', value: '20px', important: false },
      { property: 'border', value: '1px solid rgb(226, 232, 240)', important: false },
      { property: 'color', value: 'red', important: true },
    ])
  })

  it('keeps semicolons and colons inside strings and functions, and the case of custom properties', () => {
    expect(parseDeclarations('background: url("data:image/png;base64,AAAA"); --Brand-Color: #fff; content: "a;b"')).toEqual([
      { property: 'background', value: 'url("data:image/png;base64,AAAA")', important: false },
      { property: '--Brand-Color', value: '#fff', important: false },
      { property: 'content', value: '"a;b"', important: false },
    ])
    expect(parseDeclarations('')).toEqual([])
  })
})

describe('the cascade', () => {
  const rank = (over: Partial<CascadeRank>): CascadeRank => ({ inline: false, important: false, layer: Infinity, specificity: [0, 1, 0], order: 0, ...over })

  it('inline style beats any rule', () => {
    expect(compareCascade(rank({ inline: true, specificity: [0, 0, 0] }), rank({ specificity: [3, 0, 0] }))).toBeGreaterThan(0)
  })

  it('!important beats inline style and specificity', () => {
    expect(compareCascade(rank({ important: true, specificity: [0, 0, 1] }), rank({ inline: true }))).toBeGreaterThan(0)
    expect(compareCascade(rank({ important: true, specificity: [0, 0, 1] }), rank({ specificity: [1, 0, 0] }))).toBeGreaterThan(0)
    expect(compareCascade(rank({ important: true, inline: true }), rank({ important: true, specificity: [5, 0, 0] }))).toBeGreaterThan(0)
  })

  it('specificity decides, then source order', () => {
    expect(compareCascade(rank({ specificity: [0, 2, 0] }), rank({ specificity: [0, 1, 5], order: 9 }))).toBeGreaterThan(0)
    expect(compareCascade(rank({ order: 2 }), rank({ order: 1 }))).toBeGreaterThan(0)
  })

  it('an unlayered rule beats a layered one whatever the specificity; !important reverses the layers', () => {
    const utilities = rank({ layer: 3, specificity: [0, 1, 0] })
    const base = rank({ layer: 1, specificity: [1, 0, 0] })
    const unlayered = rank({ specificity: [0, 0, 1] })
    expect(compareCascade(unlayered, utilities)).toBeGreaterThan(0)
    expect(compareCascade(utilities, base)).toBeGreaterThan(0)
    expect(compareCascade({ ...base, important: true }, { ...utilities, important: true })).toBeGreaterThan(0)
    expect(compareCascade({ ...utilities, important: true }, { ...unlayered, important: true })).toBeGreaterThan(0)
  })

  it('pickWinner returns the declaration that applies', () => {
    const entries = [
      { ...rank({ specificity: [0, 1, 0], order: 1 }), value: '20px' },
      { ...rank({ specificity: [0, 1, 0], order: 2 }), value: '32px' },
      { ...rank({ specificity: [0, 0, 1], order: 3 }), value: '0' },
    ]
    expect(pickWinner(entries)?.value).toBe('32px')
    expect(pickWinner([...entries, { ...rank({ inline: true, order: 0 }), value: '4px' }])?.value).toBe('4px')
    expect(pickWinner([...entries, { ...rank({ important: true, specificity: [0, 0, 1], order: 0 }), value: '1px' }])?.value).toBe('1px')
    expect(pickWinner([])).toBeUndefined()
  })
})

describe('kebab', () => {
  it('converts the names of a style object to property names', () => {
    expect(kebab('backgroundColor')).toBe('background-color')
    expect(kebab('cssFloat')).toBe('float')
    expect(kebab('webkitLineClamp')).toBe('-webkit-line-clamp')
    expect(kebab('WebkitLineClamp')).toBe('-webkit-line-clamp')
    expect(kebab('MozAppearance')).toBe('-moz-appearance')
    expect(kebab('border-top-left-radius')).toBe('border-top-left-radius')
    expect(kebab('--my-Var')).toBe('--my-Var')
    expect(kebab('gap')).toBe('gap')
  })
})
