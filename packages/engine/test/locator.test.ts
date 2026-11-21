import { describe, expect, it } from 'vitest'
import type { Locator } from '@reglet/protocol/change'
import { MIN_CONFIDENCE, MIN_MARGIN, ancestorSimilarity, isEquivalentInstance, pathSimilarity, pickBest, scoreCandidate, textSimilarity } from '../src/locator.ts'

const el = (tag: string, indexPath: number[], ancestors: string[], rest: Partial<Locator> = {}): Locator => ({ tag, indexPath, ancestors, ...rest })

/** A header with a nav: three links and a button. */
const NAV = ['body', 'header', 'nav']
const signIn = el('button', [0, 0, 3], NAV, { role: 'button', accName: 'Sign in', text: 'Sign in', prevAnchor: 'a Docs' })
const page = (): Locator[] => [
  el('a', [0, 0, 0], NAV, { href: '/', text: 'Home', nextAnchor: 'a Pricing' }),
  el('a', [0, 0, 1], NAV, { href: '/pricing', text: 'Pricing', prevAnchor: 'a Home', nextAnchor: 'a Docs' }),
  el('a', [0, 0, 2], NAV, { href: '/docs', text: 'Docs', prevAnchor: 'a Pricing', nextAnchor: 'button Sign in' }),
  signIn,
  el('button', [1, 0, 1], ['body', 'main', 'section'], { role: 'button', accName: 'Get started', text: 'Get started', prevAnchor: 'p Fast' }),
  el('h1', [1, 0, 0], ['body', 'main', 'section'], { text: 'Ship faster' }),
]

describe('similarity parts', () => {
  it('textSimilarity: normalised, token overlap', () => {
    expect(textSimilarity('Sign in', '  sign   IN ')).toBe(1)
    expect(textSimilarity('Sign in', 'Sign in!')).toBe(1)
    expect(textSimilarity('Save', 'Save changes')).toBeCloseTo(2 / 3, 5)
    expect(textSimilarity('Item 3', 'Item 4')).toBe(0.5)
    expect(textSimilarity('Sign in', 'Log out')).toBe(0)
    expect(textSimilarity('', '')).toBe(1)
    expect(textSimilarity('Sign in', '')).toBe(0)
    expect(textSimilarity('Größe wählen', 'größe WÄHLEN')).toBe(1)
  })

  it('pathSimilarity: tolerant of one inserted or removed sibling or wrapper, independent of depth', () => {
    expect(pathSimilarity([0, 1, 2], [0, 1, 2])).toBe(1)
    expect(pathSimilarity([0, 1, 2], [0, 1, 3])).toBeCloseTo(0.6, 5)
    expect(pathSimilarity([0, 1, 2], [0, 2, 2])).toBeCloseTo(0.6, 5)
    expect(pathSimilarity([4, 0, 1, 7, 2, 0, 3, 2], [4, 0, 1, 7, 2, 0, 3, 3])).toBeCloseTo(0.6, 5)
    expect(pathSimilarity([0, 1, 2], [0, 1, 0, 2])).toBeCloseTo(0.6, 5)
    expect(pathSimilarity([0, 1, 2], [0, 1, 2, 0])).toBeCloseTo(0.6, 5)
    expect(pathSimilarity([0, 1, 2, 0], [0, 1, 2])).toBeCloseTo(0.6, 5)
    expect(pathSimilarity([0, 1, 2], [0, 1, 5])).toBeCloseTo(0.2, 5)
    expect(pathSimilarity([0, 1, 2], [0, 2, 3])).toBeCloseTo(0.2, 5)
    expect(pathSimilarity([0, 1, 2], [3, 4, 5])).toBe(0)
    expect(pathSimilarity([0], [0, 1, 2, 3])).toBe(0)
    expect(pathSimilarity([], [])).toBe(1)
  })

  it('ancestorSimilarity', () => {
    expect(ancestorSimilarity(['body', 'main', 'ul'], ['body', 'main', 'ul'])).toBe(1)
    expect(ancestorSimilarity(['body', 'main', 'ul'], ['BODY', 'MAIN', 'UL'])).toBe(1)
    expect(ancestorSimilarity(['body', 'main', 'ul'], ['body', 'main', 'div', 'ul'])).toBe(0.65)
    expect(ancestorSimilarity(['body', 'main', 'ul'], ['body', 'section', 'ul'])).toBe(0.65)
    expect(ancestorSimilarity(['body', 'main', 'ul'], ['body', 'div', 'div', 'main', 'ul'])).toBe(0.3)
    expect(ancestorSimilarity(['body'], ['body', 'a', 'b', 'c'])).toBe(0)
  })
})

describe('scoreCandidate', () => {
  it('the tag is required', () => {
    expect(scoreCandidate(signIn, { ...signIn, tag: 'a' })).toBe(0)
    expect(scoreCandidate(signIn, { ...signIn, tag: 'BUTTON' })).toBe(1)
  })

  it('an unchanged element scores 1; signals the locator does not have cost nothing', () => {
    expect(scoreCandidate(signIn, signIn)).toBe(1)
    expect(scoreCandidate(signIn, { ...signIn, id: 'new-id', testId: 'x', href: '/x', name: 'n', nextAnchor: 'a Later' })).toBe(1)
    const bare = el('div', [0, 4], ['body'])
    expect(scoreCandidate(bare, bare)).toBe(1)
  })

  it('class names are not part of it', () => {
    const withClasses = { ...signIn, classes: ['btn', 'btn-primary'] } as Locator
    const otherClasses = { ...signIn, classes: ['px-4', 'py-2', 'rounded'] } as Locator
    expect(scoreCandidate(withClasses, otherClasses)).toBe(1)
  })

  it('id and testId are strong; a different id costs a lot', () => {
    const save = el('button', [1, 2, 0], ['body', 'main', 'form'], { id: 'save', text: 'Save' })
    // text changed completely, id kept: (10 + 0 + 4 + 2) / 20
    expect(scoreCandidate(save, { ...save, text: 'Submit' })).toBeCloseTo(0.8, 5)
    // everything else the same, another id: (0 + 4 + 4 + 2) / 20
    expect(scoreCandidate(save, { ...save, id: 'cancel' })).toBeCloseTo(0.5, 5)
    const card = el('article', [1, 0, 2], ['body', 'main', 'div'], { testId: 'plan-pro' })
    // moved five places, testId kept: (6 + 4 * 0.2 + 2) / 12
    expect(scoreCandidate(card, { ...card, indexPath: [1, 0, 7] })).toBeCloseTo(8.8 / 12, 5)
    expect(scoreCandidate(card, { ...card, testId: 'plan-free' })).toBeCloseTo(0.5, 5)
  })

  it('role with accessible name, href and name', () => {
    const link = el('a', [0, 1], ['body', 'nav'], { role: 'link', accName: 'Pricing', href: '/pricing' })
    // total 3 + 2 + 4 + 2 = 11
    expect(scoreCandidate(link, { ...link, accName: 'Pricing plans' })).toBeCloseTo((3 * (0.4 + 0.6 * (2 / 3)) + 2 + 4 + 2) / 11, 5)
    expect(scoreCandidate(link, { ...link, role: 'button' })).toBeCloseTo(8 / 11, 5)
    expect(scoreCandidate(link, { ...link, href: '/plans' })).toBeCloseTo(9 / 11, 5)
    const input = el('input', [0, 1], ['body', 'form'], { name: 'email' })
    expect(scoreCandidate(input, { ...input, name: 'password' })).toBeCloseTo(6 / 8, 5)
  })
})

describe('pickBest', () => {
  it('unchanged page: the same element, confidence 1, a clear margin', () => {
    const picked = pickBest(signIn, page())
    expect(picked).not.toBeNull()
    expect(picked?.index).toBe(3)
    expect(picked?.confidence).toBe(1)
    expect(picked?.margin).toBeGreaterThan(0.5)
  })

  it('no candidates, or none with the tag: null', () => {
    expect(pickBest(signIn, [])).toBeNull()
    expect(pickBest(signIn, page().filter((c) => c.tag !== 'button'))).toBeNull()
  })

  it('a sibling inserted above: still found, by text and the tolerant index path', () => {
    const now = page()
    now.splice(3, 0, el('a', [0, 0, 3], NAV, { href: '/blog', text: 'Blog', prevAnchor: 'a Docs', nextAnchor: 'button Sign in' }))
    now[4] = { ...signIn, indexPath: [0, 0, 4], prevAnchor: 'a Blog' }
    const picked = pickBest(signIn, now)
    expect(picked?.index).toBe(4)
    // (3 + 4 + 4 * 0.6 + 2 + 0) / 14
    expect(picked?.confidence).toBeCloseTo(11.4 / 14, 3)
    expect(picked?.margin).toBeGreaterThan(0.3)
  })

  it('a sibling inserted above, far from the element: the anchors still match', () => {
    const now = page().map((c) => (c.ancestors === NAV || c.ancestors.join() === NAV.join() ? { ...c, indexPath: [0, 0, (c.indexPath[2] ?? 0) + 1] } : c))
    const picked = pickBest(signIn, now)
    expect(picked?.index).toBe(3)
    expect(picked?.confidence).toBeCloseTo(12.4 / 14, 3)
  })

  it('text changed but id the same', () => {
    const save = el('button', [1, 2, 0], ['body', 'main', 'form'], { id: 'save', text: 'Save' })
    const now = [
      el('button', [1, 2, 1], ['body', 'main', 'form'], { id: 'cancel', text: 'Cancel' }),
      { ...save, text: 'Save changes' },
      el('button', [0, 0, 3], NAV, { text: 'Save' }),
    ]
    const picked = pickBest(save, now)
    expect(picked?.index).toBe(1)
    // (10 + 4 * 2/3 + 4 + 2) / 20
    expect(picked?.confidence).toBeCloseTo(0.933, 3)
    expect(picked?.margin).toBeGreaterThan(0.5)
  })

  describe('a list item among six near-identical siblings', () => {
    const LIST = ['body', 'main', 'ul']
    const identical = (count = 6): Locator[] =>
      Array.from({ length: count }, (_, i) =>
        el('li', [1, 0, i], LIST, { text: 'Add to cart', ...(i > 0 ? { prevAnchor: 'li Add to cart' } : {}), ...(i < count - 1 ? { nextAnchor: 'li Add to cart' } : {}) }),
      )
    const numbered = (labels: string[]): Locator[] =>
      labels.map((label, i) => el('li', [1, 0, i], LIST, { text: label, ...(i > 0 ? { prevAnchor: `li ${labels[i - 1]}` } : {}), ...(i < labels.length - 1 ? { nextAnchor: `li ${labels[i + 1]}` } : {}) }))

    it('identical text: the index path decides, with enough margin', () => {
      const items = identical()
      for (const index of [0, 2, 5]) {
        const picked = pickBest(items[index] as Locator, items)
        expect(picked?.index).toBe(index)
        expect(picked?.confidence).toBe(1)
        expect(picked?.margin).toBeGreaterThanOrEqual(MIN_MARGIN)
      }
      // The only difference between a middle item and its neighbour is the path: 4 * 0.4 / 12.
      expect(pickBest(items[2] as Locator, items)?.margin).toBeCloseTo(1.6 / 12, 3)
    })

    it('the same holds deep in the tree and with more shared signals', () => {
      const deep = identical().map((c) => ({ ...c, indexPath: [3, 1, 4, 1, 5, 9, 2, 6, ...c.indexPath], testId: 'product', role: 'listitem', accName: 'Add to cart' }))
      const picked = pickBest(deep[3] as Locator, deep)
      expect(picked?.index).toBe(3)
      expect(picked?.margin).toBeGreaterThanOrEqual(MIN_MARGIN)
    })

    it('distinct text, list reordered: the text is the stable signal', () => {
      const before = numbered(['Free', 'Starter', 'Team', 'Business', 'Scale', 'Enterprise'])
      const after = numbered(['Enterprise', 'Scale', 'Business', 'Free', 'Team', 'Starter'])
      const picked = pickBest(before[1] as Locator, after)
      expect(picked?.index).toBe(5)
      expect(picked?.confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE)
    })

    it('reordered with no stable signal: ambiguous, so null', () => {
      // The recorded position now holds a divider; identical items sit on both sides of it.
      const items = identical()
      const target = items[2] as Locator
      const now = items.filter((_, i) => i !== 2)
      expect(scoreCandidate(target, now[1] as Locator)).toBeCloseTo(scoreCandidate(target, now[2] as Locator), 10)
      expect(pickBest(target, now)).toBeNull()
    })

    it('with anyInstance an equivalent instance will do; a tie between unrelated elements still will not', () => {
      const items = identical()
      const target = items[2] as Locator
      const now = items.filter((_, i) => i !== 2)
      const picked = pickBest(target, now, { anyInstance: true })
      expect(picked?.index).toBe(1)
      expect(picked?.margin).toBe(0)
      expect(picked?.confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE)

      const elsewhere = [el('li', [1, 0, 1], LIST, { text: 'Add to cart' }), el('li', [1, 1, 2], ['body', 'main', 'ol'], { text: 'Add to cart' })]
      const loose = el('li', [1, 0, 2], LIST, { text: 'Add to cart' })
      expect(isEquivalentInstance(elsewhere[0] as Locator, elsewhere[1] as Locator)).toBe(false)
      expect(pickBest({ ...loose, ancestors: ['body', 'main', 'div'] }, elsewhere, { anyInstance: true })).toBeNull()
    })

    it('text changed and list reordered: conflicting weak signals stay below the minimum', () => {
      const before = numbered(['Wireless mouse', 'USB hub', 'Laptop stand', 'Webcam', 'Desk lamp', 'Monitor arm'])
      const after = numbered(['Desk lamp', 'Webcam', 'USB hub', 'Monitor arm', 'Wireless mouse pad', 'Laptop stand'])
      // Recorded: "Laptop stand" at index 2. Now index 2 is "USB hub"; "Laptop stand" is at 5, three places away.
      const picked = pickBest(before[2] as Locator, after)
      expect(picked?.index).toBe(5)
      // "Wireless mouse" at 0: its text now only partly matches the item at 4, and the position says 0.
      expect(pickBest(before[0] as Locator, after)).toBeNull()
    })
  })

  it('element removed: null, the neighbours do not qualify', () => {
    const now = page().filter((c) => c !== signIn && c.text !== 'Sign in')
    expect(now).toHaveLength(5)
    expect(pickBest(signIn, now)).toBeNull()
    // The best remaining button is far below the minimum.
    expect(Math.max(...now.map((c) => scoreCandidate(signIn, c)))).toBeLessThan(MIN_CONFIDENCE - 0.2)
  })

  it('element removed from a list of different items: the next item slides into its place but does not qualify', () => {
    const LIST = ['body', 'main', 'ul']
    const target = el('li', [1, 0, 1], LIST, { text: 'Starter', prevAnchor: 'li Free', nextAnchor: 'li Team' })
    const now = [el('li', [1, 0, 0], LIST, { text: 'Free', nextAnchor: 'li Team' }), el('li', [1, 0, 1], LIST, { text: 'Team', prevAnchor: 'li Free' })]
    // Same position and previous sibling, other text: (0 + 4 + 2 + 1 + 0) / 12 = 0.58, and the runner-up is close.
    expect(scoreCandidate(target, now[1] as Locator)).toBeCloseTo(7 / 12, 5)
    expect(pickBest(target, now, { minConfidence: 0.6 })).toBeNull()
  })

  it('a wrapper div added around it', () => {
    const heading = el('h2', [1, 2, 0], ['body', 'main', 'section'], { text: 'Pricing', nextAnchor: 'p Choose a plan' })
    const now = [
      el('h1', [1, 0, 0], ['body', 'main', 'section'], { text: 'Ship faster' }),
      el('h2', [1, 1, 0], ['body', 'main', 'section'], { text: 'Features', nextAnchor: 'p Everything you need' }),
      // Wrapped on its own: one more level, one more ancestor, no next sibling any more.
      el('h2', [1, 2, 0, 0], ['body', 'main', 'section', 'div'], { text: 'Pricing' }),
      el('h2', [1, 3, 0], ['body', 'main', 'section'], { text: 'Questions', nextAnchor: 'p Ask us' }),
    ]
    const picked = pickBest(heading, now)
    expect(picked?.index).toBe(2)
    // (4 + 4 * 0.6 + 2 * 0.65 + 0) / 11
    expect(picked?.confidence).toBeCloseTo(0.7, 3)
    expect(picked?.margin).toBeGreaterThan(0.2)
  })

  it('a wrapper added higher up, around the whole section', () => {
    const now = page().map((c) => (c.indexPath[0] === 0 ? { ...c, indexPath: [0, 0, ...c.indexPath.slice(1)], ancestors: ['body', 'div', ...c.ancestors.slice(1)] } : c))
    const picked = pickBest(signIn, now)
    expect(picked?.index).toBe(3)
    // (3 + 4 + 4 * 0.6 + 2 * 0.65 + 1) / 14
    expect(picked?.confidence).toBeCloseTo(11.7 / 14, 3)
  })

  it('two elements with the same id: ambiguous', () => {
    const save = el('button', [1, 2, 0], ['body', 'main', 'form'], { id: 'save' })
    const twins = [el('button', [1, 2, 1], ['body', 'main', 'form'], { id: 'save' }), el('button', [1, 1, 0], ['body', 'main', 'form'], { id: 'save' })]
    expect(pickBest(save, twins)).toBeNull()
    expect(pickBest(save, [...twins, save])?.index).toBe(2)
  })

  it('thresholds can be changed by the caller', () => {
    const target = el('p', [1, 0], ['body', 'main'], { text: 'Hello world' })
    const moved = [el('p', [1, 5], ['body', 'main'], { text: 'Hello there' })]
    // (4 * 0.5 + 4 * 0.2 + 2) / 10 = 0.48
    expect(pickBest(target, moved)).toBeNull()
    expect(pickBest(target, moved, { minConfidence: 0.4 })).toEqual({ index: 0, confidence: 0.48, margin: 0.48 })
  })
})
