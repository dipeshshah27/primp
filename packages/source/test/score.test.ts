import { describe, expect, it } from 'vitest'
import { scoreTag } from '../src/node/score.ts'
import { context } from './helpers.ts'

describe('scoreTag', () => {
  it('gives one point for the tag alone', () => {
    expect(scoreTag('<p>', '', context('p'))).toEqual({ score: 1, why: ['tag'] })
  })

  it('rewards id, classes, attributes and text', () => {
    const element = context('a', { id: 'cta', classes: ['btn', 'btn-primary'], attrs: { href: '/pricing' }, ownText: 'See pricing' })
    const full = scoreTag('<a id="cta" className="btn btn-primary" href="/pricing">', 'See pricing', element)
    const partial = scoreTag('<a className="btn" href="/docs">', 'Read the docs', element)
    expect(full.score).toBeGreaterThan(partial.score)
    expect(full.why).toEqual(['tag', 'id "cta"', 'class btn btn-primary', 'href="/pricing"', 'text "See pricing"'])
    expect(partial.why).toEqual(['tag', 'class btn'])
  })

  it('matches class tokens as whole words', () => {
    const element = context('div', { classes: ['card'] })
    expect(scoreTag('<div className="card-grid">', '', element).why).toEqual(['tag'])
    expect(scoreTag('<div className="grid card">', '', element).why).toEqual(['tag', 'class card'])
  })

  it('recognises CSS-module classes by their local name', () => {
    const turbopack = context('section', { classes: ['page-module__E0kJGG__hero'] })
    expect(scoreTag('<section className={styles.hero}>', '', turbopack).why).toEqual(['tag', 'class hero (module)'])
    const vite = context('section', { classes: ['_hero_1x2y3_5'] })
    expect(scoreTag("<section className={styles['hero']}>", '', vite).why).toEqual(['tag', 'class hero (module)'])
  })

  it("ignores Svelte's generated scoping class", () => {
    const element = context('p', { classes: ['svelte-19k1lh4', 'note'] })
    expect(scoreTag('<p class="note">', '', element).why).toEqual(['tag', 'class note'])
    expect(scoreTag('<p class="svelte-19k1lh4">', '', context('p', { classes: ['svelte-19k1lh4'] })).why).toEqual(['tag'])
  })

  it('never scores on the value of a data-* attribute other than the test-id family', () => {
    // An element whose class or text happens to equal a data-label (or any tool attribute) value
    // written in the source must not be matched through it.
    const element = context('h1', { classes: ['hero-title'], ownText: 'hero-title' })
    expect(scoreTag('<h1 data-label="hero-title">', '', element)).toEqual({ score: 1, why: ['tag'] })
    expect(scoreTag("<h1 data-label={'hero-title'} data-x='hero-title'>", '', element)).toEqual({ score: 1, why: ['tag'] })
    const tested = context('h1', { attrs: { 'data-testid': 'hero-title' } })
    expect(scoreTag('<h1 data-testid="hero-title">', '', tested).why).toEqual(['tag', 'data-testid="hero-title"'])
  })

  it('falls back to single words when the text is interleaved with expressions', () => {
    const element = context('td', { ownText: 'Item 42' })
    expect(scoreTag('<td>', 'Item {index + 1}', element).why).toEqual(['tag', '1 word of the text'])
    expect(scoreTag('<td>', '{(index * 37) % 1000}', element).why).toEqual(['tag'])
  })

  it('strips nested tags before comparing text', () => {
    const element = context('p', { text: 'Read the docs now' })
    expect(scoreTag('<p>', '\n  Read the <em>docs</em> now\n', element).why).toEqual(['tag', 'text "Read the docs now"'])
  })

  it('uses single words when part of the text is computed', () => {
    const element = context('p', { text: 'Measurements taken so far: 3' })
    expect(scoreTag('<p>', '\n  Measurements taken so far: <strong>{measured}</strong>\n', element).why).toEqual(['tag', '3 words of the text'])
  })

  it('caps class and attribute points so one long class list cannot outvote everything', () => {
    const classes = Array.from({ length: 12 }, (_, index) => `u-${index}`)
    const element = context('div', { classes })
    expect(scoreTag(`<div class="${classes.join(' ')}">`, '', element).score).toBe(9)
  })
})
