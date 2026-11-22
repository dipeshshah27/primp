import Link from 'next/link'
import { Logo } from '@/components/logo'
import { GITHUB_URL } from '@/lib/config'
import { DOCS, docHref } from '@/lib/docs'

export function SiteFooter() {
  return (
    <footer className="border-t border-border/70">
      <div className="mx-auto grid max-w-[1400px] gap-10 px-4 py-12 sm:px-6 md:grid-cols-[1.4fr_1fr_1fr]">
        <div className="space-y-3">
          <Logo />
          <p className="max-w-sm text-sm text-muted-foreground">
            Edit your running app by hand, let your coding agent write the code, and have the result checked against the page.
          </p>
          <p className="text-xs text-muted-foreground">MIT licensed. No telemetry. This site makes no requests to any other origin.</p>
        </div>
        <nav aria-label="Docs" className="text-sm">
          <p className="mb-3 font-medium">Docs</p>
          <ul className="space-y-2">
            {DOCS.slice(0, 5).map((entry) => (
              <li key={entry.slug}>
                <Link href={docHref(entry)} className="text-muted-foreground transition-colors hover:text-foreground">
                  {entry.title}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <nav aria-label="Project" className="text-sm">
          <p className="mb-3 font-medium">Project</p>
          <ul className="space-y-2">
            {DOCS.slice(5).map((entry) => (
              <li key={entry.slug}>
                <Link href={docHref(entry)} className="text-muted-foreground transition-colors hover:text-foreground">
                  {entry.title}
                </Link>
              </li>
            ))}
            <li>
              <a href={GITHUB_URL} className="text-muted-foreground transition-colors hover:text-foreground">
                Source on GitHub
              </a>
            </li>
          </ul>
        </nav>
      </div>
    </footer>
  )
}
