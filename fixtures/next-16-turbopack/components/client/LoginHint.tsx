'use client'

import { useState } from 'react'

export function LoginHint() {
  const [open, setOpen] = useState(false)

  return (
    <div className="panel">
      <button data-label="login-hint-toggle" type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? 'Hide hint' : 'Show hint'}
      </button>
      <p data-label="login-hint-text" className="muted" hidden={!open}>
        The only account is user &quot;demo&quot; with password &quot;demo&quot;.
      </p>
    </div>
  )
}
