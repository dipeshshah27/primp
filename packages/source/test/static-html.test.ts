import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ProjectFiles } from '../src/node/files.ts'
import { htmlFileForPage, locateByPath, searchHtml } from '../src/node/static-html.ts'
import { context, path, positionOf, tempProject, type TempProject } from './helpers.ts'

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Bench</title>
  </head>
  <body>
    <header class="site-header" id="top">
      <a class="brand" href="/">Bench</a>
    </header>
    <main>
      <section class="cards">
        <article class="card"><h2>One</h2><p>First card</p></article>
        <article class="card featured"><h2>Two</h2><p>Second card</p></article>
        <article class="card"><h2>Three</h2><p>Third card</p></article>
      </section>
      <table>
        <tr><td>cell</td></tr>
      </table>
    </main>
    <script src="/js/site.js"></script>
  </body>
</html>
`

describe('locateByPath', () => {
  it('follows the structural path to the start tag', () => {
    const steps = path('html', 'body', 'main', 'section', 'article:1/3', 'p')
    const found = locateByPath(PAGE, steps, context('p', { text: 'Second card' }))
    expect(found).toEqual({ ...positionOf(PAGE, '<p>Second'), exact: true, notes: [] })
  })

  it('finds elements in <head> and the root', () => {
    expect(locateByPath(PAGE, path('html', 'head', 'title'), context('title'))).toMatchObject({ ...positionOf(PAGE, '<title'), exact: true })
    expect(locateByPath(PAGE, path('html'), context('html'))).toMatchObject({ line: 2, col: 1, exact: true })
  })

  it('is exact when scripts only added classes at runtime', () => {
    const steps = path('html', 'body', 'main', 'section', 'article:1/3')
    const found = locateByPath(PAGE, steps, context('article', { classes: ['card', 'featured', 'is-visible'] }))
    expect(found).toMatchObject({ ...positionOf(PAGE, '<article class="card featured"'), exact: true })
  })

  it('is not exact when the element lacks a class or id the file gives that node', () => {
    const steps = path('html', 'body', 'main', 'section', 'article:1/3')
    const found = locateByPath(PAGE, steps, context('article', { classes: ['card'] }))
    expect(found?.exact).toBe(false)
    expect(found?.notes).toEqual(['id or classes of the node in the file differ from the element'])
    const header = locateByPath(PAGE, path('html', 'body', 'header'), context('header', { classes: ['site-header'], id: 'other' }))
    expect(header?.exact).toBe(false)
  })

  it('is not exact when the page has more same-tag siblings than the file (a script inserted one)', () => {
    // Live DOM: a fourth <article> was prepended, so the element we want is now 2 of 4.
    const steps = path('html', 'body', 'main', 'section', 'article:2/4')
    const found = locateByPath(PAGE, steps, context('article', { classes: ['card', 'featured'] }))
    expect(found?.exact).toBe(false)
    expect(found?.notes[0]).toBe('<article> has 4 same-tag siblings in the page but 3 in the file')
  })

  it('returns undefined when the path leaves the file', () => {
    expect(locateByPath(PAGE, path('html', 'body', 'main', 'section', 'article:5/6', 'p'), context('p'))).toBeUndefined()
    expect(locateByPath(PAGE, path('html', 'body', 'aside'), context('aside'))).toBeUndefined()
  })

  it('returns undefined for an element the parser created (implied <tbody>)', () => {
    expect(locateByPath(PAGE, path('html', 'body', 'main', 'table', 'tbody'), context('tbody'))).toBeUndefined()
  })

  it('still finds a cell below an implied <tbody>', () => {
    const found = locateByPath(PAGE, path('html', 'body', 'main', 'table', 'tbody', 'tr', 'td'), context('td', { text: 'cell' }))
    expect(found).toMatchObject({ ...positionOf(PAGE, '<td'), exact: true })
  })
})

describe('searchHtml', () => {
  it('ranks every matching tag by classes and text', () => {
    const candidates = searchHtml(PAGE, 'index.html', context('p', { ownText: 'Third card', text: 'Third card' }))
    expect(candidates).toHaveLength(3)
    expect(candidates[0]).toMatchObject({ file: 'index.html', ...positionOf(PAGE, '<p>Third') })
    expect(candidates[0]?.score).toBeGreaterThan(candidates[1]?.score ?? 0)
  })

  it("scores only the element's own content, not a later sibling's", () => {
    // "Second card" follows the first card closely in the file but is not inside it.
    const candidates = searchHtml(PAGE, 'index.html', context('article', { classes: ['card'], text: 'Two Second card' }))
    expect(candidates[0]).toMatchObject(positionOf(PAGE, '<article class="card featured"'))
    expect(candidates[0]?.score).toBeGreaterThan(candidates[1]?.score ?? 0)
  })

  it('returns nothing when the tag is not in the file', () => {
    expect(searchHtml(PAGE, 'index.html', context('video'))).toEqual([])
  })
})

describe('htmlFileForPage', () => {
  let project: TempProject
  let files: ProjectFiles
  beforeAll(() => {
    project = tempProject({ 'index.html': 'x', 'about.html': 'x', 'docs/index.html': 'x', 'public/legal.html': 'x', 'my page.html': 'x' })
    files = new ProjectFiles(project.root)
  })
  afterAll(() => project.remove())

  it('maps page paths to files the way a static server does', () => {
    expect(htmlFileForPage(files, '/')).toBe('index.html')
    expect(htmlFileForPage(files, '/about.html')).toBe('about.html')
    expect(htmlFileForPage(files, '/about')).toBe('about.html')
    expect(htmlFileForPage(files, '/docs/')).toBe('docs/index.html')
    expect(htmlFileForPage(files, '/legal')).toBe('public/legal.html')
    expect(htmlFileForPage(files, '/my%20page.html')).toBe('my page.html')
  })

  it('returns undefined for a page with no file, and never leaves the project', () => {
    expect(htmlFileForPage(files, '/missing')).toBeUndefined()
    expect(htmlFileForPage(files, '/../../etc/hosts')).toBeUndefined()
  })
})
