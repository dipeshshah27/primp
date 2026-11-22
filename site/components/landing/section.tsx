import { cn } from '@/lib/utils'

/** A landing-page section. `split`: the heading on the left, the content on the right (on wide screens). */
export function Section({ id, eyebrow, title, lede, children, className, split = false }: { id: string; eyebrow: string; title: React.ReactNode; lede?: React.ReactNode; children: React.ReactNode; className?: string; split?: boolean }) {
  return (
    <section
      aria-labelledby={`${id}-title`}
      className={cn('relative mx-auto max-w-[1200px] px-4 py-20 sm:px-6 lg:py-28', split && 'lg:grid lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-16', className)}
    >
      <div className={cn('mb-12 max-w-2xl lg:mb-16', split && 'lg:mb-0')}>
        <p className="mb-3 font-mono text-xs tracking-wider text-accent-brand-text uppercase">{eyebrow}</p>
        <h2 id={`${id}-title`} className="text-3xl font-semibold tracking-[-0.03em] text-balance sm:text-4xl lg:text-[2.75rem] lg:leading-[1.08]">
          {title}
        </h2>
        {lede !== undefined && <p className="mt-4 text-lg leading-relaxed text-pretty text-muted-foreground">{lede}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  )
}
