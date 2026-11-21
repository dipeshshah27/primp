import type { Metadata } from 'next'
import Link from 'next/link'
import { connection } from 'next/server'
import type { ReactNode } from 'react'
import { ThemeToggle } from '@/components/client/ThemeToggle'
import './globals.css'

export const metadata: Metadata = {
  title: {
    default: 'next-16-turbopack fixture',
    template: '%s | next-16-turbopack fixture',
  },
  description: 'primp test fixture: Next.js 16 App Router on Turbopack.',
}

const NAV_LINKS = [
  { href: '/', text: 'Home' },
  { href: '/actions', text: 'Actions' },
  { href: '/stream', text: 'Stream' },
  { href: '/big', text: 'Big' },
  { href: '/account', text: 'Account' },
  { href: '/login', text: 'Login' },
  { href: '/csp', text: 'CSP' },
  { href: '/broken-toggle', text: 'Broken toggle' },
]

export default async function RootLayout({ children }: { children: ReactNode }) {
  // The CSP nonce is per request, so every page has to render per request.
  await connection()

  return (
    <html lang="en">
      <body>
        <header data-label="site-header" className="site-header">
          <Link href="/" className="site-brand">
            <span data-label="site-brand">next-16-turbopack</span>
          </Link>
          <nav data-label="site-nav" className="site-nav" aria-label="Pages">
            {NAV_LINKS.map((link) => (
              <Link key={link.href} href={link.href}>
                {link.text}
              </Link>
            ))}
          </nav>
          <ThemeToggle />
        </header>
        <main data-label="site-main" className="site-main">
          {children}
        </main>
        <footer data-label="site-footer" className="site-footer">
          <p data-label="footer-note">
            primp fixture. Server components, client components, a nonce CSP and a Server Action.
          </p>
        </footer>
      </body>
    </html>
  )
}
