#!/usr/bin/env node
// Introduces or removes a syntax error in a component used by /broken-toggle.
//
//   node scripts/break.mjs on  [server|client]   break the target (default: server)
//   node scripts/break.mjs off [server|client]   repair it (default: both)
//   node scripts/break.mjs status                print the state of both targets
//
// Each target file has exactly one line that starts with the marker
// "/* reglet:break */". The script rewrites only that line, so line numbers in
// the file (and therefore labels.json) do not change.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MARKER = '/* reglet:break */'
const LINE_OFF = `${MARKER} const breakState: string = 'off'`
// "+;" leaves the expression unfinished: a syntax error for every parser.
const LINE_ON = `${MARKER} const breakState: string = 'on' +;`

const TARGETS = {
  server: 'components/server/BreakTargetServer.tsx',
  client: 'components/client/BreakTargetClient.tsx',
}

function usage() {
  console.error('usage: node scripts/break.mjs on|off [server|client]  |  node scripts/break.mjs status')
  process.exit(2)
}

/** @returns {{ path: string, lines: string[], index: number, state: 'on' | 'off' }} */
function load(target) {
  const path = join(ROOT, TARGETS[target])
  const lines = readFileSync(path, 'utf8').split('\n')
  const matches = lines.flatMap((line, index) => (line.startsWith(MARKER) ? [index] : []))
  if (matches.length !== 1) {
    console.error(`break: expected exactly one "${MARKER}" line in ${TARGETS[target]}, found ${matches.length}`)
    process.exit(1)
  }
  const index = matches[0]
  if (lines[index] !== LINE_ON && lines[index] !== LINE_OFF) {
    console.error(`break: the marker line in ${TARGETS[target]} was edited by hand; restore it to:\n  ${LINE_OFF}`)
    process.exit(1)
  }
  return { path, lines, index, state: lines[index] === LINE_ON ? 'on' : 'off' }
}

function set(target, state) {
  const loaded = load(target)
  if (loaded.state === state) {
    console.log(`break: ${target} already ${state} (${TARGETS[target]}:${loaded.index + 1})`)
    return
  }
  loaded.lines[loaded.index] = state === 'on' ? LINE_ON : LINE_OFF
  writeFileSync(loaded.path, loaded.lines.join('\n'))
  console.log(`break: ${target} is now ${state} (${TARGETS[target]}:${loaded.index + 1})`)
}

const [command, targetArg] = process.argv.slice(2)
if (targetArg !== undefined && !(targetArg in TARGETS)) usage()

if (command === 'status') {
  for (const target of Object.keys(TARGETS)) {
    const loaded = load(target)
    console.log(`${target}: ${loaded.state} (${TARGETS[target]}:${loaded.index + 1})`)
  }
} else if (command === 'on') {
  set(targetArg ?? 'server', 'on')
} else if (command === 'off') {
  for (const target of targetArg ? [targetArg] : Object.keys(TARGETS)) set(target, 'off')
} else {
  usage()
}
