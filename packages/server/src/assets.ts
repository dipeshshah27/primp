import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOOK_ASSET_PATH, OVERLAY_ASSET_PATH, RESERVED_PREFIX } from '../../protocol/src/messages.ts'
import type { ProxyAsset } from './proxy.ts'

/**
 * The two browser bundles reglet serves from the proxy origin:
 *
 *   hook.js      the synchronous head script (HOOK_ASSET_PATH), injected into every document
 *   overlay.js   the dock (OVERLAY_ASSET_PATH), loaded by the hook after DOMContentLoaded
 *
 * Where they come from, in this order:
 *
 *   1. a prebuilt file in `prebuiltDir` (default: `assets/` next to this module, which is
 *      `dist/assets/` once the CLI is bundled into `dist/cli.js`). The published package
 *      ships these, so it needs no bundler at run time;
 *   2. esbuild, from the TypeScript entry files of packages/overlay (a checkout).
 *
 * The proxy serves every asset with `Cache-Control: no-store`. The hook's script tag also
 * carries the content hash as a query (`/__reglet/hook.js?v=<hash>`), so a document can
 * never pair with a hook from another build even where a cache ignores the header.
 */

export interface OverlayAssetsOptions {
  /** Entry file of the head script. Default: packages/overlay/src/entry/hook.ts. */
  hookEntry?: string
  /** Entry file of the dock. Default: packages/overlay/src/entry/overlay.ts. */
  overlayEntry?: string
  /**
   * Directory that may hold prebuilt `hook.js` and `overlay.js`. Default: `assets/` next to
   * this module. `false`: always bundle from the entry files. A prebuilt file is only used
   * when the matching entry option was not given.
   */
  prebuiltDir?: string | false
  /** Default true. */
  minify?: boolean
  /**
   * esbuild `define` replacements. Default: `__REGLET_HOOK_STACKS__` is `true`, which compiles
   * the DOM-call stack capture into the layout-shift hook (needed to trace an inserted culprit
   * to the script line that inserted it).
   */
  define?: Record<string, string>
}

export interface BuiltAsset {
  /** Path on the proxy origin, without the cache-busting query. */
  path: string
  code: string
  bytes: number
  /** First 12 hex characters of the SHA-256 of `code`. */
  hash: string
  from: 'prebuilt' | 'esbuild'
  /** The file the code was read or bundled from. */
  source: string
}

export interface OverlayAssets {
  hook: BuiltAsset
  overlay: BuiltAsset
  /** For `createProxy({ assets })`: keyed by the path below the reserved prefix. */
  assets: ReadonlyMap<string, ProxyAsset>
  /** For `createProxy({ headScripts })`: the hook, with its content hash as a query. */
  headScripts: string[]
}

const HERE = dirname(fileURLToPath(import.meta.url))

/** Entry files in a checkout, relative to packages/server/src. */
export const DEFAULT_HOOK_ENTRY = resolve(HERE, '../../overlay/src/entry/hook.ts')
export const DEFAULT_OVERLAY_ENTRY = resolve(HERE, '../../overlay/src/entry/overlay.ts')
/** `dist/assets/` when this module is part of the bundled CLI. */
export const DEFAULT_PREBUILT_DIR = join(HERE, 'assets')

// The settle client is started by the hook entry on the shared socket, never by its own starter code.
const DEFAULT_DEFINE: Record<string, string> = { __REGLET_HOOK_STACKS__: 'true', __REGLET_SETTLE_AUTOSTART__: 'false' }
const SCRIPT_TYPE = 'text/javascript; charset=utf-8'

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function describe(path: string, code: string, from: BuiltAsset['from'], source: string): BuiltAsset {
  return {
    path,
    code,
    bytes: Buffer.byteLength(code),
    hash: createHash('sha256').update(code).digest('hex').slice(0, 12),
    from,
    source,
  }
}

async function bundle(entry: string, minify: boolean, define: Record<string, string>): Promise<string> {
  if (!isFile(entry)) throw new Error(`overlay entry file not found: ${entry}`)
  // Loaded here so a published build that ships prebuilt assets never needs esbuild.
  const { build } = await import('esbuild')
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    minify,
    define,
    legalComments: 'none',
    write: false,
    logLevel: 'silent',
  })
  const output = result.outputFiles[0]
  if (output === undefined) throw new Error(`esbuild produced no output for ${entry}`)
  return output.text
}

async function load(
  name: string,
  path: string,
  entry: string | undefined,
  fallbackEntry: string,
  options: OverlayAssetsOptions,
): Promise<BuiltAsset> {
  const prebuiltDir = options.prebuiltDir ?? DEFAULT_PREBUILT_DIR
  if (entry === undefined && prebuiltDir !== false) {
    const prebuilt = join(prebuiltDir, name)
    if (isFile(prebuilt)) return describe(path, readFileSync(prebuilt, 'utf8'), 'prebuilt', prebuilt)
  }
  const from = resolve(entry ?? fallbackEntry)
  try {
    return describe(path, await bundle(from, options.minify ?? true, { ...DEFAULT_DEFINE, ...options.define }), 'esbuild', from)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`could not build ${name} from ${from}: ${reason}`, { cause: error })
  }
}

/** Reads or builds both bundles. Rejects with a message naming the bundle that failed. */
export async function buildOverlayAssets(options: OverlayAssetsOptions = {}): Promise<OverlayAssets> {
  const [hook, overlay] = await Promise.all([
    load('hook.js', HOOK_ASSET_PATH, options.hookEntry, DEFAULT_HOOK_ENTRY, options),
    load('overlay.js', OVERLAY_ASSET_PATH, options.overlayEntry, DEFAULT_OVERLAY_ENTRY, options),
  ])
  const assets = new Map<string, ProxyAsset>()
  for (const asset of [hook, overlay]) {
    assets.set(asset.path.slice(RESERVED_PREFIX.length), { body: asset.code, contentType: SCRIPT_TYPE })
  }
  return { hook, overlay, assets, headScripts: [`${hook.path}?v=${hook.hash}`] }
}
