import Link from 'next/link'
import { CommandMenu } from '@/components/command-menu'
import { GitHubIcon } from '@/components/github-icon'
import { Logo } from '@/components/logo'
import { MobileNav } from '@/components/mobile-nav'
import { ThemeToggle } from '@/components/theme-toggle'
import { Button } from '@/components/ui/button'
import { GITHUB_URL } from '@/lib/config'

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 w-full border-b border-border/70 bg-background/75 backdrop-blur-xl supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-2 px-4 sm:px-6">
        <MobileNav />
        <Link href="/" className="mr-4 flex items-center rounded-md" aria-label="primp home">
          <Logo />
        </Link>
        <nav aria-label="Main" className="hidden items-center gap-1 text-sm md:flex">
          <Link href="/docs/" className="rounded-md px-2.5 py-1.5 text-muted-foreground transition-colors hover:text-foreground">
            Docs
          </Link>
          <Link href="/docs/dock/" className="rounded-md px-2.5 py-1.5 text-muted-foreground transition-colors hover:text-foreground">
            The dock
          </Link>
          <Link href="/docs/layout-shifts/" className="rounded-md px-2.5 py-1.5 text-muted-foreground transition-colors hover:text-foreground">
            Layout shifts
          </Link>
          <a href={GITHUB_URL} className="rounded-md px-2.5 py-1.5 text-muted-foreground transition-colors hover:text-foreground">
            GitHub
          </a>
        </nav>
        <div className="ml-auto flex items-center gap-1.5">
          <CommandMenu className="w-auto md:w-52 lg:w-60" />
          <Button asChild variant="ghost" size="icon-sm" className="hidden sm:inline-flex">
            <a href={GITHUB_URL} aria-label="primp on GitHub" title="GitHub">
              <GitHubIcon className="size-4" />
            </a>
          </Button>
          <ThemeToggle />
        </div>
      </div>
    </header>
  )
}
