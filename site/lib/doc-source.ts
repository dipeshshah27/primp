import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import GithubSlugger from 'github-slugger'
import type { DocEntry } from './docs'

/**
 * Headings and plain text of an MDX page, read from its source at build time: the "On this page"
 * list and the search index. Slugs are made the way rehype-slug makes the ids (github-slugger
 * over the heading's text), so the links land.
 */

export interface Heading {
  depth: 2 | 3
  text: string
  id: string
}

export function docSource(entry: DocEntry): string {
  return readFileSync(join(process.cwd(), 'content/docs', `${entry.file}.mdx`), 'utf8')
}

/** Markdown inline syntax and JSX tags out, entities decoded: the text a reader sees. */
export function plain(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

function withoutCode(source: string): string {
  return source.replace(/```[\s\S]*?```/g, '')
}

export function headings(source: string): Heading[] {
  const slugger = new GithubSlugger()
  const found: Heading[] = []
  for (const line of withoutCode(source).split('\n')) {
    const match = /^(#{1,3})\s+(.+?)\s*$/.exec(line)
    if (match === null) continue
    const depth = (match[1] as string).length
    const text = plain(match[2] as string)
    const id = slugger.slug(text)
    if (depth === 2 || depth === 3) found.push({ depth, text, id })
  }
  return found
}

export interface SearchSection {
  /** Heading id, or '' for the top of the page. */
  id: string
  heading: string
  text: string
}

/** The page cut at its headings, prose only: imports, exports and JSX blocks are left out. */
export function sections(source: string): SearchSection[] {
  const slugger = new GithubSlugger()
  const result: SearchSection[] = [{ id: '', heading: '', text: '' }]
  for (const line of withoutCode(source).split('\n')) {
    if (/^(import|export)\s/.test(line) || /^\s*<\/?[A-Z]/.test(line)) continue
    const match = /^(#{1,3})\s+(.+?)\s*$/.exec(line)
    if (match !== null) {
      const text = plain(match[2] as string)
      const id = slugger.slug(text)
      if ((match[1] as string).length > 1) result.push({ id, heading: text, text: '' })
      continue
    }
    const current = result[result.length - 1] as SearchSection
    const words = plain(line.replace(/^\s*[-*|>]\s?/, ''))
    if (words !== '') current.text = current.text === '' ? words : `${current.text} ${words}`
  }
  return result.filter((section) => section.heading !== '' || section.text !== '')
}
