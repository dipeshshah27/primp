import { transformSync } from 'esbuild'

/** A small component, compiled the way a dev server would: automatic JSX runtime, dev mode, source map. */
export const APP_SOURCE = `export function App({ items }: { items: string[] }) {
  return (
    <main className="app">
      <h1 className="title">Hello</h1>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <p className="note">First note</p>
      <p className="note">Second note</p>
    </main>
  )
}
`

export interface Compiled {
  /** Generated code without a sourceMappingURL comment. */
  code: string
  /** The source map as JSON text; `sources` is `[sourcefile]`. */
  map: string
  /** Generated code followed by an inline base64 source map. */
  inline: string
  /** 1-based generated line and column of the `jsxDEV("<tag>"` call: what a V8 stack frame prints. */
  callOf(tag: string, occurrence?: number): { line: number; col: number }
}

export function compile(source: string, sourcefile: string): Compiled {
  const result = transformSync(source, { loader: 'tsx', jsx: 'automatic', jsxDev: true, sourcemap: 'external', sourcefile, format: 'esm' })
  const code = result.code
  const inline = `${code}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(result.map).toString('base64')}\n`
  return {
    code,
    map: result.map,
    inline,
    callOf(tag, occurrence = 0) {
      const needle = `jsxDEV("${tag}"`
      let index = -1
      for (let count = 0; count <= occurrence; count += 1) {
        index = code.indexOf(needle, index + 1)
        if (index === -1) throw new Error(`${needle} (occurrence ${occurrence}) not in the generated code`)
      }
      const before = code.slice(0, index)
      return { line: before.split('\n').length, col: index - before.lastIndexOf('\n') }
    },
  }
}

/** A React `_debugStack` as the collector sends it: message, JSX factory, then the given frames. */
export function reactStack(...frames: string[]): string {
  return ['Error: react-stack-top-frame', '    at exports.jsxDEV (http://localhost:9000/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1:196:25)', ...frames.map((frame) => `    at ${frame}`)].join('\n')
}
