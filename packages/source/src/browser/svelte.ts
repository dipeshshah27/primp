import type { SvelteEvidence } from '../types.ts'

/**
 * Svelte 5 in dev sets `__svelte_meta` on every element it creates or hydrates:
 * `{ loc: { file, line, column }, parent, component }`. `file` is relative to the project
 * root, `line` is 1-based and `column` 0-based. The object is circular through `parent`.
 *
 * Elements that Svelte did not create on the client have none: `{@html}` content, the
 * `app.html` template, and every element of a page rendered with `csr = false`.
 */

interface SvelteLoc {
  file?: unknown
  line?: unknown
  column?: unknown
}
interface SvelteMeta {
  loc?: SvelteLoc
  parent?: SvelteParent | null
}
interface SvelteParent {
  file?: unknown
  parent?: SvelteParent | null
}

function metaOf(element: Element): SvelteMeta | undefined {
  const meta = (element as Element & { __svelte_meta?: unknown }).__svelte_meta
  return typeof meta === 'object' && meta !== null ? (meta as SvelteMeta) : undefined
}

function locOf(meta: SvelteMeta): SvelteEvidence['loc'] {
  const loc = meta.loc
  if (!loc || typeof loc.file !== 'string' || typeof loc.line !== 'number') return undefined
  return { file: loc.file, line: loc.line, column: typeof loc.column === 'number' ? loc.column : 0 }
}

export function collectSvelte(element: Element): SvelteEvidence | undefined {
  const own = metaOf(element)
  let meta = own
  let ancestor: Element | null = element
  while (!meta && ancestor) {
    ancestor = ancestor.parentElement
    if (ancestor) meta = metaOf(ancestor)
  }
  if (!meta) return undefined

  const parents: string[] = []
  let parent = meta.parent
  for (let depth = 0; parent && depth < 12; depth += 1, parent = parent.parent) {
    if (typeof parent.file === 'string' && parents.at(-1) !== parent.file) parents.push(parent.file)
  }
  const evidence: SvelteEvidence = { parents }
  const loc = locOf(meta)
  if (own) evidence.loc = loc
  else evidence.ancestorLoc = loc
  return evidence
}
