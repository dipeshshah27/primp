import type { Metadata } from 'next'
import { BreakTargetClient } from '@/components/client/BreakTargetClient'
import { BreakTargetServer } from '@/components/server/BreakTargetServer'

export const metadata: Metadata = { title: 'Broken toggle' }

export default function BrokenTogglePage() {
  return (
    <>
      <h1 data-label="broken-title">Broken toggle</h1>
      <p data-label="broken-intro">
        Run <code>node scripts/break.mjs on</code> to put a syntax error into one of the two components below, and{' '}
        <code>node scripts/break.mjs off</code> to remove it. Only this page imports them.
      </p>
      <BreakTargetServer />
      <BreakTargetClient />
    </>
  )
}
