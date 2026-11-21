import { describe, expect, it } from 'vitest'
import { contentAfterTagAt, findOpeningTag, isJsxFile, offsetOf, openingTagText, textAfterTag, untilClosingTag } from '../src/node/verify.ts'
import { positionOf } from './helpers.ts'

const CARD = `import styles from './Card.module.css'

export function Card<T extends string>({ title, items }: Props<T>) {
  const wide = items.length < 3 && title.length > 4
  return (
    <article className={styles.card} data-wide={wide}>
      <h3 className="title">{title}</h3>
      <ul>
        {items.map((item) => (
          <li key={item}><span>{item}</span><span className="dot">.</span></li>
        ))}
      </ul>
      <Button
        variant="ghost"
        onClick={() => console.log(title > 'a')}
      >
        More
      </Button>
    </article>
  )
}
`

describe('findOpeningTag', () => {
  it('confirms a tag that starts exactly at the claimed position', () => {
    const at = positionOf(CARD, '<h3')
    expect(findOpeningTag(CARD, at.line, at.col, { tag: 'h3' })).toEqual({ line: 7, col: 7, kind: 'exact', name: 'h3', dynamic: false })
  })

  it('moves to the tag on the same line when the column points elsewhere', () => {
    // Source maps often point at the tag name or at the start of the statement.
    expect(findOpeningTag(CARD, 7, 8, { tag: 'h3' })).toMatchObject({ line: 7, col: 7, kind: 'same-line' })
    expect(findOpeningTag(CARD, 7, 1, { tag: 'h3' })).toMatchObject({ line: 7, col: 7, kind: 'same-line' })
    expect(findOpeningTag(CARD, 7, undefined, { tag: 'h3' })).toMatchObject({ line: 7, col: 7, kind: 'same-line' })
  })

  it('picks the nearest of several same tags on one line', () => {
    const first = positionOf(CARD, '<span')
    const second = positionOf(CARD, '<span', 1)
    expect(findOpeningTag(CARD, first.line, first.col + 2, { tag: 'span' })).toMatchObject({ col: first.col, kind: 'same-line' })
    expect(findOpeningTag(CARD, second.line, second.col + 2, { tag: 'span' })).toMatchObject({ col: second.col, kind: 'same-line' })
    expect(findOpeningTag(CARD, second.line, second.col, { tag: 'span' })).toMatchObject({ col: second.col, kind: 'exact' })
  })

  it('does not accept another host tag at the claimed position', () => {
    const at = positionOf(CARD, '<ul')
    // The claim says <li> at the <ul> position: the <li> two lines down is found, as nearby.
    expect(findOpeningTag(CARD, at.line, at.col, { tag: 'li' })).toEqual({ line: 10, col: 11, kind: 'nearby', name: 'li', dynamic: false })
  })

  it('searches nearby lines nearest first, within the window only', () => {
    expect(findOpeningTag(CARD, 9, 1, { tag: 'li' })).toMatchObject({ line: 10, kind: 'nearby' })
    expect(findOpeningTag(CARD, 4, 1, { tag: 'li' })).toBeUndefined()
    expect(findOpeningTag(CARD, 4, 1, { tag: 'li', window: 6 })).toMatchObject({ line: 10, kind: 'nearby' })
    expect(findOpeningTag(CARD, 9, 1, { tag: 'li', window: 0 })).toBeUndefined()
  })

  it('does not take comparisons, arrow generics or closing tags for opening tags', () => {
    // Line 4 of CARD has `<` comparisons.
    expect(findOpeningTag(CARD, 4, 1, { window: 0 })).toBeUndefined()
    expect(findOpeningTag('const a = <T,>(x: T) => x\n', 1, 11, { window: 0 })).toBeUndefined()
    expect(findOpeningTag('  </div>\n', 1, 3, { tag: 'div', window: 0 })).toBeUndefined()
  })

  it('in JSX files, a search of the line does not take a type argument list for a tag', () => {
    // Line 3 of CARD: `Card<T extends string>({ ... }: Props<T>)`.
    expect(findOpeningTag(CARD, 3, 1, { window: 0, jsx: true })).toBeUndefined()
    expect(findOpeningTag(CARD, 3, 1, { window: 0 })).toMatchObject({ name: 'T', kind: 'same-line' })
    expect(findOpeningTag('const [item, setItem] = useState<Item>(first)\n', 1, 1, { tag: 'div', window: 0, jsx: true })).toBeUndefined()
    expect(findOpeningTag('const rows = (list as Array<Row>).map(render)\n', 1, 1, { tag: 'tr', window: 0, jsx: true })).toBeUndefined()
    // JSX after `(`, `{`, `&&`, `return` or `>` is still found.
    expect(findOpeningTag('  return <Row item={item} />\n', 1, 1, { tag: 'tr', jsx: true })).toMatchObject({ col: 10, name: 'Row', dynamic: true })
    expect(findOpeningTag('  {open && <div>x</div>}\n', 1, 1, { tag: 'div', jsx: true })).toMatchObject({ col: 12, kind: 'same-line' })
    expect(findOpeningTag('<li><span>a</span></li>\n', 1, 5, { tag: 'span', jsx: true })).toMatchObject({ col: 5, kind: 'exact' })
    // At the claimed column a tag straight after text is accepted: `one<br />two` is valid JSX.
    expect(findOpeningTag('  <p>one<br />two</p>\n', 1, 9, { tag: 'br', jsx: true })).toMatchObject({ col: 9, kind: 'exact' })
  })

  it('in HTML-like files, a tag may follow text directly', () => {
    expect(findOpeningTag('Hello<b>bold</b>\n', 1, 6, { tag: 'b' })).toMatchObject({ col: 6, kind: 'exact' })
    expect(isJsxFile('src/App.tsx')).toBe(true)
    expect(isJsxFile('src/lib/util.mjs')).toBe(true)
    expect(isJsxFile('src/routes/+page.svelte')).toBe(false)
    expect(isJsxFile('index.html')).toBe(false)
  })

  it('accepts a component or member expression for any DOM tag and says so', () => {
    const at = positionOf(CARD, '<Button')
    expect(findOpeningTag(CARD, at.line, at.col, { tag: 'button' })).toEqual({ line: 13, col: 7, kind: 'exact', name: 'Button', dynamic: true })
    expect(findOpeningTag('  <motion.div layout>\n', 1, 3, { tag: 'div' })).toMatchObject({ kind: 'exact', name: 'motion.div', dynamic: true })
    expect(findOpeningTag('<svelte:element this={tag}>\n', 1, 1, { tag: 'h2' })).toMatchObject({ name: 'svelte:element', dynamic: true })
  })

  it('prefers a real host tag over a component on the same line', () => {
    const line = '  <Wrap><p>text</p></Wrap>\n'
    expect(findOpeningTag(line, 1, 1, { tag: 'p' })).toMatchObject({ col: 9, name: 'p', dynamic: false, kind: 'same-line' })
  })

  it('never reports a component as a nearby match', () => {
    expect(findOpeningTag('<Card>\n\n</Card>\n', 2, 1, { tag: 'div' })).toBeUndefined()
  })

  it('accepts any opening tag when no tag is expected (component usage)', () => {
    const at = positionOf(CARD, '<Button')
    expect(findOpeningTag(CARD, at.line, at.col)).toMatchObject({ kind: 'exact', name: 'Button', dynamic: false })
    expect(findOpeningTag(CARD, 2, 1)).toBeUndefined()
  })

  it('returns undefined for a line beyond the file', () => {
    expect(findOpeningTag(CARD, 500, 1, { tag: 'h3' })).toBeUndefined()
  })

  it('matches upper-case HTML tags against the DOM tag name', () => {
    expect(findOpeningTag('<DIV class="a">\n', 1, 1, { tag: 'div' })).toMatchObject({ kind: 'exact', dynamic: true })
    expect(findOpeningTag('<div class="a">\n', 1, 1, { tag: 'div' })).toMatchObject({ kind: 'exact', dynamic: false })
  })
})

describe('openingTagText', () => {
  it('ends at the closing > of the tag, not at one inside an attribute', () => {
    const at = positionOf(CARD, '<Button')
    const text = openingTagText(CARD, at.line, at.col)
    expect(text.startsWith('<Button')).toBe(true)
    expect(text.endsWith("console.log(title > 'a')}\n      >")).toBe(true)
  })

  it('handles a > inside a quoted attribute and an arrow function', () => {
    expect(openingTagText('<a title="a > b" onClick={() => go()}>x</a>', 1, 1)).toBe('<a title="a > b" onClick={() => go()}>')
  })

  it('is cut at the limit when the tag never closes', () => {
    expect(openingTagText(`<div ${'x'.repeat(50)}`, 1, 1, 10)).toHaveLength(10)
  })
})

describe('offsetOf', () => {
  it('converts 1-based line and column to an offset', () => {
    expect(offsetOf('ab\ncd\nef', 1, 1)).toBe(0)
    expect(offsetOf('ab\ncd\nef', 2, 2)).toBe(4)
    expect(offsetOf('ab\ncd\nef', 3, 1)).toBe(6)
    expect(offsetOf('ab\ncd', 9, 1)).toBe(5)
  })
})

describe('textAfterTag', () => {
  it("returns the element's own content, not the text of later siblings", () => {
    const row = '<tr>\n  <td>Item {n}</td>\n  <td>{n % 3 ? "idle" : "active"}</td>\n</tr>\n'
    expect(textAfterTag(row, 2, 3)).toBe('Item {n}')
    expect(textAfterTag(row, 3, 3)).toBe('{n % 3 ? "idle" : "active"}')
  })

  it('counts nested elements of the same name', () => {
    const source = '<div class="outer"><div>inner</div> outer text</div><p>after</p>'
    expect(textAfterTag(source, 1, 1)).toBe('<div>inner</div> outer text')
    expect(untilClosingTag('<div>a</div> b</div> c', 'div')).toBe('<div>a</div> b')
  })

  it('is empty for a self-closing tag', () => {
    expect(textAfterTag('<input name="q" /> Search me', 1, 1)).toBe('')
    expect(contentAfterTagAt('<br/>next', 0, '<br/>')).toBe('')
  })

  it('falls back to the following text when the closing tag is out of reach', () => {
    expect(textAfterTag('<p>abcdefgh', 1, 1, 4)).toBe('abcd')
  })
})
