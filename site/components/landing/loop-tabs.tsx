'use client'

import { Tabs as TabsPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'

export interface LoopStep {
  value: string
  number: string
  title: string
  text: string
  panel: React.ReactNode
}

/** Edit -> Agent -> Verify. Every panel is rendered (forceMount) and stacked, so switching changes no size. */
export function LoopTabs({ steps }: { steps: LoopStep[] }) {
  return (
    <TabsPrimitive.Root defaultValue={steps[0]?.value} className="grid gap-4">
      <TabsPrimitive.List aria-label="The loop" className="grid gap-2 sm:grid-cols-3">
        {steps.map((step) => (
          <TabsPrimitive.Trigger
            key={step.value}
            value={step.value}
            className={cn(
              'group relative rounded-xl border bg-card/40 p-4 text-left transition-[background-color,border-color,box-shadow] outline-none hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50',
              'data-[state=active]:border-foreground/20 data-[state=active]:bg-card data-[state=active]:shadow-[0_0_0_1px_var(--color-border),0_16px_40px_-24px_oklch(0_0_0/0.5)]',
            )}
          >
            <span className="flex items-center gap-2 font-mono text-xs text-muted-foreground group-data-[state=active]:text-accent-brand-text">
              {step.number}
              <span className="h-px flex-1 bg-border" aria-hidden="true" />
            </span>
            <span className="mt-2 block font-medium">{step.title}</span>
            <span className="mt-1 block text-sm leading-relaxed text-muted-foreground">{step.text}</span>
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
      <div className="grid">
        {steps.map((step) => (
          <TabsPrimitive.Content
            key={step.value}
            value={step.value}
            forceMount
            className="col-start-1 row-start-1 rounded-2xl border bg-card/60 outline-none data-[state=inactive]:invisible data-[state=inactive]:opacity-0 data-[state=active]:animate-in data-[state=active]:fade-in-0 focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {step.panel}
          </TabsPrimitive.Content>
        ))}
      </div>
    </TabsPrimitive.Root>
  )
}
