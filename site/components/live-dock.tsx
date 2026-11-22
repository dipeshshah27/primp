'use client'

/**
 * The website's side of the live dock. primp's real dock runs on every page (public/primp/, built
 * by `pnpm site:assets`), with an in-browser stand-in for primp's server (tools/standin/). This
 * module opens the dock, shows the prompt a Send produced, and runs the layout-shift replay.
 */

import { ActivityIcon, ArrowRightIcon, RotateCcwIcon, SendIcon, XIcon } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { CopyButton } from '@/components/copy-button'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'

/** Must match tools/standin/host.ts. */
const SENT_EVENT = 'primp-site:sent'

interface DockHandle {
  ready?: () => Promise<void>
  open?: (on: boolean) => void
  panel?: (name: string | null) => void
  collapse?: (collapsed: boolean) => void
  openTab?: (tab: string) => void
  state?: () => { collapsed?: boolean; open?: boolean }
}

function handle(): DockHandle | undefined {
  return (window as unknown as { __primp_test?: DockHandle }).__primp_test
}

async function waitForDock(timeoutMs = 6000): Promise<DockHandle | undefined> {
  const started = performance.now()
  while (performance.now() - started < timeoutMs) {
    const dock = handle()
    if (dock !== undefined) return dock
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return undefined
}

/**
 * Opens the dock, on a panel if given (`shifts`, `changes`, `verify`). The dock has no page-facing
 * API to open it, so this goes through the handle it always publishes for tests
 * (`window.__primp_test`): `open(true)` and `panel(name)`. A dock without them gets its keyboard
 * shortcut, ⌘⇧E / Ctrl⇧E.
 */
export async function openDock(panel?: string): Promise<boolean> {
  const dock = await waitForDock()
  if (dock === undefined) return false
  if (typeof dock.open === 'function') dock.open(true)
  else if (typeof dock.collapse === 'function') dock.collapse(false)
  else {
    const mac = /Mac|iPhone|iPad/.test(navigator.platform)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'E', code: 'KeyE', shiftKey: true, metaKey: mac, ctrlKey: !mac, bubbles: true }))
  }
  if (panel !== undefined) {
    if (typeof dock.panel === 'function') dock.panel(panel)
    else dock.openTab?.(panel === 'changes' ? 'edits' : panel)
  }
  return true
}

export function OpenDockButton({ children, className, tab, variant = 'accent', size = 'lg' }: { children: React.ReactNode; className?: string; tab?: string; variant?: 'accent' | 'outline' | 'default'; size?: 'lg' | 'default' | 'sm' }) {
  return (
    <Button variant={variant} size={size} className={className} onClick={() => void openDock(tab)}>
      {children}
    </Button>
  )
}

/** Installs the delay worker, then loads this page again with `?shift=1` (see tools/standin/head.ts). */
async function replayWithShift(): Promise<void> {
  const target = new URL(location.href)
  target.searchParams.set('shift', '1')
  target.hash = ''
  try {
    if ('serviceWorker' in navigator && window.isSecureContext) {
      await navigator.serviceWorker.register('/primp-sw.js', { scope: '/' })
      if (navigator.serviceWorker.controller === null) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 4000)
          navigator.serviceWorker.addEventListener('controllerchange', () => {
            clearTimeout(timer)
            resolve()
          })
        })
      }
    }
  } catch {
    // The page itself retries on the replay load and says so when it cannot.
  }
  // The landing page holds the replayed picture.
  location.assign(target.pathname === '/' ? target.href : `/?shift=1`)
}

export function ReplayShiftButton({ className, variant = 'outline', size = 'sm' }: { className?: string; variant?: 'outline' | 'default' | 'accent'; size?: 'sm' | 'default' | 'lg' }) {
  const [busy, setBusy] = useState(false)
  return (
    <Button
      variant={variant}
      size={size}
      className={className}
      disabled={busy}
      onClick={() => {
        setBusy(true)
        void replayWithShift()
      }}
    >
      <RotateCcwIcon className={cn(busy && 'animate-spin [animation-direction:reverse]')} />
      Replay with a layout shift
    </Button>
  )
}

/** Mounted once, in the root layout: the prompt sheet and the replay notice. */
export function LiveDock() {
  const [sent, setSent] = useState<{ prompt: string; count: number } | null>(null)
  const [open, setOpen] = useState(false)
  const [replay, setReplay] = useState<{ held: boolean } | null>(null)

  useEffect(() => {
    const onSent = (event: Event): void => {
      const detail = (event as CustomEvent<{ prompt: string; count: number }>).detail
      setSent(detail)
      setOpen(true)
    }
    window.addEventListener(SENT_EVENT, onSent)
    // Stopgap for a dock that opens by default (before its redesign, which starts closed and has
    // an open() of its own): close it once, so every page starts with the dock out of the way.
    void waitForDock().then(async (dock) => {
      if (dock === undefined || typeof dock.open === 'function' || typeof dock.collapse !== 'function') return
      await dock.ready?.()
      if (dock.state?.().collapsed === false) dock.collapse(true)
    })
    if (document.documentElement.hasAttribute('data-primp-shift')) {
      const host = (window as unknown as { __primp_site_host?: { shift: { held: boolean } } }).__primp_site_host
      setReplay({ held: host?.shift.held ?? false })
    }
    return () => window.removeEventListener(SENT_EVENT, onSent)
  }, [])

  return (
    <>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent primpRoot className="gap-0 sm:max-w-2xl">
          <SheetHeader className="border-b p-5">
            <div className="flex items-center gap-2">
              <SendIcon className="size-4 text-accent-brand-text" />
              <SheetTitle>The prompt your agent would get</SheetTitle>
              {sent !== null && <Badge variant="outline">{sent.count === 1 ? '1 change' : `${sent.count} changes`}</Badge>}
            </div>
            <SheetDescription>
              Rendered by primp&apos;s own prompt code from the changes you just made on this page. With <code className="font-mono text-foreground">npx primp</code>, your agent takes it over MCP, or you paste it.
            </SheetDescription>
          </SheetHeader>
          <div className="relative min-h-0 flex-1" data-copy-root>
            <div className="absolute top-3 right-5 z-10 rounded-md border bg-background/80 backdrop-blur">
              <CopyButton label="Copy the prompt" />
            </div>
            <pre data-copy-source className="h-full overflow-auto p-5 pr-14 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-foreground/90">
              {sent?.prompt}
            </pre>
          </div>
          <div className="space-y-3 border-t bg-muted/30 p-5">
            <p className="text-sm text-muted-foreground">
              Nothing is verified on this site: verification needs <code className="font-mono text-foreground">npx primp</code> and an agent that edits your source. Then primp waits for the page to update, measures every change again and reports pass, drift or fail.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button asChild size="sm">
                <Link href="/docs/" onClick={() => setOpen(false)}>
                  Run it on your project <ArrowRightIcon />
                </Link>
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href="/docs/agents/" onClick={() => setOpen(false)}>
                  Connect your agent
                </Link>
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      {replay !== null && <ReplayNotice held={replay.held} onClose={() => setReplay(null)} />}
    </>
  )
}

function ReplayNotice({ held, onClose }: { held: boolean; onClose: () => void }) {
  return (
    <aside
      data-primp-root
      aria-label="Layout-shift replay"
      className="fixed bottom-4 left-4 z-40 w-[min(380px,calc(100vw-2rem))] animate-in rounded-xl border bg-popover/95 p-4 text-sm shadow-2xl backdrop-blur fade-in-0 slide-in-from-bottom-2"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-fail/10 text-fail">
          <ActivityIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1 space-y-2">
          <p className="font-medium">This load had a layout shift, on purpose.</p>
          <p className="text-muted-foreground">
            {held
              ? 'The hero screenshot was served without reserved space and held back, so the page jumped when it arrived. Open the dock’s Layout shifts panel: primp names the image, the cause and a source line. (Its note that a resource came from a cache is about this replay: a service worker hands the screenshot over. Through npx primp every response is uncached.)'
              : 'This browser did not let the site install the small service worker that holds the screenshot back, so it may arrive before the first paint and the shift may not happen.'}
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button size="sm" variant="accent" onClick={() => void openDock('shifts')}>
              Open Shifts
            </Button>
            <Button size="sm" variant="outline" asChild>
              {/* A full load, so primp records a fresh one. */}
              <a href="/">Normal load</a>
            </Button>
          </div>
        </div>
        <button type="button" onClick={onClose} aria-label="Hide this notice" className="rounded-sm text-muted-foreground hover:text-foreground">
          <XIcon className="size-4" />
        </button>
      </div>
    </aside>
  )
}
