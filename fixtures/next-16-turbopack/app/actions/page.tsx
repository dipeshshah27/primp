import type { Metadata } from 'next'
import { SubmitButton } from '@/components/client/SubmitButton'
import { getStore } from '@/lib/store'
import { incrementCounter, resetCounter } from './actions'

export const metadata: Metadata = { title: 'Server Action' }

export default function ActionsPage() {
  const store = getStore()

  return (
    <>
      <h1 data-label="actions-title">Server Action</h1>
      <p data-label="actions-result">
        Saved value: <output data-label="actions-count" data-count={store.count}>{store.count}</output>
      </p>
      <p data-label="actions-meta" className="muted" data-updates={store.updates}>
        {store.updates} update(s). Last note: {store.note || 'none'}
      </p>
      <form data-label="actions-form" className="stack" action={incrementCounter}>
        <label>
          Step <input data-label="actions-step" name="step" type="number" defaultValue={1} />
        </label>
        <label>
          Note <input data-label="actions-note" name="note" type="text" maxLength={80} />
        </label>
        <SubmitButton>Add to saved value</SubmitButton>
      </form>
      <form data-label="actions-reset-form" className="panel" action={resetCounter}>
        <button data-label="actions-reset" type="submit">
          Reset saved value
        </button>
      </form>
    </>
  )
}
