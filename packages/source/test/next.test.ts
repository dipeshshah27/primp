import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isTurbopackModuleUrl, nextClientChunkFile, nextOriginalFrame, nextSourceMapPath } from '../src/node/next.ts'
import { tempProject, type TempProject } from './helpers.ts'

const FRAME = { file: 'file:///app/.next/dev/static/chunks/a.js', methodName: 'Counter', line1: 86, column1: 416 }

function endpoint(answer: unknown, status = 200) {
  const calls: { path: string; body: unknown }[] = []
  const post = async (path: string, body: string) => {
    calls.push({ path, body: JSON.parse(body) })
    return { status, text: typeof answer === 'string' ? answer : JSON.stringify(answer) }
  }
  return { post, calls }
}

describe('nextOriginalFrame', () => {
  it('sends the request shape of Next 16 and reads the original frame', async () => {
    const { post, calls } = endpoint([
      { status: 'fulfilled', value: { originalStackFrame: { file: 'components/client/Counter.tsx', line1: 11, column1: 7, ignored: false, methodName: 'Counter', arguments: [] }, originalCodeFrame: null } },
    ])
    expect(await nextOriginalFrame(post, FRAME, false)).toEqual({ status: 'mapped', frame: { file: 'components/client/Counter.tsx', line: 11, col: 7, ignored: false } })
    expect(calls).toEqual([
      {
        path: '/__nextjs_original-stack-frames',
        body: { frames: [{ ...FRAME, arguments: [] }], isServer: false, isEdgeServer: false, isAppDirectory: true },
      },
    ])
  })

  it('passes isServer for a Server Component frame and keeps the ignored flag', async () => {
    const { post, calls } = endpoint([{ status: 'fulfilled', value: { originalStackFrame: { file: 'node_modules/next/dist/x.js', line1: 1, column1: 1, ignored: true } } }])
    expect(await nextOriginalFrame(post, FRAME, true)).toMatchObject({ status: 'mapped', frame: { ignored: true } })
    expect((calls[0]?.body as { isServer: boolean }).isServer).toBe(true)
  })

  it('reports a rejected frame as unmapped with the reason', async () => {
    const { post } = endpoint([{ status: 'rejected', reason: 'Unknown url scheme: http://localhost:3000/_next/static/chunks/a.js' }])
    expect(await nextOriginalFrame(post, FRAME, false)).toEqual({ status: 'unmapped', reason: 'Unknown url scheme: http://localhost:3000/_next/static/chunks/a.js' })
  })

  it('treats an answer that echoes the generated position as unmapped', async () => {
    const echoed = endpoint([{ status: 'fulfilled', value: { originalStackFrame: { file: FRAME.file, line1: 86, column1: 416, ignored: false } } }])
    expect(await nextOriginalFrame(echoed.post, FRAME, false)).toEqual({ status: 'unmapped', reason: 'the endpoint returned the generated position unchanged' })
    const bare = endpoint([{ status: 'fulfilled', value: { originalStackFrame: { file: '/_next/static/chunks/a.js', line1: 86, column1: 416, ignored: false } } }])
    expect(await nextOriginalFrame(bare.post, { ...FRAME, file: '/_next/static/chunks/a.js?v=1' }, false)).toMatchObject({ status: 'unmapped' })
  })

  it('reports a missing original frame as unmapped', async () => {
    const { post } = endpoint([{ status: 'fulfilled', value: { originalStackFrame: null } }])
    expect(await nextOriginalFrame(post, FRAME, false)).toEqual({ status: 'unmapped', reason: 'no original frame in the answer' })
  })

  it('reports unavailable when the endpoint does not exist, answers HTML, or the request fails', async () => {
    expect(await nextOriginalFrame(endpoint('Not Found', 404).post, FRAME, false)).toEqual({ status: 'unavailable', reason: 'HTTP 404' })
    expect(await nextOriginalFrame(endpoint('<!doctype html><html></html>').post, FRAME, false)).toEqual({ status: 'unavailable', reason: 'answer is not JSON' })
    expect(await nextOriginalFrame(endpoint({ error: 'x' }).post, FRAME, false)).toEqual({ status: 'unavailable', reason: 'answer is not an array of results' })
    const failing = async () => {
      throw new Error('connect ECONNREFUSED')
    }
    expect(await nextOriginalFrame(failing, FRAME, false)).toEqual({ status: 'unavailable', reason: 'connect ECONNREFUSED' })
  })
})

describe('nextClientChunkFile', () => {
  let turbopack: TempProject
  let legacy: TempProject
  beforeAll(() => {
    turbopack = tempProject({ '.next/dev/static/chunks/app_[slug]_page.js': 'x' })
    legacy = tempProject({ '.next/static/chunks/main.js': 'x' })
  })
  afterAll(() => {
    turbopack.remove()
    legacy.remove()
  })

  it('maps a browser chunk URL to the file under .next/dev (Next 16) or .next', () => {
    expect(nextClientChunkFile('http://localhost:9000/_next/static/chunks/app_%5Bslug%5D_page.js', turbopack.root)).toBe(
      pathToFileURL(join(turbopack.root, '.next/dev/static/chunks/app_[slug]_page.js')).href,
    )
    expect(nextClientChunkFile('http://localhost:9000/_next/static/chunks/main.js', legacy.root)).toBe(pathToFileURL(join(legacy.root, '.next/static/chunks/main.js')).href)
  })

  it('keeps the query that names a hot-updated module', () => {
    expect(nextClientChunkFile('http://localhost:9000/_next/static/chunks/main.js?id=%5Bproject%5D%2Fa.tsx', legacy.root)).toBe(
      `${pathToFileURL(join(legacy.root, '.next/static/chunks/main.js')).href}?id=%5Bproject%5D%2Fa.tsx`,
    )
  })

  it('returns undefined for a chunk that is not on disk or a URL that is not a Next asset', () => {
    expect(nextClientChunkFile('http://localhost:9000/_next/static/chunks/missing.js', legacy.root)).toBeUndefined()
    expect(nextClientChunkFile('http://localhost:9000/src/App.tsx', legacy.root)).toBeUndefined()
    expect(nextClientChunkFile('not a url', legacy.root)).toBeUndefined()
  })
})

describe('Next URL helpers', () => {
  it('recognises the URL of one hot-updated module of a chunk', () => {
    expect(isTurbopackModuleUrl('http://localhost:3000/_next/static/chunks/a.js?id=%5Bproject%5D%2Fa.tsx')).toBe(true)
    expect(isTurbopackModuleUrl('http://localhost:3000/_next/static/chunks/a.js')).toBe(false)
    expect(isTurbopackModuleUrl('http://localhost:5173/src/App.tsx?id=1')).toBe(false)
    expect(isTurbopackModuleUrl('about://React/Server/x')).toBe(false)
  })

  it('builds the source-map endpoint path', () => {
    expect(nextSourceMapPath('file:///app/.next/dev/static/chunks/a.js?id=x')).toBe('/__nextjs_source-map?filename=file%3A%2F%2F%2Fapp%2F.next%2Fdev%2Fstatic%2Fchunks%2Fa.js%3Fid%3Dx')
  })
})
