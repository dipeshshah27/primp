'use client'

import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

export interface TocItem {
  depth: 2 | 3
  text: string
  id: string
}

/** "On this page": rendered on the server, highlighted here as you scroll (colour only, no layout change). */
export function Toc({ items }: { items: TocItem[] }) {
  const [active, setActive] = useState<string | null>(items[0]?.id ?? null)
  useEffect(() => {
    const elements = items.map((item) => document.getElementById(item.id)).filter((element): element is HTMLElement => element !== null)
    if (elements.length === 0) return
    const visible = new Map<string, boolean>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) visible.set(entry.target.id, entry.isIntersecting)
        const first = elements.find((element) => visible.get(element.id))
        if (first !== undefined) setActive(first.id)
      },
      { rootMargin: '-72px 0px -60% 0px' },
    )
    for (const element of elements) observer.observe(element)
    return () => observer.disconnect()
  }, [items])
  if (items.length === 0) return null
  return (
    <nav aria-label="On this page" className="text-sm">
      <p className="mb-3 font-medium">On this page</p>
      <ul className="space-y-0.5 border-l">
        {items.map((item) => (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
              className={cn(
                '-ml-px block border-l border-transparent py-1 text-muted-foreground transition-colors hover:text-foreground',
                item.depth === 3 ? 'pl-6' : 'pl-3',
                active === item.id && 'border-foreground font-medium text-foreground',
              )}
            >
              {item.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}
