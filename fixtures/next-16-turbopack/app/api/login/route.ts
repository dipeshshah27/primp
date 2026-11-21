import { NextResponse, type NextRequest } from 'next/server'
import { DEMO_PASSWORD, DEMO_USER, SESSION_COOKIE } from '@/lib/session'

/**
 * POST /api/login: checks the demo credentials, sets the HttpOnly "session"
 * cookie and redirects to /account. The redirect target is built from
 * request.url, the usual idiom, so it reflects whatever host the server
 * believes it is being reached on.
 */
export async function POST(request: NextRequest) {
  const form = await request.formData()
  const username = String(form.get('username') ?? '')
  const password = String(form.get('password') ?? '')

  if (username !== DEMO_USER || password !== DEMO_PASSWORD) {
    return NextResponse.redirect(new URL('/login?error=1', request.url), 303)
  }

  const response = NextResponse.redirect(new URL('/account', request.url), 303)
  response.cookies.set(SESSION_COOKIE, DEMO_USER, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
  })
  return response
}
