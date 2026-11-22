'use client'

import { ActivityIcon, FileTextIcon, HashIcon, MoonIcon, MousePointerClickIcon, SearchIcon } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useTheme } from 'next-themes'
import { useCallback, useEffect, useState } from 'react'
import { openDock } from '@/components/live-dock'
import { Button } from '@/components/ui/button'
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from '@/components/ui/command'
import { cn } from '@/lib/utils'

/** One entry of /search.json (app/search.json/route.ts). */
interface Entry {
  href: string
  page: string
  heading: string
  text: string
}

let loaded: Promise<Entry[]> | undefined
function loadIndex(): Promise<Entry[]> {
  loaded ??= fetch('/search.json')
    .then((response) => (response.ok ? (response.json() as Promise<Entry[]>) : []))
    .catch(() => {
      loaded = undefined
      return []
    })
  return loaded
}

export function CommandMenu({ className }: { className?: string }) {
  const router = useRouter()
  const { resolvedTheme, setTheme } = useTheme()
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<Entry[]>([])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const typing = event.target instanceof HTMLElement && (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName))
      if ((event.key === 'k' && (event.metaKey || event.ctrlKey)) || (event.key === '/' && !typing)) {
        event.preventDefault()
        setOpen((value) => !value)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (open) void loadIndex().then(setEntries)
  }, [open])

  const run = useCallback((action: () => void) => {
    setOpen(false)
    action()
  }, [])

  const pages = entries.filter((entry) => entry.heading === '')
  const sections = entries.filter((entry) => entry.heading !== '')

  return (
    <>
      <Button
        variant="outline"
        onClick={() => setOpen(true)}
        className={cn('h-8 justify-start gap-2 rounded-md bg-muted/40 pr-1.5 pl-2.5 text-sm font-normal text-muted-foreground shadow-none dark:bg-white/[0.03]', className)}
      >
        <SearchIcon className="size-3.5" />
        <span className="hidden lg:inline">Search docs…</span>
        <span className="lg:hidden">Search</span>
        <kbd className="ml-auto hidden gap-0.5 sm:inline-flex">
          <span className="text-xs">⌘</span>K
        </kbd>
      </Button>
      <CommandDialog open={open} onOpenChange={setOpen} title="Search the docs" description="Search pages and sections of the primp docs, or run an action.">
        <CommandInput placeholder="Search the docs…" />
        <CommandList>
          <CommandEmpty>No results.</CommandEmpty>
          {pages.length > 0 && (
            <CommandGroup heading="Pages">
              {pages.map((entry) => (
                <CommandItem key={entry.href} value={`page ${entry.page}`} keywords={[entry.text.slice(0, 240)]} onSelect={() => run(() => router.push(entry.href))}>
                  <FileTextIcon />
                  {entry.page}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {sections.length > 0 && (
            <CommandGroup heading="Sections">
              {sections.map((entry) => (
                <CommandItem key={entry.href} value={`${entry.page} ${entry.heading} ${entry.href}`} keywords={[entry.text.slice(0, 400)]} onSelect={() => run(() => router.push(entry.href))}>
                  <HashIcon />
                  <span className="truncate">
                    {entry.heading}
                    <span className="ml-2 text-muted-foreground">{entry.page}</span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          <CommandSeparator />
          <CommandGroup heading="Actions">
            <CommandItem value="open the live dock on this page try" onSelect={() => run(() => void openDock())}>
              <MousePointerClickIcon />
              Open the live dock on this page
            </CommandItem>
            <CommandItem value="open the shifts tab layout shift" onSelect={() => run(() => void openDock('shifts'))}>
              <ActivityIcon />
              Open the dock&apos;s Layout shifts panel
            </CommandItem>
            <CommandItem value="toggle theme dark light" onSelect={() => run(() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark'))}>
              <MoonIcon />
              Toggle light and dark theme
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  )
}
