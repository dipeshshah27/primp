import { describe, expect, it } from 'vitest'
import { composeSelector, escapeString, stepSelector, type SelectorStep } from '../src/probe/selector.ts'

const step = (tag: string, extra: Partial<SelectorStep> = {}): SelectorStep => ({ tag, nthOfType: 1, hasTwin: false, ...extra })

describe('stepSelector', () => {
  it('prefers the id, then the test id, then the position', () => {
    expect(stepSelector(step('div', { id: 'main', testId: 't' }))).toBe('#main')
    expect(stepSelector(step('div', { testId: 'save' }))).toBe('[data-testid="save"]')
    expect(stepSelector(step('li', { nthOfType: 3, hasTwin: true }))).toBe('li:nth-of-type(3)')
    expect(stepSelector(step('main'))).toBe('main')
  })

  it('escapes what a selector cannot hold as is', () => {
    expect(stepSelector(step('div', { id: 'a:b' }))).toBe('#a\\:b')
    expect(stepSelector(step('div', { testId: 'say "hi"' }))).toBe('[data-testid="say \\"hi\\""]')
    expect(escapeString('a\\b')).toBe('a\\\\b')
  })
})

describe('composeSelector', () => {
  it('uses an id alone when it is unique', () => {
    const tried: string[] = []
    const selector = composeSelector([step('button', { id: 'save' }), step('form'), step('main')], (candidate) => {
      tried.push(candidate)
      return true
    })
    expect(selector).toBe('#save')
    expect(tried).toEqual(['#save'])
  })

  it('grows upwards one step at a time until the selector is unique', () => {
    // The third card of a grid inside #features.
    const steps = [step('article', { nthOfType: 3, hasTwin: true }), step('div'), step('section', { id: 'features' }), step('main')]
    const unique = new Set(['#features > div > article:nth-of-type(3)'])
    expect(composeSelector(steps, (candidate) => unique.has(candidate))).toBe('#features > div > article:nth-of-type(3)')
  })

  it('stops as early as possible', () => {
    const steps = [step('h1'), step('header'), step('div', { id: 'root' })]
    expect(composeSelector(steps, (candidate) => candidate === 'h1')).toBe('h1')
    expect(composeSelector(steps, (candidate) => candidate === 'header > h1')).toBe('header > h1')
  })

  it('climbs past a duplicated id', () => {
    const steps = [step('span', { id: 'dup' }), step('li', { nthOfType: 2, hasTwin: true }), step('ul', { testId: 'list' })]
    const selector = composeSelector(steps, (candidate) => candidate === '[data-testid="list"] > li:nth-of-type(2) > #dup')
    expect(selector).toBe('[data-testid="list"] > li:nth-of-type(2) > #dup')
  })

  it('falls back to the full path from body', () => {
    const steps = [step('p', { nthOfType: 2, hasTwin: true }), step('div')]
    expect(composeSelector(steps, () => false)).toBe('body > div > p:nth-of-type(2)')
    expect(composeSelector([], () => false)).toBe('body')
  })
})
