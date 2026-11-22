'use client'

import { MenuIcon } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { Logo } from '@/components/logo'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { GITHUB_URL } from '@/lib/config'
import { DOCS, docHref } from '@/lib/docs'
import { cn } from '@/lib/utils'

export function MobileNav() {
  const [open, setOpen] = useState(false)
  const pathname = usePathname()
  return (
    <>
      <Button variant="ghost" size="icon-sm" className="-ml-1.5 md:hidden" aria-label="Open the menu" onClick={() => setOpen(true)}>
        <MenuIcon />
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="w-72 gap-0 p-0">
          <SheetHeader className="border-b p-4">
            <SheetTitle asChild>
              <Logo />
            </SheetTitle>
            <SheetDescription className="sr-only">Site and documentation menu</SheetDescription>
          </SheetHeader>
          <nav aria-label="Menu" className="flex flex-col gap-0.5 overflow-y-auto p-3 text-sm">
            <Link href="/" onClick={() => setOpen(false)} className="rounded-md px-2.5 py-2 hover:bg-muted">
              Home
            </Link>
            <a href={GITHUB_URL} className="rounded-md px-2.5 py-2 hover:bg-muted">
              GitHub
            </a>
            <p className="mt-4 mb-1 px-2.5 text-xs font-medium text-muted-foreground">Docs</p>
            {DOCS.map((entry) => {
              const href = docHref(entry)
              return (
                <Link
                  key={href}
                  href={href}
                  onClick={() => setOpen(false)}
                  aria-current={pathname === href ? 'page' : undefined}
                  className={cn('rounded-md px-2.5 py-2 text-muted-foreground hover:bg-muted hover:text-foreground', pathname === href && 'bg-muted font-medium text-foreground')}
                >
                  {entry.title}
                </Link>
              )
            })}
          </nav>
        </SheetContent>
      </Sheet>
    </>
  )
}
