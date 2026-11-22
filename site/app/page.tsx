import { ArrowRightIcon, MousePointerClickIcon } from 'lucide-react'
import Link from 'next/link'
import { CommandPill } from '@/components/command-pill'
import { Bento } from '@/components/landing/bento'
import { Hero } from '@/components/landing/hero'
import { InstallTabs } from '@/components/landing/install'
import { Loop } from '@/components/landing/loop'
import { Section } from '@/components/landing/section'
import { Tested } from '@/components/landing/tested'
import { OpenDockButton } from '@/components/live-dock'
import { Button } from '@/components/ui/button'
import { highlight } from '@/lib/highlight'
import { capturedChange, capturedPrompt, facts, shotPair } from '@/lib/shots'

/**
 * The landing page. Every example it quotes comes from public/shots/facts.json and prompt.txt,
 * which site/capture.ts wrote from a real run of primp on the demo site.
 */

const LIMITS = [
  <>The proxy runs on its own port, so logins kept in <code>localStorage</code> and OAuth redirects tied to the dev server&apos;s port do not carry over.</>,
  <>Every response through primp is sent uncached, so each load is a first visit. Pages load a little slower than straight from the dev server.</>,
  <>A <code>:hover</code> made by script, or a rule in a stylesheet from another origin, cannot be checked: such a change is reported as fail or not measurable, never as a pass.</>,
  <>A dev server&apos;s shifts can differ from production. Point primp at a preview build to check.</>,
]

export default async function Home() {
  const captured = facts()
  const promptHtml = await highlight(capturedPrompt(), 'markdown')
  const failed = captured.verify.results.find((result) => result.status === 'fail')
  const change = captured.edit.change ?? capturedChange(captured.edit.id ?? failed?.id ?? '')
  return (
    <main id="main">
      <Hero shots={shotPair('tray')} summary={captured.edit.summary} />
      <Loop facts={captured} change={change} promptHtml={promptHtml} editShots={shotPair('step-edit')} verifyShots={shotPair('step-verify')} />
      <Bento facts={captured} shiftShots={shotPair('shifts')} />

      <Section
        id="start"
        split
        eyebrow="Get started"
        title="One command in front of your dev server."
        lede="Needs Node 22.22 or later in the 22 line, or 24.11 and later. Nothing is installed in your project, and primp never writes to your source files."
      >
        <div className="grid gap-4">
          <InstallTabs />
        </div>
      </Section>

      <Tested />

      <Section split id="limits" eyebrow="Limits" title="The ones you are most likely to meet." lede={<>All of them, and privacy, in <Link href="/docs/limits/" className="text-foreground underline underline-offset-4">Limits and privacy</Link>.</>}>
        <ul className="grid gap-px overflow-hidden rounded-2xl border bg-border">
          {LIMITS.map((limit, index) => (
            <li key={index} className="bg-background px-6 py-5 text-sm leading-relaxed text-muted-foreground [&_code]:font-mono [&_code]:text-[0.9em] [&_code]:text-foreground">
              <div className="flex gap-4">
                <span className="font-mono text-xs leading-6 text-muted-foreground/70">0{index + 1}</span>
                <p>{limit}</p>
              </div>
            </li>
          ))}
        </ul>
      </Section>

      <section aria-labelledby="cta-title" className="relative isolate overflow-hidden border-t">
        <div className="bg-dots absolute inset-0 -z-10 [mask-image:radial-gradient(ellipse_60%_80%_at_50%_100%,#000,transparent)]" aria-hidden="true" />
        <div className="mx-auto max-w-3xl px-4 py-24 text-center sm:px-6 lg:py-32">
          <h2 id="cta-title" className="text-3xl font-semibold tracking-[-0.03em] text-balance sm:text-5xl">
            The dock is on this page.
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-lg text-pretty text-muted-foreground">
            Open it, click anything, change it, press Send: you get the prompt your agent would get, rendered by primp&apos;s own code.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <OpenDockButton>
              <MousePointerClickIcon />
              Try it on this page
            </OpenDockButton>
            <Button asChild variant="outline" size="lg">
              <Link href="/docs/">
                Read the docs <ArrowRightIcon />
              </Link>
            </Button>
          </div>
          <div className="mt-6 flex justify-center">
            <CommandPill command="npx primp" className="w-full max-w-xs" />
          </div>
        </div>
      </section>
    </main>
  )
}
