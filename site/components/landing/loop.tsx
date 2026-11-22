import { FileCodeIcon, MoveVerticalIcon, PaintbrushIcon, UsersIcon } from 'lucide-react'
import { CopyButton } from '@/components/copy-button'
import { CodeSpans } from '@/components/mdx/bystander-example'
import { LoopTabs } from '@/components/landing/loop-tabs'
import { Section } from '@/components/landing/section'
import { Status } from '@/components/status'
import { Badge } from '@/components/ui/badge'
import type { Facts, RecordedChange, Shot } from '@/lib/shots'
import { cn } from '@/lib/utils'

function DockCrop({ shots, alt }: { shots: { light: Shot; dark: Shot }; alt: string }) {
  return (
    <div className="mx-auto w-full max-w-[300px] shrink-0 overflow-hidden rounded-xl border bg-muted/30 shadow-[0_20px_50px_-24px_oklch(0_0_0/0.6)] lg:mx-0">
      <img src={shots.light.src} width={shots.light.width} height={shots.light.height} alt={alt} loading="lazy" className="block h-auto w-full dark:hidden" />
      <img src={shots.dark.src} width={shots.dark.width} height={shots.dark.height} alt={alt} loading="lazy" className="hidden h-auto w-full dark:block" />
    </div>
  )
}

function Row({ icon: Icon, label, children }: { icon: typeof FileCodeIcon; label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 border-t py-3 first:border-t-0">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 text-sm">
        <p className="text-xs text-muted-foreground">{label}</p>
        <div className="mt-0.5 break-words">{children}</div>
      </div>
    </div>
  )
}

export function Loop({ facts, change, promptHtml, editShots, verifyShots }: { facts: Facts; change: RecordedChange | undefined; promptHtml: string; editShots: { light: Shot; dark: Shot }; verifyShots: { light: Shot; dark: Shot } }) {
  const results = facts.verify.results
  const panelBody = 'flex flex-col gap-8 p-5 sm:p-8 lg:flex-row lg:items-start'
  return (
    <Section
      id="loop"
      eyebrow="How it works"
      title="Edit, hand off, verify."
      lede="You make the change where you can see it. The agent does what it is good at: finding the right place in your code. primp checks the result against the page, not against the agent's account of it."
    >
      <LoopTabs
        steps={[
          {
            value: 'edit',
            number: '01',
            title: 'Change the running page',
            text: 'Select an element, change any CSS property, at rest or in a state. primp records it, its source line, and what else moved.',
            panel: (
              <div className={panelBody}>
                <div className="min-w-0 flex-1">
                  <h3 className="text-lg font-medium">What primp recorded</h3>
                  <p className="mt-2 text-sm text-muted-foreground">One edit on the demo site: the padding of a button, changed by hand in the dock.</p>
                  <div className="mt-6 rounded-xl border bg-background/60 px-4 py-1">
                    {change !== undefined && (
                      <Row icon={PaintbrushIcon} label="The change">
                        <code className="font-mono text-[13px]">
                          <span className="text-accent-brand-text">{change.property}</span>: <span className="text-muted-foreground line-through decoration-muted-foreground/50">{change.before}</span> <span className="text-muted-foreground">→</span> {change.after}
                        </code>
                      </Row>
                    )}
                    <Row icon={FileCodeIcon} label="Element and source">
                      <code className="font-mono text-[13px]">{facts.edit.label}</code>
                      <span className="text-muted-foreground"> at </span>
                      <code className="font-mono text-[13px]">{facts.edit.source}</code>
                    </Row>
                    <Row icon={MoveVerticalIcon} label="Side effects, measured">
                      {facts.edit.summary}
                    </Row>
                    <Row icon={UsersIcon} label="Bystanders: same rule, not part of the change">
                      {facts.edit.bystanders.map((label) => (
                        <code key={label} className="mr-2 font-mono text-[13px]">
                          {label}
                        </code>
                      ))}
                    </Row>
                  </div>
                  <p className="mt-5 text-sm leading-relaxed text-muted-foreground">
                    Mark a side effect as unwanted and it becomes a constraint the agent must keep. The bystander is why this change will fail in step 3 if the agent edits the shared rule in place.
                  </p>
                </div>
                <DockCrop shots={editShots} alt={`The dock listing recorded changes, the first with the note "${facts.edit.summary}".`} />
              </div>
            ),
          },
          {
            value: 'agent',
            number: '02',
            title: 'Your agent writes it',
            text: 'Send. Your agent takes the changes over MCP, or you paste the prompt. This is the prompt primp produced for that edit.',
            panel: (
              <div className="flex flex-col" data-copy-root>
                <div className="flex items-center justify-between gap-3 border-b px-5 py-2.5 sm:px-8">
                  <p className="truncate font-mono text-xs text-muted-foreground">get_pending_changes · the prompt, as the agent received it</p>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge variant="outline" className="hidden font-mono font-normal sm:inline-flex">
                      markdown
                    </Badge>
                    <CopyButton label="Copy the prompt" />
                  </div>
                </div>
                <div className="relative">
                  <div
                    data-copy-source
                    className="max-h-[540px] overflow-auto px-5 pt-5 pb-16 font-mono text-[12.5px] leading-relaxed sm:px-8 [&_pre]:whitespace-pre-wrap"
                    tabIndex={0}
                    role="region"
                    aria-label="The prompt primp produced"
                    dangerouslySetInnerHTML={{ __html: promptHtml }}
                  />
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 rounded-b-2xl bg-gradient-to-t from-card to-transparent" aria-hidden="true" />
                </div>
              </div>
            ),
          },
          {
            value: 'verify',
            number: '03',
            title: 'primp checks the page',
            text: 'Once the source changes, primp waits for the page to update, measures each change in your tab and judges it.',
            panel: (
              <div className={panelBody}>
                <div className="min-w-0 flex-1">
                  <h3 className="text-lg font-medium">{facts.verify.summary}</h3>
                  <p className="mt-2 text-sm text-muted-foreground">
                    A script stood in for the agent and edited the stylesheet. It changed the shared rule in place, so another button changed too. The verdicts are primp&apos;s own.
                  </p>
                  <ul className="mt-6 space-y-3">
                    {results.map((result) => (
                      <li key={result.id} className={cn('rounded-xl border bg-background/60 p-4 text-sm', result.status === 'fail' && 'border-fail/30')}>
                        <div className="flex items-center gap-2">
                          <Status s={result.status} />
                          <code className="truncate font-mono text-xs text-muted-foreground">{result.id}</code>
                        </div>
                        <p className="mt-2 line-clamp-4 leading-relaxed text-foreground/85">
                          <CodeSpans text={result.hint} />
                        </p>
                      </li>
                    ))}
                  </ul>
                </div>
                <DockCrop shots={verifyShots} alt={`The Verification panel: ${facts.verify.summary}`} />
              </div>
            ),
          },
        ]}
      />
    </Section>
  )
}
