import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * Read-only view of the project directory: path containment, cached file reads and a list
 * of source-like files for searching. Nothing here ever writes.
 *
 * Every path that comes from the browser or from a source map goes through `relative()`
 * before it is read, so evidence can never make the resolver open a file outside the project.
 */

/** Directories that hold installs or build output, never authored markup. */
const SKIPPED_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.svelte-kit',
  '.vite',
  '.turbo',
  '.cache',
  '.output',
  '.nuxt',
  '.astro',
  '.vercel',
  '.netlify',
  'dist',
  'build',
  'out',
  'coverage',
  'test-results',
  'playwright-report',
])

/** Files that can contain an opening tag someone wrote. */
const MARKUP_EXTENSIONS = new Set([
  '.html',
  '.htm',
  '.jsx',
  '.tsx',
  '.js',
  '.mjs',
  '.ts',
  '.svelte',
  '.vue',
  '.astro',
  '.mdx',
  '.md',
  '.php',
  '.erb',
  '.ejs',
  '.hbs',
  '.njk',
  '.liquid',
  '.twig',
])

const MAX_FILES = 20_000
const MAX_FILE_BYTES = 1_000_000
const LIST_TTL_MS = 3_000

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot).toLowerCase()
}

interface CachedText {
  mtimeMs: number
  size: number
  text: string
}

export class ProjectFiles {
  /** Absolute, symlinks resolved. */
  readonly root: string
  private readonly texts = new Map<string, CachedText>()
  private listed: { at: number; files: string[] } | undefined

  constructor(root: string) {
    this.root = realpathSync(resolve(root))
  }

  /** Project-relative path with forward slashes, or undefined when `path` is outside the project. */
  relative(path: string): string | undefined {
    let absolute = isAbsolute(path) ? path : join(this.root, path)
    try {
      absolute = realpathSync(absolute)
    } catch {
      absolute = resolve(absolute)
    }
    const rel = relative(this.root, absolute)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined
    return rel.split(sep).join('/')
  }

  absolute(rel: string): string {
    return join(this.root, rel)
  }

  isFile(rel: string): boolean {
    try {
      return this.relative(rel) !== undefined && statSync(this.absolute(rel)).isFile()
    } catch {
      return false
    }
  }

  /** Modification time in epoch milliseconds, or undefined when the file cannot be read. */
  modifiedAt(rel: string): number | undefined {
    try {
      return this.relative(rel) === undefined ? undefined : statSync(this.absolute(rel)).mtimeMs
    } catch {
      return undefined
    }
  }

  /** Text of a project file; undefined when missing, outside the project, a directory or over 1 MB. */
  read(rel: string): string | undefined {
    const inside = this.relative(rel)
    if (inside === undefined) return undefined
    const absolute = this.absolute(inside)
    try {
      const stat = statSync(absolute)
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return undefined
      const cached = this.texts.get(inside)
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.text
      const text = readFileSync(absolute, 'utf8')
      this.texts.set(inside, { mtimeMs: stat.mtimeMs, size: stat.size, text })
      return text
    } catch {
      return undefined
    }
  }

  /** Project-relative paths of files that can hold markup, in directory order. Cached for a few seconds. */
  list(): string[] {
    if (this.listed && Date.now() - this.listed.at < LIST_TTL_MS) return this.listed.files
    const files: string[] = []
    const walk = (dir: string, prefix: string): void => {
      if (files.length >= MAX_FILES) return
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!SKIPPED_DIRS.has(entry.name)) walk(join(dir, entry.name), `${prefix}${entry.name}/`)
        } else if (entry.isFile() && MARKUP_EXTENSIONS.has(extensionOf(entry.name))) {
          files.push(prefix + entry.name)
          if (files.length >= MAX_FILES) return
        }
      }
    }
    walk(this.root, '')
    this.listed = { at: Date.now(), files }
    return files
  }

  /** Listed files whose path ends with `suffix` on a path-segment boundary (`components/Card.tsx`). */
  bySuffix(suffix: string): string[] {
    const wanted = suffix.replace(/^\/+/, '')
    if (wanted === '') return []
    return this.list().filter((file) => file === wanted || file.endsWith(`/${wanted}`))
  }

  /** Forget cached listings and texts (call when the file watcher reports a change). */
  invalidate(): void {
    this.listed = undefined
    this.texts.clear()
  }
}
