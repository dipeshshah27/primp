'use client'

import { useState, type FormEvent } from 'react'

export function Newsletter() {
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState('Not subscribed.')

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setStatus(email ? `Subscribed ${email} (client state only).` : 'Enter an address first.')
  }

  return (
    <form data-label="newsletter-form" className="stack" onSubmit={onSubmit}>
      <div className="row">
        <input
          data-label="newsletter-input"
          type="email"
          name="email"
          placeholder="you@example.test"
          aria-label="Email address"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <button data-label="newsletter-submit" data-variant="primary" type="submit">
          Subscribe
        </button>
      </div>
      <p data-label="newsletter-status" className="muted" role="status">
        {status}
      </p>
    </form>
  )
}
