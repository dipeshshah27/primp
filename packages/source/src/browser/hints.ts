import type { Framework, SourceHint } from '../types.ts'

/**
 * Locations that a framework's dev mode, or a plugin the project already uses, writes
 * straight into the DOM. They cost one attribute read and need no symbolication.
 */

interface Reader {
  framework: Framework
  read(element: Element): Omit<SourceHint, 'framework'> | undefined
}

/** `path:line:col`, `path:line` or `path`; the path may itself contain colons (Windows drive letters). */
export function parseLocation(value: string): { file: string; line?: number; col?: number } | undefined {
  const match = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(value.trim())
  if (!match || !match[1]) return undefined
  const result: { file: string; line?: number; col?: number } = { file: match[1] }
  if (match[2] !== undefined) result.line = Number(match[2])
  if (match[3] !== undefined) result.col = Number(match[3])
  return result
}

function combined(attribute: string, framework: Framework, zeroBasedCol = false): Reader {
  return {
    framework,
    read(element) {
      const value = element.getAttribute(attribute)
      const parsed = value ? parseLocation(value) : undefined
      if (!parsed) return undefined
      if (zeroBasedCol && parsed.col !== undefined) parsed.col += 1
      return { from: attribute, ...parsed }
    },
  }
}

const READERS: Reader[] = [
  {
    // Astro dev toolbar: absolute file plus "line:col".
    framework: 'astro',
    read(element) {
      const file = element.getAttribute('data-astro-source-file')
      if (!file) return undefined
      const loc = /^(\d+):(\d+)$/.exec(element.getAttribute('data-astro-source-loc') ?? '')
      return loc
        ? { from: 'data-astro-source-file', file, line: Number(loc[1]), col: Number(loc[2]) }
        : { from: 'data-astro-source-file', file }
    },
  },
  combined('data-qwik-inspector', 'qwik'),
  combined('data-source-loc', 'solid'),
  combined('data-v-inspector', 'vue'),
  {
    // react-dev-inspector's Babel plugin.
    framework: 'react',
    read(element) {
      const file = element.getAttribute('data-inspector-relative-path')
      const line = Number(element.getAttribute('data-inspector-line'))
      if (!file || !Number.isInteger(line) || line < 1) return undefined
      const col = Number(element.getAttribute('data-inspector-column'))
      return Number.isInteger(col) && col >= 0
        ? { from: 'data-inspector-relative-path', file, line, col: col + 1 }
        : { from: 'data-inspector-relative-path', file, line }
    },
  },
  {
    // Vue 3 dev: the component that owns the element. File only.
    framework: 'vue',
    read(element) {
      const component = (element as Element & { __vueParentComponent?: { type?: { __file?: unknown } } }).__vueParentComponent
      const file = component?.type?.__file
      return typeof file === 'string' ? { from: '__vueParentComponent', file } : undefined
    },
  },
]

export function collectHints(element: Element): SourceHint[] {
  const hints: SourceHint[] = []
  for (const reader of READERS) {
    try {
      const hint = reader.read(element)
      if (hint) hints.push({ ...hint, framework: reader.framework })
    } catch {
      // A hostile or broken page must not break collection.
    }
  }
  return hints
}
