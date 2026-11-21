import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { decodeDataUrl, findSourceMappingUrl, SourceMapStore, type FetchedText } from '../src/node/sourcemap.ts'
import { APP_SOURCE, compile } from './fixtures.ts'
import { positionOf, tempProject, type TempProject } from './helpers.ts'

describe('findSourceMappingUrl', () => {
  it('finds line and block comments, # and @', () => {
    expect(findSourceMappingUrl('code()\n//# sourceMappingURL=app.js.map\n')).toBe('app.js.map')
    expect(findSourceMappingUrl('code()\n//@ sourceMappingURL=old.map')).toBe('old.map')
    expect(findSourceMappingUrl('a{}\n/*# sourceMappingURL=style.css.map */')).toBe('style.css.map')
  })

  it('takes the last one', () => {
    expect(findSourceMappingUrl('//# sourceMappingURL=first.map\ncode()\n//# sourceMappingURL=second.map\n')).toBe('second.map')
  })

  it('ignores the text when it is not in a comment', () => {
    expect(findSourceMappingUrl('const key = "sourceMappingURL=nope"')).toBeUndefined()
    expect(findSourceMappingUrl('code()')).toBeUndefined()
    expect(findSourceMappingUrl('//# sourceMappingURL=\n')).toBeUndefined()
  })

  it('returns a whole data URL', () => {
    const url = `data:application/json;base64,${Buffer.from('{"version":3}').toString('base64')}`
    expect(findSourceMappingUrl(`x\n//# sourceMappingURL=${url}\n`)).toBe(url)
  })
})

describe('decodeDataUrl', () => {
  it('decodes base64 and percent-encoded payloads', () => {
    expect(decodeDataUrl(`data:application/json;charset=utf-8;base64,${Buffer.from('{"a":"é"}').toString('base64')}`)).toBe('{"a":"é"}')
    expect(decodeDataUrl('data:application/json,%7B%22a%22%3A1%7D')).toBe('{"a":1}')
  })

  it('returns undefined for anything else', () => {
    expect(decodeDataUrl('http://localhost/x.map')).toBeUndefined()
    expect(decodeDataUrl('data:application/json')).toBeUndefined()
    expect(decodeDataUrl('data:application/json,%E0%A4%A')).toBeUndefined()
  })
})

describe('SourceMapStore', () => {
  const compiled = compile(APP_SOURCE, 'App.tsx')
  const h1 = compiled.callOf('h1')
  const li = compiled.callOf('li')
  const SCRIPT = 'http://localhost:4000/src/App.tsx'

  function store(responses: Record<string, FetchedText | (() => FetchedText)>, ttlMs?: number) {
    const requested: string[] = []
    const maps = new SourceMapStore({
      ttlMs,
      allowFile: () => false,
      async fetchText(url) {
        requested.push(url)
        const response = responses[url]
        if (!response) return { status: 404, text: 'not found' }
        return typeof response === 'function' ? response() : response
      },
    })
    return { maps, requested }
  }

  it('maps through an inline data: map and resolves sources against the script URL', async () => {
    const { maps } = store({ [SCRIPT]: { status: 200, text: compiled.inline } })
    const outcome = await maps.trace(SCRIPT, h1.line, h1.col)
    expect(outcome).toEqual({ status: 'mapped', position: { source: 'http://localhost:4000/src/App.tsx', ...positionOf(APP_SOURCE, '<h1'), ignored: false } })
    const inMap = await maps.trace(SCRIPT, li.line, li.col)
    expect(inMap).toMatchObject({ status: 'mapped', position: positionOf(APP_SOURCE, '<li') })
  })

  it('treats the stack-frame column as 1-based', async () => {
    // One generated line, two segments: column 0 -> line 1 col 1, column 5 -> line 10 col 4.
    const map = JSON.stringify({ version: 3, sources: ['a.js'], names: [], mappings: 'AAAA,KASG' })
    const { maps } = store({ 'http://localhost:4000/a.min.js': { status: 200, text: `aaaaabbbbb\n//# sourceMappingURL=data:application/json,${encodeURIComponent(map)}` } })
    expect(await maps.trace('http://localhost:4000/a.min.js', 1, 5)).toMatchObject({ status: 'mapped', position: { line: 1, col: 1 } })
    expect(await maps.trace('http://localhost:4000/a.min.js', 1, 6)).toMatchObject({ status: 'mapped', position: { line: 10, col: 4 } })
  })

  it('follows an external map, relative to the script, keeping the query of a Vite URL on the script only', async () => {
    const script = 'http://localhost:4000/src/App.tsx?v=abc123'
    const { maps, requested } = store({
      [script]: { status: 200, text: `${compiled.code}\n//# sourceMappingURL=App.tsx.map` },
      'http://localhost:4000/src/App.tsx.map': { status: 200, text: compiled.map },
    })
    expect(await maps.trace(script, h1.line, h1.col)).toMatchObject({ status: 'mapped', position: positionOf(APP_SOURCE, '<h1') })
    expect(requested).toEqual([script, 'http://localhost:4000/src/App.tsx.map'])
  })

  it('uses the SourceMap response header when the script has no comment', async () => {
    const { maps } = store({
      [SCRIPT]: { status: 200, text: compiled.code, sourceMapHeader: '/maps/app.map' },
      'http://localhost:4000/maps/app.map': { status: 200, text: `)]}'\n${compiled.map}` },
    })
    expect(await maps.trace(SCRIPT, h1.line, h1.col)).toMatchObject({ status: 'mapped', position: positionOf(APP_SOURCE, '<h1') })
  })

  it('flattens a sectioned (index) map, as Turbopack writes for a chunk', async () => {
    // Two modules in one chunk: a 3-line preamble, then the compiled module starting on line 4.
    const other = compile('export const Other = () => <aside>x</aside>\n', 'Other.tsx')
    const chunkLines = ['// chunk preamble', ...other.code.trimEnd().split('\n')]
    const offset = chunkLines.length
    const chunk = [...chunkLines, compiled.code].join('\n')
    const index = {
      version: 3,
      sections: [
        { offset: { line: 1, column: 0 }, map: JSON.parse(other.map) },
        { offset: { line: offset, column: 0 }, map: { ...JSON.parse(compiled.map), sources: ['turbopack:///[project]/src/App.tsx'], ignoreList: [] } },
      ],
    }
    const url = 'http://localhost:4000/_next/static/chunks/app.js'
    const { maps } = store({
      [url]: { status: 200, text: `${chunk}\n//# sourceMappingURL=app.js.map` },
      'http://localhost:4000/_next/static/chunks/app.js.map': { status: 200, text: JSON.stringify(index) },
    })
    expect(await maps.trace(url, h1.line + offset, h1.col)).toEqual({
      status: 'mapped',
      position: { source: 'turbopack:///[project]/src/App.tsx', ...positionOf(APP_SOURCE, '<h1'), ignored: false },
    })
    const aside = other.callOf('aside')
    expect(await maps.trace(url, aside.line + 1, aside.col)).toMatchObject({ status: 'mapped', position: { line: 1 } })
  })

  it('reports sources on the ignore list', async () => {
    const map = { ...JSON.parse(compiled.map), ignoreList: [0] }
    const { maps } = store({ [SCRIPT]: { status: 200, text: `${compiled.code}\n//# sourceMappingURL=data:application/json,${encodeURIComponent(JSON.stringify(map))}` } })
    expect(await maps.trace(SCRIPT, h1.line, h1.col)).toMatchObject({ status: 'mapped', position: { ignored: true } })
  })

  it('says no-map for a script served as written, and unmapped for a position outside the map', async () => {
    const { maps } = store({ 'http://localhost:4000/js/site.js': { status: 200, text: 'document.body.append("x")\n' }, [SCRIPT]: { status: 200, text: compiled.inline } })
    expect(await maps.trace('http://localhost:4000/js/site.js', 1, 1)).toEqual({ status: 'no-map' })
    expect(await maps.trace(SCRIPT, 9999, 1)).toEqual({ status: 'unmapped' })
  })

  it('reports fetch failures as errors and does not cache them', async () => {
    let up = false
    const { maps } = store({ [SCRIPT]: () => (up ? { status: 200, text: compiled.inline } : { status: 500, text: 'building' }) })
    expect(await maps.trace(SCRIPT, h1.line, h1.col)).toEqual({ status: 'error', reason: `GET ${SCRIPT} answered 500` })
    up = true
    expect(await maps.trace(SCRIPT, h1.line, h1.col)).toMatchObject({ status: 'mapped' })
  })

  it('reuses a map within the TTL, refetches when asked for a fresh one or after invalidate()', async () => {
    const { maps, requested } = store({ [SCRIPT]: { status: 200, text: compiled.inline } }, 60_000)
    await maps.trace(SCRIPT, h1.line, h1.col)
    await maps.trace(SCRIPT, li.line, li.col)
    expect(requested).toHaveLength(1)
    await maps.trace(SCRIPT, h1.line, h1.col, true)
    expect(requested).toHaveLength(2)
    maps.invalidate()
    await maps.trace(SCRIPT, h1.line, h1.col)
    expect(requested).toHaveLength(3)
  })

  it('fetches a map from an explicit URL instead of reading the script', async () => {
    const mapUrl = 'http://localhost:4000/__nextjs_source-map?filename=x'
    const { maps, requested } = store({ [mapUrl]: { status: 200, text: compiled.map }, 'http://localhost:4000/none': { status: 204, text: '' } })
    expect(await maps.trace('http://localhost:4000/_next/static/chunks/a.js?id=1', h1.line, h1.col, false, mapUrl)).toMatchObject({ status: 'mapped' })
    expect(requested).toEqual([mapUrl])
    expect(await maps.trace('http://localhost:4000/_next/static/chunks/b.js?id=2', 1, 1, false, 'http://localhost:4000/none')).toEqual({ status: 'no-map' })
  })

  describe('file:// scripts', () => {
    let project: TempProject
    beforeAll(() => {
      project = tempProject({
        '.next/dev/server/chunks/ssr/page.js': `${compiled.code}\n//# sourceMappingURL=page.js.map`,
        '.next/dev/server/chunks/ssr/page.js.map': JSON.stringify({ ...JSON.parse(compiled.map), sources: ['file:///project/src/App.tsx'] }),
      })
    })
    afterAll(() => project.remove())

    it('reads the script and its map from disk when allowed', async () => {
      const maps = new SourceMapStore({ allowFile: (path) => path.startsWith(project.root), fetchText: async () => ({ status: 500, text: '' }) })
      const url = pathToFileURL(join(project.root, '.next/dev/server/chunks/ssr/page.js')).href
      expect(await maps.trace(url, h1.line, h1.col)).toMatchObject({ status: 'mapped', position: { source: 'file:///project/src/App.tsx', ...positionOf(APP_SOURCE, '<h1') } })
    })

    it('refuses a file the caller does not allow', async () => {
      const maps = new SourceMapStore({ allowFile: () => false, fetchText: async () => ({ status: 500, text: '' }) })
      const outcome = await maps.trace('file:///etc/hosts', 1, 1)
      expect(outcome).toEqual({ status: 'error', reason: '/etc/hosts is outside the project' })
    })
  })
})
