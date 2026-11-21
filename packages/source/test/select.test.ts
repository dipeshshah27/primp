import { describe, expect, it } from 'vitest'
import { callSiteFrames, pickProjectFrame } from '../src/node/select.ts'

const VITE_CLIENT = `Error: react-stack-top-frame
    at exports.jsxDEV (http://localhost:5173/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=72dbd0ee:196:25)
    at Card (http://localhost:5173/src/components/Card.tsx:19:20)
    at Object.react_stack_bottom_frame (http://localhost:5173/node_modules/.vite/deps/react-dom_client.js?v=16a84e23:14177:12)
    at renderWithHooks (http://localhost:5173/node_modules/.vite/deps/react-dom_client.js?v=16a84e23:4425:17)`

const NEXT_SERVER_MAP = `Error: react-stack-top-frame
    at fakeJSXCallSite (http://localhost:3000/_next/static/chunks/react-server-dom-turbopack.js:2093:21)
    at <anonymous> (about://React/Server/file:///app/.next/dev/server/chunks/ssr/page.js?4:29:468)
    at Function.from (<anonymous>:1:22)
    at Rows (about://React/Server/file:///app/.next/dev/server/chunks/ssr/page.js?5:25:18)
    at Object.react_stack_bottom_frame (http://localhost:3000/_next/static/chunks/react-server-dom-turbopack.js:2859:93)
    at initializeElement (http://localhost:3000/_next/static/chunks/react-server-dom-turbopack.js:1216:154)`

const PLACEHOLDER = `Error: react-stack-top-frame
    at UnknownOwner (http://localhost:5173/.vite/deps/react_jsx-dev-runtime.js?v=72dbd0ee:79:11)
    at Object.react_stack_bottom_frame (http://localhost:5173/.vite/deps/react_jsx-dev-runtime.js?v=72dbd0ee:183:11)
    at http://localhost:5173/.vite/deps/react_jsx-dev-runtime.js?v=72dbd0ee:187:88`

const SERVER_NO_FRAMES = `Error: react-stack-top-frame
    at fakeJSXCallSite (http://localhost:3000/_next/static/chunks/react-server-dom-turbopack.js:2093:21)
    at Object.react_stack_bottom_frame (http://localhost:3000/_next/static/chunks/react-server-dom-turbopack.js:2859:93)
    at initializeElement (http://localhost:3000/_next/static/chunks/react-server-dom-turbopack.js:1216:154)`

describe('callSiteFrames', () => {
  it('returns the frame below the JSX factory and stops at the bottom marker', () => {
    const { state, frames } = callSiteFrames(VITE_CLIENT)
    expect(state).toBe('captured')
    expect(frames.map((frame) => frame.fn)).toEqual(['Card'])
    expect(frames[0]).toMatchObject({ url: 'http://localhost:5173/src/components/Card.tsx', line: 19, col: 20 })
  })

  it('never returns the factory, React internals below the marker, or native frames', () => {
    const { state, frames } = callSiteFrames(NEXT_SERVER_MAP)
    expect(state).toBe('captured')
    // The .map callback that wrote the JSX comes first, then the component that called .map.
    expect(frames.map((frame) => `${frame.fn}:${frame.line}:${frame.col}`)).toEqual(['<anonymous>:29:468', 'Rows:25:18'])
    expect(frames.every((frame) => frame.url.startsWith('about://React/Server/'))).toBe(true)
  })

  it("recognises React's shared placeholder", () => {
    expect(callSiteFrames(PLACEHOLDER)).toEqual({ state: 'placeholder', frames: [] })
  })

  it('reports empty when only the factory is above the marker (the server sent no frames)', () => {
    expect(callSiteFrames(SERVER_NO_FRAMES)).toEqual({ state: 'empty', frames: [] })
  })

  it('reports empty for no stack', () => {
    expect(callSiteFrames(undefined)).toEqual({ state: 'empty', frames: [] })
    expect(callSiteFrames('')).toEqual({ state: 'empty', frames: [] })
  })

  it('accepts a stack the collector already trimmed at the marker', () => {
    const trimmed = VITE_CLIENT.split('\n').slice(0, 3).join('\n')
    expect(callSiteFrames(trimmed).frames.map((frame) => frame.fn)).toEqual(['Card'])
  })

  it('accepts the dashed marker name used by older React 19 builds', () => {
    const stack = VITE_CLIENT.replace('react_stack_bottom_frame', 'react-stack-bottom-frame')
    expect(callSiteFrames(stack).frames).toHaveLength(1)
  })

  it('does not mistake a user component called UnknownOwnerList for the placeholder', () => {
    const stack = VITE_CLIENT.replace('at Card (', 'at UnknownOwnerList (')
    expect(callSiteFrames(stack).state).toBe('captured')
  })
})

describe('pickProjectFrame', () => {
  it('takes the first frame that maps into the project and is not ignored', () => {
    expect(pickProjectFrame([{ ignored: true, file: 'node_modules/ui/Button.js' }, { ignored: false }, { ignored: false, file: 'src/App.tsx' }, { ignored: false, file: 'src/main.tsx' }])).toBe(2)
  })

  it('returns -1 when the element was created entirely inside dependencies', () => {
    expect(pickProjectFrame([{ ignored: true }, { ignored: true, file: 'node_modules/x.js' }])).toBe(-1)
    expect(pickProjectFrame([])).toBe(-1)
  })
})
