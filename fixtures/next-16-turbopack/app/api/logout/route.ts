import { NextResponse, type NextRequest } from 'next/server'
import { SESSION_COOKIE } from '@/lib/session'

/** POST /api/logout: clears the session cookie and redirects to /login. */
export async function POST(request: NextRequest) {
  const response = NextResponse.redirect(new URL('/login', request.url), 303)
  response.cookies.delete(SESSION_COOKIE)
  return response
}
