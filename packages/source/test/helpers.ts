import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ElementContext, Evidence, PathStep } from '../src/types.ts'

const TMP_ROOT = fileURLToPath(new URL('../../../.tmp/', import.meta.url))

export interface TempProject {
  root: string
  write(rel: string, text: string): void
  remove(): void
}

/** A throwaway project directory under the repo's git-ignored `.tmp/`. */
export function tempProject(files: Record<string, string> = {}): TempProject {
  mkdirSync(TMP_ROOT, { recursive: true })
  const root = mkdtempSync(join(TMP_ROOT, 'source-test-'))
  const project: TempProject = {
    root,
    write(rel, text) {
      const path = join(root, rel)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text)
    },
    remove() {
      rmSync(root, { recursive: true, force: true })
    },
  }
  for (const [rel, text] of Object.entries(files)) project.write(rel, text)
  return project
}

export function context(tag: string, overrides: Partial<ElementContext> = {}): ElementContext {
  return {
    tag,
    classes: [],
    attrs: {},
    ownText: '',
    text: '',
    path: [],
    pagePath: '/',
    pageOrigin: 'http://localhost:4000',
    pageLoadedAt: Date.now(),
    ...overrides,
  }
}

export function evidence(tag: string, overrides: Omit<Partial<Evidence>, 'context'> & { context?: Partial<ElementContext> } = {}): Evidence {
  const { context: contextOverrides, ...rest } = overrides
  return { context: context(tag, contextOverrides), hints: [], collectMs: 0, ...rest }
}

/** `html>body>main>p:1/3` style shorthand: `tag:ofType/ofTypeCount`, index defaults to ofType. */
export function path(...steps: string[]): PathStep[] {
  return steps.map((step) => {
    const match = /^([a-z0-9-]+)(?::(\d+)\/(\d+))?(?:@(\d+))?(?:#(.+))?$/.exec(step)
    if (!match) throw new Error(`bad step ${step}`)
    const ofType = Number(match[2] ?? 0)
    const result: PathStep = { tag: match[1] as string, ofType, ofTypeCount: Number(match[3] ?? 1), index: Number(match[4] ?? ofType) }
    if (match[5] !== undefined) result.id = match[5]
    return result
  })
}

/** 1-based line and column of the first occurrence of `needle` in `text`. */
export function positionOf(text: string, needle: string, occurrence = 0): { line: number; col: number } {
  let index = -1
  for (let count = 0; count <= occurrence; count += 1) {
    index = text.indexOf(needle, index + 1)
    if (index === -1) throw new Error(`"${needle}" (occurrence ${occurrence}) not found`)
  }
  const before = text.slice(0, index)
  const line = before.split('\n').length
  return { line, col: index - before.lastIndexOf('\n') }
}
