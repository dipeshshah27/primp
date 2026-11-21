'use server'

import { revalidatePath } from 'next/cache'
import { getStore } from '@/lib/store'

/** Adds the submitted step to the saved counter and re-renders the pages that show it. */
export async function incrementCounter(formData: FormData): Promise<void> {
  const step = Number(formData.get('step') ?? 1)
  const store = getStore()
  store.count += Number.isFinite(step) ? Math.trunc(step) : 1
  store.note = String(formData.get('note') ?? '').slice(0, 80)
  store.updates += 1
  revalidatePath('/actions')
  revalidatePath('/')
}

/** Puts the saved counter back to zero. */
export async function resetCounter(): Promise<void> {
  const store = getStore()
  store.count = 0
  store.note = ''
  store.updates = 0
  revalidatePath('/actions')
  revalidatePath('/')
}
