import { CheckIcon, MinusIcon } from 'lucide-react'
import Link from 'next/link'
import { Section } from '@/components/landing/section'
import { TestedMatrix } from '@/components/tables'
import { cn } from '@/lib/utils'

/** The held-out layout-shift measurement, as dots: 7 right with confidence, 3 "unknown", none wrong. */
function Dots() {
  const pages = Array.from({ length: 10 }, (_, index) => (index < 7 ? 'right' : 'unknown'))
  return (
    <div className="flex flex-wrap gap-1.5" role="img" aria-label="10 pages that shift: 7 named correctly with confidence, 3 reported as unknown, none wrong">
      {pages.map((kind, index) => (
        <span
          key={index}
          className={cn('flex size-7 items-center justify-center rounded-md border', kind === 'right' ? 'border-pass/40 bg-pass/15 text-pass' : 'border-dashed text-muted-foreground')}
        >
          {kind === 'right' ? <CheckIcon className="size-3.5" /> : <MinusIcon className="size-3.5" />}
        </span>
      ))}
    </div>
  )
}

export function Tested() {
  return (
    <Section
      id="tested"
      eyebrow="What is tested"
      title="Claims with a script behind them."
      lede="Each claim below has an end-to-end check in the repository that exits 0 or 1. What has not been run is said so."
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          <TestedMatrix className="my-0 bg-card/40" />
          <ul className="mt-5 space-y-2 text-sm leading-relaxed text-muted-foreground">
            <li>
              <span className="text-foreground">Other frameworks</span> (Vue, Astro, Solid, Angular, server-rendered templates): the proxy and the dock are framework-independent and should work; source positions fall back to ranked guesses. Untested.
            </li>
            <li>
              <span className="text-foreground">Only Chromium and only macOS</span> have been run. Layout shifts need Chromium in any case: it is the only engine with the Layout Instability API.
            </li>
          </ul>
        </div>
        <article className="rounded-2xl border bg-card/60 p-6 sm:p-7">
          <p className="text-sm text-muted-foreground">Layout-shift attribution, held-out pages</p>
          <p className="mt-2 text-6xl font-semibold tracking-[-0.05em]">
            7 <span className="text-muted-foreground/70">of</span> 10
          </p>
          <div className="mt-5">
            <Dots />
          </div>
          <div className="mt-6 space-y-3 text-sm leading-relaxed text-muted-foreground">
            <p>
              14 realistic pages, written without sight of the attribution code, scored once. On <span className="text-foreground">7 of the 10 pages that shift</span>, primp named the cause and the culprit correctly, with confidence.
            </p>
            <p>
              The other 3 it reported as <span className="text-foreground">&ldquo;unknown&rdquo;</span>, without a confident claim. No page got a confident wrong answer, and none of the 4 pages that must not be accused was. The goal was 8 of 10.
            </p>
            <p>
              In plain words: when it names a culprit with confidence, it was right on every page of this set; on 3 of 10 it said it did not know. An earlier blind set scored 5 of 11 and led to three fixes; it now scores 11 of 11, which no longer counts as a measurement.
            </p>
            <Link href="/docs/layout-shifts/#how-accurate-it-is" className="inline-block text-foreground underline underline-offset-4">
              How it is measured
            </Link>
          </div>
        </article>
      </div>
    </Section>
  )
}
