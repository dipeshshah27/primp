import type { ElementState } from '@reglet/protocol/change'
import { describe, expect, it } from 'vitest'
import { parseDeclarations, type Specificity } from '../src/probe/specificity.ts'
import { appliesIn, declaredIn, declaredWinners, draftShowsIn, originOf, pageSelector, statesCovering, statesWithRules, type ElementStyles, type MatchedRule } from '../src/probe/styles.ts'

let order = 0
/** A rule as `readStyles` records it. */
function rule(matched: string, css: string, states: ElementState[] = [], extra: Partial<MatchedRule> = {}): MatchedRule {
  const classes = (matched.match(/[.:[]/g) ?? []).length
  const specificity: Specificity = [(matched.match(/#/g) ?? []).length, classes, /^[a-z]/.test(matched) ? 1 : 0]
  return { selector: matched, matched, specificity, declarations: parseDeclarations(css), media: [], active: true, states, cssInJs: false, order: order++, ...extra }
}

const value = (declared: ReturnType<typeof declaredWinners>, property: string): string | undefined => declared.find((entry) => entry.property === property)?.value
const from = (declared: ReturnType<typeof declaredWinners>, property: string): string | undefined => declared.find((entry) => entry.property === property)?.rule?.matched

describe('appliesIn', () => {
  it('a resting rule applies everywhere; a state rule where every state it needs holds', () => {
    const resting = { active: true, states: [] as ElementState[] }
    const hover = { active: true, states: ['hover'] as ElementState[] }
    const pressed = { active: true, states: ['active'] as ElementState[] }
    const ring = { active: true, states: ['focus-visible'] as ElementState[] }
    const both = { active: true, states: ['hover', 'focus'] as ElementState[] }
    for (const state of [null, 'hover', 'focus', 'focus-visible', 'active'] as const) expect(appliesIn(resting, state)).toBe(true)
    expect(appliesIn(hover)).toBe(false)
    expect(appliesIn(hover, 'hover')).toBe(true)
    // An element being pressed is hovered too.
    expect(appliesIn(hover, 'active')).toBe(true)
    expect(appliesIn(pressed, 'hover')).toBe(false)
    expect(appliesIn(hover, 'focus')).toBe(false)
    // A visible focus is a focus; a focus is not necessarily visible.
    expect(appliesIn({ active: true, states: ['focus'] }, 'focus-visible')).toBe(true)
    expect(appliesIn(ring, 'focus')).toBe(false)
    expect(appliesIn(both, 'hover')).toBe(false)
    expect(appliesIn(both, 'focus')).toBe(false)
  })

  it('never outside its media query', () => {
    expect(appliesIn({ active: false, states: [] })).toBe(false)
    expect(appliesIn({ active: false, states: ['hover'] }, 'hover')).toBe(false)
  })
})

describe('statesWithRules', () => {
  it('lists the states a rule is written for, not the ones it merely carries over to', () => {
    expect(statesWithRules([rule('.btn', 'color: red')])).toEqual([])
    expect(statesWithRules([rule('.btn', 'color: red'), rule('.btn:hover', 'color: blue', ['hover'])])).toEqual(['hover'])
    expect(statesWithRules([rule('.btn:focus', 'color: blue', ['focus'])])).toEqual(['focus'])
    expect(statesWithRules([rule('.btn:active', 'color: blue', ['active']), rule('.btn:focus-visible', 'outline: 0', ['focus-visible'])])).toEqual(['focus-visible', 'active'])
    expect(statesWithRules([rule('.btn:hover:active', 'color: blue', ['hover', 'active'])])).toEqual(['active'])
  })

  it('leaves out rules of a media query that does not match, and combinations no single state reaches', () => {
    expect(statesWithRules([rule('.btn:hover', 'color: blue', ['hover'], { active: false })])).toEqual([])
    expect(statesWithRules([rule('.btn:hover:focus', 'color: blue', ['hover', 'focus'])])).toEqual([])
  })
})

describe('declaredWinners: the winner at rest and in a state', () => {
  const base = rule('.plan__cta', 'background-color: #0f172a; color: #ffffff; padding: 10px 16px')
  const hover = rule('.plan__cta:hover', 'background-color: #1e293b', ['hover'])
  const pressed = rule('.plan__cta:active', 'background-color: #000000; padding: 11px 16px 9px', ['active'])
  const ring = rule(':focus-visible', 'outline: 2px solid orange', ['focus-visible'])
  const rules = [base, hover, pressed, ring]

  it('at rest only resting rules count, as before states were read', () => {
    const declared = declaredWinners(rules, [], [])
    expect(declared.map((entry) => entry.property).sort()).toEqual(['background-color', 'color', 'padding'])
    expect(from(declared, 'background-color')).toBe('.plan__cta')
    expect(declaredWinners(rules, [], [], null)).toEqual(declared)
  })

  it('under :hover the hover rule wins its property and the resting rule keeps the others', () => {
    const declared = declaredWinners(rules, [], [], 'hover')
    expect(value(declared, 'background-color')).toBe('#1e293b')
    expect(from(declared, 'background-color')).toBe('.plan__cta:hover')
    expect(declared.find((entry) => entry.property === 'background-color')?.overrides).toBe(1)
    expect(from(declared, 'padding')).toBe('.plan__cta')
    expect(value(declared, 'outline')).toBeUndefined()
    // Strongest source first: the hover rule's property leads.
    expect(declared[0]?.property).toBe('background-color')
  })

  it('under :active the hover rule applies too, and the later rule of equal weight wins', () => {
    const declared = declaredWinners(rules, [], [], 'active')
    expect(from(declared, 'background-color')).toBe('.plan__cta:active')
    expect(declared.find((entry) => entry.property === 'background-color')?.overrides).toBe(2)
    expect(value(declared, 'padding')).toBe('11px 16px 9px')
    // Written the other way round (:active before :hover), hover would win while pressed, as in the browser.
    const reversed = [base, { ...pressed, order: 1000 }, { ...hover, order: 1001 }]
    expect(from(declaredWinners(reversed, [], [], 'active'), 'background-color')).toBe('.plan__cta:hover')
  })

  it('under :focus-visible a bare :focus-visible rule applies; under :focus it does not', () => {
    expect(value(declaredWinners(rules, [], [], 'focus-visible'), 'outline')).toBe('2px solid orange')
    expect(value(declaredWinners(rules, [], [], 'focus'), 'outline')).toBeUndefined()
    const focus = rule('.plan__cta:focus', 'outline: 1px dotted', ['focus'])
    // More specific than the bare rule, so it wins in both.
    expect(value(declaredWinners([...rules, focus], [], [], 'focus-visible'), 'outline')).toBe('1px dotted')
    expect(value(declaredWinners([...rules, focus], [], [], 'focus'), 'outline')).toBe('1px dotted')
  })

  it('specificity, !important, layers and the style attribute rank a state rule like any other', () => {
    const strong = rule('#buy.plan__cta', 'background-color: green')
    expect(from(declaredWinners([base, hover, strong], [], [], 'hover'), 'background-color')).toBe('#buy.plan__cta')
    const important = rule('.plan__cta', 'background-color: red !important')
    expect(value(declaredWinners([base, hover, important], [], [], 'hover'), 'background-color')).toBe('red')
    const inline = parseDeclarations('background-color: pink')
    const withInline = declaredWinners([base, hover], inline, [], 'hover')
    expect(value(withInline, 'background-color')).toBe('pink')
    expect(withInline.find((entry) => entry.property === 'background-color')?.from).toBe('inline')
    // A hover rule in an earlier layer loses to a resting rule in a later one, whatever its specificity.
    const layers = ['components', 'utilities']
    const layeredHover = rule('.plan__cta:hover', 'background-color: #1e293b', ['hover'], { layer: 'components' })
    const utility = rule('.bg-blue', 'background-color: blue', [], { layer: 'utilities' })
    expect(from(declaredWinners([layeredHover, utility], [], layers, 'hover'), 'background-color')).toBe('.bg-blue')
    // Unlayered beats layered.
    expect(from(declaredWinners([utility, hover], [], layers, 'hover'), 'background-color')).toBe('.plan__cta:hover')
  })

  it('a rule outside its media query is not a candidate in any state', () => {
    const wide = rule('.plan__cta:hover', 'background-color: purple', ['hover'], { active: false, media: [{ query: '(min-width: 2000px)', matches: false }] })
    expect(value(declaredWinners([base, hover, wide], [], [], 'hover'), 'background-color')).toBe('#1e293b')
  })
})

describe('declaredIn and originOf', () => {
  const base = rule('.plan__cta', 'background-color: #0f172a; cursor: pointer', [], { sheet: '/src/styles/site.css' })
  const hover = rule('.plan__cta:hover', 'background-color: #1e293b', ['hover'], { sheet: '/src/styles/site.css' })
  const rules = [base, hover]
  const styles: ElementStyles = {
    rules,
    inline: [],
    declared: declaredWinners(rules, [], []),
    states: statesWithRules(rules),
    layers: [],
    media: [],
    system: 'plain-css',
    tailwind: false,
    stats: { rules: 2, unreadableSheets: 0, ms: 0 },
  }

  it('without a state it is the resting list itself', () => {
    expect(declaredIn(styles)).toBe(styles.declared)
    expect(declaredIn(styles, null)).toBe(styles.declared)
    // No rule is particular to :focus here: nothing to compute.
    expect(declaredIn(styles, 'focus')).toBe(styles.declared)
  })

  it('with a state it is that state\'s winners, computed once', () => {
    const inHover = declaredIn(styles, 'hover')
    expect(value(inHover, 'background-color')).toBe('#1e293b')
    expect(declaredIn(styles, 'hover')).toBe(inHover)
    expect(value(declaredIn(styles, 'active'), 'background-color')).toBe('#1e293b')
  })

  it('originOf names the rule that sets the value in the state asked about', () => {
    const resting = originOf(styles, 'background-color')
    expect(resting.origin).toEqual({ via: 'rule', selector: '.plan__cta', sheet: '/src/styles/site.css' })
    expect(resting.authored).toBe('#0f172a')
    expect(resting.ruleStates).toEqual([])
    const inHover = originOf(styles, 'background-color', 'hover')
    expect(inHover.origin).toEqual({ via: 'rule', selector: '.plan__cta:hover', sheet: '/src/styles/site.css' })
    expect(inHover.authored).toBe('#1e293b')
    expect(inHover.ruleSelector).toBe('.plan__cta:hover')
    expect(inHover.ruleStates).toEqual(['hover'])
    // A property the hover rule does not set still comes from the resting rule.
    expect(originOf(styles, 'cursor', 'hover').origin.selector).toBe('.plan__cta')
    expect(originOf(styles, 'cursor', 'hover').ruleStates).toEqual([])
  })
})

describe('pageSelector', () => {
  it('drops the alternatives a forced state added to a rule', () => {
    expect(pageSelector('.btn:hover')).toBe('.btn:hover')
    expect(pageSelector('.btn:hover, .btn[data-reglet-force~="hover"]')).toBe('.btn:hover')
    expect(pageSelector('.a:hover, .b:hover, .a[data-reglet-force~="hover"], .b[data-reglet-force~="hover"]')).toBe('.a:hover, .b:hover')
    expect(pageSelector('&:hover, &[data-reglet-force~="hover"]')).toBe('&:hover')
    expect(pageSelector('.card[data-reglet-force~="hover"] .btn, .card:hover .btn')).toBe('.card:hover .btn')
  })
})

describe('draftShowsIn: which draft a property row shows', () => {
  it('the draft for the very state', () => {
    expect(draftShowsIn(null, null)).toBe('exact')
    expect(draftShowsIn('hover', 'hover', ['hover'])).toBe('exact')
  })

  it('a state draft never shows at rest or in an unrelated state', () => {
    expect(draftShowsIn('hover', null)).toBe(false)
    expect(draftShowsIn('hover', 'focus')).toBe(false)
    expect(draftShowsIn('active', 'hover')).toBe(false)
    expect(draftShowsIn('focus-visible', 'focus')).toBe(false)
  })

  it('a resting draft shows through in a state unless the page has a rule for that state', () => {
    expect(draftShowsIn(null, 'hover', [])).toBe('through')
    expect(draftShowsIn(null, 'hover', ['hover'])).toBe(false)
  })

  it('a :hover draft shows through under :active unless the page has an :active rule', () => {
    expect(draftShowsIn('hover', 'active', [])).toBe('through')
    expect(draftShowsIn('hover', 'active', ['hover'])).toBe('through')
    expect(draftShowsIn('hover', 'active', ['active'])).toBe(false)
    expect(draftShowsIn('focus', 'focus-visible', ['focus-visible'])).toBe(false)
  })
})

describe('statesCovering: where a resting edit of a property does not reach', () => {
  const base = rule('.plan__cta', 'background-color: #0f172a; padding: 10px 16px')
  const hover = rule('.plan__cta:hover', 'background-color: #1e293b', ['hover'])
  const ring = rule(':focus-visible', 'outline: 2px solid orange', ['focus-visible'])
  const wide = rule('.plan__cta:focus', 'padding-top: 12px', ['focus'], { active: false })

  // Shorthands and longhands are related through the browser's CSSOM (longhandsOf), which this environment lacks.
  it('the states whose own rule sets the property; :active is hovered too, a visible focus is a focus', () => {
    expect(statesCovering({ rules: [base, hover, ring] }, 'background-color')).toEqual(['hover', 'active'])
    expect(statesCovering({ rules: [base, hover, ring] }, 'outline')).toEqual(['focus-visible'])
    expect(statesCovering({ rules: [base, rule('.plan__cta:focus', 'outline: 0', ['focus'])] }, 'outline')).toEqual(['focus', 'focus-visible'])
    expect(statesCovering({ rules: [base, hover, ring] }, 'padding')).toEqual([])
    expect(statesCovering({ rules: [base, hover, ring] }, 'color')).toEqual([])
  })

  it('not through a rule whose media query does not match', () => {
    expect(statesCovering({ rules: [base, wide] }, 'padding-top')).toEqual([])
  })
})
