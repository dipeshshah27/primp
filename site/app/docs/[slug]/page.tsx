import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { DocPage } from '@/components/docs/doc-page'
import { DOCS, docBySlug, docHref } from '@/lib/docs'

export const dynamicParams = false

export function generateStaticParams(): { slug: string }[] {
  return DOCS.filter((entry) => entry.slug !== '').map((entry) => ({ slug: entry.slug }))
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const entry = docBySlug((await params).slug)
  if (entry === undefined) return {}
  return { title: entry.title, description: entry.description, alternates: { canonical: docHref(entry) } }
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const entry = docBySlug((await params).slug)
  if (entry === undefined || entry.slug === '') notFound()
  return <DocPage entry={entry} />
}
