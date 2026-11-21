'use client'

import { useState, type ReactNode } from 'react'

/**
 * A client component that wraps children rendered on the server. The frame
 * itself belongs to this file; the children keep their server source location.
 */
export function ClientFrame({ title, children }: { title: string; children: ReactNode }) {
  const [emphasised, setEmphasised] = useState(false)

  return (
    <section
      data-label="client-frame"
      className="panel"
      data-emphasised={emphasised ? 'true' : 'false'}
    >
      <h2 data-label="client-frame-title">{title}</h2>
      {children}
      <button data-label="client-frame-toggle" type="button" onClick={() => setEmphasised((value) => !value)}>
        {emphasised ? 'Thin border' : 'Thick border'}
      </button>
    </section>
  )
}
