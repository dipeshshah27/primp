import { ActivityIcon, BotIcon, GitPullRequestArrowIcon, LaptopIcon, ScanSearchIcon, ShieldCheckIcon } from 'lucide-react'
import Link from 'next/link'
import { ReplayShiftButton } from '@/components/live-dock'
import { CodeSpans } from '@/components/mdx/bystander-example'
import { Section } from '@/components/landing/section'
import { Status } from '@/components/status'
import type { Facts, Shot } from '@/lib/shots'
import { cn } from '@/lib/utils'

function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return <article className={cn('group relative flex flex-col overflow-hidden rounded-2xl border bg-card/60 p-6 sm:p-7', className)}>{children}</article>
}

function CardTitle({ icon: Icon, title, children }: { icon: typeof ActivityIcon; title: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="mb-4 flex size-9 items-center justify-center rounded-lg border bg-background/80 shadow-xs">
        <Icon className="size-4 text-accent-brand-text" aria-hidden="true" />
      </span>
      <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-pretty text-muted-foreground">{children}</p>
    </div>
  )
}

/** Real output, as a little console: label on the left, primp's words on the right. */
function Output({ children, label = 'From a real run on the demo site' }: { children: React.ReactNode; label?: string }) {
  return (
    <div className="mt-6 overflow-hidden rounded-xl border bg-background/70 font-mono text-[12.5px] leading-relaxed">
      <p className="border-b bg-muted/40 px-4 py-2 font-sans text-xs text-muted-foreground">{label}</p>
      <div className="space-y-2 p-4">{children}</div>
    </div>
  )
}

const UNMEASURED = ['no_update_observed', 'unresolved', 'not_measurable', 'not_checkable', 'tab_hidden', 'no_browser']

export function Bento({ facts, shiftShots }: { facts: Facts; shiftShots: { light: Shot; dark: Shot } }) {
  const fail = facts.verify.results.find((result) => result.status === 'fail')
  const firstSentence = fail === undefined ? '' : `${fail.hint.split('. ')[0]}.`
  const reserved = facts.shift.evidence.find((line) => line.includes('not reserved'))
  const moved = facts.shift.evidence.find((line) => / (moved|pushed) (down|up)/.test(line))
  return (
    <Section
      id="different"
      eyebrow="What makes it different"
      title="Built around what happens before and after the hand-off."
      lede="Editing a live page and passing the result to an agent is the easy part. These three are where the work went."
    >
      <div className="grid gap-4 lg:grid-cols-6">
        <Card className="lg:col-span-4">
          <CardTitle icon={ScanSearchIcon} title="Side effects and bystanders">
            Every edit is measured. primp lists what else on the page moved; mark one as unwanted and it becomes a constraint the agent must keep. When a change goes through a CSS rule other elements share, primp records those elements and fails the change if one of them moved.
          </CardTitle>
          <Output>
            <p>
              <span className="text-muted-foreground">edit</span> <span className="text-foreground">{facts.edit.label}</span>
            </p>
            <p>
              <span className="text-muted-foreground">moved</span> {facts.edit.summary}
            </p>
            {facts.edit.bystanders.map((label) => (
              <p key={label}>
                <span className="text-muted-foreground">bystander</span> {label}
              </p>
            ))}
            {fail !== undefined && (
              <div className="flex items-start gap-2 border-t pt-3 font-sans text-[13px] [&_code]:border-0 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-foreground">
                <Status s="fail" />
                <p className="text-foreground/85">
                  <CodeSpans text={firstSentence} />
                </p>
              </div>
            )}
          </Output>
        </Card>

        <Card className="lg:col-span-2">
          <CardTitle icon={ShieldCheckIcon} title="Never passes unmeasured">
            A change passes only when the page was measured and the value is there. Everything else has a status of its own, and none of them counts as success.
          </CardTitle>
          <div className="mt-6 space-y-3">
            <div className="flex flex-wrap gap-1.5">
              <Status s="pass" />
              <Status s="drift" />
              <Status s="fail" />
              <Status s="build_error" />
            </div>
            <div className="flex flex-wrap gap-1.5 border-t pt-3">
              {UNMEASURED.map((status) => (
                <Status key={status} s={status} />
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Grey: primp could not look, or there was nothing to measure. <Link href="/docs/verification/" className="text-foreground underline underline-offset-4">All statuses</Link>
            </p>
          </div>
        </Card>

        <Card className="lg:col-span-3">
          <CardTitle icon={ActivityIcon} title="Layout shifts, attributed">
            primp records the page load from its first script and names the element that caused each shift, the cause (an image without reserved space, a web font swapping in, content inserted above) and the line in your source.
          </CardTitle>
          <Output>
            <p>
              <span className="text-muted-foreground">culprit</span> {facts.shift.culprit}
            </p>
            <p>
              <span className="text-muted-foreground">cause</span> {facts.shift.cause} <span className="text-muted-foreground">· {Math.round(facts.shift.confidence * 100)}% confident</span>
            </p>
            <p>
              <span className="text-muted-foreground">source</span> {facts.shift.source}
            </p>
            {reserved !== undefined && <p className="text-foreground/80">{reserved}</p>}
            {moved !== undefined && <p className="text-foreground/80">{moved}</p>}
          </Output>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <ReplayShiftButton />
            <span className="text-xs text-muted-foreground">Reloads this page with one, for the dock to find.</span>
          </div>
        </Card>

        <Card className="p-0 sm:p-0 lg:col-span-3">
          <div className="relative min-h-[320px] flex-1 overflow-hidden bg-muted/30">
            <img src={shiftShots.light.src} width={shiftShots.light.width} height={shiftShots.light.height} alt="The Layout shifts panel of the dock on the demo site: the culprit image outlined on the page, its cause, source line and evidence." loading="lazy" className="absolute inset-0 size-full object-cover object-[100%_62%] dark:hidden" />
            <img src={shiftShots.dark.src} width={shiftShots.dark.width} height={shiftShots.dark.height} alt="The Layout shifts panel of the dock on the demo site: the culprit image outlined on the page, its cause, source line and evidence." loading="lazy" className="absolute inset-0 hidden size-full object-cover object-[100%_62%] dark:block" />
          </div>
          <div className="border-t px-6 py-4">
            <p className="text-sm font-medium">The Layout shifts panel</p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              The culprit outlined on the page, with the evidence. <Link href="/docs/layout-shifts/" className="text-foreground underline underline-offset-4">How attribution works</Link>
            </p>
          </div>
        </Card>

        <Card className="lg:col-span-2">
          <CardTitle icon={GitPullRequestArrowIcon} title="Never writes your code">
            primp records and checks. Your agent makes the edits, in your project&apos;s own style; nothing is installed in your project.
          </CardTitle>
        </Card>
        <Card className="lg:col-span-2">
          <CardTitle icon={BotIcon} title="Any agent">
            Six MCP tools for Claude Code, Codex, Cursor or any MCP client. Without MCP, paste the prompt; primp still verifies.
          </CardTitle>
        </Card>
        <Card className="lg:col-span-2">
          <CardTitle icon={LaptopIcon} title="Runs on your machine">
            No telemetry, no requests of its own. The proxy accepts connections from localhost only.
          </CardTitle>
        </Card>
      </div>
    </Section>
  )
}
