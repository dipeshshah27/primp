/**
 * The website (site/): built, served as plain files, and checked in headless Chromium.
 *
 *   1. Build: `site/build.ts` runs and writes site/dist.
 *   2. Every page: loads with no console error, no failed request, no request to any other
 *      origin; every image has width, height and alt text; one <main> and one <h1>; no
 *      horizontal scroll at 360 px.
 *   3. Links: every internal link of every page resolves (crawled from `/`), and every `#id`
 *      it points to exists on the target page.
 *   4. CLS: the landing page and every docs page, loaded and scrolled to the bottom and back,
 *      record a layout-shift score of 0 (PerformanceObserver, buffered, over a few seconds).
 *   5. Live demo: a first visit installs the delay worker and reloads once (the requests of that
 *      first, stopped load are aborted: they are listed, and nothing else may fail; a second visit
 *      must have no failed request at all); the real dock mounts;
 *      selecting an element resolves its source line; a setStyle is recorded; Send returns the
 *      prompt with the change; the Shifts tab names the hero image as the culprit, cause
 *      unsized-media, with its line in index.html.
 *
 * Screenshots of the landing page (light, dark, 390 px), a docs page and the demo go to
 * .tmp/site-shots/ for a person to look at.
 *
 *   pnpm spike:site
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Browser, Page } from '@playwright/test'
import type { PrimpTestHandle } from '../packages/overlay/src/test-handle.ts'
import { startStaticServer } from '../site/serve.ts'
import { createReport, expect, launchBrowser, newPage, onCleanup, REPO_ROOT, runCleanups, sleep, TMP_ROOT, waitFor } from './lib/index.ts'

const report = createReport('Website: build, pages, links, CLS, live demo')
const SITE = join(REPO_ROOT, 'site')
const DIST = join(SITE, 'dist')
const SHOTS = join(TMP_ROOT, 'site-shots')
const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href

interface PageFacts {
  links: string[]
  ids: string[]
  imagesWithoutSize: string[]
  imagesWithoutAlt: string[]
  /** `<main>` elements and `<h1>` elements on the page. */
  landmarks: { main: number; h1: number }
  overflowAt360?: number
}

/** tsx keeps function names, which page.evaluate then references (see AGENTS.md). */
async function freshPage(browser: Browser, options: Parameters<typeof newPage>[1] = {}): Promise<Awaited<ReturnType<typeof newPage>> & { external: string[] }> {
  const handle = await newPage(browser, options)
  await handle.context.addInitScript(() => {
    ;(globalThis as unknown as { __name: (fn: unknown) => unknown }).__name = (fn) => fn
  })
  const external: string[] = []
  handle.page.on('request', (request) => {
    const url = request.url()
    if (!url.startsWith('http://localhost:') && !url.startsWith('data:') && !url.startsWith('blob:')) external.push(url)
  })
  return { ...handle, external }
}

async function factsOf(page: Page): Promise<PageFacts> {
  return page.evaluate(() => ({
    links: [...document.querySelectorAll('a[href]')].map((a) => (a as HTMLAnchorElement).href),
    ids: [...document.querySelectorAll('[id]')].map((element) => element.id),
    imagesWithoutSize: [...document.querySelectorAll('img')].filter((img) => !img.hasAttribute('width') || !img.hasAttribute('height')).map((img) => img.getAttribute('src') ?? '?'),
    imagesWithoutAlt: [...document.querySelectorAll('img')].filter((img) => (img.getAttribute('alt') ?? '').trim() === '').map((img) => img.getAttribute('src') ?? '?'),
    landmarks: { main: document.querySelectorAll('main').length, h1: document.querySelectorAll('h1').length },
  }))
}

try {
  mkdirSync(SHOTS, { recursive: true })

  report.section('1. Build')
  const built = await report.attempt('site/build.ts builds site/dist', async () => {
    const run = spawnSync(process.execPath, ['--import', TSX, join(SITE, 'build.ts')], { cwd: REPO_ROOT, encoding: 'utf8' })
    expect(run.status === 0, `exit ${run.status}: ${run.stderr.slice(-800)}`)
    return run.stdout.trim().split('\n')[0] ?? ''
  })
  if (!built) throw new Error('nothing to check without a build')

  const server = await startStaticServer(DIST)
  onCleanup(() => server.close())
  const origin = server.url
  const browser = await launchBrowser()

  report.section('2. Pages and 3. links')
  // Crawl from the landing page; the demo is checked on its own below.
  const queue = ['/']
  const seen = new Map<string, PageFacts>()
  const problems: string[] = []
  const linkTargets = new Set<string>()
  const { page, record, external } = await freshPage(browser)
  while (queue.length > 0) {
    const path = queue.shift() as string
    if (seen.has(path)) continue
    const before = { console: record.consoleErrors().length, failed: record.failedRequests.length, responses: record.responses.length, errors: record.pageErrors.length }
    const response = await page.goto(origin + path, { waitUntil: 'load' })
    await sleep(150)
    if (response === null || response.status() !== 200) problems.push(`${path}: status ${response?.status()}`)
    const facts = await factsOf(page)
    seen.set(path, facts)
    for (const entry of record.consoleErrors().slice(before.console)) problems.push(`${path}: console error ${entry.text}`)
    for (const entry of record.pageErrors.slice(before.errors)) problems.push(`${path}: page error ${entry}`)
    for (const entry of record.failedRequests.slice(before.failed)) problems.push(`${path}: failed ${entry.url} ${entry.failure}`)
    for (const entry of record.responses.slice(before.responses)) if (entry.status >= 400) problems.push(`${path}: ${entry.status} ${entry.url}`)
    if (facts.imagesWithoutSize.length > 0) problems.push(`${path}: images without width/height: ${facts.imagesWithoutSize.join(', ')}`)
    if (facts.imagesWithoutAlt.length > 0) problems.push(`${path}: images without alt text: ${facts.imagesWithoutAlt.join(', ')}`)
    if (facts.landmarks.main !== 1 || facts.landmarks.h1 !== 1) problems.push(`${path}: ${facts.landmarks.main} <main>, ${facts.landmarks.h1} <h1>`)
    for (const link of facts.links) {
      const url = new URL(link)
      if (url.origin !== origin) continue
      linkTargets.add(link)
      const target = url.pathname
      if (target.startsWith('/demo/')) continue
      if (!seen.has(target) && !queue.includes(target)) queue.push(target)
    }
  }
  const expected = ['/', '/docs/', ...['dock', 'layout-shifts', 'agents', 'mcp-tools', 'verification', 'limits', 'faq'].map((name) => `/docs/${name}.html`)]
  const missing = expected.filter((path) => !seen.has(path))
  if (missing.length > 0) problems.push(`not reached by the crawl: ${missing.join(', ')}`)
  report.check(
    'every page loads with no console error and no failed request; images sized and described; one <main> and one <h1>',
    problems.length === 0,
    problems.length === 0 ? `${seen.size} pages: ${[...seen.keys()].join(' ')}` : problems.slice(0, 12).join('\n'),
  )

  // Not linked from anywhere, but served by any static host for unknown paths.
  const notFound = await page.goto(`${origin}/no/such/page`)
  report.check('an unknown path gets the 404 page', notFound?.status() === 404 && (await page.title()).includes('Page not found'), `status ${notFound?.status()}, title "${await page.title()}"`)

  const broken: string[] = []
  for (const link of linkTargets) {
    const url = new URL(link)
    const answer = await fetch(url.origin + url.pathname, { redirect: 'follow' })
    if (answer.status !== 200) {
      broken.push(`${link}: ${answer.status}`)
      continue
    }
    if (url.hash !== '' && url.hash !== '#') {
      const id = decodeURIComponent(url.hash.slice(1))
      const html = await answer.text()
      if (!html.includes(`id="${id}"`)) broken.push(`${link}: no element with id "${id}"`)
    }
  }
  report.check('every internal link resolves, anchors included', broken.length === 0, broken.length === 0 ? `${linkTargets.size} distinct internal links` : broken.join('\n'))

  const narrow = await freshPage(browser, { viewport: { width: 360, height: 740 } })
  const overflow: string[] = []
  for (const path of seen.keys()) {
    await narrow.page.goto(origin + path)
    const width = await narrow.page.evaluate(() => document.documentElement.scrollWidth)
    if (width > 360) overflow.push(`${path}: ${width}px`)
  }
  report.check('no horizontal scroll at 360 px', overflow.length === 0, overflow.length === 0 ? `${seen.size} pages fit` : overflow.join(', '))

  report.section('4. Layout shift of the site itself')
  const clsPages = [...seen.keys()].filter((path) => path === '/' || path.startsWith('/docs/'))
  const clsResults: string[] = []
  let clsTotal = 0
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const probe = await freshPage(browser, { viewport })
    await probe.context.addInitScript(() => {
      const state = { value: 0, entries: 0 }
      ;(window as unknown as { __cls: typeof state }).__cls = state
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) {
          if (entry.hadRecentInput) continue
          state.value += entry.value
          state.entries += 1
        }
      }).observe({ type: 'layout-shift', buffered: true })
    })
    for (const path of clsPages) {
      await probe.page.goto(origin + path, { waitUntil: 'load' })
      await sleep(1200)
      // Scroll through the page so lazy images load, then back.
      await probe.page.evaluate(async () => {
        for (let y = 0; y < document.documentElement.scrollHeight; y += 400) {
          scrollTo(0, y)
          await new Promise((resolve) => setTimeout(resolve, 60))
        }
        scrollTo(0, 0)
      })
      await sleep(1500)
      const cls = await probe.page.evaluate(() => (window as unknown as { __cls: { value: number; entries: number } }).__cls)
      clsTotal += cls.value
      if (cls.value > 0) clsResults.push(`${path} at ${viewport.width}px: ${cls.value.toFixed(4)} in ${cls.entries} entries`)
    }
    for (const url of probe.external) external.push(url)
    await probe.close()
  }
  report.check('CLS is 0 on the landing page and every docs page, at 1280 and 390 px', clsTotal === 0, clsTotal === 0 ? `${clsPages.length} pages x 2 widths, each about 3 s with a scroll to the bottom: 0 layout-shift entries` : clsResults.join('\n'))

  report.section('5. Live demo')
  const demo = await freshPage(browser, { viewport: { width: 1280, height: 800 } })
  const dock = <M extends keyof PrimpTestHandle>(method: M, ...args: Parameters<PrimpTestHandle[M]>): Promise<Awaited<ReturnType<PrimpTestHandle[M]>>> =>
    demo.page.evaluate(([name, values]) => (window as unknown as { __primp_test: Record<string, (...a: unknown[]) => unknown> }).__primp_test[name as string]?.(...(values as unknown[])), [method, args] as const) as Promise<
      Awaited<ReturnType<PrimpTestHandle[M]>>
    >
  let firstVisitFailures = 0
  const mounted = await report.attempt('a first visit installs the delay worker, reloads once, and the real dock mounts with the stand-in session', async () => {
    await demo.page.goto(`${origin}/demo/`)
    await waitFor(() => demo.page.evaluate(() => navigator.serviceWorker.controller !== null && (window as unknown as { __primp_test?: unknown }).__primp_test !== undefined), { what: 'the controlled demo page with the dock', timeoutMs: 20_000 })
    await dock('ready')
    const state = await dock('state')
    expect(state.mounted && state.connected && state.ready, `dock state: ${JSON.stringify(state)}`)
    const loads = demo.record.documentRequests.filter((url) => url.includes('/demo/')).length
    const banner = await demo.page.isVisible('#pd-banner')
    expect(banner, 'the banner is not visible')
    firstVisitFailures = demo.record.failedRequests.length
    const aborted = demo.record.failedRequests.filter((entry) => entry.failure === 'net::ERR_ABORTED' && new URL(entry.url).pathname.startsWith('/demo/'))
    expect(aborted.length === firstVisitFailures, `failures other than the first load's aborted requests: ${JSON.stringify(demo.record.failedRequests)}`)
    return `mounted and connected after ${loads} document loads of /demo/; banner shown; the stopped first load aborted ${aborted.length} request(s): ${aborted.map((entry) => new URL(entry.url).pathname).join(', ')}`
  })
  if (mounted) {
    await report.attempt('selecting the primary button resolves its source in the browser: index.html, exact', async () => {
      const ref = await dock('select', '.btn-primary')
      await waitFor(async () => (await dock('state')).source?.state === 'done', { what: 'the source lookup', timeoutMs: 5000 })
      const source = (await dock('state')).source
      const line = readFileSync(join(REPO_ROOT, 'packages/cli/demo-site/index.html'), 'utf8').split('\n').findIndex((text) => text.includes('btn-primary" href="#subscribe">Start')) + 1
      expect(source?.file === 'index.html' && source.line === line && source.level === 'exact', `source ${JSON.stringify(source)}, the tag is on line ${line}`)
      return `${ref.label} -> ${source?.file}:${source?.line} (${source?.level})`
    })
    let itemId = ''
    await report.attempt('setStyle padding 14px 26px on it is recorded, with side effects and the bystander', async () => {
      const edit = await dock('setStyle', 'padding', '14px 26px', { media: null, scope: 'all-instances' })
      expect(edit.ok && edit.item !== null, `not recorded: ${edit.error}`)
      itemId = edit.item?.id ?? ''
      const item = edit.item
      const bystanders = item?.kind === 'style' ? (item.bystanders ?? []).map((entry) => entry.label) : []
      const shown = await demo.page.evaluate(() => getComputedStyle(document.querySelector('.btn-primary') as Element).paddingTop)
      expect(shown === '14px', `the page shows padding-top ${shown}`)
      return `item ${itemId}; "${await dock('summary', itemId)}"; bystanders ${bystanders.join(', ') || 'none'}`
    })
    await report.attempt('Send returns the prompt, rendered by the real engine, with the change in it; the banner shows it', async () => {
      const prompt = await dock('send')
      expect(prompt.includes('`padding`: `10px 18px` -> `14px 26px`') && prompt.includes('index.html:24'), `prompt:\n${prompt.slice(0, 600)}`)
      await waitFor(() => demo.page.isVisible('#pd-prompt'), { what: 'the prompt in the banner', timeoutMs: 3000 })
      const inBanner = await demo.page.textContent('#pd-prompt-text')
      expect(inBanner === prompt, 'the banner shows another text')
      return `${prompt.length} characters: ${prompt.split('\n')[0]}`
    })
    await report.attempt('the Shifts tab shows the seeded shift: culprit the hero image, cause unsized-media, its line in index.html', async () => {
      // A fresh load for the shift: the earlier edits are previews in this one.
      await demo.page.reload()
      await waitFor(() => demo.page.evaluate(() => (window as unknown as { __primp_test?: unknown }).__primp_test !== undefined), { what: 'the dock after the reload', timeoutMs: 15_000 })
      await dock('ready')
      const shifts = await dock('shiftReport')
      const issue = shifts.report.issues.find((candidate) => candidate.scored)
      expect(issue !== undefined, `no scored shift: ${shifts.report.status}, ${shifts.report.issues.length} issues, notes ${shifts.report.notes.join('; ')}`)
      const source = shifts.culpritSources[issue.id]
      const line = readFileSync(join(REPO_ROOT, 'packages/cli/demo-site/index.html'), 'utf8').split('\n').findIndex((text) => text.includes('<img id="hero-art"')) + 1
      expect(issue.culprit?.node.selector === '#hero-art' && issue.cause === 'unsized-media', `culprit ${issue.culprit?.node.selector}, cause ${issue.cause}`)
      expect(source?.file === 'index.html' && source.line === line, `source ${source?.file}:${source?.line}, the tag is on line ${line}`)
      dock('openTab', 'shifts')
      await sleep(500)
      const text = await demo.page.evaluate(() => document.querySelector('primp-root')?.shadowRoot?.querySelector('iframe')?.contentDocument?.body.innerText ?? '')
      expect(text.includes('img#hero-art') && text.includes('unsized media') && text.includes(`index.html:${line}`), `the Shifts tab reads:\n${text.slice(0, 400)}`)
      return `${issue.cause} ${issue.value.toFixed(3)} by ${issue.culprit?.node.selector} at ${source?.file}:${source?.line} (${source?.level}), ${Math.round(issue.confidence * 100)}% confident; shown in the Shifts tab`
    })
    const demoProblems = [
      ...demo.record.consoleErrors().map((entry) => `console error: ${entry.text}`),
      ...demo.record.pageErrors.map((entry) => `page error: ${entry}`),
      ...demo.record.failedRequests.slice(firstVisitFailures).map((entry) => `failed: ${entry.url} ${entry.failure}`),
      ...demo.record.responses.filter((entry) => entry.status >= 400).map((entry) => `${entry.status} ${entry.url}`),
    ]
    report.check('after the first-visit reload: no console error and no failed request in the demo', demoProblems.length === 0, demoProblems.length === 0 ? `${demo.record.responses.length} responses, all below 400` : demoProblems.join('\n'))
    await report.attempt('a second visit (worker installed) loads with no failed request at all and the shift in place', async () => {
      const again = await demo.context.newPage()
      const failed: string[] = []
      const errors: string[] = []
      again.on('requestfailed', (request) => failed.push(`${request.url()} ${request.failure()?.errorText}`))
      again.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text())
      })
      await again.goto(`${origin}/demo/`)
      await waitFor(() => again.evaluate(() => (window as unknown as { __primp_test?: unknown }).__primp_test !== undefined), { what: 'the dock', timeoutMs: 15_000 })
      const shifts = await again.evaluate(() => (window as unknown as { __primp_test: PrimpTestHandle }).__primp_test.shiftReport())
      await again.close()
      expect(failed.length === 0 && errors.length === 0, `failed: ${failed.join(', ')}; console errors: ${errors.join(', ')}`)
      const scored = shifts.report.issues.filter((issue) => issue.scored)
      expect(scored.length === 1 && scored[0]?.culprit?.node.selector === '#hero-art', `shifts: ${JSON.stringify(scored.map((issue) => issue.culprit?.node.selector))}`)
      return 'no failed request, no console error; one scored shift by #hero-art'
    })
    await demo.page.screenshot({ path: join(SHOTS, 'demo-1280.png') })
    for (const url of demo.external) external.push(url)
  }

  report.section('No external requests')
  report.check('no page requested anything from another origin', external.length === 0, external.length === 0 ? 'every request went to the local static server' : [...new Set(external)].slice(0, 10).join('\n'))

  report.section('Screenshots for a person to look at')
  await report.attempt(`landing light, dark and 390 px, a docs page and the demo, in ${SHOTS.replace(REPO_ROOT + '/', '')}`, async () => {
    const shots: string[] = []
    for (const [name, options, path] of [
      ['landing-light', { viewport: { width: 1280, height: 800 }, context: { colorScheme: 'light' } }, '/'],
      ['landing-dark', { viewport: { width: 1280, height: 800 }, context: { colorScheme: 'dark' } }, '/'],
      ['landing-390', { viewport: { width: 390, height: 844 }, context: { colorScheme: 'light' } }, '/'],
      ['docs-dock-light', { viewport: { width: 1280, height: 800 }, context: { colorScheme: 'light' } }, '/docs/dock.html'],
      ['docs-dock-390-dark', { viewport: { width: 390, height: 844 }, context: { colorScheme: 'dark' } }, '/docs/dock.html'],
      ['demo-390', { viewport: { width: 390, height: 844 }, context: { colorScheme: 'light' } }, '/demo/'],
    ] as const) {
      const shot = await freshPage(browser, options as Parameters<typeof newPage>[1])
      await shot.page.goto(origin + path)
      if (path === '/demo/') await waitFor(() => shot.page.evaluate(() => (window as unknown as { __primp_test?: unknown }).__primp_test !== undefined), { what: 'the dock', timeoutMs: 20_000 })
      await shot.page.evaluate(async () => {
        for (let y = 0; y < document.documentElement.scrollHeight; y += 500) {
          scrollTo(0, y)
          await new Promise((resolve) => setTimeout(resolve, 40))
        }
        scrollTo(0, 0)
      })
      await sleep(800)
      await shot.page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: path !== '/demo/' })
      shots.push(name)
      await shot.close()
    }
    return `${shots.length + 1} PNGs: ${shots.join(', ')}, demo-1280`
  })
} catch (error) {
  report.check('spike ran to completion', false, error instanceof Error ? (error.stack ?? error.message) : String(error))
} finally {
  await runCleanups()
  report.finish()
}
