import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { NodeDescriptor, ShiftIssue, ShiftRecording } from '../../protocol/src/shift.ts'
import type { Evidence, SourceResult } from '../../source/src/types.ts'
import { createCulpritResolver, locateByIndexPath } from '../src/culprit-source.ts'
import { removeDir, tempDir } from './session-helpers.ts'

/**
 * A small static project on disk and hand-written issues: what matters here is
 * which route answers and how sure it claims to be.
 */

const INDEX = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Shop</title>
  </head>
  <body>
    <header id="top" class="bar">
      <img class="logo" src="/logo.png" alt="">
      <nav><a href="/a">A</a><a href="/b">B</a></nav>
    </header>
    <main>
      <p>First paragraph.</p>
      <p>Second paragraph.</p>
      <img src="/hero.jpg">
      <div class="a b c d e">Many classes</div>
    </main>
    <script src="/consent.js"></script>
  </body>
</html>
`

const CONSENT = `// consent banner
function show() {
  const bar = document.createElement('div')
  bar.textContent = 'We use cookies'
  document.body.insertBefore(bar, document.body.firstChild)
}
setTimeout(show, 700)
`

let root: string

beforeAll(() => {
  root = tempDir('culprit-test')
  writeFileSync(join(root, 'index.html'), INDEX)
  writeFileSync(join(root, 'consent.js'), CONSENT)
  mkdirSync(join(root, 'docs'))
  writeFileSync(join(root, 'docs', 'index.html'), '<html><body><h1 id="docs">Docs</h1><script>document.body.append(document.createElement("aside"))</script></body></html>\n')
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'banner.ts'), "export function banner(): void {\n  const el = document.createElement('aside')\n  document.body.prepend(el)\n}\n")
})

afterAll(() => removeDir(root))

const node = (partial: Partial<NodeDescriptor> & Pick<NodeDescriptor, 'tag' | 'path'>): NodeDescriptor => ({ uid: 1, selector: partial.tag, ...partial })

function issue(culprit: NodeDescriptor | undefined, stack?: string): ShiftIssue {
  return {
    id: 'shift-1',
    entries: [0],
    startTime: 800,
    endTime: 800,
    value: 0.1,
    cause: stack === undefined ? 'unsized-media' : 'injected-content',
    confidence: 0.9,
    geometricMatch: true,
    ...(culprit === undefined ? {} : { culprit: { node: culprit, sizeBefore: null, sizeAfter: { w: 100, h: 50 } } }),
    ...(stack === undefined ? {} : { trigger: { kind: 'mutation' as const, stack } }),
    victims: [],
    evidence: [],
    scored: true,
  }
}

const recording = (url: string): ShiftRecording => ({ url }) as ShiftRecording

/** Serves the project directory the way a static dev server would. */
function serveProject(extra: Record<string, { body: string; headers?: Record<string, string> }> = {}): { fetch: typeof fetch; requested: string[] } {
  const requested: string[] = []
  const files: Record<string, string> = { '/consent.js': CONSENT, '/': INDEX, '/docs/': 'docs' }
  return {
    requested,
    fetch: (async (input: string | URL | Request) => {
      const url = new URL(String(input))
      requested.push(url.href)
      const special = extra[url.pathname]
      if (special !== undefined) return new Response(special.body, { status: 200, headers: special.headers })
      const body = files[url.pathname]
      return body === undefined ? new Response('not found', { status: 404 }) : new Response(body, { status: 200 })
    }) as typeof fetch,
  }
}

describe('locateByIndexPath', () => {
  it('follows child indexes from <html> to the start tag', () => {
    // html > body(1) > header(0) > img(0)
    expect(locateByIndexPath(INDEX, node({ tag: 'img', path: [1, 0, 0], classes: ['logo'], attrs: { src: '/logo.png' } }))).toMatchObject({ line: 9, col: 7, agrees: true, notes: [] })
    // html > body > main(1) > img(2)
    expect(locateByIndexPath(INDEX, node({ tag: 'img', path: [1, 1, 2], attrs: { src: '/hero.jpg' } }))).toMatchObject({ line: 15, col: 7, agrees: true })
    const header = locateByIndexPath(INDEX, node({ tag: 'header', path: [1, 0], id: 'top', classes: ['bar', 'is-stuck'] }))
    expect(header).toMatchObject({ line: 8, col: 5, agrees: true })
    expect(header?.steps.map((step) => `${step.tag}:${step.index}:${step.ofType}/${step.ofTypeCount}`)).toEqual(['html:0:0/1', 'body:1:0/1', 'header:0:0/1'])
  })

  it('returns nothing when the path leaves the file, ends on another tag, or names no element', () => {
    expect(locateByIndexPath(INDEX, node({ tag: 'img', path: [1, 5, 0] }))).toBeUndefined()
    expect(locateByIndexPath(INDEX, node({ tag: 'div', path: [1, 0, 0] }))).toBeUndefined()
    expect(locateByIndexPath(INDEX, node({ tag: 'img', path: [] }))).toBeUndefined()
    expect(locateByIndexPath(INDEX, node({ tag: '#text', path: [1, 1, 0] }))).toBeUndefined()
    // <html><body> made up by the parser have no position.
    expect(locateByIndexPath('<p>bare</p>', node({ tag: 'body', path: [1] }))).toBeUndefined()
    expect(locateByIndexPath('<p>bare</p>', node({ tag: 'p', path: [1, 0], text: 'bare' }))).toMatchObject({ line: 1, col: 1, agrees: true })
  })

  it('does not call a same-tag neighbour a match: id, classes, src and text must agree', () => {
    // A script inserted a node before the paragraphs: index 1 is now the FIRST paragraph of the file.
    const shifted = locateByIndexPath(INDEX, node({ tag: 'p', path: [1, 1, 1], text: 'First paragraph.' }))
    expect(shifted).toMatchObject({ line: 14, agrees: false, notes: ['the text in the file differs from the element'] })
    expect(locateByIndexPath(INDEX, node({ tag: 'p', path: [1, 1, 1], text: 'Second paragraph.' }))).toMatchObject({ line: 14, agrees: true })
    expect(locateByIndexPath(INDEX, node({ tag: 'img', path: [1, 1, 2], attrs: { src: '/other.jpg' } }))?.notes).toEqual(['the src in the file differs from the element'])
    expect(locateByIndexPath(INDEX, node({ tag: 'header', path: [1, 0], id: 'bottom', classes: ['bar'] }))?.notes).toEqual(['the id in the file differs from the element'])
    expect(locateByIndexPath(INDEX, node({ tag: 'header', path: [1, 0], id: 'top', classes: ['other'] }))?.notes).toEqual(['the classes in the file differs from the element'.replace('differs', 'differ')])
  })

  it('allows for the four-class limit of the recording', () => {
    // The element has five classes in the file; the recording kept the first four.
    expect(locateByIndexPath(INDEX, node({ tag: 'div', path: [1, 1, 3], classes: ['a', 'b', 'c', 'd'], text: 'Many classes' }))).toMatchObject({ agrees: true })
    expect(locateByIndexPath(INDEX, node({ tag: 'div', path: [1, 1, 3], classes: ['w', 'x', 'y', 'z'], text: 'Many classes' }))).toMatchObject({ agrees: false })
  })
})

describe('createCulpritResolver', () => {
  const PAGE = 'http://localhost:5174/'

  it('html route: an element written in the page file is exact, with the file and line', async () => {
    const resolve = createCulpritResolver({ projectRoot: root, target: 'http://localhost:5173', fetch: serveProject().fetch })
    const loc = await resolve(issue(node({ tag: 'img', path: [1, 1, 2], attrs: { src: '/hero.jpg' } })), recording(PAGE))
    expect(loc).toEqual({ file: 'index.html', line: 15, col: 7, framework: 'html', level: 'exact', verifiedOnDisk: true, via: 'html-path', target: 'element', notes: [] })
    const docs = await resolve(issue(node({ tag: 'h1', path: [1, 0], id: 'docs', text: 'Docs' })), recording('http://localhost:5174/docs/'))
    expect(docs).toMatchObject({ file: 'docs/index.html', line: 1, level: 'exact' })
  })

  it('html route: a positional match that disagrees is reported at level file, never exact', async () => {
    const resolve = createCulpritResolver({ projectRoot: root, target: 'http://localhost:5173', fetch: serveProject().fetch })
    const loc = await resolve(issue(node({ tag: 'p', path: [1, 1, 1], text: 'First paragraph.' })), recording(PAGE))
    expect(loc).toMatchObject({ file: 'index.html', line: 14, level: 'file', via: 'html-path' })
    expect(loc?.notes).toContain('found by position in the document; the line is a best guess')
  })

  it('stack route: the DOM call of an inserted culprit, in a script served as written', async () => {
    const { fetch, requested } = serveProject()
    const resolve = createCulpritResolver({ projectRoot: root, target: 'http://localhost:5173', fetch })
    // The page was loaded through the proxy (5174); the script is fetched from the dev server (5173).
    const stack = '    at show (http://localhost:5174/consent.js:5:17)\n    at http://localhost:5174/consent.js:7:1'
    const loc = await resolve(issue(node({ tag: 'div', path: [1, 0], text: 'We use cookies' }), stack), recording(PAGE))
    expect(loc).toEqual({
      file: 'consent.js',
      line: 5,
      col: 17,
      framework: 'unknown',
      level: 'file',
      verifiedOnDisk: true,
      via: 'shift-stack',
      target: 'element',
      notes: ['position of the DOM call that inserted or changed the element, not of a tag'],
    })
    expect(requested).toEqual(['http://localhost:5173/consent.js'])
  })

  it('stack route: skips reglet\'s own frames and frames from other hosts, and reads inline scripts as the page file', async () => {
    const { fetch, requested } = serveProject()
    const resolve = createCulpritResolver({ projectRoot: root, target: 'http://localhost:5173', fetch })
    const stack = [
      '    at HTMLBodyElement.append (http://localhost:5174/__reglet/hook.js?v=abc:1:2000)',
      '    at inject (https://cdn.example.com/widget.js:3:9)',
      '    at http://localhost:5174/docs/:1:60',
    ].join('\n')
    const loc = await resolve(issue(node({ tag: 'aside', path: [1, 2] }), stack), recording('http://localhost:5174/docs/'))
    expect(loc).toMatchObject({ file: 'docs/index.html', line: 1, col: 60, via: 'shift-stack' })
    expect(requested.some((url) => url.includes('cdn.example.com') || url.includes('__reglet'))).toBe(false)
  })

  it('stack route: goes through the source map of a transformed module', async () => {
    // "document.body.prepend(el)" is line 3 of src/banner.ts; the served module puts it on line 2.
    const generated = 'function banner(){const el=document.createElement("aside");\ndocument.body.prepend(el)}\n//# sourceMappingURL=banner.ts.map\n'
    const map = JSON.stringify({ version: 3, file: 'banner.ts', sources: [join(root, 'src/banner.ts')], names: [], mappings: 'AAAA;AAEE' })
    const { fetch } = serveProject({ '/src/banner.ts': { body: generated }, '/src/banner.ts.map': { body: map } })
    const resolve = createCulpritResolver({ projectRoot: root, target: 'http://localhost:5173', fetch })
    const loc = await resolve(issue(node({ tag: 'aside', path: [1, 0] }), '    at banner (http://localhost:5174/src/banner.ts?t=1:2:1)'), recording(PAGE))
    expect(loc).toMatchObject({ file: 'src/banner.ts', line: 3, col: 3, level: 'file', via: 'shift-stack', verifiedOnDisk: true })
  })

  it('falls from an unusable stack to the html route', async () => {
    const resolve = createCulpritResolver({ projectRoot: root, target: 'http://localhost:5173', fetch: serveProject().fetch })
    const loc = await resolve(issue(node({ tag: 'img', path: [1, 1, 2], attrs: { src: '/hero.jpg' } }), '    at f (http://localhost:5174/vanished.js:1:1)'), recording(PAGE))
    expect(loc).toMatchObject({ file: 'index.html', line: 15, via: 'html-path' })
  })

  it('search route: asks the resolver with what the recording knows and never passes the answer on as exact', async () => {
    const asked: Evidence[] = []
    const answer: SourceResult = { file: 'src/Card.tsx', line: 4, col: 5, framework: 'react', level: 'exact', verifiedOnDisk: true, via: 'grep', target: 'element', notes: [], resolveMs: 1 }
    const resolve = createCulpritResolver({
      projectRoot: root,
      target: 'http://localhost:5173',
      fetch: serveProject().fetch,
      resolver: {
        async resolve(evidence) {
          asked.push(evidence)
          return answer
        },
      },
    })
    // An element of a framework app: its path is not in index.html.
    const culprit = node({ tag: 'article', path: [1, 4, 0, 2], id: 'card-3', classes: ['card'], text: 'Fast builds', attrs: { href: '/x' } })
    const loc = await resolve(issue(culprit), recording('http://localhost:5174/pricing?plan=pro'))
    expect(asked).toHaveLength(1)
    expect(asked[0]?.context).toMatchObject({ tag: 'article', id: 'card-3', classes: ['card'], text: 'Fast builds', ownText: 'Fast builds', attrs: { href: '/x' }, path: [], pagePath: '/pricing', pageOrigin: 'http://localhost:5174' })
    expect(loc).toMatchObject({ file: 'src/Card.tsx', line: 4, level: 'file', via: 'grep' })
    expect(loc?.notes.at(-1)).toMatch(/guessed from the shift recording alone/)
  })

  it('answers undefined when there is no culprit, no resolver for the search, or the resolver finds no file', async () => {
    const none: SourceResult = { framework: 'unknown', level: 'candidates', verifiedOnDisk: false, via: 'none', target: 'element', notes: [], resolveMs: 0 }
    const withResolver = createCulpritResolver({ projectRoot: root, target: 'http://localhost:5173', fetch: serveProject().fetch, resolver: { resolve: async () => none } })
    const without = createCulpritResolver({ projectRoot: root, target: 'http://localhost:5173', fetch: serveProject().fetch })
    const framework = node({ tag: 'article', path: [1, 4, 0, 2] })
    expect(await withResolver(issue(undefined), recording(PAGE))).toBeUndefined()
    expect(await withResolver(issue(framework), recording(PAGE))).toBeUndefined()
    expect(await without(issue(framework), recording(PAGE))).toBeUndefined()
  })

  it('never rejects, and remembers an answer until invalidated', async () => {
    let calls = 0
    const resolve = createCulpritResolver({
      projectRoot: root,
      target: 'http://localhost:5173',
      fetch: serveProject().fetch,
      resolver: {
        resolve() {
          calls += 1
          throw new Error('resolver broke')
        },
      },
    })
    const culprit = issue(node({ tag: 'article', path: [1, 9] }))
    expect(await resolve(culprit, recording(PAGE))).toBeUndefined()
    expect(await resolve(culprit, recording(PAGE))).toBeUndefined()
    expect(calls).toBe(1)
    resolve.invalidate()
    expect(await resolve(culprit, recording(PAGE))).toBeUndefined()
    expect(calls).toBe(2)
  })
})
