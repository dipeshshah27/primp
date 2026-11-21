import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sweepChangedFiles } from '../src/settle.ts'

const TMP_ROOT = join(import.meta.dirname, '../../../.tmp')

describe('sweepChangedFiles', () => {
  let dir: string
  beforeEach(() => {
    mkdirSync(TMP_ROOT, { recursive: true })
    dir = mkdtempSync(join(TMP_ROOT, 'sweep-test-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const write = (rel: string, mtimeMs: number): void => {
    const file = join(dir, rel)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, 'x')
    utimesSync(file, mtimeMs / 1000, mtimeMs / 1000)
  }

  it('returns only files written at or after the given time, oldest first', async () => {
    const since = 1_700_000_100_000
    write('src/old.tsx', since - 5_000)
    write('src/components/New.tsx', since + 2_000)
    write('src/first.css', since + 1_000)
    const found = await sweepChangedFiles(dir, since)
    expect(found.map((f) => f.path)).toEqual(['src/first.css', 'src/components/New.tsx'])
    expect(found[0]?.mtimeMs).toBe(since + 1_000)
  })

  it('skips ignored directories, tool files, symlinks and what the caller ignores', async () => {
    const since = 1_700_000_100_000
    write('node_modules/pkg/index.js', since + 1_000)
    write('.next/dev/chunk.js', since + 1_000)
    write('dist/out.js', since + 1_000)
    write('src/.DS_Store', since + 1_000)
    write('src/skip-me.ts', since + 1_000)
    write('src/keep.ts', since + 1_000)
    mkdirSync(join(dir, 'elsewhere'), { recursive: true })
    write('elsewhere/linked.ts', since + 1_000)
    symlinkSync(join(dir, 'elsewhere'), join(dir, 'src/link'))
    const found = await sweepChangedFiles(dir, since, (path) => path.endsWith('skip-me.ts'))
    expect(found.map((f) => f.path).sort()).toEqual(['elsewhere/linked.ts', 'src/keep.ts'])
  })

  it('stops at the file limit instead of walking a huge tree', async () => {
    const since = 1_700_000_100_000
    for (let i = 0; i < 12; i += 1) write(`src/f${i}.ts`, since + 1_000)
    const found = await sweepChangedFiles(dir, since, undefined, 5)
    expect(found.length).toBe(5)
  })

  it('returns nothing for a directory that does not exist', async () => {
    expect(await sweepChangedFiles(join(dir, 'missing'), 0)).toEqual([])
  })
})
