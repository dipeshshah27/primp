/**
 * The demo page's banner (markup in build-demo.ts): "What to try", hide and show again, and the
 * prompt of the last Send, which the stand-in session (fake-session.ts) publishes on
 * `window.__primp_demo`.
 */

import type { DemoEvents } from './fake-session.ts'

const HIDDEN_KEY = 'primp-demo-banner-hidden'

function remember(hidden: boolean): void {
  try {
    if (hidden) sessionStorage.setItem(HIDDEN_KEY, '1')
    else sessionStorage.removeItem(HIDDEN_KEY)
  } catch {
    // Storage blocked: the banner just comes back on the next load.
  }
}

function wasHidden(): boolean {
  try {
    return sessionStorage.getItem(HIDDEN_KEY) === '1'
  } catch {
    return false
  }
}

function wire(): void {
  const byId = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null
  const banner = byId('pd-banner')
  const pill = byId<HTMLButtonElement>('pd-pill')
  const toggle = byId<HTMLButtonElement>('pd-toggle')
  const more = byId('pd-more')
  const close = byId<HTMLButtonElement>('pd-close')
  const prompt = byId('pd-prompt')
  const promptText = byId('pd-prompt-text')
  const promptSize = byId('pd-prompt-size')
  const delay = byId('pd-delay')
  if (!banner || !pill || !toggle || !more || !close || !prompt || !promptText || !promptSize || !delay) return

  const show = (visible: boolean, focus: boolean): void => {
    banner.hidden = !visible
    pill.hidden = visible
    remember(!visible)
    if (focus) (visible ? close : pill).focus()
  }
  if (wasHidden()) show(false, false)

  toggle.addEventListener('click', () => {
    const open = more.hidden
    more.hidden = !open
    toggle.setAttribute('aria-expanded', String(open))
  })
  close.addEventListener('click', () => show(false, true))
  pill.addEventListener('click', () => show(true, true))

  const demo: DemoEvents | undefined = window.__primp_demo
  if (demo === undefined) return
  if (demo.delayProblem !== null) {
    delay.textContent = demo.delayProblem
    delay.hidden = false
  }
  const update = (): void => {
    if (demo.lastPrompt === null) return
    promptText.textContent = demo.lastPrompt
    promptSize.textContent = `(${demo.lastPrompt.length.toLocaleString('en')} characters)`
    prompt.hidden = false
    if (banner.hidden) show(true, false)
  }
  demo.listeners.add(update)
  update()
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire, { once: true })
else wire()
