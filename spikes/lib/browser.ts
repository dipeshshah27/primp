import { chromium } from '@playwright/test'
import type { Browser, BrowserContext, BrowserContextOptions, Page } from '@playwright/test'
import { onCleanup } from './proc.ts'

/**
 * Headless Chromium through Playwright, with everything a check usually needs
 * recorded from the first byte of the first navigation: console output,
 * uncaught errors, Content-Security-Policy violations, responses, failed
 * requests, WebSocket URLs and main-frame navigations.
 *
 * Two rules for code that drives pages behind a CSP (the Next fixture):
 *   - pass FUNCTIONS to `page.evaluate` / `page.waitForFunction`, never
 *     strings: a string is run with eval(), which a policy without
 *     'unsafe-eval' blocks;
 *   - do not use `bypassCSP`: it would hide exactly the problems the checks
 *     are looking for.
 *
 * Cookies ignore ports, so `http://localhost:<dev>` and
 * `http://localhost:<proxy>` share one cookie jar inside a context. Use one
 * `newPage()` (one context) per origin when a check is about cookies.
 */

export interface ConsoleEntry {
  /** `error`, `warning`, `log`, ... */
  type: string
  text: string
  /** URL of the script that logged, when known. */
  url: string
}

export interface CspViolation {
  documentURI: string
  /** For example `script-src-elem`. */
  effectiveDirective: string
  /** URL, or `inline`, `eval`, ... */
  blockedURI: string
  sourceFile: string
  lineNumber: number
  /** `enforce` or `report`. */
  disposition: string
  sample: string
  /** Tag name of the event target as seen from the document (a shadow host for violations inside a shadow tree). */
  target: string
}

export interface ResponseEntry {
  url: string
  status: number
  method: string
  resourceType: string
}

export interface PageRecord {
  console: ConsoleEntry[]
  /** Uncaught exceptions and unhandled rejections. */
  pageErrors: string[]
  cspViolations: CspViolation[]
  responses: ResponseEntry[]
  failedRequests: { url: string; method: string; failure: string }[]
  /** URL of every WebSocket the page opened. */
  webSockets: string[]
  /**
   * URL of every main-frame navigation event. This INCLUDES same-document
   * navigations (history.replaceState, which Next and SvelteKit call while
   * hydrating), so it does not count page loads; use `documentRequests`.
   */
  navigations: string[]
  /** URL of every main-frame document request: one per real page load, reload or redirect hop. */
  documentRequests: string[]
  /** Number of `load` events of the page. */
  loads: number
  /** Console entries of type `error`. */
  consoleErrors(): ConsoleEntry[]
}

export interface PageHandle {
  context: BrowserContext
  page: Page
  record: PageRecord
  close(): Promise<void>
}

export interface NewPageOptions {
  /** Default 1280 x 800. */
  viewport?: { width: number; height: number }
  context?: BrowserContextOptions
}

interface HarnessWindow {
  __harnessCsp?: (violation: CspViolation) => void
}

/** Starts headless Chromium. It is closed by `runCleanups()` if the caller does not close it. */
export async function launchBrowser(options: { headless?: boolean } = {}): Promise<Browser> {
  const browser = await chromium.launch({
    headless: options.headless ?? true,
    // Playwright's own signal handlers close the browser and then call process.exit(130) at
    // once, which would cut off the harness's cleanup (dev servers, working copies). The
    // harness closes the browser itself on a signal.
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  })
  const removeCleanup = onCleanup(() => browser.close())
  browser.once('disconnected', removeCleanup)
  return browser
}

/** A page in a fresh context (own cookies and cache), recording from before its first navigation. */
export async function newPage(browser: Browser, options: NewPageOptions = {}): Promise<PageHandle> {
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1280, height: 800 },
    ...options.context,
  })
  const record: PageRecord = {
    console: [],
    pageErrors: [],
    cspViolations: [],
    responses: [],
    failedRequests: [],
    webSockets: [],
    navigations: [],
    documentRequests: [],
    loads: 0,
    consoleErrors() {
      return this.console.filter((entry) => entry.type === 'error')
    },
  }

  // A CDP binding plus an init script: neither is a page script, so the page's CSP does not
  // apply to them and they do not show up in `document.scripts`.
  await context.exposeBinding('__harnessCsp', (_source, violation: CspViolation) => {
    record.cspViolations.push(violation)
  })
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      const target = event.target instanceof Element ? event.target.tagName.toLowerCase() : 'document'
      ;(window as unknown as HarnessWindow).__harnessCsp?.({
        documentURI: event.documentURI,
        effectiveDirective: event.effectiveDirective,
        blockedURI: event.blockedURI,
        sourceFile: event.sourceFile,
        lineNumber: event.lineNumber,
        disposition: event.disposition,
        sample: event.sample,
        target,
      })
    })
  })

  const page = await context.newPage()
  page.on('console', (message) => {
    record.console.push({ type: message.type(), text: message.text(), url: message.location().url })
  })
  page.on('pageerror', (error) => record.pageErrors.push(error.stack ?? error.message))
  page.on('response', (response) => {
    const request = response.request()
    record.responses.push({
      url: response.url(),
      status: response.status(),
      method: request.method(),
      resourceType: request.resourceType(),
    })
  })
  page.on('requestfailed', (request) => {
    record.failedRequests.push({
      url: request.url(),
      method: request.method(),
      failure: request.failure()?.errorText ?? 'unknown',
    })
  })
  page.on('websocket', (socket) => record.webSockets.push(socket.url()))
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) record.documentRequests.push(request.url())
  })
  page.on('load', () => {
    record.loads += 1
  })
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) record.navigations.push(frame.url())
  })

  let closing: Promise<void> | undefined
  return {
    context,
    page,
    record,
    close() {
      closing ??= context.close().catch(() => {})
      return closing
    },
  }
}

/** `data-label` values currently in the document, each once. */
export function labelsInDom(page: Page): Promise<string[]> {
  return page.evaluate(() => [
    ...new Set([...document.querySelectorAll('[data-label]')].map((element) => element.getAttribute('data-label') ?? '')),
  ])
}
