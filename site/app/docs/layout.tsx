import { DocsSidebar } from '@/components/docs/sidebar'

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-[1400px] px-4 sm:px-6">
      <div className="grid gap-10 md:grid-cols-[13rem_minmax(0,1fr)] lg:gap-14">
        <aside className="hidden md:block">
          <div className="sticky top-14 max-h-[calc(100svh-3.5rem)] overflow-y-auto py-10 pr-2">
            <DocsSidebar />
          </div>
        </aside>
        <main className="min-w-0 py-10 lg:py-12">{children}</main>
      </div>
    </div>
  )
}
