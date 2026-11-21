/**
 * The page frame (head, header, footer) and small helpers shared by every page.
 * Pages are plain functions returning HTML strings; nothing here runs in the browser.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CANONICAL_ORIGIN, GITHUB_URL, SITE_NAME } from '../config.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
export const SHOTS_DIR = join(HERE, '../assets/shots')

/** Escapes text for HTML content and attribute values. */
export function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Width and height of a JPEG or PNG, read from its header. */
export function imageSize(file: string): { width: number; height: number } {
  const data = readFileSync(file)
  if (data[0] === 0x89 && data.toString('ascii', 1, 4) === 'PNG') return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
  let offset = 2
  while (offset < data.length) {
    if (data[offset] !== 0xff) throw new Error(`${file}: not a JPEG marker at ${offset}`)
    const marker = data[offset + 1] as number
    const length = data.readUInt16BE(offset + 2)
    // SOF0..SOF15, except DHT (c4), JPG (c8) and DAC (cc).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) }
    }
    offset += 2 + length
  }
  throw new Error(`${file}: no size found`)
}

export interface ShotOptions {
  /** Base name in assets/shots, without `-light.jpg`. */
  name: string
  alt: string
  /** A `-dark.jpg` exists and is shown under a dark colour scheme. */
  dark?: boolean
  /** Below the fold. */
  lazy?: boolean
  /** CSS width the image is shown at most, for `sizes`. */
  caption?: string
  /** Prefix from the page to the site root, for example `../`. */
  root: string
}

/** A screenshot with reserved space (width and height of the file), light and optional dark variant. */
export function shot(options: ShotOptions): string {
  const light = `${options.name}-light.jpg`
  const size = imageSize(join(SHOTS_DIR, light))
  const src = (file: string): string => `${options.root}assets/shots/${file}`
  const loading = options.lazy === true ? ' loading="lazy"' : ''
  const img = `<img src="${src(light)}" width="${size.width}" height="${size.height}" alt="${esc(options.alt)}" decoding="async"${loading}>`
  const picture = options.dark === true ? `<picture><source srcset="${src(`${options.name}-dark.jpg`)}" media="(prefers-color-scheme: dark)">${img}</picture>` : img
  return options.caption === undefined ? picture : `<figure class="shot">${picture}<figcaption>${options.caption}</figcaption></figure>`
}

/** A command with a copy button. */
export function command(text: string): string {
  return `<div class="cmd"><pre><code>${esc(text)}</code></pre><button type="button" class="copy" data-copy="${esc(text)}" aria-label="Copy: ${esc(text)}">Copy</button></div>`
}

const MARK = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="2.5" y="2.5" width="19" height="19" rx="5" fill="none" stroke="currentColor" stroke-width="2"/><rect x="7" y="7" width="7" height="5" rx="1.2" fill="var(--accent)"/><path d="M7 15.5h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`

/** The favicon, inline: a page must not make a request for it. */
const ICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="2.5" y="2.5" width="19" height="19" rx="5" fill="#fff" stroke="#14171d" stroke-width="2"/><rect x="7" y="7" width="7" height="5" rx="1.2" fill="#2456d6"/><path d="M7 15.5h10" stroke="#14171d" stroke-width="2" stroke-linecap="round"/></svg>')}`

export type Section = 'home' | 'docs' | 'demo'

export interface PageOptions {
  /** Output path below dist, for example `docs/dock.html`. */
  path: string
  title: string
  description: string
  section: Section
  body: string
  /** Load the small copy-button script. Default true. */
  script?: boolean
}

/** `../` repeated once per directory level of `path`. */
export function rootOf(path: string): string {
  return '../'.repeat(path.split('/').length - 1)
}

export function page(options: PageOptions): string {
  const root = rootOf(options.path)
  const canonicalPath = options.path.replace(/(^|\/)index\.html$/, '$1')
  const canonical = `${CANONICAL_ORIGIN}/${canonicalPath}`
  const current = (section: Section): string => (options.section === section ? ' aria-current="page"' : '')
  const fullTitle = options.section === 'home' ? options.title : `${options.title} · ${SITE_NAME}`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(fullTitle)}</title>
<meta name="description" content="${esc(options.description)}">
<link rel="canonical" href="${canonical}">
<meta property="og:title" content="${esc(fullTitle)}">
<meta property="og:description" content="${esc(options.description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:type" content="website">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="${ICON}">
<link rel="stylesheet" href="${root}assets/site.css">
${options.script === false ? '' : `<script src="${root}assets/site.js" defer></script>\n`}</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-header">
<div class="wrap">
<a class="brand" href="${root || './'}" aria-label="primp, home">${MARK}<span>primp</span></a>
<nav class="site-nav" aria-label="Main">
<a href="${root}docs/"${current('docs')}>Docs</a>
<a href="${root}demo/"${current('demo')}>Live demo</a>
<a href="${GITHUB_URL}" class="hide-small">GitHub</a>
</nav>
</div>
</header>
${options.body}
<footer class="site-footer">
<div class="wrap">
<p>primp is open source under the MIT licence. No telemetry; it runs on your machine.</p>
<ul>
<li><a href="${root}docs/">Docs</a></li>
<li><a href="${root}demo/">Live demo</a></li>
<li><a href="${root}docs/limits.html">Limits and privacy</a></li>
<li><a href="${GITHUB_URL}">GitHub</a></li>
</ul>
</div>
</footer>
</body>
</html>
`
}
