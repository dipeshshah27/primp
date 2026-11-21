import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HOOK_ASSET_PATH, OVERLAY_ASSET_PATH } from '../../protocol/src/messages.ts'
import { buildOverlayAssets } from '../src/assets.ts'
import { removeDir, tempDir } from './session-helpers.ts'

/** Stub entry files stand in for packages/overlay's, so the test does not depend on the dock. */

let dir: string
let hookEntry: string
let overlayEntry: string

beforeAll(() => {
  dir = tempDir('assets-test')
  hookEntry = join(dir, 'hook.ts')
  overlayEntry = join(dir, 'overlay.ts')
  writeFileSync(join(dir, 'shared.ts'), 'export const greeting: string = "from shared"\n')
  writeFileSync(
    hookEntry,
    [
      "import { greeting } from './shared.ts'",
      'declare const __REGLET_HOOK_STACKS__: boolean',
      'declare const __CUSTOM__: string',
      "const result: { hook: string; stacks: boolean; custom: string } = { hook: greeting, stacks: __REGLET_HOOK_STACKS__, custom: typeof __CUSTOM__ === 'undefined' ? 'unset' : __CUSTOM__ }",
      ';(globalThis as Record<string, unknown>).__hook = result',
      '',
    ].join('\n'),
  )
  writeFileSync(overlayEntry, ";(globalThis as Record<string, unknown>).__overlay = 'overlay ran'\n")
})

afterAll(() => removeDir(dir))

function run(code: string): Record<string, unknown> {
  const sandbox: Record<string, unknown> = {}
  vm.runInNewContext(code, sandbox)
  return sandbox
}

describe('buildOverlayAssets', () => {
  it('bundles both entries as minified IIFE scripts and maps them to the protocol paths', async () => {
    const built = await buildOverlayAssets({ hookEntry, overlayEntry })
    expect(built.hook).toMatchObject({ path: HOOK_ASSET_PATH, from: 'esbuild', source: hookEntry })
    expect(built.overlay).toMatchObject({ path: OVERLAY_ASSET_PATH, from: 'esbuild', source: overlayEntry })
    expect([...built.assets.keys()].sort()).toEqual(['hook.js', 'overlay.js'])
    expect(built.assets.get('hook.js')).toEqual({ body: built.hook.code, contentType: 'text/javascript; charset=utf-8' })
    // One script, no module syntax left, the import inlined, the default define applied.
    expect(built.hook.code).not.toMatch(/\bimport\b|\bexport\b/)
    expect(built.hook.code.trim().split('\n')).toHaveLength(1)
    expect(run(built.hook.code).__hook).toEqual({ hook: 'from shared', stacks: true, custom: 'unset' })
    expect(run(built.overlay.code).__overlay).toBe('overlay ran')
    expect(built.hook.bytes).toBe(Buffer.byteLength(built.hook.code))
  })

  it('puts the content hash on the head script and changes it when the code changes', async () => {
    const first = await buildOverlayAssets({ hookEntry, overlayEntry })
    const same = await buildOverlayAssets({ hookEntry, overlayEntry })
    const other = await buildOverlayAssets({ hookEntry, overlayEntry, define: { __CUSTOM__: '"set"' } })
    expect(first.hook.hash).toMatch(/^[0-9a-f]{12}$/)
    expect(first.headScripts).toEqual([`/__reglet/hook.js?v=${first.hook.hash}`])
    expect(same.hook.hash).toBe(first.hook.hash)
    expect(other.hook.hash).not.toBe(first.hook.hash)
    expect(run(other.hook.code).__hook).toMatchObject({ custom: 'set' })
    expect(other.overlay.hash).toBe(first.overlay.hash)
  })

  it('lets the caller turn minification and the stack capture off', async () => {
    const built = await buildOverlayAssets({ hookEntry, overlayEntry, minify: false, define: { __REGLET_HOOK_STACKS__: 'false' } })
    expect(built.hook.code.trim().split('\n').length).toBeGreaterThan(1)
    expect(run(built.hook.code).__hook).toMatchObject({ stacks: false })
  })

  it('uses prebuilt files when they exist and no entry was named', async () => {
    const prebuiltDir = join(dir, 'dist-assets')
    mkdirSync(prebuiltDir)
    writeFileSync(join(prebuiltDir, 'hook.js'), 'globalThis.__hook="prebuilt hook"')
    writeFileSync(join(prebuiltDir, 'overlay.js'), 'globalThis.__overlay="prebuilt overlay"')
    const built = await buildOverlayAssets({ prebuiltDir })
    expect(built.hook).toMatchObject({ from: 'prebuilt', source: join(prebuiltDir, 'hook.js'), code: 'globalThis.__hook="prebuilt hook"' })
    expect(built.overlay).toMatchObject({ from: 'prebuilt', code: 'globalThis.__overlay="prebuilt overlay"' })
    expect(built.headScripts).toEqual([`/__reglet/hook.js?v=${built.hook.hash}`])

    // A named entry wins over the prebuilt file of the same bundle; the other still comes prebuilt.
    const mixed = await buildOverlayAssets({ prebuiltDir, hookEntry })
    expect(mixed.hook.from).toBe('esbuild')
    expect(mixed.overlay.from).toBe('prebuilt')

    // And `false` never looks for prebuilt files.
    const forced = await buildOverlayAssets({ prebuiltDir: false, hookEntry, overlayEntry })
    expect([forced.hook.from, forced.overlay.from]).toEqual(['esbuild', 'esbuild'])
  })

  it('falls back to bundling when only one prebuilt file is there', async () => {
    const prebuiltDir = join(dir, 'half')
    mkdirSync(prebuiltDir)
    writeFileSync(join(prebuiltDir, 'hook.js'), 'globalThis.__hook="prebuilt hook"')
    await expect(buildOverlayAssets({ prebuiltDir, overlayEntry: join(dir, 'missing.ts') })).rejects.toThrow(/could not build overlay\.js .*overlay entry file not found/)
  })

  it('names the bundle and the file when an entry is missing or does not compile', async () => {
    await expect(buildOverlayAssets({ hookEntry: join(dir, 'nope.ts'), overlayEntry })).rejects.toThrow(/could not build hook\.js from .*nope\.ts: overlay entry file not found/)
    const broken = join(dir, 'broken.ts')
    writeFileSync(broken, "import { missing } from './does-not-exist.ts'\nconsole.log(missing)\n")
    await expect(buildOverlayAssets({ hookEntry, overlayEntry: broken })).rejects.toThrow(/could not build overlay\.js from .*broken\.ts/)
  })
})
