/**
 * After `next build`: puts primp's head script first in the <head> of every exported page, right
 * after the charset and viewport metas, so it records layout shifts from the very start of the
 * load, before any of Next's own scripts. Then checks that it is the first script of each page.
 * (`node tools/postbuild.ts`, part of `pnpm build`.)
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const OUT = join(import.meta.dirname, '..', 'out')
const TAG = '<script src="/primp/head.js"></script>'

function htmlFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? htmlFiles(path) : path.endsWith('.html') ? [path] : []
  })
}

const problems: string[] = []
const pages = htmlFiles(OUT)
for (const file of pages) {
  let html = readFileSync(file, 'utf8')
  const name = relative(OUT, file)
  if (!html.includes(TAG)) {
    const viewport = /<meta name="viewport"[^>]*\/?>/.exec(html)
    if (viewport === null) {
      problems.push(`${name}: no viewport meta`)
      continue
    }
    const at = viewport.index + viewport[0].length
    html = `${html.slice(0, at)}${TAG}${html.slice(at)}`
  }
  const head = html.slice(0, html.indexOf('</head>'))
  const firstScript = /<script\b[^>]*>/.exec(head)
  if (firstScript === null || firstScript[0] !== TAG.replace('</script>', '')) problems.push(`${name}: the first script in <head> is ${firstScript?.[0] ?? 'none'}`)
  const beforeHook = head.slice(0, head.indexOf(TAG))
  if (/<(link|style|script)\b/.test(beforeHook)) problems.push(`${name}: something loads before primp's head script`)
  writeFileSync(file, html)
}
if (problems.length > 0) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log(`postbuild: primp's head script is the first script in <head> of ${pages.length} pages`)
