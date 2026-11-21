'use client'

import type { ReactNode } from 'react'
import { useFormStatus } from 'react-dom'

/** Submit button for a Server Action form; shows the pending state. */
export function SubmitButton({ children }: { children: ReactNode }) {
  const { pending } = useFormStatus()

  return (
    <button data-label="actions-submit" data-variant="primary" type="submit" disabled={pending} data-pending={pending}>
      {pending ? 'Saving…' : children}
    </button>
  )
}
