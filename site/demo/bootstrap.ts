/**
 * Inlined as the first script of the demo page (build-demo.ts). It runs before anything else is
 * requested, and on a first visit only:
 *
 * The seeded layout shift needs the picture to arrive after the first paint. `npx primp demo`
 * gets that from its server (`?delay=700`); here the service worker sw.ts does it, and a page
 * is controlled by a service worker only from its next load on. So when no worker controls
 * this page yet, this script stops the page before the parser asks for anything (the picture
 * must not land in the memory cache, or the next load would show it at once), installs the
 * worker, and reloads once. If the worker cannot be installed (blocked, private mode, an old
 * browser), it remembers that for the session and reloads without it; the banner then says the
 * shift may not happen.
 */

const NO_SW_KEY = 'primp-demo-no-sw'

function storage(): Storage | undefined {
  try {
    return window.sessionStorage
  } catch {
    return undefined
  }
}

const canUse = 'serviceWorker' in navigator && window.isSecureContext && storage()?.getItem(NO_SW_KEY) !== '1'

if (canUse && navigator.serviceWorker.controller === null) {
  // Keeps primp's head script and the stand-in from starting on this load.
  ;(window as { __primp_demo_reloading?: boolean }).__primp_demo_reloading = true
  window.stop()
  const giveUp = (): void => {
    storage()?.setItem(NO_SW_KEY, '1')
    location.reload()
  }
  const timer = setTimeout(giveUp, 4000)
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    clearTimeout(timer)
    location.reload()
  })
  navigator.serviceWorker.register(new URL('sw.js', location.href), { scope: './' }).catch(() => {
    clearTimeout(timer)
    giveUp()
  })
}
