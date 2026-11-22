/**
 * The website's one server-side behaviour, done in a service worker: `?delay=<ms>` holds a
 * response back (capped at 5000 ms), as the demo server of `npx @primpdev/cli demo` does. That is what
 * makes the replay's hero screenshot arrive after the first paint, which is the layout shift.
 * Every other request is left to the browser untouched. Installed only by the layout-shift replay
 * (tools/standin/head.ts and components/live-dock.tsx), served from the site root as /primp-sw.js.
 */

/// <reference lib="webworker" />
const worker = self as unknown as ServiceWorkerGlobalScope

worker.addEventListener('install', () => {
  void worker.skipWaiting()
})

worker.addEventListener('activate', (event) => {
  event.waitUntil(worker.clients.claim())
})

worker.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.origin !== worker.location.origin || event.request.method !== 'GET') return
  const delay = Math.min(Math.max(Number(url.searchParams.get('delay') ?? 0) || 0, 0), 5000)
  if (delay === 0) return
  event.respondWith(new Promise<void>((resolve) => setTimeout(resolve, delay)).then(() => fetch(event.request)))
})
