/**
 * Shared harness for spikes and end-to-end tests.
 *
 *   import { startFixture, startProxy, launchBrowser, newPage, editFile, replaceOnce,
 *            waitFor, createReport, expect, runCleanups, MARKER_HOOK_ENTRY } from './lib/index.ts'
 *
 * Playwright tests import the same things from `e2e/lib/index.ts`.
 *
 * A complete spike looks like this:
 *
 *   const report = createReport('S9 example')
 *   try {
 *     const fixture = await startFixture('vite-react-19')
 *     const proxy = await startProxy(fixture, { headScripts: [{ name: 'hook.js', entry: MARKER_HOOK_ENTRY }] })
 *     const browser = await launchBrowser()
 *     const { page, record } = await newPage(browser)
 *     report.section('vite-react-19')
 *     await report.attempt('title updates without a reload', async () => {
 *       await page.goto(proxy.url + '/')
 *       editFile(fixture, 'src/components/Hero.tsx', replaceOnce('Ship the layout', 'Ship THE layout'))
 *       await waitFor(async () => (await page.textContent('[data-label="hero-title"]'))?.includes('THE'))
 *       expect(record.navigations.length === 1, `page navigated ${record.navigations.length} times`)
 *       return 'updated in place'
 *     })
 *   } catch (error) {
 *     report.check('spike ran to completion', false, String(error))
 *   } finally {
 *     await runCleanups()   // closes browser and proxy, kills dev servers, removes working copies
 *     report.finish()       // prints the table, sets process.exitCode (0 only if every check passed)
 *   }
 *
 * FIXTURES (fixture.ts)
 *
 *   startFixture(name, options?) -> FixtureHandle { name, dir, sourceDir, port, url, pid, labels,
 *                                                   startupMs, output(), outputSince(n), stop() }
 *     Copies `fixtures/<name>` to `<repo>/.tmp/<run-id>/<name>/` without node_modules, .next,
 *     .svelte-kit or .vite, symlinks node_modules to the checked-in install, starts the fixture's
 *     own `dev` script on a free port in its own process group, and resolves once `GET /` is 200.
 *     `url` is `http://localhost:<port>`: always use the name localhost, the dev servers listen
 *     on ::1 only and 127.0.0.1 is refused.
 *     `stop()` kills the whole process group and deletes the working copy. It also runs on
 *     SIGINT/SIGTERM and from `runCleanups()`; a synchronous last resort runs at process exit.
 *     Options: `runId`, `copyName` (two copies of one fixture), `port`, `env`, `readyPath`,
 *     `readyTimeoutMs`, `echo` (show server output), `inPlace` (run the checked-in directory;
 *     edits are then restored on stop, SIGINT and exit).
 *     Names: 'vite-react-19' | 'next-16-turbopack' | 'sveltekit-svelte-5' | 'static-html' | 'cls-corpus'.
 *     Working copies must stay under the repo's `.tmp/`: Turbopack only accepts a symlinked
 *     node_modules when copy and install share its root (see the comment in fixture.ts).
 *     Start-up measured on this machine: Vite 0.5 s, SvelteKit 1 s, static 0.1 s, Next 2-4 s plus
 *     1-3 s to compile each page on first request.
 *
 *   editFile(handle, relPath, transform) -> FileEdit { file, before, after, writtenAt, revert() }
 *     Rewrites a file of the working copy. Throws if `transform` returns the text unchanged.
 *   replaceOnce(search, replacement)   a transform that requires exactly one occurrence
 *   readFixtureFile(handle, relPath)
 *   labelsOnPage(handle, page)         labels.json entries a signed-out GET of `page` renders
 *   REPO_ROOT, FIXTURES_ROOT, TMP_ROOT, defaultRunId()
 *
 * PROXY (proxy.ts)
 *
 *   startProxy(fixtureOrPort, options?) -> ProxyHandle { port, url, frames, logs, frameSummary(from?),
 *                                                        waitForFrame(match, opts?), server, close() }
 *     Runs `createProxy` from packages/server in front of `http://localhost:<port>`.
 *     `options.headScripts`: [{ name: 'hook.js', entry: '/abs/path/hook.ts' }] bundles each entry
 *     with esbuild (IIFE) and injects them, in order, as the first elements of <head>;
 *     `{ name, code }` takes a ready string instead. Also: `assets`, `cspMode`, `onWebSocket`
 *     (the overlay socket under /__reglet/), `maxFrameText`, `proxy` (raw createProxy overrides).
 *     `frames` holds every WebSocket message of every tunnelled upgrade (the HMR socket):
 *     { t, direction, tunnelId, path, opcode, kind, bytes, text?, isJson?, jsonType?, jsonEvent? }.
 *     `frames.length` taken before an action is a mark for `frameSummary(mark)` and
 *     `waitForFrame(match, { from: mark })`.
 *
 *   bundleBrowser(entryFile, { minify?, define? }) -> Promise<string>   one IIFE script
 *   MARKER_HOOK_ENTRY   a ready head script that sets `window.__reglet_hook` (hooks/marker-hook.ts)
 *
 * BROWSER (browser.ts)
 *
 *   launchBrowser({ headless? }) -> Browser            headless Chromium
 *   newPage(browser, { viewport?, context? }) -> { context, page, record, close() }
 *     A fresh context per call. `record` collects from before the first navigation:
 *     console, consoleErrors(), pageErrors, cspViolations, responses, failedRequests,
 *     webSockets (URLs), documentRequests (one URL per real main-frame load, reload or redirect
 *     hop: this is how a check proves "no full reload"), loads, navigations (also counts
 *     history.replaceState, so not a load counter).
 *     Cookies are shared across ports of localhost inside one context: use separate
 *     `newPage()` calls for the dev server and for the proxy when cookies matter.
 *     Under a CSP, pass functions (not strings) to page.evaluate / page.waitForFunction.
 *   labelsInDom(page) -> string[]
 *
 * HTTP (http.ts)
 *
 *   rawRequest(url, { method?, headers?, body? }) -> RawResponse { status, headers, rawHeaders, body,
 *       text, chunks, headersMs, firstByteMs, endMs, arrivalOf(needle) }
 *     No redirects followed, no decompression, one connection per request, arrival time per chunk.
 *   rawNavigate(url, options?)   the same with Chromium's navigation headers (so the proxy injects)
 *   NAVIGATION_HEADERS, median(values), percentile(values, p)
 *
 * WAITING (wait.ts)
 *
 *   waitFor(probe, { timeoutMs?, intervalMs?, what? })   polls until `probe` returns a value that is
 *     not undefined/null/false; a throwing probe counts as "not yet"; rejects with WaitTimeoutError.
 *   since(start)   ms since a performance.now() value
 *   sleep(ms)
 *
 * REPORTING (report.ts)
 *
 *   createReport(title) -> { section(title), check(name, pass, evidence), attempt(name, async () => evidence),
 *                            skip(name, reason, { optional? }), notApplicable(name, reason), info(line),
 *                            ok(), finish(), entries }
 *     `finish()` prints the table and sets process.exitCode: 0 only when at least one check passed
 *     and none failed. A skipped check counts as a failure unless the spike passes
 *     `{ optional: true }` with a reason. `notApplicable` is for a criterion a fixture does not
 *     have (it is listed, not counted).
 *   expect(condition, message)   throws inside `attempt`
 *
 * PROCESSES (proc.ts)
 *
 *   runCleanups()               stop everything the harness started, newest first; call it in `finally`
 *   onCleanup(fn), onExitSync(fn), spawnGroup(command, { cwd, env }), killGroup(pgid), groupAlive(pgid)
 *
 * RULES OF THUMB (each one cost a failed run while S1 was written)
 *
 *   - Never call process.exit() while servers are running; set process.exitCode (report.finish()
 *     does) and let `runCleanups()` finish. SIGINT/SIGTERM are handled by the harness.
 *   - Do not launch Chromium yourself with Playwright's default signal handlers: they call
 *     process.exit(130) and skip the cleanup. Use `launchBrowser()`.
 *   - Before editing a file, wait until the page's HMR socket is open (`record.webSockets`,
 *     `proxy.frames`), or the update can be missed.
 *   - `page.route()` + `route.fulfill()` makes Chromium treat the document as non-local and block
 *     its WebSockets to localhost (ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS). Do not use it on
 *     documents whose HMR you need.
 *   - `record.navigations` grows on history.replaceState; count `record.documentRequests`.
 *   - Under Next's 'strict-dynamic' policy a script element created with createElement runs
 *     without a nonce (with or without the proxy). Parser-inserted scripts, inline handlers and
 *     javascript: URLs are what the policy blocks.
 */

import { fileURLToPath } from 'node:url'

export * from './browser.ts'
export * from './fixture.ts'
export * from './http.ts'
export * from './proc.ts'
export * from './proxy.ts'
export * from './report.ts'
export * from './wait.ts'
export type { RegletHookMarker } from './hooks/marker-hook.ts'

/** Absolute path of the marker head script, for `startProxy({ headScripts: [{ name, entry }] })`. */
export const MARKER_HOOK_ENTRY = fileURLToPath(new URL('./hooks/marker-hook.ts', import.meta.url))
