import { ArrowRightIcon, MousePointerClickIcon } from 'lucide-react'
import Link from 'next/link'
import { BrowserFrame } from '@/components/browser-frame'
import { CommandPill } from '@/components/command-pill'
import { OpenDockButton } from '@/components/live-dock'
import { Button } from '@/components/ui/button'
import type { Shot } from '@/lib/shots'

/**
 * The hero. Its screenshot exists twice: sized (width and height attributes, so the browser
 * reserves its space) and, for the layout-shift replay only (`?shift=1`), unsized and held back
 * by the delay worker, so the page jumps when it arrives. See `.shift-replay-only` in globals.css.
 */
export function Hero({ shots, summary }: { shots: { light: Shot; dark: Shot }; summary: string }) {
  const alt = `The primp dock open on the demo site: two recorded changes, each with its source line; the first one notes what else moved on the page: "${summary}".`
  return (
    <section aria-labelledby="hero-title" className="relative isolate overflow-hidden">
      <div className="bg-grid absolute inset-0 -z-10 h-[820px]" aria-hidden="true" />
      <div className="glow absolute top-[420px] left-1/2 -z-10 h-[620px] w-[1100px] -translate-x-1/2" aria-hidden="true" />
      <div className="mx-auto max-w-[1200px] px-4 pt-16 pb-10 text-center sm:px-6 sm:pt-24">
        <p className="mx-auto mb-7 inline-flex animate-rise items-center gap-2 rounded-full border bg-background/60 px-3 py-1 text-xs text-muted-foreground backdrop-blur">
          <span className="size-1.5 rounded-full bg-accent-brand" aria-hidden="true" />
          Open source, MIT. Runs on your machine.
        </p>
        <h1 id="hero-title" className="text-gradient mx-auto max-w-5xl animate-rise text-[2.6rem] leading-[1.02] font-semibold tracking-[-0.045em] text-balance [animation-delay:60ms] sm:text-6xl lg:text-[4.6rem]">
          Edit the page. Your agent edits the code. primp checks they match.
        </h1>
        <p className="mx-auto mt-6 max-w-2xl animate-rise text-lg leading-relaxed text-pretty text-muted-foreground [animation-delay:120ms] sm:text-xl">
          Change the running page by hand. Your coding agent writes it into your source, and primp measures the page again: pass, drift or fail, for every change.
        </p>
        <div className="mt-9 flex animate-rise flex-col items-center justify-center gap-3 [animation-delay:180ms] sm:flex-row">
          <OpenDockButton>
            <MousePointerClickIcon />
            Try it on this page
          </OpenDockButton>
          <Button asChild variant="outline" size="lg">
            <Link href="/docs/">
              Get started <ArrowRightIcon />
            </Link>
          </Button>
        </div>
        <div className="mt-5 flex animate-rise justify-center [animation-delay:220ms]">
          <CommandPill command="npx primp" className="w-full max-w-xs" />
        </div>
      </div>
      <div className="mx-auto max-w-[1200px] animate-rise px-4 pb-8 [animation-delay:280ms] sm:px-6">
        <BrowserFrame url="localhost:5174">
          <img src={shots.light.src} width={shots.light.width} height={shots.light.height} alt={alt} fetchPriority="high" className="shift-replay-hide block h-auto w-full dark:hidden" />
          <img src={shots.dark.src} width={shots.dark.width} height={shots.dark.height} alt={alt} className="shift-replay-hide hidden h-auto w-full dark:block" />
          {/* The replay only: no width, no height, no aspect-ratio, and held back 700 ms by /primp-sw.js. */}
          <img src={`${shots.dark.src}?delay=700`} alt={alt} loading="lazy" className="shift-replay-only hero-replay-shot w-full" />
        </BrowserFrame>
        <p className="mt-4 text-center text-sm text-muted-foreground">
          The dock on the demo site of <code className="font-mono text-foreground/80">npx primp demo</code>: two changes recorded, each with its source line and what else moved.
        </p>
      </div>
    </section>
  )
}
