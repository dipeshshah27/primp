import type { Metadata } from 'next'
import { LoginHint } from '@/components/client/LoginHint'
import { DEMO_PASSWORD, DEMO_USER } from '@/lib/session'

export const metadata: Metadata = { title: 'Login' }

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams

  return (
    <>
      <h1 data-label="login-title">Log in</h1>
      {/* Always rendered so the label is in the DOM; shown only after a failed login. */}
      <p data-label="login-error" role="alert" hidden={!error}>
        Wrong user name or password.
      </p>
      {/* A plain HTML form: it posts to a Route Handler, not a Server Action. */}
      <form data-label="login-form" className="stack" method="post" action="/api/login">
        <label>
          User name <input data-label="login-username" name="username" defaultValue={DEMO_USER} autoComplete="username" />
        </label>
        <label>
          Password{' '}
          <input
            data-label="login-password"
            name="password"
            type="password"
            defaultValue={DEMO_PASSWORD}
            autoComplete="current-password"
          />
        </label>
        <button data-label="login-submit" data-variant="primary" type="submit">
          Log in
        </button>
      </form>
      <LoginHint />
    </>
  )
}
