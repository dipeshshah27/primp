import type { MDXContent } from 'mdx/types'
import { Pager } from '@/components/docs/pager'
import { Toc } from '@/components/docs/toc'
import { docSource, headings } from '@/lib/doc-source'
import type { DocEntry } from '@/lib/docs'

const CONTENT: Record<string, () => Promise<{ default: MDXContent }>> = {
  'getting-started': () => import('@/content/docs/getting-started.mdx'),
  dock: () => import('@/content/docs/dock.mdx'),
  'layout-shifts': () => import('@/content/docs/layout-shifts.mdx'),
  agents: () => import('@/content/docs/agents.mdx'),
  'mcp-tools': () => import('@/content/docs/mcp-tools.mdx'),
  verification: () => import('@/content/docs/verification.mdx'),
  limits: () => import('@/content/docs/limits.mdx'),
  faq: () => import('@/content/docs/faq.mdx'),
}

export async function DocPage({ entry }: { entry: DocEntry }) {
  const load = CONTENT[entry.file]
  if (load === undefined) throw new Error(`no MDX for ${entry.file}`)
  const { default: Content } = await load()
  const toc = headings(docSource(entry))
  return (
    <div className="grid gap-10 xl:grid-cols-[minmax(0,1fr)_13rem]">
      <article id="main" className="min-w-0">
        <header className="mb-8 border-b pb-8">
          <p className="mb-3 text-sm font-medium text-accent-brand-text">Docs</p>
          <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{entry.title}</h1>
          <p className="mt-3 text-lg text-pretty text-muted-foreground">{entry.description}</p>
        </header>
        <div className="doc-content">
          <Content />
        </div>
        <Pager current={entry} />
      </article>
      <aside className="hidden xl:block">
        <div className="sticky top-24 max-h-[calc(100svh-7rem)] overflow-y-auto pb-8">
          <Toc items={toc} />
        </div>
      </aside>
    </div>
  )
}
