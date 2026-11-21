#!/usr/bin/env node
// Generates labels.json: one entry per element that carries a data-label
// attribute in the source, with the true position of its opening tag.
//
//   node scripts/gen-labels.mjs           write labels.json
//   node scripts/gen-labels.mjs --check   exit 1 if labels.json is out of date
//
// The position comes from the TypeScript parser (the fixture's own
// devDependency), not from a regex, so multi-line tags and several elements on
// one line are handled. "line" and "col" are 1-based and point at the "<" of
// the opening tag. "kind" is "client" for files that start with the
// "use client" directive and "server" for every other file.
//
// Two fields go beyond the shared fixture convention:
//   "page"  the first route (sorted, "/" first) that renders the element,
//           found by following imports from every app/**/page.tsx and the
//           layouts above it.
//   "note"  only on labels that are not in the DOM of a plain GET of "page";
//           says what is needed. See NOTES below.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_DIRS = ['app', 'components']
const OUTPUT = join(ROOT, 'labels.json')
const ATTRIBUTE = 'data-label'

// Hand-written, checked below: every key must name an existing file or label.
const NOTES = {
  files: {
    'app/account/page.tsx': 'needs the session cookie: POST /api/login first, otherwise /account redirects to /login',
  },
  labels: {
    'stream-fallback': 'in the DOM only until the Suspense boundary resolves, about 1.5 s after the response starts',
  },
}

/** @returns {string[]} absolute paths of every .tsx / .jsx file under dir */
function listSourceFiles(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...listSourceFiles(full))
    else if (/\.(tsx|jsx)$/.test(entry.name)) found.push(full)
  }
  return found
}

/** True when the file's first statement is the "use client" directive. */
function hasUseClientDirective(sourceFile) {
  const first = sourceFile.statements[0]
  return (
    first !== undefined &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteral(first.expression) &&
    first.expression.text === 'use client'
  )
}

/** Resolves an import specifier to a fixture source file, or undefined for packages and CSS. */
function resolveImport(fromFile, specifier) {
  let base
  if (specifier.startsWith('@/')) base = join(ROOT, specifier.slice(2))
  else if (specifier.startsWith('.')) base = join(dirname(fromFile), specifier)
  else return undefined
  for (const candidate of [base, `${base}.tsx`, `${base}.ts`, join(base, 'index.tsx'), join(base, 'index.ts')]) {
    if (/\.tsx?$/.test(candidate) && existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return undefined
}

/** @returns {Set<string>} entry files plus every fixture file they import, transitively */
function importClosure(entries) {
  const reached = new Set()
  const queue = [...entries]
  while (queue.length > 0) {
    const current = queue.pop()
    if (reached.has(current)) continue
    reached.add(current)
    const sourceFile = ts.createSourceFile(current, readFileSync(current, 'utf8'), ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX)
    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
      const resolved = resolveImport(current, statement.moduleSpecifier.text)
      if (resolved) queue.push(resolved)
    }
  }
  return reached
}

/** @returns {Map<string, string>} absolute file -> first route that renders it */
function mapFilesToPages() {
  const appDir = join(ROOT, 'app')
  const appFiles = listSourceFiles(appDir)
  const routes = appFiles
    .filter((file) => /[\\/]page\.tsx$/.test(file))
    .map((file) => {
      const segments = relative(appDir, dirname(file)).split(sep).filter(Boolean)
      // A layout applies to every route at or below its own directory.
      const layouts = appFiles.filter((candidate) => {
        if (!/[\\/]layout\.tsx$/.test(candidate)) return false
        const inside = relative(dirname(candidate), dirname(file))
        return inside === '' || !inside.startsWith('..')
      })
      return { route: `/${segments.join('/')}`, entries: [file, ...layouts] }
    })
    .sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : 0))

  const pageOf = new Map()
  for (const { route, entries } of routes) {
    for (const file of importClosure(entries)) {
      if (!pageOf.has(file)) pageOf.set(file, route)
    }
  }
  return pageOf
}

const problems = []
const labels = []
const pageOf = mapFilesToPages()
const labelledFiles = new Set()

for (const dir of SOURCE_DIRS) {
  for (const absolute of listSourceFiles(join(ROOT, dir)).sort()) {
    const file = relative(ROOT, absolute).split(sep).join('/')
    const text = readFileSync(absolute, 'utf8')
    const sourceFile = ts.createSourceFile(absolute, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const isClient = hasUseClientDirective(sourceFile)

    // The directory says what a component is meant to be; the directive says
    // what it is. Refuse to write labels when the two disagree.
    if (file.startsWith('components/client/') && !isClient) {
      problems.push(`${file}: under components/client/ but has no "use client" directive`)
    }
    if (!file.startsWith('components/client/') && isClient) {
      problems.push(`${file}: has "use client" but is not under components/client/`)
    }

    let found = 0
    const visit = (node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        for (const attribute of node.attributes.properties) {
          if (!ts.isJsxAttribute(attribute) || attribute.name.getText(sourceFile) !== ATTRIBUTE) continue
          found += 1
          const start = node.getStart(sourceFile)
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(start)
          const where = `${file}:${line + 1}:${character + 1}`
          const tag = node.tagName.getText(sourceFile)
          const value = attribute.initializer
          if (value === undefined || !ts.isStringLiteral(value)) {
            problems.push(`${where}: ${ATTRIBUTE} must be a plain string literal`)
            continue
          }
          if (!/^[a-z][a-z0-9]*$/.test(tag)) {
            problems.push(`${where}: ${ATTRIBUTE} must sit on a host element, found <${tag}>`)
            continue
          }
          if (text[start] !== '<') {
            problems.push(`${where}: expected "<" at the recorded position`)
            continue
          }
          const page = pageOf.get(absolute)
          if (page === undefined) {
            problems.push(`${where}: no page imports this file, so the label is never rendered`)
            continue
          }
          const note = NOTES.labels[value.text] ?? NOTES.files[file]
          labelledFiles.add(file)
          labels.push({
            label: value.text,
            file,
            line: line + 1,
            col: character + 1,
            tag,
            kind: isClient ? 'client' : 'server',
            page,
            ...(note ? { note } : {}),
          })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)

    // Cross-check against a plain text count, so nothing the parser skipped
    // (for example a label in a file with broken syntax) goes unnoticed.
    const textual = text.split(`${ATTRIBUTE}=`).length - 1
    if (textual !== found) {
      problems.push(`${file}: ${textual} "${ATTRIBUTE}=" occurrences in the text but ${found} found by the parser`)
    }
  }
}

const seen = new Map()
for (const entry of labels) {
  const previous = seen.get(entry.label)
  if (previous) {
    problems.push(`duplicate label "${entry.label}": ${previous.file}:${previous.line} and ${entry.file}:${entry.line}`)
  }
  seen.set(entry.label, entry)
}

for (const file of Object.keys(NOTES.files)) {
  if (!labelledFiles.has(file)) problems.push(`NOTES.files names "${file}", which has no labels`)
}
for (const label of Object.keys(NOTES.labels)) {
  if (!seen.has(label)) problems.push(`NOTES.labels names "${label}", which does not exist`)
}

if (problems.length > 0) {
  console.error(`gen-labels: ${problems.length} problem(s)`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}

const output = `[\n${labels.map((entry) => `  ${JSON.stringify(entry)}`).join(',\n')}\n]\n`
const counts = { server: 0, client: 0 }
for (const entry of labels) counts[entry.kind] += 1
const summary = `${labels.length} labels (${counts.server} server, ${counts.client} client)`

if (process.argv.includes('--check')) {
  let current = ''
  try {
    current = readFileSync(OUTPUT, 'utf8')
  } catch {
    // missing file counts as out of date
  }
  if (current !== output) {
    console.error('gen-labels: labels.json is out of date; run "node scripts/gen-labels.mjs"')
    process.exit(1)
  }
  console.log(`gen-labels: labels.json is up to date, ${summary}`)
} else {
  writeFileSync(OUTPUT, output)
  console.log(`gen-labels: wrote labels.json, ${summary}`)
}
