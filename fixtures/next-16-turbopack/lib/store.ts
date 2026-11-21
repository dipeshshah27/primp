/**
 * In-memory state for the Server Action demo. It lives on globalThis so it
 * survives hot reloads of this module; it resets when the dev server restarts.
 * Nothing is written to disk, so file watchers never see the app change itself.
 */
export interface CounterStore {
  count: number
  note: string
  updates: number
}

const holder = globalThis as typeof globalThis & {
  __fixtureCounterStore?: CounterStore
}

export function getStore(): CounterStore {
  holder.__fixtureCounterStore ??= { count: 0, note: '', updates: 0 }
  return holder.__fixtureCounterStore
}
