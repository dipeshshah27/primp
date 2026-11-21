import { describe, expect, it } from 'vitest'
import { parseStack, scriptRefOf } from '../src/node/stack.ts'

describe('parseStack', () => {
  it('parses V8 frames with and without a function name', () => {
    const frames = parseStack(
      [
        'Error: react-stack-top-frame',
        '    at exports.jsxDEV (http://localhost:5173/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=72dbd0ee:196:25)',
        '    at Card (http://localhost:5173/src/components/Card.tsx:19:20)',
        '    at http://localhost:5173/src/components/Features.tsx?t=1763640000000:23:20',
      ].join('\n'),
    )
    expect(frames).toHaveLength(3)
    expect(frames[0]).toMatchObject({ fn: 'exports.jsxDEV', url: 'http://localhost:5173/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=72dbd0ee', line: 196, col: 25 })
    expect(frames[1]).toMatchObject({ fn: 'Card', url: 'http://localhost:5173/src/components/Card.tsx', line: 19, col: 20 })
    expect(frames[2]?.fn).toBeUndefined()
    expect(frames[2]).toMatchObject({ url: 'http://localhost:5173/src/components/Features.tsx?t=1763640000000', line: 23, col: 20 })
  })

  it('keeps the whole virtual URL of a replayed Server Component frame', () => {
    const [frame] = parseStack(
      '    at HomePage (about://React/Server/file:///Users/me/app/.next/dev/server/chunks/ssr/%5Broot-of-the-server%5D__07nya._.js?10:51:473)',
    )
    expect(frame).toMatchObject({
      fn: 'HomePage',
      url: 'about://React/Server/file:///Users/me/app/.next/dev/server/chunks/ssr/%5Broot-of-the-server%5D__07nya._.js?10',
      line: 51,
      col: 473,
    })
  })

  it('gives native and anonymous frames an empty URL instead of dropping them', () => {
    const frames = parseStack(['    at Array.map (<anonymous>)', '    at Function.from (<anonymous>:1:22)', '    at new Foo (native)'].join('\n'))
    expect(frames.map((frame) => frame.url)).toEqual(['', '', ''])
    expect(frames.map((frame) => frame.fn)).toEqual(['Array.map', 'Function.from', 'Foo'])
    expect(frames[0]).toMatchObject({ line: 0, col: 0 })
  })

  it('strips async and new from the function name', () => {
    const frames = parseStack(['    at async load (http://localhost:3000/a.js:1:2)', '    at new Widget (http://localhost:3000/b.js:3:4)'].join('\n'))
    expect(frames.map((frame) => frame.fn)).toEqual(['load', 'Widget'])
  })

  it('handles a function name that contains parentheses-like text and a path with parentheses', () => {
    const [frame] = parseStack('    at Object.<anonymous> (webpack-internal:///(app-pages-browser)/./src/x.tsx:12:5)')
    expect(frame).toMatchObject({ fn: 'Object.<anonymous>', url: 'webpack-internal:///(app-pages-browser)/./src/x.tsx', line: 12, col: 5 })
  })

  it('parses Firefox and Safari frames', () => {
    const frames = parseStack(['Card@http://localhost:5173/src/components/Card.tsx:19:20', '@http://localhost:5173/src/main.tsx:7:1', 'http://localhost:5173/src/x.tsx:1:2'].join('\n'))
    expect(frames).toHaveLength(3)
    expect(frames[0]).toMatchObject({ fn: 'Card', url: 'http://localhost:5173/src/components/Card.tsx', line: 19, col: 20 })
    expect(frames[1]?.fn).toBeUndefined()
    expect(frames[1]).toMatchObject({ url: 'http://localhost:5173/src/main.tsx', line: 7, col: 1 })
    expect(frames[2]).toMatchObject({ url: 'http://localhost:5173/src/x.tsx', line: 1, col: 2 })
  })

  it('takes line and column from the end, whatever the path looks like', () => {
    const [frame] = parseStack('    at render (http://localhost:3000/v:1:2/app.js:30:40)')
    expect(frame).toMatchObject({ url: 'http://localhost:3000/v:1:2/app.js', line: 30, col: 40 })
  })

  it('drops the message line and anything that is not a frame', () => {
    expect(parseStack('Error: boom at the disco\nsome note\n')).toEqual([])
    expect(parseStack('')).toEqual([])
  })
})

describe('scriptRefOf', () => {
  it('passes ordinary URLs through', () => {
    expect(scriptRefOf('http://localhost:5173/src/App.tsx?t=1')).toEqual({ url: 'http://localhost:5173/src/App.tsx?t=1' })
  })

  it('unwraps about://React/<Env>/ and removes the replay counter', () => {
    expect(scriptRefOf('about://React/Server/file:///Users/me/app/.next/dev/server/chunks/ssr/%5Broot-of-the-server%5D__07nya._.js?10')).toEqual({
      url: 'file:///Users/me/app/.next/dev/server/chunks/ssr/[root-of-the-server]__07nya._.js',
      serverEnv: 'Server',
    })
  })

  it('unwraps the older rsc:// spelling and other environments', () => {
    expect(scriptRefOf('rsc://React/Prerender/file:///app/.next/server/chunks/ssr/page.js?3')).toEqual({
      url: 'file:///app/.next/server/chunks/ssr/page.js',
      serverEnv: 'Prerender',
    })
  })

  it('keeps a query that is not a bare counter', () => {
    expect(scriptRefOf('about://React/Server/file:///app/a.js?id=5').url).toBe('file:///app/a.js?id=5')
  })
})
