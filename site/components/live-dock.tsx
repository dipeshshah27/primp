'use client'

/**
 * The website's side of the live dock. primp's real dock runs on every page (public/primp/, built
 * by `pnpm site:assets`), with an in-browser stand-in for primp's server (tools/standin/). This
 * module opens the dock, shows the prompt a Send produced, offers a simulated agent that applies
 * it (so primp's real verification can be watched), and runs the layout-shift replay.
 */

import { ActivityIcon, ArrowRightIcon, BotIcon, RotateCcwIcon, SendIcon, ShieldCheckIcon, XIcon } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { CopyButton } from '@/components/copy-button'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'

/** Must match tools/standin/host.ts. */
const SENT_EVENT = 'primp-site:sent'
const SIMULATE_EVENT = 'primp-site:simulate'
const VERIFIED_EVENT = 'primp-site:verified'

type AgentMode = 'careful' | 'sloppy'

interface SimulationResult {
  mode: AgentMode
  counts: Record<string, number>
  did: string[]
}

type PanelName = 'changes' | 'shifts' | 'verify' | 'settings'

/** The dock's public API (packages/overlay/src/boot.ts), published once the dock has mounted. */
interface PrimpDockApi {
  open(): void
  close(): void
  toggle(): boolean
  panel(name: PanelName | null): void
  isOpen(): boolean
}

function dockApi(): PrimpDockApi | undefined {
  return (window as unknown as { __primp_dock?: PrimpDockApi }).__primp_dock
}

/** The dock loads after DOMContentLoaded; a click that comes earlier waits for it. */
async function waitForDock(timeoutMs = 6000): Promise<PrimpDockApi | undefined> {
  const started = performance.now()
  while (performance.now() - started < timeoutMs) {
    const dock = dockApi()
    if (dock !== undefined) return dock
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return undefined
}

/** Opens the dock, on one of its panels if given. */
export async function openDock(panel?: PanelName): Promise<boolean> {
  const dock = await waitForDock()
  if (dock === undefined) return false
  if (panel === undefined) dock.open()
  else dock.panel(panel)
  return true
}

export function OpenDockButton({ children, className, tab, variant = 'accent', size = 'lg' }: { children: React.ReactNode; className?: string; tab?: PanelName; variant?: 'accent' | 'outline' | 'default'; size?: 'lg' | 'default' | 'sm' }) {
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
  const [simulation, setSimulation] = useState<SimulationResult | null>(null)
  // Closed from here (a controlled `open`), the sheet does not call onOpenChange: the Verification panel stays.
  const simulate = (mode: AgentMode): void => {
    setOpen(false)
    setSimulation(null)
    dockApi()?.panel('verify')
    window.dispatchEvent(new CustomEvent(SIMULATE_EVENT, { detail: { mode } }))
  }

  useEffect(() => {
    const onSent = (event: Event): void => {
      const detail = (event as CustomEvent<{ prompt: string; count: number }>).detail
      setSent(detail)
      setOpen(true)
      // The sheet is where the prompt is read: the dock (its toolbar, outlines and pins sit above
      // everything) steps aside while the sheet is open, and comes back on its Changes panel, with
      // the stand-in's word on what Send did here, when the sheet closes.
      dockApi()?.close()
    }
    window.addEventListener(SENT_EVENT, onSent)
    const onVerified = (event: Event): void => setSimulation((event as CustomEvent<SimulationResult>).detail)
    window.addEventListener(VERIFIED_EVENT, onVerified)
    if (document.documentElement.hasAttribute('data-primp-shift')) {
      const host = (window as unknown as { __primp_site_host?: { shift: { held: boolean } } }).__primp_site_host
      setReplay({ held: host?.shift.held ?? false })
    }
    return () => {
      window.removeEventListener(SENT_EVENT, onSent)
      window.removeEventListener(VERIFIED_EVENT, onVerified)
    }
  }, [])

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) dockApi()?.panel('changes')
        }}
      >
        <SheetContent primpRoot className="gap-0 sm:max-w-2xl">
          <SheetHeader className="border-b p-5">
            <div className="flex items-center gap-2">
              <SendIcon className="size-4 text-accent-brand-text" />
              <SheetTitle>The prompt your agent would get</SheetTitle>
              {sent !== null && <Badge variant="outline">{sent.count === 1 ? '1 change' : `${sent.count} changes`}</Badge>}
            </div>
            <SheetDescription>
              Rendered by primp&apos;s own prompt code from the changes you just made on this page. With <code className="font-mono text-foreground">npx @primpdev/cli</code>, your agent takes it over MCP, or you paste it.
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
            <div className="space-y-1">
              <p className="flex items-center gap-2 text-sm font-medium">
                <ShieldCheckIcon className="size-4 text-accent-brand-text" />
                Watch primp verify it
              </p>
              <p className="text-sm text-muted-foreground">
                A simulated agent applies these changes to this page, as your agent&apos;s edit would arrive after a hot reload. Then primp&apos;s real verifier measures the page and judges every change. The careful agent does what you asked; the sloppy one edits a CSS rule other elements share and rounds a length, the mistakes verification is there to catch.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="accent" onClick={() => simulate('careful')}>
                <BotIcon /> A careful agent
              </Button>
              <Button size="sm" variant="outline" onClick={() => simulate('sloppy')}>
                <BotIcon /> A sloppy agent
              </Button>
              <Button asChild size="sm" variant="ghost">
                <Link href="/docs/" onClick={() => setOpen(false)}>
                  Run it on your project <ArrowRightIcon />
                </Link>
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      {replay !== null && <ReplayNotice held={replay.held} onClose={() => setReplay(null)} />}
      {simulation !== null && <SimulationNotice result={simulation} onClose={() => setSimulation(null)} />}
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
              ? 'The hero screenshot came without reserved space and was held back, so the page jumped. Open Layout shifts: primp names the image, the cause and a source line.'
              : 'This browser did not let the site install the small service worker that holds the screenshot back, so it may arrive before the first paint and the shift may not happen.'}
          </p>
          {held && <p className="text-xs text-muted-foreground/80">Its note that a resource came from a cache is this replay&apos;s service worker. Through npx @primpdev/cli every response is uncached.</p>}
          <div className="flex flex-wrap gap-2 pt-1">
            <Button size="sm" variant="accent" onClick={() => void openDock('shifts')}>
              Open Layout shifts
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

const WORD: Record<string, string> = {
  pass: 'pass',
  drift: 'drift',
  fail: 'fail',
  unresolved: 'not found',
  not_checkable: 'by eye',
  not_measurable: 'not measurable',
  no_browser: 'not measured',
  tab_hidden: 'tab hidden',
}

function SimulationNotice({ result, onClose }: { result: SimulationResult; onClose: () => void }) {
  const parts = Object.entries(result.counts).map(([status, count]) => `${count} ${WORD[status] ?? status.replaceAll('_', ' ')}`)
  const headline = parts.length === 0 ? `The ${result.mode} agent had nothing to do.` : `The ${result.mode} agent is done: ${parts.join(', ')}.`
  return (
    <aside
      data-primp-root
      data-simulation={result.mode}
      aria-label="Simulated agent"
      aria-live="polite"
      className="fixed bottom-4 left-4 z-40 w-[min(400px,calc(100vw-2rem))] animate-in rounded-xl border bg-popover/95 p-4 text-sm shadow-2xl backdrop-blur fade-in-0 slide-in-from-bottom-2"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-foreground">
          <BotIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1 space-y-2">
          <p className="font-medium">{headline}</p>
          <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
            {result.did.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground/80">The agent is simulated; the measuring and the judging are primp&apos;s own. The Verification panel shows each check.</p>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button size="sm" variant="accent" onClick={() => void openDock('verify')}>
              Open Verification
            </Button>
            <Button size="sm" variant="outline" asChild>
              {/* A full load puts the page back as it was. */}
              <a href={typeof location === 'undefined' ? '/' : location.pathname}>Reset the page</a>
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
