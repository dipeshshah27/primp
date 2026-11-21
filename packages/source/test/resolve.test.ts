import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseJsxSites } from '../src/browser/react.ts'
import { createResolver, type Resolver } from '../src/node/resolve.ts'
import type { ReactEvidence } from '../src/types.ts'
import { APP_SOURCE, compile, reactStack } from './fixtures.ts'
import { evidence, path, positionOf, tempProject, type TempProject } from './helpers.ts'

/** The dev server (what the resolver must talk to) and the proxy (what the page's URLs name). */
const TARGET = 'http://localhost:4000'
const PROXY = 'http://localhost:9000'

interface Route {
  status?: number
  body: string
  headers?: Record<string, string>
}

interface Server {
  fetch: typeof fetch
  requests: { method: string; url: string; body?: string }[]
  routes: Map<string, Route | ((body?: string) => Route)>
}

function fakeServer(): Server {
  const server: Server = {
    requests: [],
    routes: new Map(),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const body = typeof init?.body === 'string' ? init.body : undefined
      server.requests.push({ method: init?.method ?? 'GET', url, body })
      const route = server.routes.get(url)
      if (!route) return new Response('not found', { status: 404 })
      const answer = typeof route === 'function' ? route(body) : route
      return new Response(answer.body, { status: answer.status ?? 200, headers: answer.headers ?? {} })
    }) as typeof fetch,
  }
  return server
}

const react = (overrides: Partial<ReactEvidence>): ReactEvidence => ({ hostFiber: true, stackState: 'captured', stackFrom: 'element', ownerRoot: false, owners: [{ name: 'App', kind: 'client' }], ...overrides })

describe('createResolver', () => {
  let project: TempProject
  let server: Server
  let resolver: Resolver
  const compiled = compile(APP_SOURCE, 'App.tsx')
  const frameOf = (tag: string, fn = 'App', occurrence = 0): string => {
    const at = compiled.callOf(tag, occurrence)
    return `${fn} (${PROXY}/src/App.tsx:${at.line}:${at.col})`
  }

  beforeEach(() => {
    project = tempProject({ 'src/App.tsx': APP_SOURCE })
    server = fakeServer()
    server.routes.set(`${TARGET}/src/App.tsx`, { body: compiled.inline })
    resolver = createResolver({ projectRoot: project.root, target: TARGET, fetch: server.fetch })
  })
  afterEach(() => project.remove())

  describe('React, captured stack', () => {
    it('resolves the JSX call site to file, line and column, verified on disk', async () => {
      const result = await resolver.resolve(evidence('h1', { react: react({ stack: reactStack(frameOf('h1')) }) }))
      expect(result).toMatchObject({
        file: 'src/App.tsx',
        ...positionOf(APP_SOURCE, '<h1'),
        component: 'App',
        framework: 'react',
        level: 'exact',
        verifiedOnDisk: true,
        via: 'react-stack',
        target: 'element',
      })
      // The page named the proxy; the script was fetched from the dev server.
      expect(server.requests.map((request) => request.url)).toEqual([`${TARGET}/src/App.tsx`])
    })

    it('takes the callback that wrote the JSX, not the component that called .map', async () => {
      const stack = reactStack(frameOf('li', '<anonymous>'), 'Array.map (<anonymous>)', frameOf('ul'))
      const result = await resolver.resolve(evidence('li', { react: react({ stack }) }))
      expect(result).toMatchObject({ file: 'src/App.tsx', ...positionOf(APP_SOURCE, '<li'), level: 'exact' })
    })

    it('tells two elements of the same tag apart by their own call sites', async () => {
      const first = await resolver.resolve(evidence('p', { react: react({ stack: reactStack(frameOf('p', 'App', 0)) }) }))
      const second = await resolver.resolve(evidence('p', { react: react({ stack: reactStack(frameOf('p', 'App', 1)) }) }))
      expect([first.line, second.line]).toEqual([positionOf(APP_SOURCE, '<p', 0).line, positionOf(APP_SOURCE, '<p', 1).line])
      expect([first.level, second.level]).toEqual(['exact', 'exact'])
    })

    it('downgrades to file, unverified, when the file holds no such tag near the claimed line', async () => {
      // The stack says <h1>'s call site, but the element is a <table>: something is off, and it must show.
      const result = await resolver.resolve(evidence('table', { react: react({ stack: reactStack(frameOf('h1')) }) }))
      expect(result).toMatchObject({ file: 'src/App.tsx', level: 'file', verifiedOnDisk: false, via: 'react-stack' })
      expect(result.notes.join(' ')).toContain('no <table> at or near src/App.tsx:4')
    })

    it('refetches a source map that no longer matches the file on disk', async () => {
      // First answer: the module as compiled before an edit moved everything down one line.
      const edited = `// added line\n${APP_SOURCE}`
      const recompiled = compile(edited, 'App.tsx')
      project.write('src/App.tsx', edited)
      let served = 0
      server.routes.set(`${TARGET}/src/App.tsx`, () => ({ body: (served += 1) === 1 ? compiled.inline : recompiled.inline }))
      const at = recompiled.callOf('ul')
      // Generated positions of both versions agree here (the edit is a comment), so the stale map is one line off.
      expect(at).toEqual(compiled.callOf('ul'))
      const result = await resolver.resolve(evidence('ul', { react: react({ stack: reactStack(`App (${PROXY}/src/App.tsx:${at.line}:${at.col})`) }) }))
      expect(served).toBe(2)
      expect(result).toMatchObject({ file: 'src/App.tsx', ...positionOf(edited, '<ul'), level: 'exact', verifiedOnDisk: true })
    })

    it('reports the nearest matching tag at level file when the map stays stale', async () => {
      const edited = `// added line\n${APP_SOURCE}`
      project.write('src/App.tsx', edited)
      const result = await resolver.resolve(evidence('ul', { react: react({ stack: reactStack(frameOf('ul')) }) }))
      expect(result).toMatchObject({ file: 'src/App.tsx', line: positionOf(edited, '<ul').line, level: 'file', verifiedOnDisk: true })
      expect(result.notes[0]).toBe('<ul> is not on the reported line 5; the nearest one is on line 6')
    })

    it('reports where project code uses a component whose element is created inside a dependency', async () => {
      project.write('node_modules/ui/Button.js', 'export function Button() { return jsxDEV("button", {}) }\n')
      server.routes.set(`${TARGET}/node_modules/ui/Button.js`, { body: 'export function Button() { return jsxDEV("button", {}) }\n' })
      const result = await resolver.resolve(
        evidence('button', {
          react: react({
            stack: reactStack(`Button (${PROXY}/node_modules/ui/Button.js:1:35)`),
            owners: [{ name: 'Button', kind: 'client', stack: reactStack(frameOf('main')) }],
          }),
        }),
      )
      expect(result).toMatchObject({ file: 'src/App.tsx', ...positionOf(APP_SOURCE, '<main'), via: 'react-owner-stack', target: 'usage', component: 'Button' })
    })

    it('never fetches a script from a host other than the dev server', async () => {
      const result = await resolver.resolve(evidence('h1', { react: react({ stack: reactStack('App (https://cdn.example.com/app.js:1:100)') }) }))
      expect(server.requests).toEqual([])
      expect(result.level).not.toBe('exact')
      expect(result.notes.join(' ')).toContain('https://cdn.example.com/app.js is not served by the dev server')
    })

    it('never reads a file:// script outside the project', async () => {
      const result = await resolver.resolve(evidence('h1', { react: react({ stack: reactStack('Page (about://React/Server/file:///etc/hosts?1:1:1)') }) }))
      expect(result.level).not.toBe('exact')
      expect(result.notes.join(' ')).toContain('/etc/hosts is outside the project')
    })
  })

  describe("React, owner-stack limit reached (React's placeholder stack)", () => {
    const sites = parseJsxSites(compiled.code).map(({ file: _file, ...site }) => site)
    const placeholder = (overrides: Partial<ReactEvidence> = {}): ReactEvidence =>
      react({ stackState: 'placeholder', stack: 'Error: react-stack-top-frame\n    at UnknownOwner (http://localhost:9000/jsx.js:79:11)', owners: [{ name: 'App', kind: 'client', jsxSites: sites }], ...overrides })

    it("is exact when the owner has one such tag and the element carries what the tag says", async () => {
      const result = await resolver.resolve(evidence('h1', { react: placeholder(), context: { classes: ['title'], ownText: 'Hello', text: 'Hello' } }))
      expect(result).toMatchObject({ file: 'src/App.tsx', ...positionOf(APP_SOURCE, '<h1'), level: 'exact', verifiedOnDisk: true, via: 'react-jsx-sites' })
      expect(server.requests).toEqual([])
    })

    it('claims only the file when nothing in the single tag shows on the element', async () => {
      const result = await resolver.resolve(evidence('h1', { react: placeholder(), context: { classes: ['banner'], ownText: 'Sale', text: 'Sale' } }))
      expect(result).toMatchObject({ file: 'src/App.tsx', line: positionOf(APP_SOURCE, '<h1').line, level: 'file', via: 'react-jsx-sites' })
    })

    it('ranks several tags of the owner by text and claims only the file', async () => {
      const result = await resolver.resolve(evidence('p', { react: placeholder(), context: { classes: ['note'], ownText: 'Second note', text: 'Second note' } }))
      expect(result).toMatchObject({ file: 'src/App.tsx', ...positionOf(APP_SOURCE, '<p', 1), level: 'file', via: 'react-jsx-sites' })
      expect(result.candidates).toHaveLength(2)
    })

    it('returns candidates when the tags cannot be told apart', async () => {
      const result = await resolver.resolve(evidence('p', { react: placeholder(), context: { classes: ['note'] } }))
      expect(result).toMatchObject({ file: 'src/App.tsx', level: 'candidates', via: 'react-jsx-sites' })
      expect(result.candidates?.map((candidate) => candidate.line)).toEqual([positionOf(APP_SOURCE, '<p', 0).line, positionOf(APP_SOURCE, '<p', 1).line])
    })

    it('breaks a tie by sibling position when the element has as many same-tag siblings as the owner has such tags', async () => {
      const second = await resolver.resolve(evidence('p', { react: placeholder(), context: { classes: ['note'], path: path('html', 'body', 'main', 'p:1/2') } }))
      expect(second).toMatchObject({ file: 'src/App.tsx', ...positionOf(APP_SOURCE, '<p', 1), level: 'file', via: 'react-jsx-sites' })
      expect(second.notes[0]).toContain('sibling 2 of 2')
      // Not when the counts differ (a list rendered from data), and never against the text.
      const listed = await resolver.resolve(evidence('p', { react: placeholder(), context: { classes: ['note'], path: path('html', 'body', 'main', 'p:1/5') } }))
      expect(listed.level).toBe('candidates')
      const byText = await resolver.resolve(evidence('p', { react: placeholder(), context: { classes: ['note'], ownText: 'First note', text: 'First note', path: path('html', 'body', 'main', 'p:1/2') } }))
      expect(byText).toMatchObject({ ...positionOf(APP_SOURCE, '<p', 0), level: 'file' })
    })

    it('does not use JSX positions that do not hold a matching tag in the file that defines the owner', async () => {
      project.write('src/App.tsx', `// moved\n// again\n${APP_SOURCE}`)
      const result = await resolver.resolve(evidence('h1', { react: placeholder(), context: { classes: ['title'] } }))
      expect(result.level).not.toBe('exact')
      expect(result.via).not.toBe('react-jsx-sites')
    })
  })

  describe('React, no fiber', () => {
    it('does not offer the nearest React ancestor as the answer', async () => {
      const result = await resolver.resolve(evidence('h1', { react: react({ hostFiber: false, stack: reactStack(frameOf('main')) }), context: { classes: ['title'], ownText: 'Hello' } }))
      expect(result.via).toBe('grep')
      expect(result.level).toBe('candidates')
      expect(result.notes.join(' ')).toContain('React has no fiber for this element')
    })
  })

  describe('Next', () => {
    const CHUNK = '/_next/static/chunks/app_page.js'
    const original = { file: 'src/App.tsx', line1: 4, column1: 7, ignored: false, methodName: 'App', arguments: [] }

    beforeEach(() => {
      project.write(`.next/dev${CHUNK.replace('/_next', '')}`, compiled.code)
    })

    it('asks the stack-frame endpoint with the chunk as a file URL', async () => {
      server.routes.set(`${TARGET}/__nextjs_original-stack-frames`, { body: JSON.stringify([{ status: 'fulfilled', value: { originalStackFrame: original } }]) })
      const at = compiled.callOf('h1')
      const result = await resolver.resolve(evidence('h1', { react: react({ stack: reactStack(`App (${PROXY}${CHUNK}:${at.line}:${at.col})`) }) }))
      expect(result).toMatchObject({ file: 'src/App.tsx', line: 4, col: 7, level: 'exact', via: 'react-stack' })
      expect(server.requests).toHaveLength(1)
      const body = JSON.parse(server.requests[0]?.body ?? '{}') as { frames: { file: string; line1: number; column1: number }[]; isServer: boolean }
      expect(server.requests[0]).toMatchObject({ method: 'POST', url: `${TARGET}/__nextjs_original-stack-frames` })
      expect(body.isServer).toBe(false)
      expect(body.frames).toEqual([{ file: pathToFileURL(join(resolver.files.root, '.next/dev/static/chunks/app_page.js')).href, methodName: 'App', line1: at.line, column1: at.col, arguments: [] }])
    })

    it('sends a replayed Server Component frame as a server frame', async () => {
      const serverChunk = pathToFileURL(join(resolver.files.root, '.next/dev/server/chunks/ssr/page.js')).href
      server.routes.set(`${TARGET}/__nextjs_original-stack-frames`, { body: JSON.stringify([{ status: 'fulfilled', value: { originalStackFrame: original } }]) })
      const result = await resolver.resolve(evidence('h1', { react: react({ stack: reactStack(`Page (about://React/Server/${serverChunk}?7:51:473)`), owners: [{ name: 'Page', kind: 'server', env: 'Server' }] }) }))
      expect(result).toMatchObject({ file: 'src/App.tsx', line: 4, level: 'exact', component: 'Page' })
      const body = JSON.parse(server.requests[0]?.body ?? '{}') as { frames: { file: string }[]; isServer: boolean }
      expect(body).toMatchObject({ isServer: true, frames: [{ file: serverChunk, line1: 51, column1: 473 }] })
    })

    it('falls back to the source map when the endpoint is missing, and stops asking', async () => {
      const map = JSON.stringify({ ...JSON.parse(compiled.map), sources: ['turbopack:///[project]/src/App.tsx'] })
      server.routes.set(`${TARGET}${CHUNK}`, { body: `${compiled.code}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(map).toString('base64')}\n` })
      const at = compiled.callOf('h1')
      const stack = reactStack(`App (${PROXY}${CHUNK}:${at.line}:${at.col})`)
      const first = await resolver.resolve(evidence('h1', { react: react({ stack }) }))
      const second = await resolver.resolve(evidence('h1', { react: react({ stack }) }))
      expect(first).toMatchObject({ file: 'src/App.tsx', ...positionOf(APP_SOURCE, '<h1'), level: 'exact' })
      expect(second).toMatchObject({ file: 'src/App.tsx', level: 'exact' })
      expect(server.requests.filter((request) => request.method === 'POST')).toHaveLength(1)
    })

    it('does not accept an endpoint answer that the file on disk contradicts', async () => {
      server.routes.set(`${TARGET}/__nextjs_original-stack-frames`, { body: JSON.stringify([{ status: 'fulfilled', value: { originalStackFrame: { ...original, line1: 1, column1: 1 } } }]) })
      const at = compiled.callOf('h1')
      const result = await resolver.resolve(evidence('h1', { react: react({ stack: reactStack(`App (${PROXY}${CHUNK}:${at.line}:${at.col})`) }) }))
      // Line 1 holds no <h1>; the nearest one is three lines down, so the claim is reduced to the file.
      expect(result).toMatchObject({ file: 'src/App.tsx', line: 4, level: 'file' })
    })
  })

  describe('Svelte', () => {
    const SVELTE = '<script>\n  let { title } = $props()\n</script>\n\n<section class="hero">\n\t<h1>{title}</h1>\n</section>\n'

    it('uses __svelte_meta.loc (0-based column) and verifies it', async () => {
      project.write('src/lib/Hero.svelte', SVELTE)
      const result = await resolver.resolve(evidence('h1', { svelte: { loc: { file: 'src/lib/Hero.svelte', line: 6, column: 1 }, parents: [] } }))
      expect(result).toMatchObject({ file: 'src/lib/Hero.svelte', line: 6, col: 2, component: 'Hero', framework: 'svelte', level: 'exact', verifiedOnDisk: true, via: 'svelte-meta' })
    })

    it('downgrades when the file changed under the recorded position', async () => {
      project.write('src/lib/Hero.svelte', `<!-- note -->\n${SVELTE}`)
      const result = await resolver.resolve(evidence('h1', { svelte: { loc: { file: 'src/lib/Hero.svelte', line: 6, column: 1 }, parents: [] } }))
      expect(result).toMatchObject({ file: 'src/lib/Hero.svelte', line: 7, col: 2, level: 'file', verifiedOnDisk: true })
    })

    it('ignores a loc that points outside the project', async () => {
      const result = await resolver.resolve(evidence('h1', { svelte: { loc: { file: '../../../etc/hosts', line: 1, column: 0 }, parents: [] } }))
      expect(result.file).not.toBe('../../../etc/hosts')
      expect(result.notes.join(' ')).toContain('which is not in the project')
    })
  })

  describe('hints, static HTML and search', () => {
    it('uses a location a plugin wrote into the DOM', async () => {
      const result = await resolver.resolve(evidence('h1', { hints: [{ from: 'data-inspector-relative-path', file: 'src/App.tsx', line: 4, col: 7, framework: 'react' }] }))
      expect(result).toMatchObject({ file: 'src/App.tsx', line: 4, col: 7, level: 'exact', via: 'hint', framework: 'react' })
    })

    it('locates an element of a static page by its structural path', async () => {
      const html = '<!doctype html>\n<html>\n<head><title>t</title></head>\n<body>\n  <main>\n    <p class="a">one</p>\n    <p class="b">two</p>\n  </main>\n</body>\n</html>\n'
      project.write('index.html', html)
      const result = await resolver.resolve(evidence('p', { context: { classes: ['b'], text: 'two', path: path('html', 'body', 'main', 'p:1/2') } }))
      expect(result).toMatchObject({ file: 'index.html', ...positionOf(html, '<p class="b"'), framework: 'html', level: 'exact', verifiedOnDisk: true, via: 'html-path' })
    })

    it('falls back to scoring the tags of the page when the structure changed at runtime', async () => {
      const html = '<!doctype html>\n<html>\n<body>\n  <main>\n    <p class="a">one</p>\n    <p class="b">two</p>\n  </main>\n</body>\n</html>\n'
      project.write('index.html', html)
      const result = await resolver.resolve(evidence('p', { context: { classes: ['b'], ownText: 'two', text: 'two', path: path('html', 'body', 'main', 'p:2/3') } }))
      expect(result).toMatchObject({ file: 'index.html', ...positionOf(html, '<p class="b"'), level: 'file', via: 'html-search' })
    })

    it('searches the project as a last resort and never calls the result better than candidates', async () => {
      const result = await resolver.resolve(evidence('h1', { context: { classes: ['title'], ownText: 'Hello', text: 'Hello', pagePath: '/somewhere' } }))
      expect(result).toMatchObject({ file: 'src/App.tsx', ...positionOf(APP_SOURCE, '<h1'), level: 'candidates', via: 'grep', framework: 'react' })
      expect(result.candidates?.[0]?.why).toEqual(['tag', 'class title', 'text "Hello"'])
    })

    it('answers with nothing rather than a guess when no such tag exists', async () => {
      const result = await resolver.resolve(evidence('video', { context: { pagePath: '/somewhere' } }))
      expect(result).toMatchObject({ level: 'candidates', via: 'none', verifiedOnDisk: false, candidates: [] })
      expect(result.file).toBeUndefined()
    })
  })
})
