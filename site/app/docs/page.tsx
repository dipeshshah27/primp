import type { Metadata } from 'next'
import { DocPage } from '@/components/docs/doc-page'
import { DOCS } from '@/lib/docs'

const entry = DOCS[0] as (typeof DOCS)[number]

export const metadata: Metadata = { title: entry.title, description: entry.description, alternates: { canonical: '/docs/' } }

export default function Page() {
  return <DocPage entry={entry} />
}
