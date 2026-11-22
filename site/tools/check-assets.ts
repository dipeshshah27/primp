// Run before `next build`: the page scripts come from the repository (`pnpm site:assets` at its root).
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const needed = ['public/primp/head.js', 'public/primp/overlay.js', 'public/primp/session.js', 'public/primp-sw.js']
const missing = needed.filter((file) => !existsSync(join(import.meta.dirname, '..', file)))
if (missing.length > 0) {
  console.error(`Missing ${missing.join(', ')}.\nRun \`pnpm site:assets\` at the repository root first: it builds primp's dock and head script for the site.`)
  process.exit(1)
}
