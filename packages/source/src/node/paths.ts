import { fileURLToPath } from 'node:url'
import { isAbsolute } from 'node:path'
import type { ProjectFiles } from './files.ts'

/**
 * Turns whatever a source map, a stack frame or a debug field calls a file into a path
 * inside the project. The spellings seen so far:
 *
 *   file:///abs/app/page.tsx                       Turbopack source maps, RSC frames
 *   http://localhost:5173/src/App.tsx              Vite: sources resolve against the module URL
 *   http://localhost:5173/@fs/abs/packages/ui/x.tsx   Vite, file outside its root
 *   webpack://_N_E/./src/x.tsx, webpack-internal:///(app-pages-browser)/./src/x.tsx
 *   turbopack:///[project]/app/page.tsx, [project]/app/page.tsx
 *   /abs/path/x.tsx, src/x.svelte
 */

export interface LocatedSource {
  /** Project-relative path, when the source is an existing file inside the project. */
  file?: string
  /** True when the source is in `node_modules` or is a bundler/runtime internal. */
  dependency: boolean
}

const stripQuery = (value: string): string => value.replace(/[?#].*$/, '')

function decode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Path-like spellings of `source`, most specific first. Absolute ones are tried as they are, relative ones against the project. */
export function pathSpellings(source: string): string[] {
  const spellings: string[] = []
  if (source.startsWith('file://')) {
    try {
      spellings.push(fileURLToPath(stripQuery(source)))
    } catch {
      // Not a valid file URL.
    }
    return spellings
  }
  let path = source
  const bundler = /^(?:webpack(?:-internal)?|turbopack):\/\/[^/]*\/(.*)$/.exec(source)
  if (bundler) {
    path = bundler[1] ?? ''
  } else if (/^[a-z][\w+.-]*:\/\//i.test(source)) {
    try {
      path = decode(new URL(source).pathname)
    } catch {
      return spellings
    }
  }
  path = stripQuery(path)
  // Vite serves files outside its root under /@fs/<absolute path>.
  const fs = /^\/@fs(\/.*)$/.exec(path)
  if (fs?.[1]) {
    const absolute = fs[1]
    spellings.push(/^\/[A-Za-z]:\//.test(absolute) ? absolute.slice(1) : absolute)
    return spellings
  }
  // webpack layers and Turbopack roots: "(app-pages-browser)/./src/x.tsx", "[project]/src/x.tsx".
  path = path.replace(/^\/?\([^)]*\)\//, '').replace(/^\/?\[[^\]]*\]\//, '').replace(/^(?:\.\/)+/, '')
  if (isAbsolute(path)) spellings.push(path)
  const relative = path.replace(/^\/+/, '')
  if (relative !== '') spellings.push(relative)
  return spellings
}

const DEPENDENCY = /(?:^|\/)node_modules\/|^\/?@(?:vite|id|react-refresh)\b|^\/?\.vite\/|\/next\/dist\//

export function locateSource(source: string, files: ProjectFiles): LocatedSource {
  const spellings = pathSpellings(source)
  const dependency = DEPENDENCY.test(source) || spellings.some((spelling) => DEPENDENCY.test(spelling))
  for (const spelling of spellings) {
    const file = files.relative(spelling)
    if (file !== undefined && files.isFile(file)) return { file, dependency: dependency || DEPENDENCY.test(file) }
  }
  if (dependency) return { dependency }

  // A dev server whose root is not the project root, or a bundler root above the project
  // ("[project]/apps/web/src/x.tsx" when primp runs in apps/web): match by path suffix.
  for (const spelling of spellings) {
    if (isAbsolute(spelling)) continue
    const segments = spelling.split('/')
    for (let drop = 0; drop < segments.length - 1; drop += 1) {
      const matches = files.bySuffix(segments.slice(drop).join('/'))
      if (matches.length === 1 && matches[0] !== undefined) return { file: matches[0], dependency: false }
      if (matches.length > 1) break
    }
  }
  return { dependency: false }
}
