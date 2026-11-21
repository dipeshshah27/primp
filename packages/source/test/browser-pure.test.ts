import { describe, expect, it } from 'vitest'
import { parseLocation } from '../src/browser/hints.ts'
import { parseJsxSites, stackState, trimStack } from '../src/browser/react.ts'
import { APP_SOURCE, compile } from './fixtures.ts'
import { positionOf } from './helpers.ts'

describe('parseJsxSites', () => {
  it('reads every JSX call of an esbuild dev build with the position of its tag', () => {
    const sites = parseJsxSites(compile(APP_SOURCE, 'src/App.tsx').code)
    const at = (needle: string, occurrence = 0) => positionOf(APP_SOURCE, needle, occurrence)
    expect(sites).toEqual([
      { type: 'h1', host: true, ...at('<h1'), file: 'src/App.tsx', top: false },
      { type: 'li', host: true, ...at('<li'), file: 'src/App.tsx', top: false },
      { type: 'ul', host: true, ...at('<ul'), file: 'src/App.tsx', top: false },
      { type: 'p', host: true, ...at('<p', 0), file: 'src/App.tsx', top: false },
      { type: 'p', host: true, ...at('<p', 1), file: 'src/App.tsx', top: false },
      { type: 'main', host: true, ...at('<main'), file: 'src/App.tsx', top: true },
    ])
  })

  it('reads Babel / oxc output, where the file name is a variable', () => {
    const text = `function Card({ title }) {
  return /* @__PURE__ */ _jsxDEV("article", { className: styles.card, children: [/* @__PURE__ */ _jsxDEV("h3", { children: title }, void 0, false, { fileName: _jsxFileName, lineNumber: 16, columnNumber: 7 }, this), /* @__PURE__ */ _jsxDEV(Badge, { tone: "new" }, void 0, false, { fileName: _jsxFileName, lineNumber: 17, columnNumber: 7 }, this)] }, void 0, true, { fileName: _jsxFileName, lineNumber: 15, columnNumber: 5 }, this);
}`
    expect(parseJsxSites(text)).toEqual([
      { type: 'h3', host: true, line: 16, col: 7, top: false },
      { type: 'Badge', host: false, line: 17, col: 7, top: false },
      { type: 'article', host: true, line: 15, col: 5, top: true },
    ])
  })

  it('reads Turbopack / SWC output, where the factory is a member of the imported module', () => {
    const text = `function HomePage() {
    return (0, __TURBOPACK__imported__module__$5b$project$5d$__$5b$app$2d$rsc$5d$__["jsxDEV"])("h1", {
        "data-label": "home-title",
        children: "Home"
    }, void 0, false, {
        fileName: "[project]/app/page.tsx",
        lineNumber: 14,
        columnNumber: 9
    }, this);
}`
    expect(parseJsxSites(text)).toEqual([{ type: 'h1', host: true, line: 14, col: 9, file: '[project]/app/page.tsx', top: true }])
  })

  it('reads the classic runtime, where __source comes before the children', () => {
    const text = `function Old() {
  return React.createElement("div", { className: "a", __source: { fileName: _jsxFileName, lineNumber: 3, columnNumber: 5 } },
    React.createElement("span", { __source: { fileName: _jsxFileName, lineNumber: 4, columnNumber: 7 } }, "x"));
}`
    expect(parseJsxSites(text).map((site) => `${site.type}@${site.line}:${site.col}`)).toEqual(['div@3:5', 'span@4:7'])
  })

  it('returns nothing for a production build or a function without JSX', () => {
    expect(parseJsxSites('function A(){return jsx("div",{children:"x"})}')).toEqual([])
    expect(parseJsxSites('function add(a, b) { return a + b }')).toEqual([])
  })
})

describe('trimStack', () => {
  const STACK = `Error: react-stack-top-frame
    at exports.jsxDEV (http://localhost:5173/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1:196:25)
    at Card (http://localhost:5173/src/components/Card.tsx:19:20)
    at Object.react_stack_bottom_frame (http://localhost:5173/node_modules/.vite/deps/react-dom_client.js?v=1:14177:12)
    at renderWithHooks (http://localhost:5173/node_modules/.vite/deps/react-dom_client.js?v=1:4425:17)`

  it('keeps the frames above the bottom marker', () => {
    expect(trimStack(STACK)?.split('\n')).toHaveLength(3)
    expect(trimStack(STACK)).not.toContain('renderWithHooks')
  })

  it('caps the number of lines of a stack that has no marker', () => {
    const long = ['Error: x', ...Array.from({ length: 50 }, (_, index) => `    at f${index} (http://localhost/a.js:${index + 1}:1)`)].join('\n')
    expect(trimStack(long)?.split('\n').length).toBeLessThanOrEqual(13)
  })

  it('returns undefined for anything that is not a non-empty string', () => {
    expect(trimStack(undefined)).toBeUndefined()
    expect(trimStack('')).toBeUndefined()
    expect(trimStack({ stack: 'x' })).toBeUndefined()
  })
})

describe('stackState', () => {
  it('tells a captured stack from the placeholder and from a stack without a call site', () => {
    expect(stackState('Error: react-stack-top-frame\n    at exports.jsxDEV (http://l/jsx.js:1:1)\n    at Card (http://l/src/Card.tsx:19:20)')).toBe('captured')
    expect(stackState('Error: react-stack-top-frame\n    at UnknownOwner (http://l/jsx.js:79:11)')).toBe('placeholder')
    expect(stackState('Error: react-stack-top-frame\n    at fakeJSXCallSite (http://l/rsc.js:2093:21)')).toBe('missing')
    expect(stackState(undefined)).toBe('missing')
  })
})

describe('parseLocation', () => {
  it('splits path, line and column', () => {
    expect(parseLocation('src/App.vue:12:5')).toEqual({ file: 'src/App.vue', line: 12, col: 5 })
    expect(parseLocation('src/App.vue:12')).toEqual({ file: 'src/App.vue', line: 12 })
    expect(parseLocation('src/App.vue')).toEqual({ file: 'src/App.vue' })
  })

  it('keeps a Windows drive letter in the path', () => {
    expect(parseLocation('C:/work/src/App.vue:12:5')).toEqual({ file: 'C:/work/src/App.vue', line: 12, col: 5 })
  })

  it('returns undefined for an empty value', () => {
    expect(parseLocation('   ')).toBeUndefined()
  })
})
