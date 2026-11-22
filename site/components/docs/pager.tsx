import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import Link from 'next/link'
import { DOCS, docHref, type DocEntry } from '@/lib/docs'

export function Pager({ current }: { current: DocEntry }) {
  const index = DOCS.indexOf(current)
  const previous = DOCS[index - 1]
  const next = DOCS[index + 1]
  return (
    <nav aria-label="Previous and next" className="mt-16 grid gap-3 border-t pt-8 sm:grid-cols-2">
      {previous === undefined ? (
        <span />
      ) : (
        <Link href={docHref(previous)} className="group rounded-xl border p-4 transition-colors hover:bg-muted/40">
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <ChevronLeftIcon className="size-3.5 transition-transform group-hover:-translate-x-0.5" /> Previous
          </span>
          <span className="mt-1 block font-medium">{previous.title}</span>
        </Link>
      )}
      {next !== undefined && (
        <Link href={docHref(next)} className="group rounded-xl border p-4 text-right transition-colors hover:bg-muted/40">
          <span className="flex items-center justify-end gap-1 text-xs text-muted-foreground">
            Next <ChevronRightIcon className="size-3.5 transition-transform group-hover:translate-x-0.5" />
          </span>
          <span className="mt-1 block font-medium">{next.title}</span>
        </Link>
      )}
    </nav>
  )
}
