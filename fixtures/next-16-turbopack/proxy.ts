import { NextResponse, type NextRequest } from 'next/server'

/**
 * Strict Content-Security-Policy with a per-request nonce, following the
 * Next.js 16 "Content Security Policy" guide. In Next 16 this file is called
 * proxy.ts (the former middleware.ts convention is deprecated).
 *
 * Next.js reads the nonce back out of the request's CSP header during
 * rendering and puts it on its own scripts. Anything else that wants to run
 * an inline or injected script has to carry the same nonce.
 *
 * One directive from the guide is left out: upgrade-insecure-requests, because
 * the fixture is only ever served over plain http on localhost.
 */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64')
  const isDev = process.env.NODE_ENV === 'development'

  // The guide's main example keeps style-src on the nonce in development too.
  // Next's own dev tools then get their unnonced <style> elements blocked (see
  // the README). FIXTURE_CSP_STYLE=unsafe-inline switches to the relaxed
  // variant from the guide's "Development Environment" section.
  const styleSource = process.env.FIXTURE_CSP_STYLE === 'unsafe-inline' ? `'unsafe-inline'` : `'nonce-${nonce}'`

  // 'unsafe-eval' is needed in development only: React uses eval to rebuild
  // server stack traces in the browser.
  const directives = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' ${styleSource}`,
    `img-src 'self' blob: data:`,
    `font-src 'self'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
  ]
  const csp = directives.join('; ')

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', nonce)
  requestHeaders.set('Content-Security-Policy', csp)

  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set('Content-Security-Policy', csp)
  return response
}

export const config = {
  matcher: [
    {
      // Everything except Route Handlers under /api, static assets and
      // prefetches, as recommended by the guide.
      source: '/((?!api|_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
}
