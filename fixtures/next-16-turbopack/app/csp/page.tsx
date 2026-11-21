import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { CspStatus } from '@/components/client/CspStatus'

export const metadata: Metadata = { title: 'CSP' }

export default async function CspPage() {
  const requestHeaders = await headers()
  const nonce = requestHeaders.get('x-nonce') ?? undefined
  const policy = requestHeaders.get('content-security-policy') ?? '(none)'

  return (
    <>
      <h1 data-label="csp-title">Content Security Policy</h1>
      <p data-label="csp-intro">
        proxy.ts sets a strict policy with a fresh nonce on every request. Two inline scripts follow: one carries the
        nonce, one does not.
      </p>
      <pre data-label="csp-policy" className="panel">{policy}</pre>
      {/* Allowed: carries this request's nonce. */}
      <script nonce={nonce} dangerouslySetInnerHTML={{ __html: 'window.__cspNonced = "ran"' }} />
      {/* Blocked by the policy: no nonce. Expect one CSP violation in the console on this page. */}
      <script dangerouslySetInnerHTML={{ __html: 'window.__cspUnnonced = "ran"' }} />
      <CspStatus />
    </>
  )
}
