/**
 * Builds site/public/primp/ and site/public/primp-sw.js: primp's real dock and head script for the
 * website, with the in-browser stand-in for primp's server. Run at the repository root, before
 * the site's own build:
 *
 *   pnpm site:assets
 *
 *   primp/head.js      tools/standin/head.ts, then primp's head script (packages/overlay/src/entry/hook.ts)
 *                      as built by the server's own buildOverlayAssets: one synchronous script that
 *                      tools/postbuild.ts puts first in every page's <head>
 *   primp/overlay.js   the dock (packages/overlay/src/entry/overlay.ts), same build as the CLI's
 *   primp/session.js   tools/standin/session.ts: the session, with the REAL prompt renderer and
 *                      layout-shift attributor of packages/engine and the text search of
 *                      packages/source, plus this site's .tsx and .mdx sources as text
 *   primp-sw.js        tools/sw.ts, the delay worker of the layout-shift replay (site root scope)
 *
 * `--ref <git ref>` builds the dock and the head script from that commit instead of the working
 * tree (exported to .tmp/), for when packages/overlay is mid-change: `pnpm site:assets --ref HEAD`.
 */

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, type Plugin } from 'esbuild'
import { buildOverlayAssets } from '../../packages/server/src/assets.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SITE = resolve(HERE, '..')
const REPO = resolve(SITE, '..')
const OUT = join(SITE, 'public/primp')

/** Where the site's authored markup lives; the source lookup searches these. */
const SOURCE_ROOTS = ['app', 'components', 'content', 'mdx-components.tsx']

function listSources(): string[] {
  const found: string[] = []
  const walk = (path: string): void => {
    const stat = statSync(path)
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) walk(join(path, name))
    } else if (/\.(tsx|mdx)$/.test(path)) {
      found.push(relative(SITE, path).split('\\').join('/'))
    }
  }
  for (const root of SOURCE_ROOTS) walk(join(SITE, root))
  return found
}

const siteSources: Plugin = {
  name: 'site-sources',
  setup(b) {
    b.onResolve({ filter: /^site-sources$/ }, () => ({ path: 'site-sources', namespace: 'site-sources' }))
    b.onLoad({ filter: /.*/, namespace: 'site-sources' }, () => {
      const sources: Record<string, string> = {}
      for (const file of listSources()) sources[file] = readFileSync(join(SITE, file), 'utf8')
      return { contents: `export default ${JSON.stringify(sources)}`, loader: 'js' }
    })
  },
}

/**
 * The stand-in imports pure functions from server and source modules whose other exports read
 * files. Those Node built-ins are replaced by stubs that throw if anything ever called them.
 */
const NODE_NAMES = [
  'readFileSync', 'readdirSync', 'realpathSync', 'statSync', 'existsSync', 'isAbsolute', 'join', 'relative', 'resolve',
  'sep', 'dirname', 'basename', 'extname', 'normalize', 'fileURLToPath', 'pathToFileURL', 'createHash', 'randomBytes',
]
const nodeStubs: Plugin = {
  name: 'node-stubs',
  setup(b) {
    b.onResolve({ filter: /^node:/ }, (args) => ({ path: args.path, namespace: 'node-stub' }))
    b.onLoad({ filter: /.*/, namespace: 'node-stub' }, (args) => ({
      contents: [
        `const fail = () => { throw new Error('${args.path} is not available in the browser') }`,
        ...NODE_NAMES.map((name) => (name === 'sep' ? `export const sep = '/'` : `export const ${name} = fail`)),
        'export default {}',
      ].join('\n'),
      loader: 'js',
    }))
  },
}

/**
 * The protocol modules build their zod schemas when they load, which would put all of zod into
 * the bundle for constants and types. Here `zod` is a stub on which every schema call chains and
 * `safeParse` accepts its input as it is. The one schema use left on this path is the output
 * check of the server's `toSourceLoc`, whose input is the resolver's own result.
 */
const zodStub: Plugin = {
  name: 'zod-stub',
  setup(b) {
    b.onResolve({ filter: /^zod$/ }, () => ({ path: 'zod', namespace: 'zod-stub' }))
    b.onLoad({ filter: /.*/, namespace: 'zod-stub' }, () => ({
      contents: [
        'const accept = (value) => ({ success: true, data: value })',
        'const handler = { get: (_, key) => (key === "safeParse" ? accept : key === "parse" ? (value) => value : schema), apply: () => schema }',
        'const schema = new Proxy(function () {}, handler)',
        'export const z = schema',
        'export default schema',
      ].join('\n'),
      loader: 'js',
    }))
  },
}

/** `packages/` and the base tsconfig of `ref`, exported under .tmp/, with the workspace links of the checkout. */
function exportRef(ref: string): string {
  const dir = join(REPO, '.tmp', `site-assets-${ref.replace(/[^\w.-]/g, '_')}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const archive = execFileSync('git', ['archive', '--format=tar', ref, 'packages', 'tsconfig.base.json'], { cwd: REPO, maxBuffer: 256 * 1024 * 1024 })
  execFileSync('tar', ['-x', '-C', dir], { input: archive })
  for (const name of readdirSync(join(REPO, 'packages'))) {
    const links = join(REPO, 'packages', name, 'node_modules')
    if (existsSync(links) && existsSync(join(dir, 'packages', name))) cpSync(links, join(dir, 'packages', name, 'node_modules'), { recursive: true, verbatimSymlinks: true })
  }
  return dir
}

export async function buildSiteAssets(options: { ref?: string } = {}): Promise<Record<string, number>> {
  mkdirSync(OUT, { recursive: true })
  const from = options.ref === undefined ? undefined : exportRef(options.ref)
  const version = (JSON.parse(readFileSync(join(REPO, 'packages/cli/package.json'), 'utf8')) as { version: string }).version
  const common = { bundle: true, platform: 'browser', target: 'es2022', minify: true, legalComments: 'none', write: false, logLevel: 'silent' } as const
  const text = (result: Awaited<ReturnType<typeof build>>): string => result.outputFiles?.[0]?.text ?? ''

  const assets = await buildOverlayAssets(
    from === undefined
      ? { prebuiltDir: false }
      : { prebuiltDir: false, hookEntry: join(from, 'packages/overlay/src/entry/hook.ts'), overlayEntry: join(from, 'packages/overlay/src/entry/overlay.ts') },
  )
  const shim = text(await build({ ...common, entryPoints: [join(HERE, 'standin/head.ts')], format: 'iife' }))
  const session = text(
    await build({
      ...common,
      entryPoints: [join(HERE, 'standin/session.ts')],
      format: 'iife',
      plugins: [siteSources, nodeStubs, zodStub],
      define: { __PRIMP_VERSION__: JSON.stringify(version) },
    }),
  )
  const worker = text(await build({ ...common, entryPoints: [join(HERE, 'sw.ts')], format: 'iife' }))

  const files: Record<string, string> = {
    'primp/head.js': `${shim.trim()}\n${assets.hook.code.trim()}\n`,
    'primp/overlay.js': assets.overlay.code,
    'primp/session.js': session,
    'primp-sw.js': worker,
  }
  const bytes: Record<string, number> = {}
  for (const [name, code] of Object.entries(files)) {
    writeFileSync(join(SITE, 'public', name), code)
    bytes[name] = Buffer.byteLength(code)
  }
  return bytes
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const refAt = process.argv.indexOf('--ref')
  const ref = refAt < 0 ? undefined : process.argv[refAt + 1]
  const bytes = await buildSiteAssets(ref === undefined ? {} : { ref })
  if (ref !== undefined) console.log(`dock and head script built from ${ref}`)
  const sources = listSources().length
  for (const [name, size] of Object.entries(bytes)) console.log(`site/public/${name}  ${(size / 1024).toFixed(0)} kB`)
  console.log(`(${sources} site source files bundled for the source lookup)`)
}
