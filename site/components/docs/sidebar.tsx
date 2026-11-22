'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { DOCS, docHref } from '@/lib/docs'
import { cn } from '@/lib/utils'

const GROUPS: { title: string; slugs: string[] }[] = [
  { title: 'Start', slugs: ['', 'dock', 'layout-shifts'] },
  { title: 'Your agent', slugs: ['agents', 'mcp-tools', 'verification'] },
  { title: 'Reference', slugs: ['limits', 'faq'] },
]

export function DocsSidebar() {
  const pathname = usePathname()
  return (
    <nav aria-label="Documentation" className="space-y-6 text-sm">
      {GROUPS.map((group) => (
        <div key={group.title}>
          <p className="mb-2 px-2.5 text-xs font-medium tracking-wide text-muted-foreground/80 uppercase">{group.title}</p>
          <ul className="space-y-0.5">
            {group.slugs.map((slug) => {
              const entry = DOCS.find((doc) => doc.slug === slug)
              if (entry === undefined) return null
              const href = docHref(entry)
              const active = pathname === href
              return (
                <li key={slug}>
                  <Link
                    href={href}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'relative flex h-8 items-center rounded-md px-2.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground',
                      active && 'bg-muted font-medium text-foreground',
                    )}
                  >
                    {entry.title}
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </nav>
  )
}
