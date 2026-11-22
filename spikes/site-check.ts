/**
 * The website (site/, a static Next.js export): built, served as plain files, and checked in
 * headless Chromium with primp's real dock running on every page.
 *
 *   1. Build: `pnpm site:assets` (the dock, the head script and the stand-in session into
 *      site/public/primp), then `pnpm build` in site/ (needs `pnpm install --ignore-workspace`
 *      there first). Every exported page has primp's head script as the first script in <head>.
 *   2. Every page (crawled from `/`): loads with no console error or warning, no page error, no
 *      hydration complaint, no failed request, no request to another origin; rendered images
 *      have alt text and width/height; one <main> and one <h1>. The ⌘K index lists every page.
 *   3. Links: every internal link resolves, and every `#id` it points to exists on the target.
 *      No horizontal scroll at 360 px.
 *   4. CLS: every page, loaded and scrolled through, at 1280 and 390 px, with the hook loaded,
 *      records a layout-shift score of 0 (PerformanceObserver), and the dock's own report of the
 *      landing page has no scored shift.
 *   5. The live dock: mounts closed; "Try it on this page" opens it; selecting landing-page
 *      elements resolves them to their .tsx file and line (ranked guesses, never "exact"); an
 *      edit is recorded; Send shows the prompt in the site's sheet; "Replay with a layout shift"
 *      reloads with ?shift=1 and the dock names the unsized hero screenshot, cause unsized-media,
 *      with its line in components/landing/hero.tsx.
 *
 * Screenshots go to .tmp/site-shots/ for a person to look at: the landing page dark and light at
 * 1440 and 390 px, a docs page, ⌘K open, the dock open on the site, the prompt sheet, the replay.
 *
 *   pnpm spike:site               build, then check
 *   pnpm spike:site --no-build    check site/out as it is
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { Browser, Page } from '@playwright/test'
import type { PrimpTestHandle } from '../packages/overlay/src/test-handle.ts'
import { startStaticServer } from '../site/serve.ts'
import { createReport, expect, launchBrowser, newPage, onCleanup, REPO_ROOT, runCleanups, sleep, TMP_ROOT, waitFor } from './lib/index.ts'

const report = createReport('Website: build, pages, links, CLS, the live dock')
const SITE = join(REPO_ROOT, 'site')
const OUT = join(SITE, 'out')
const SHOTS = join(TMP_ROOT, 'site-shots')
const DOCS = ['/docs/', ...['dock', 'layout-shifts', 'agents', 'mcp-tools', 'verification', 'limits', 'faq'].map((name) => `/docs/${name}/`)]
const HEAD_TAG = '<script src="/primp/head.js"></script>'

interface PageFacts {
  links: string[]
  ids: string[]
  /** Rendered images (with a box) that lack width or height attributes. */
  imagesWithoutSize: string[]
  imagesWithoutAlt: string[]
  /** Images in the page that are not rendered and have no size: allowed only for the layout-shift replay. */
  hiddenUnsized: string[]
  landmarks: { main: number; h1: number }
  hook: boolean
}

type Dock = <M extends keyof PrimpTestHandle>(method: M, ...args: Parameters<PrimpTestHandle[M]>) => Promise<Awaited<ReturnType<PrimpTestHandle[M]>>>

function dockOf(page: Page): Dock {
  return ((method: string, ...args: unknown[]) =>
    page.evaluate(([name, values]) => (window as unknown as { __primp_test: Record<string, (...a: unknown[]) => unknown> }).__primp_test[name as string]?.(...(values as unknown[])), [method, args] as const)) as Dock
}

/** A line of a site source file, 1-based: the first that contains `needle`. */
function lineOf(file: string, needle: string): number {
  const index = readFileSync(join(SITE, file), 'utf8').split('\n').findIndex((line) => line.includes(needle))
  if (index < 0) throw new Error(`${file} has no line with ${needle}`)
  return index + 1
}

function htmlFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? htmlFiles(path) : path.endsWith('.html') ? [path] : []
  })
}

/** Console lines that must not appear: every error, and any warning (hydration and React's own are warnings in places). */
const isProblem = (entry: { type: string; text: string }): boolean => entry.type === 'error' || entry.type === 'warning' || /hydrat|Minified React error #(418|419|421|422|423|425)/i.test(entry.text)

/** tsx keeps function names, which page.evaluate then references (see AGENTS.md). */
async function freshPage(browser: Browser, options: Parameters<typeof newPage>[1] & { theme?: 'dark' | 'light' } = {}): Promise<Awaited<ReturnType<typeof newPage>> & { external: string[] }> {
  const handle = await newPage(browser, options)
  await handle.context.addInitScript((theme) => {
    ;(globalThis as unknown as { __name: (fn: unknown) => unknown }).__name = (fn) => fn
    try {
      if (theme !== undefined) localStorage.setItem('theme', theme)
    } catch {
      // Storage blocked: the default theme.
    }
  }, options.theme)
  const external: string[] = []
  handle.page.on('request', (request) => {
    const url = request.url()
    if (!url.startsWith('http://localhost:') && !url.startsWith('data:') && !url.startsWith('blob:') && !url.startsWith('about:')) external.push(url)
  })
  return { ...handle, external }
}

async function factsOf(page: Page): Promise<PageFacts> {
  return page.evaluate(() => {
    const images = [...document.querySelectorAll('img')]
    const rendered = (img: HTMLImageElement): boolean => img.getClientRects().length > 0
    const unsized = (img: HTMLImageElement): boolean => !img.hasAttribute('width') || !img.hasAttribute('height')
    return {
      links: [...document.querySelectorAll('a[href]')].map((a) => (a as HTMLAnchorElement).href),
      ids: [...document.querySelectorAll('[id]')].map((element) => element.id),
      imagesWithoutSize: images.filter((img) => rendered(img) && unsized(img)).map((img) => img.getAttribute('src') ?? '?'),
      imagesWithoutAlt: images.filter((img) => (img.getAttribute('alt') ?? '').trim() === '').map((img) => img.getAttribute('src') ?? '?'),
      hiddenUnsized: images.filter((img) => !rendered(img) && unsized(img)).map((img) => img.className),
      landmarks: { main: document.querySelectorAll('main').length, h1: document.querySelectorAll('h1').length },
      hook: (window as unknown as { __primp?: unknown }).__primp !== undefined,
    }
  })
}

async function scrollThrough(page: Page): Promise<void> {
  await page.evaluate(async () => {
    for (let y = 0; y < document.documentElement.scrollHeight; y += 400) {
      scrollTo(0, y)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    scrollTo(0, 0)
  })
}

/** Text of every frame of the dock (toolbar and popover). */
async function dockText(page: Page): Promise<string> {
  return page.evaluate(() =>
    [...(document.querySelector('primp-root')?.shadowRoot?.querySelectorAll('iframe') ?? [])].map((frame) => frame.contentDocument?.body?.innerText ?? '').join('\n'),
  )
}

try {
  mkdirSync(SHOTS, { recursive: true })

  report.section('1. Build')
  if (process.argv.includes('--no-build')) {
    report.info('--no-build: checking site/out as it is')
  } else {
    await report.attempt('pnpm site:assets builds the dock, the head script and the stand-in into site/public', () => {
      const run = spawnSync('pnpm', ['site:assets'], { cwd: REPO_ROOT, encoding: 'utf8' })
      expect(run.status === 0, `exit ${run.status}: ${(run.stderr || run.stdout).slice(-800)}`)
      return run.stdout.trim().split('\n').filter((line) => line.startsWith('site/') || line.startsWith('(')).join('; ')
    })
    await report.attempt('the site builds (next build, static export, then the head-script post-processing)', () => {
      expect(existsSync(join(SITE, 'node_modules/next')), 'site/node_modules is missing: run `pnpm install --ignore-workspace` in site/')
      const run = spawnSync('pnpm', ['build'], { cwd: SITE, encoding: 'utf8' })
      expect(run.status === 0, `exit ${run.status}: ${(run.stderr + run.stdout).slice(-1500)}`)
      return run.stdout.trim().split('\n').at(-1) ?? ''
    })
  }
  expect(existsSync(join(OUT, 'index.html')), 'site/out has no index.html')
  const exported = htmlFiles(OUT)
  const notFirst = exported.filter((file) => {
    const html = readFileSync(file, 'utf8')
    const head = html.slice(0, html.indexOf('</head>'))
    return /<script\b[^>]*>/.exec(head)?.[0] !== '<script src="/primp/head.js">' || /<(link|style|script)\b/.test(head.slice(0, head.indexOf(HEAD_TAG)))
  })
  report.check(
    "primp's head script is the first script in <head> of every exported page, after only the charset and viewport metas",
    notFirst.length === 0,
    notFirst.length === 0 ? `${exported.length} HTML files` : notFirst.map((file) => relative(OUT, file)).join(', '),
  )

  const server = await startStaticServer(OUT)
  onCleanup(() => server.close())
  const origin = server.url
  const browser = await launchBrowser()
  const external: string[] = []

  report.section('2. Pages and 3. links')
  const queue = ['/']
  const seen = new Map<string, PageFacts>()
  const problems: string[] = []
  const linkTargets = new Set<string>()
  const crawler = await freshPage(browser)
  const { page, record } = crawler
  while (queue.length > 0) {
    const path = queue.shift() as string
    if (seen.has(path)) continue
    const before = { console: record.console.length, failed: record.failedRequests.length, responses: record.responses.length, errors: record.pageErrors.length }
    // A full load per page (not a client-side navigation): what a visitor arriving there gets.
    const response = await page.goto(origin + path, { waitUntil: 'load' })
    await waitFor(() => page.evaluate(() => (window as unknown as { __primp_test?: unknown }).__primp_test !== undefined), { what: `the dock on ${path}`, timeoutMs: 10_000 }).catch(() => undefined)
    await sleep(400)
    if (response === null || response.status() !== 200) problems.push(`${path}: status ${response?.status()}`)
    const facts = await factsOf(page)
    seen.set(path, facts)
    for (const entry of record.console.slice(before.console)) if (isProblem(entry)) problems.push(`${path}: console ${entry.type} ${entry.text.slice(0, 200)}`)
    for (const entry of record.pageErrors.slice(before.errors)) problems.push(`${path}: page error ${entry}`)
    for (const entry of record.failedRequests.slice(before.failed)) problems.push(`${path}: failed ${entry.url} ${entry.failure}`)
    for (const entry of record.responses.slice(before.responses)) if (entry.status >= 400) problems.push(`${path}: ${entry.status} ${entry.url}`)
    if (facts.imagesWithoutSize.length > 0) problems.push(`${path}: rendered images without width/height: ${facts.imagesWithoutSize.join(', ')}`)
    if (facts.imagesWithoutAlt.length > 0) problems.push(`${path}: images without alt text: ${facts.imagesWithoutAlt.join(', ')}`)
    const unexpectedHidden = facts.hiddenUnsized.filter((name) => !name.includes('shift-replay-only'))
    if (unexpectedHidden.length > 0) problems.push(`${path}: unsized images other than the replay's: ${unexpectedHidden.join(', ')}`)
    if (facts.landmarks.main !== 1 || facts.landmarks.h1 !== 1) problems.push(`${path}: ${facts.landmarks.main} <main>, ${facts.landmarks.h1} <h1>`)
    if (!facts.hook) problems.push(`${path}: primp's hook (window.__primp) is not there`)
    for (const link of facts.links) {
      const url = new URL(link)
      if (url.origin !== origin) continue
      linkTargets.add(link)
      if (!seen.has(url.pathname) && !queue.includes(url.pathname)) queue.push(url.pathname)
    }
  }
  external.push(...crawler.external)
  const missing = ['/', ...DOCS].filter((path) => !seen.has(path))
  if (missing.length > 0) problems.push(`not reached by the crawl: ${missing.join(', ')}`)
  report.check(
    'every page loads with no console error or warning, no hydration complaint, no failed request; the hook runs; rendered images sized and described; one <main> and one <h1>',
    problems.length === 0,
    problems.length === 0 ? `${seen.size} pages: ${[...seen.keys()].join(' ')}` : problems.slice(0, 14).join('\n'),
  )

  const notFound = await page.goto(`${origin}/no/such/page/`)
  report.check('an unknown path gets the 404 page', notFound?.status() === 404 && (await page.title()).includes('Page not found'), `status ${notFound?.status()}, title "${await page.title()}"`)

  await report.attempt('the ⌘K index (/search.json) lists every docs page and its sections', async () => {
    const entries = (await (await fetch(`${origin}/search.json`)).json()) as { href: string; heading: string }[]
    const pages = new Set(entries.filter((entry) => entry.heading === '').map((entry) => entry.href))
    const absent = DOCS.filter((path) => !pages.has(path))
    expect(absent.length === 0, `pages missing from the index: ${absent.join(', ')}`)
    const sections = entries.filter((entry) => entry.heading !== '')
    const dead = sections.filter((entry) => {
      const [path, id] = entry.href.split('#') as [string, string]
      return !(seen.get(path)?.ids.includes(id) ?? false)
    })
    expect(dead.length === 0, `sections whose anchor does not exist: ${dead.map((entry) => entry.href).join(', ')}`)
    return `${pages.size} pages, ${sections.length} sections, every anchor exists`
  })

  const broken: string[] = []
  for (const link of linkTargets) {
    const url = new URL(link)
    const target = seen.get(url.pathname)
    if (target === undefined) {
      const answer = await fetch(url.origin + url.pathname)
      if (answer.status !== 200) broken.push(`${link}: ${answer.status}`)
      continue
    }
    if (url.hash !== '' && url.hash !== '#' && !target.ids.includes(decodeURIComponent(url.hash.slice(1)))) broken.push(`${link}: no element with that id`)
  }
  report.check('every internal link resolves, anchors included', broken.length === 0, broken.length === 0 ? `${linkTargets.size} distinct internal links` : broken.join('\n'))

  const narrow = await freshPage(browser, { viewport: { width: 360, height: 740 } })
  const overflow: string[] = []
  for (const path of seen.keys()) {
    await narrow.page.goto(origin + path)
    await sleep(200)
    const width = await narrow.page.evaluate(() => document.documentElement.scrollWidth)
    if (width > 360) overflow.push(`${path}: ${width}px`)
  }
  external.push(...narrow.external)
  await narrow.close()
  report.check('no horizontal scroll at 360 px', overflow.length === 0, overflow.length === 0 ? `${seen.size} pages fit` : overflow.join(', '))

  report.section('4. Layout shift of the site itself')
  const clsResults: string[] = []
  let clsTotal = 0
  let measured = 0
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const probe = await freshPage(browser, { viewport })
    await probe.context.addInitScript(() => {
      const state = { value: 0, entries: 0, sources: [] as string[] }
      ;(window as unknown as { __cls: typeof state }).__cls = state
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean; sources?: { node?: Node }[] })[]) {
          if (entry.hadRecentInput) continue
          state.value += entry.value
          state.entries += 1
          for (const source of entry.sources ?? []) {
            const node = source.node as Element | undefined
            state.sources.push(node?.tagName === undefined ? '?' : `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}.${String(node.className).split(' ').slice(0, 3).join('.')}`)
          }
        }
      }).observe({ type: 'layout-shift', buffered: true })
    })
    for (const path of seen.keys()) {
      await probe.page.goto(origin + path, { waitUntil: 'load' })
      await sleep(1200)
      await scrollThrough(probe.page)
      await sleep(1200)
      const cls = await probe.page.evaluate(() => (window as unknown as { __cls: { value: number; entries: number; sources: string[] } }).__cls)
      const hook = await probe.page.evaluate(() => (window as unknown as { __primp?: unknown }).__primp !== undefined)
      if (!hook) clsResults.push(`${path} at ${viewport.width}px: the hook is not loaded`)
      clsTotal += cls.value
      measured += 1
      if (cls.value > 0) clsResults.push(`${path} at ${viewport.width}px: ${cls.value.toFixed(4)} in ${cls.entries} entries (${[...new Set(cls.sources)].slice(0, 4).join(', ')})`)
    }
    external.push(...probe.external)
    await probe.close()
  }
  report.check(
    'CLS is 0 on every page, at 1280 and 390 px, with the hook loaded',
    clsTotal === 0 && clsResults.length === 0,
    clsResults.length === 0 ? `${measured} loads, each about 3 s with a scroll to the bottom and back: 0 layout-shift entries` : clsResults.join('\n'),
  )

  report.section('5. The live dock')
  const live = await freshPage(browser, { viewport: { width: 1440, height: 900 } })
  const dock = dockOf(live.page)
  await live.page.goto(`${origin}/`)
  await waitFor(() => live.page.evaluate(() => (window as unknown as { __primp_test?: unknown }).__primp_test !== undefined), { what: 'the dock', timeoutMs: 15_000 })
  await dock('ready')

  await report.attempt("the dock's own report of the landing page: no scored layout shift", async () => {
    const shifts = await dock('shiftReport')
    const scored = shifts.report.issues.filter((issue) => issue.scored)
    expect(shifts.report.status === 'ok' && scored.length === 0, `status ${shifts.report.status}, ${scored.length} scored: ${scored.map((issue) => `${issue.culprit?.node.selector} ${issue.cause}`).join(', ')}`)
    return `status ok, CLS ${shifts.report.cls ?? 'n/a'}, ${shifts.report.issues.length} issue(s), none scored`
  })

  const opened = await report.attempt('the dock mounts closed; "Try it on this page" opens it', async () => {
    const before = await dock('state')
    expect(before.mounted && before.connected && before.ready, `dock state: ${JSON.stringify({ mounted: before.mounted, connected: before.connected, ready: before.ready })}`)
    expect(before.open === false, 'the dock is open before anyone opened it')
    await live.page.getByRole('button', { name: 'Try it on this page' }).first().click()
    await waitFor(async () => (await dock('state')).open, { what: 'the dock to open', timeoutMs: 5000 })
    return 'closed after load, open after the click'
  })

  if (opened) {
    const lookups: [string, string, string, string][] = [
      ['the hero headline', '#hero-title', 'components/landing/hero.tsx', '<h1 id="hero-title"'],
      ['the "7 of 10" figure', '#tested-title ~ * .text-6xl, section[aria-labelledby="tested-title"] p.text-6xl', 'components/landing/tested.tsx', 'text-6xl font-semibold'],
      ['the footer tagline', 'footer p.max-w-sm', 'components/site-footer.tsx', '<p className="max-w-sm'],
    ]
    for (const [what, selector, file, needle] of lookups) {
      await report.attempt(`selecting ${what} resolves to ${file}, as a ranked guess`, async () => {
        const line = lineOf(file, needle)
        await live.page.evaluate((css) => document.querySelector(css)?.scrollIntoView({ block: 'center' }), selector)
        const ref = await dock('select', selector)
        await waitFor(async () => {
          const state = (await dock('state')).source?.state
          return state === 'done' || state === 'failed' || state === 'error'
        }, { what: 'the source lookup', timeoutMs: 8000 })
        const source = (await dock('state')).source
        expect(source?.file === file && source.line === line, `source ${JSON.stringify(source)}; the tag is at ${file}:${line}`)
        expect(source.level !== 'exact', `level ${source.level}: a text search must not claim to be exact`)
        return `${ref.label} -> ${source.file}:${source.line} (${source.level})`
      })
    }

    await report.attempt('an edit on the headline is recorded, with its source', async () => {
      await live.page.evaluate(() => scrollTo(0, 0))
      await dock('select', '#hero-title')
      const edit = await dock('setStyle', 'letter-spacing', '-1px', { media: null, scope: 'instance' })
      expect(edit.ok && edit.item !== null, `not recorded: ${edit.error}`)
      const shown = await live.page.evaluate(() => getComputedStyle(document.querySelector('#hero-title') as Element).letterSpacing)
      expect(shown === '-1px', `the page shows letter-spacing ${shown}`)
      return `item ${edit.item?.id}: letter-spacing -> -1px at ${edit.item?.target.source?.file}:${edit.item?.target.source?.line}; "${await dock('summary', edit.item?.id ?? '')}"`
    })

    await report.attempt("Send shows the site's prompt sheet with the prompt primp's engine rendered", async () => {
      const prompt = await dock('send')
      expect(prompt.includes('letter-spacing') && prompt.includes('components/landing/hero.tsx'), `prompt:\n${prompt.slice(0, 600)}`)
      const sheet = live.page.locator('[data-slot="sheet-content"]')
      await sheet.waitFor({ state: 'visible', timeout: 5000 })
      const shown = (await sheet.locator('[data-copy-source]').textContent()) ?? ''
      expect(shown === prompt, `the sheet shows another text (${shown.length} vs ${prompt.length} characters)`)
      expect((await sheet.textContent())?.includes('verification needs') === true, 'the sheet does not say that verification needs npx primp and an agent')
      await sleep(700)
      await live.page.screenshot({ path: join(SHOTS, 'prompt-sheet.png') })
      await sheet.getByRole('button', { name: 'Close' }).click()
      await sheet.waitFor({ state: 'detached', timeout: 5000 })
      return `${prompt.length} characters: ${prompt.split('\n')[0]}`
    })

    await report.attempt('"Replay with a layout shift" reloads with ?shift=1; the dock names the unsized hero screenshot', async () => {
      await dock('open', false)
      const button = live.page.getByRole('button', { name: 'Replay with a layout shift' }).first()
      await button.scrollIntoViewIfNeeded()
      await button.click()
      await live.page.waitForURL(/\?shift=1/, { timeout: 15_000 })
      await waitFor(() => live.page.evaluate(() => navigator.serviceWorker.controller !== null && (window as unknown as { __primp_test?: unknown }).__primp_test !== undefined), { what: 'the replay with the dock', timeoutMs: 20_000 })
      await dock('ready')
      await sleep(1500)
      const shifts = await dock('shiftReport')
      const issue = shifts.report.issues.find((candidate) => candidate.scored)
      expect(issue !== undefined, `no scored shift: ${shifts.report.status}, ${shifts.report.issues.length} issues, notes ${shifts.report.notes.join('; ')}`)
      const culprit = issue.culprit?.node
      expect(culprit?.tag === 'img' && (culprit.classes ?? []).includes('shift-replay-only') && issue.cause === 'unsized-media', `culprit ${culprit?.tag}.${(culprit?.classes ?? []).join('.')}, cause ${issue.cause}`)
      const source = shifts.culpritSources[issue.id]
      const line = lineOf('components/landing/hero.tsx', 'className="shift-replay-only')
      expect(source?.file === 'components/landing/hero.tsx' && source.line === line, `culprit source ${source?.file}:${source?.line}; the tag is on line ${line}`)
      await dock('open', true)
      await dock('panel', 'shifts')
      await sleep(600)
      const text = await dockText(live.page)
      expect(/unsized/i.test(text), `the Layout shifts panel reads:\n${text.slice(0, 500)}`)
      await live.page.screenshot({ path: join(SHOTS, 'replay-shifts.png') })
      return `${issue.cause} ${issue.value.toFixed(3)} by img.shift-replay-only at ${source?.file}:${source?.line} (${source?.level}), ${Math.round(issue.confidence * 100)}% confident; shown in the panel`
    })
  }
  const liveProblems = [
    ...live.record.console.filter(isProblem).map((entry) => `console ${entry.type}: ${entry.text.slice(0, 200)}`),
    ...live.record.pageErrors.map((entry) => `page error: ${entry}`),
    ...live.record.failedRequests.filter((entry) => !(entry.failure === 'net::ERR_ABORTED' && entry.url.includes('shift=1'))).map((entry) => `failed: ${entry.url} ${entry.failure}`),
  ]
  report.check('no console error or warning and no failed request while the dock was used', liveProblems.length === 0, liveProblems.length === 0 ? `${live.record.responses.length} responses` : liveProblems.join('\n'))
  external.push(...live.external)
  await live.close()

  report.section('No external requests')
  report.check('no page requested anything from another origin', external.length === 0, external.length === 0 ? 'every request went to the local static server' : [...new Set(external)].slice(0, 10).join('\n'))

  report.section('Screenshots for a person to look at')
  await report.attempt(`landing dark and light at 1440 and 390, a docs page, ⌘K, the dock open, in ${relative(REPO_ROOT, SHOTS)}`, async () => {
    const shots: string[] = []
    const jobs: { name: string; path: string; width: number; height: number; theme: 'dark' | 'light'; full: boolean; then?: (page: Page) => Promise<void> }[] = [
      { name: 'landing-dark-1440', path: '/', width: 1440, height: 900, theme: 'dark', full: true },
      { name: 'landing-light-1440', path: '/', width: 1440, height: 900, theme: 'light', full: true },
      { name: 'landing-dark-390', path: '/', width: 390, height: 844, theme: 'dark', full: true },
      { name: 'landing-light-390', path: '/', width: 390, height: 844, theme: 'light', full: true },
      { name: 'docs-dock-dark-1440', path: '/docs/dock/', width: 1440, height: 900, theme: 'dark', full: false },
      { name: 'docs-verification-light-1440', path: '/docs/verification/', width: 1440, height: 900, theme: 'light', full: false },
      { name: 'docs-dark-390', path: '/docs/layout-shifts/', width: 390, height: 844, theme: 'dark', full: false },
      {
        name: 'command-k',
        path: '/docs/',
        width: 1440,
        height: 900,
        theme: 'dark',
        full: false,
        then: async (page) => {
          await page.keyboard.press('ControlOrMeta+k')
          await sleep(400)
          await page.keyboard.type('shift')
          await sleep(500)
        },
      },
      {
        name: 'dock-open',
        path: '/',
        width: 1440,
        height: 900,
        theme: 'dark',
        full: false,
        then: async (page) => {
          const shotDock = dockOf(page)
          await shotDock('open', true)
          await shotDock('select', '#hero-title')
          await sleep(800)
        },
      },
    ]
    for (const job of jobs) {
      const shot = await freshPage(browser, { viewport: { width: job.width, height: job.height }, theme: job.theme })
      await shot.page.goto(origin + job.path)
      await waitFor(() => shot.page.evaluate(() => (window as unknown as { __primp_test?: unknown }).__primp_test !== undefined), { what: 'the dock', timeoutMs: 15_000 })
      if (job.full) await scrollThrough(shot.page)
      await sleep(900)
      await job.then?.(shot.page)
      await shot.page.screenshot({ path: join(SHOTS, `${job.name}.png`), fullPage: job.full })
      shots.push(job.name)
      external.push(...shot.external)
      await shot.close()
    }
    return `${shots.length + 2} PNGs: ${shots.join(', ')}, prompt-sheet, replay-shifts`
  })
} catch (error) {
  report.check('spike ran to completion', false, error instanceof Error ? (error.stack ?? error.message) : String(error))
} finally {
  await runCleanups()
  report.finish()
}
