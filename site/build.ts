/**
 * Builds the static site into site/dist/: plain files for any static host (GitHub Pages,
 * Cloudflare Pages), working at the domain root or below a sub-path. No external requests.
 *
 *   index.html              landing page                        (src/landing.ts)
 *   docs/*.html             documentation                       (src/docs.ts)
 *   demo/                   the live demo: the real dock on a copy of the demo site (demo/build-demo.ts)
 *   404.html
 *   assets/site.css, site.js, shots/*.jpg
 *
 * Screenshots and the facts the landing page quotes come from site/capture.ts (run it first
 * when they are missing or stale).
 *
 *   pnpm exec tsx site/build.ts
 */

import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, transform } from 'esbuild'
import { buildDemo } from './demo/build-demo.ts'
import { docPages } from './src/docs.ts'
import { landing } from './src/landing.ts'
import { page } from './src/layout.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST = join(HERE, 'dist')
const REPO = join(HERE, '..')

function write(path: string, content: string): void {
  const file = join(DIST, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? listFiles(path) : [path]
  })
}

rmSync(DIST, { recursive: true, force: true })
mkdirSync(DIST, { recursive: true })

const css = await transform(readFileSync(join(HERE, 'src/site.css'), 'utf8'), { loader: 'css', minify: true })
write('assets/site.css', css.code)
const script = await build({ entryPoints: [join(HERE, 'src/site.ts')], bundle: true, format: 'iife', target: 'es2022', minify: true, write: false, logLevel: 'silent' })
write('assets/site.js', script.outputFiles[0]?.text ?? '')

const shots = join(HERE, 'assets/shots')
mkdirSync(join(DIST, 'assets/shots'), { recursive: true })
for (const name of readdirSync(shots).filter((file) => file.endsWith('.jpg'))) cpSync(join(shots, name), join(DIST, 'assets/shots', name))

write('index.html', landing())
for (const doc of docPages()) write(doc.path, doc.html)
write(
  '404.html',
  page({
    path: '404.html',
    title: 'Page not found',
    description: 'This page does not exist.',
    section: 'home',
    script: false,
    body: `<main id="main" class="wrap" style="padding-top:64px"><h1>Page not found</h1><p>There is nothing at this address. Try the <a href="/">home page</a> or the <a href="/docs/">docs</a>.</p></main>`,
  }),
)

const version = (JSON.parse(readFileSync(join(REPO, 'packages/cli/package.json'), 'utf8')) as { version: string }).version
const demo = await buildDemo(DIST, version)

const files = listFiles(DIST)
const total = files.reduce((sum, file) => sum + statSync(file).size, 0)
console.log(`site/dist: ${files.length} files, ${(total / 1024).toFixed(0)} kB`)
for (const file of files.filter((path) => path.endsWith('.html'))) console.log(`  ${relative(DIST, file)}`)
for (const [file, bytes] of Object.entries(demo.bytes)) console.log(`  ${file} ${(bytes / 1024).toFixed(0)} kB`)
