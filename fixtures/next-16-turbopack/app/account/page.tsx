import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { DEMO_USER, SESSION_COOKIE } from '@/lib/session'

export const metadata: Metadata = { title: 'Account' }

export default async function AccountPage() {
  const session = (await cookies()).get(SESSION_COOKIE)?.value
  if (session !== DEMO_USER) {
    redirect('/login')
  }

  return (
    <>
      <h1 data-label="account-title">Account</h1>
      <p data-label="account-status">{`Signed in as ${session}`}</p>
      <form data-label="account-logout-form" method="post" action="/api/logout">
        <button data-label="account-logout" type="submit">
          Log out
        </button>
      </form>
    </>
  )
}
