import type { Metadata } from 'next'
import { Suspense } from 'react'
import { SlowContent } from '@/components/server/SlowContent'

export const metadata: Metadata = { title: 'Streaming' }

export default function StreamPage() {
  return (
    <>
      <h1 data-label="stream-title">Streaming with Suspense</h1>
      <p data-label="stream-intro">The shell below is sent first. The slow section streams in later in the same response.</p>
      <Suspense
        fallback={
          <p data-label="stream-fallback" className="panel" role="status">
            Loading slow content…
          </p>
        }
      >
        <SlowContent />
      </Suspense>
    </>
  )
}
