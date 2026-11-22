import { docSource, sections } from '@/lib/doc-source'
import { DOCS, docHref } from '@/lib/docs'

/** The ⌘K index: every docs page and its sections, plain text, written once at build time. */
export const dynamic = 'force-static'

export function GET(): Response {
  const entries = DOCS.flatMap((entry) =>
    sections(docSource(entry)).map((section) => ({
      href: section.id === '' ? docHref(entry) : `${docHref(entry)}#${section.id}`,
      page: entry.title,
      heading: section.heading,
      text: section.id === '' ? `${entry.description} ${section.text}` : section.text,
    })),
  )
  return Response.json(entries)
}
