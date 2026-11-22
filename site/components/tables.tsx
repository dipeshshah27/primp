import { Status } from '@/components/status'
import { cn } from '@/lib/utils'

/** Tables used on more than one page, worded as in README.md. */

export function TableShell({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('not-prose my-6 w-full overflow-x-auto rounded-xl border', className)}>
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  )
}

const th = 'border-b bg-muted/40 px-4 py-2.5 text-left font-medium text-foreground'
const td = 'border-b px-4 py-3 align-top text-muted-foreground [tr:last-child_&]:border-b-0'

export function TestedMatrix({ className }: { className?: string }) {
  const rows: [string, string[]][] = [
    ['Proxy in front of it (hot reload, logins, streamed pages where the app has them)', ['yes', 'yes', 'yes', 'yes']],
    ['Element to source line', ['exact', 'exact, server and client components', 'exact when hydrated', 'exact']],
    ['Edit, hand off, verify loop', ['yes', 'yes', 'yes', 'yes (primp reloads the page)']],
  ]
  const columns = ['Vite + React 19', 'Next 16 (Turbopack, RSC, strict CSP)', 'SvelteKit (Svelte 5)', 'Plain HTML']
  return (
    <TableShell className={className}>
      <caption className="sr-only">What has been tested, per framework</caption>
      <thead>
        <tr>
          <th scope="col" className={cn(th, 'min-w-44')}>
            <span className="sr-only">Claim</span>
          </th>
          {columns.map((column) => (
            <th key={column} scope="col" className={cn(th, 'min-w-32')}>
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map(([claim, cells]) => (
          <tr key={claim}>
            <th scope="row" className={cn(td, 'text-left font-normal text-foreground')}>
              {claim}
            </th>
            {cells.map((cell, index) => (
              <td key={index} className={td}>
                <span className="inline-flex items-start gap-1.5">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-pass" aria-hidden="true" />
                  {cell}
                </span>
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </TableShell>
  )
}

export function StatusTable() {
  const rows: [string, React.ReactNode][] = [
    ['The value is the one you asked for', <Status key="s" s="pass" />],
    ['It landed close, such as the nearest design token', <Status key="s" s="drift" />],
    ['It is something else, or unchanged', <><Status s="fail" />, with expected and actual</>],
    ['An element you did not touch changed with it', <><Status s="fail" />, naming that element</>],
    ['The build is broken', <><Status s="build_error" />, with the message</>],
    ['No source file changed', <Status key="s" s="no_update_observed" />],
    ['The element cannot be found again', <Status key="s" s="unresolved" />],
    ["The viewport is outside the change's media query, or the state cannot be emulated", <Status key="s" s="not_measurable" />],
    ['The change is a note: there is nothing to measure, a person checks it', <Status key="s" s="not_checkable" />],
    ['The tab is in the background, or closed', <><Status s="tab_hidden" /> <Status s="no_browser" /></>],
  ]
  return (
    <TableShell>
      <thead>
        <tr>
          <th scope="col" className={th}>
            What happened
          </th>
          <th scope="col" className={th}>
            What primp reports
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([what, status]) => (
          <tr key={what}>
            <td className={cn(td, 'text-foreground')}>{what}</td>
            <td className={cn(td, 'whitespace-nowrap')}>{status}</td>
          </tr>
        ))}
      </tbody>
    </TableShell>
  )
}
