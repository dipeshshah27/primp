import { InfoIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export function Callout({ title, children, className }: { title?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('not-prose my-6 flex gap-3 rounded-xl border bg-muted/30 p-4 text-sm', className)}>
      <InfoIcon className="mt-0.5 size-4 shrink-0 text-accent-brand-text" aria-hidden="true" />
      <div className="space-y-1.5 text-muted-foreground [&_a]:text-foreground [&_a]:underline [&_a]:underline-offset-4 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] [&_code]:text-foreground [&_strong]:font-medium [&_strong]:text-foreground">
        {title !== undefined && <p className="font-medium text-foreground">{title}</p>}
        {children}
      </div>
    </div>
  )
}
