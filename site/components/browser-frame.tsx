import { LockIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

/** A quiet browser window around a screenshot: three dots and an address. */
export function BrowserFrame({ url, children, className }: { url?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('overflow-hidden rounded-xl border bg-card shadow-[0_1px_0_0_oklch(1_0_0/0.04)_inset,0_24px_64px_-24px_oklch(0_0_0/0.45)] ring-1 ring-black/[0.02] dark:ring-white/[0.03]', className)}>
      <div className="flex h-9 items-center gap-3 border-b bg-muted/50 px-3.5">
        <div className="flex gap-1.5" aria-hidden="true">
          <span className="size-2.5 rounded-full bg-foreground/15" />
          <span className="size-2.5 rounded-full bg-foreground/15" />
          <span className="size-2.5 rounded-full bg-foreground/15" />
        </div>
        {url !== undefined && (
          <div className="mx-auto flex h-6 max-w-[60%] min-w-0 items-center gap-1.5 rounded-md border bg-background/60 px-2.5 font-mono text-[11px] text-muted-foreground">
            <LockIcon className="size-3 shrink-0 opacity-60" aria-hidden="true" />
            <span className="truncate">{url}</span>
          </div>
        )}
        <div className="w-[42px]" aria-hidden="true" />
      </div>
      <div className="relative">{children}</div>
    </div>
  )
}
