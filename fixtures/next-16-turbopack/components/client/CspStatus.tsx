'use client'

import { useEffect, useState } from 'react'

interface Probe {
  nonced: string
  unnonced: string
}

declare global {
  interface Window {
    __cspNonced?: string
    __cspUnnonced?: string
  }
}

/** Reports which of the two inline scripts on /csp actually ran. */
export function CspStatus() {
  const [probe, setProbe] = useState<Probe | null>(null)

  useEffect(() => {
    setProbe({
      nonced: window.__cspNonced === 'ran' ? 'ran' : 'blocked',
      unnonced: window.__cspUnnonced === 'ran' ? 'ran' : 'blocked',
    })
  }, [])

  return (
    <dl data-label="csp-status" className="panel" data-ready={probe ? 'true' : 'false'}>
      <dt>Inline script with nonce</dt>
      <dd data-label="csp-status-nonced">{probe ? probe.nonced : 'checking'}</dd>
      <dt>Inline script without nonce</dt>
      <dd data-label="csp-status-unnonced">{probe ? probe.unnonced : 'checking'}</dd>
    </dl>
  )
}
