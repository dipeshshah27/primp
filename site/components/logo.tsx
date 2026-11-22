import { cn } from '@/lib/utils'

/** The mark: a selection box with its resize handles, the first thing you see when you edit with primp. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={cn('size-5', className)}>
      <rect x="4.5" y="4.5" width="15" height="15" rx="2.5" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.6 2.4" opacity="0.55" />
      <rect x="2.5" y="2.5" width="5" height="5" rx="1.25" fill="currentColor" />
      <rect x="16.5" y="16.5" width="5" height="5" rx="1.25" className="fill-accent-brand" />
      <rect x="16.5" y="2.5" width="5" height="5" rx="1.25" stroke="currentColor" strokeWidth="1.5" />
      <rect x="2.5" y="16.5" width="5" height="5" rx="1.25" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2 font-semibold tracking-tight', className)}>
      <LogoMark />
      <span className="text-[15px]">primp</span>
    </span>
  )
}
