import Link from 'next/link'
import { Button } from '@/components/ui/button'

export const metadata = { title: 'Page not found' }

export default function NotFound() {
  return (
    <main id="main" className="mx-auto flex max-w-xl flex-col items-start px-4 py-28 sm:px-6">
      <p className="font-mono text-sm text-muted-foreground">404</p>
      <h1 className="mt-2 text-4xl font-semibold tracking-tight">Page not found</h1>
      <p className="mt-3 text-muted-foreground">There is nothing at this address.</p>
      <div className="mt-8 flex gap-2">
        <Button asChild>
          <Link href="/">Home</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/docs/">Docs</Link>
        </Button>
      </div>
    </main>
  )
}
