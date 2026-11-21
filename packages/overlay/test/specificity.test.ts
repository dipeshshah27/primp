import { describe, expect, it } from 'vitest'
import {
  compareCascade,
  compareSpecificity,
  hasDynamicState,
  hasPseudoElement,
  kebab,
  parseDeclarations,
  pickWinner,
  resolveNested,
  specificityOf,
  splitSelectorList,
  type CascadeRank,
} from '../src/probe/specificity.ts'

describe('splitSelectorList', () => {
  it('splits at top-level commas only', () => {
    expect(splitSelectorList('.a, .b')).toEqual(['.a', '.b'])
    expect(splitSelectorList(':is(.a, .b) .c, [title="x, y"], .d')).toEqual([':is(.a, .b) .c', '[title="x, y"]', '.d'])
    expect(splitSelectorList('.sm\\:grid-cols-2')).toEqual(['.sm\\:grid-cols-2'])
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
