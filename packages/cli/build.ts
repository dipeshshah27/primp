/**
 * Builds the published package: `dist/cli.js` (one ESM file with every dependency inside)
 * and `dist/assets/{hook,overlay}.js` (the two scripts reglet serves to the page).
 *
 *   pnpm --filter reglet build      (or: pnpm build, from the repo root)
 *
 * The published package has no dependencies. esbuild is only needed here: at run time the
 * prebuilt assets next to cli.js are used (see packages/server/src/assets.ts).
 */

import { copyFileSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { buildOverlayAssets } from '../server/src/assets.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST = join(HERE, 'dist')
const REPO = join(HERE, '../..')

rmSync(DIST, { recursive: true, force: true })
mkdirSync(join(DIST, 'assets'), { recursive: true })

const result = await build({
  entryPoints: [join(HERE, 'src/index.ts')],
  outfile: join(DIST, 'cli.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // esbuild: only loaded when there are no prebuilt assets. The other two are optional speed-ups of `ws`.
  external: ['esbuild', 'bufferutil', 'utf-8-validate'],
  // Bundled CommonJS dependencies call `require` for Node built-ins; an ES module has none of its own.
  banner: { js: "import { createRequire as __regletCreateRequire } from 'node:module';\nconst require = __regletCreateRequire(import.meta.url);" },
  legalComments: 'none',
  minifyWhitespace: true,
  minifySyntax: true,
  logLevel: 'warning',
  metafile: true,
})

// The scripts for the page, built from source exactly as a checkout builds them at start-up.
const assets = await buildOverlayAssets({ prebuiltDir: false })
writeFileSync(join(DIST, 'assets/hook.js'), assets.hook.code)
writeFileSync(join(DIST, 'assets/overlay.js'), assets.overlay.code)

// npm packs these from the package directory; they are copies, kept out of git.
for (const file of ['README.md', 'LICENSE', 'NOTICE']) copyFileSync(join(REPO, file), join(HERE, file))

const kb = (file: string): string => `${(statSync(join(DIST, file)).size / 1024).toFixed(1)} kB`
const inputs = Object.keys(result.metafile.inputs).length
console.log(`dist/cli.js ${kb('cli.js')} (${inputs} modules), dist/assets/hook.js ${kb('assets/hook.js')}, dist/assets/overlay.js ${kb('assets/overlay.js')}`)
