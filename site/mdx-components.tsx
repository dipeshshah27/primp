import type { MDXComponents } from 'mdx/types'
import Link from 'next/link'
import { Callout } from '@/components/callout'
import { CommandPill } from '@/components/command-pill'
import { CopyButton } from '@/components/copy-button'
import { OpenDockButton, ReplayShiftButton } from '@/components/live-dock'
import { BystanderExample, CapturedSummary } from '@/components/mdx/bystander-example'
import { Shot } from '@/components/mdx/shot'
import { Status } from '@/components/status'
import { StatusTable, TableShell, TestedMatrix } from '@/components/tables'
import { cn } from '@/lib/utils'

/** Inline `code`; block code comes from rehype-pretty-code with `data-language` set. */
function Code({ className, ...props }: React.ComponentProps<'code'> & { 'data-language'?: string }) {
  if (props['data-language'] !== undefined) return <code className={className} {...props} />
  return <code className={cn('rounded-md border bg-muted/60 px-[0.3rem] py-[0.1rem] font-mono text-[0.84em] text-foreground', className)} {...props} />
}

function Figure(props: React.ComponentProps<'figure'> & { 'data-rehype-pretty-code-figure'?: string }) {
  if (props['data-rehype-pretty-code-figure'] === undefined) return <figure {...props} />
  return (
    <figure {...props} data-copy-root className="group relative my-6 overflow-hidden rounded-xl border bg-code">
      {props.children}
      <CopyButton className="absolute top-2.5 right-2.5 bg-code opacity-70 group-hover:opacity-100 focus-visible:opacity-100" label="Copy code" />
    </figure>
  )
}

function Anchor({ href = '', className, ...props }: React.ComponentProps<'a'>) {
  const style = cn('font-medium text-foreground underline decoration-foreground/25 underline-offset-4 transition-colors hover:decoration-foreground', className)
  if (href.startsWith('/') || href.startsWith('#')) return <Link href={href} className={style} {...props} />
  return <a href={href} className={style} {...props} />
}

/** A heading with a hover anchor link; the id comes from rehype-slug. */
function heading(Tag: 'h2' | 'h3', style: string) {
  return function Heading({ id, children, className, ...props }: React.ComponentProps<'h2'>) {
    return (
      <Tag id={id} className={cn('group scroll-mt-24', style, className)} {...props}>
        {children}
        {id !== undefined && (
          <a href={`#${id}`} className="ml-2 text-muted-foreground/0 no-underline transition-colors group-hover:text-muted-foreground/60" aria-label={`Link to this section`}>
            #
          </a>
        )}
      </Tag>
    )
  }
}

const components: MDXComponents = {
  h2: heading('h2', 'mt-12 mb-4 border-b pb-2 text-2xl font-semibold tracking-tight first:mt-0'),
  h3: heading('h3', 'mt-8 mb-3 text-lg font-semibold tracking-tight'),
  p: ({ className, ...props }) => <p className={cn('my-4 leading-7 text-foreground/80', className)} {...props} />,
  a: Anchor,
  ul: ({ className, ...props }) => <ul className={cn('my-4 ml-5 list-disc space-y-2 leading-7 text-foreground/80 marker:text-muted-foreground/60', className)} {...props} />,
  ol: ({ className, ...props }) => <ol className={cn('my-4 ml-5 list-decimal space-y-2 leading-7 text-foreground/80 marker:text-muted-foreground', className)} {...props} />,
  li: ({ className, ...props }) => <li className={cn('pl-1', className)} {...props} />,
  strong: ({ className, ...props }) => <strong className={cn('font-semibold text-foreground', className)} {...props} />,
  blockquote: ({ className, ...props }) => <blockquote className={cn('my-6 border-l-2 border-accent-brand/60 pl-4 text-foreground/80 italic', className)} {...props} />,
  hr: () => <hr className="my-10" />,
  code: Code,
  figure: Figure,
  pre: ({ className, ...props }) => <pre data-copy-source className={cn('overflow-x-auto py-4 font-mono text-[13px] leading-6', className)} {...props} />,
  table: ({ children }) => <TableShell>{children}</TableShell>,
  th: ({ className, ...props }) => <th className={cn('border-b bg-muted/40 px-4 py-2.5 text-left font-medium', className)} {...props} />,
  td: ({ className, ...props }) => <td className={cn('border-b px-4 py-3 align-top text-muted-foreground [tr:last-child_&]:border-b-0', className)} {...props} />,
  Callout,
  Terminal: ({ command }: { command: string }) => (
    <div className="my-5">
      <CommandPill command={command} className="w-full sm:w-auto sm:min-w-80" />
    </div>
  ),
  Shot,
  BystanderExample,
  CapturedSummary,
  Status,
  StatusTable,
  TestedMatrix,
  OpenDockButton,
  ReplayShiftButton,
}

export function useMDXComponents(): MDXComponents {
  return components
}
