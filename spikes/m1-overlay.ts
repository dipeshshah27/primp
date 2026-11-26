/**
 * M1/M2 integration check of the browser side: the head script, the dock, the probe.
 *
 * Everything is real: the fixtures' dev servers, primp itself (`startPrimp`: proxy, session
 * server, settle detector, source resolver, shift attributor, verifier) bundling the entries of
 * packages/overlay the way the product does, and headless Chromium. The dock is driven through
 * `window.__primp_test` and, where the point is the UI, with real mouse and keyboard input.
 *
 * One thing the real server cannot be made to say on demand is a shift report for a tab that
 * was hidden; for that single check the same bundles run against a small fake session server
 * (m1-overlay-assets/fake-session.ts).
 *
 * Fixtures: vite-react-19 (most checks, the :hover state, reorder of the pricing plans and resize
 * of a card, both also by real mouse drags on the handles), next-16-turbopack (strict nonce
 * CSP), static-html (also :focus-visible, and a stylesheet from another origin that cannot be
 * read), and one positive page of cls-corpus (the Shifts tab).
 *
 * Run: pnpm spike:m1-overlay                  (exit 0 = every check passed)
 *      pnpm spike:m1-overlay vite next ...    only these sections: vite, next, static, cls, shots
 *                                             (vite-ux: only the launcher, toolbar, selection, pins and pause checks;
 *                                              vite-states: only the :hover checks of vite;
 *                                              vite-moves: only its reorder and resize checks)
 * Screenshots go to .tmp/m1-overlay-shots/.
 */

import { mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { Browser } from '@playwright/test'
import type { ChangeItem, Expectation, StructuralChange, StyleChange } from '../packages/protocol/src/change.ts'
import type { ShiftReport } from '../packages/protocol/src/shift.ts'
import { createReport, editFile, expect, launchBrowser, newPage, onCleanup, replaceOnce, runCleanups, sleep, TMP_ROOT, waitFor } from './lib/index.ts'
import { buildBundles, computed, computedAll, dockFrame, items, marks, openDock, px, rect, restartPrimp, startFakeLane, startLane, testState, type Bundles, type DockPage, type Lane } from './m1-overlay-assets/harness.ts'
import { fixed, readPlainEntries, sum, type PlainEntry } from './s7-assets/measure.ts'

const report = createReport('M1 overlay: head script, dock and probe against the real primp server')
const SHOTS = join(TMP_ROOT, 'm1-overlay-shots')
const HOOK_TARGET_BYTES = 12_000
/** Budget for what this milestone adds to the head script on top of the M0 recorder and settle client. */
const HOOK_ADDED_BYTES = 2_500
const EFFECTS_BUDGET_MS = 30
const SENT_TEXT = 'Copied. Paste into your agent, or it will pick the batch up over MCP.'

/** Equal within the half pixel the geometry snapshot rounds to. */
const near = (a: number, b: number, within = 0.5): boolean => Math.abs(a - b) <= within
const scored = (entries: PlainEntry[]): PlainEntry[] => entries.filter((entry) => !entry.hadRecentInput)
const describeEntries = (entries: PlainEntry[]): string => `${scored(entries).length} (${fixed(sum(scored(entries).map((entry) => entry.value)), 6)})`
const style = (item: ChangeItem | null | undefined): StyleChange => {
  if (item === null || item === undefined || item.kind !== 'style') throw new Error(`expected a style change, got ${JSON.stringify(item)?.slice(0, 120)}`)
  return item
}

/**
 * What the fixture logs and violates by itself, read from the same page WITHOUT primp. Next's
 * dev tools, for one, insert unnonced <style> elements that its own strict policy blocks; that
 * is the fixture's doing and happens with or without the dock.
 */
interface Baseline {
  errors: Set<string>
  violations: Set<string>
  counts: { errors: number; violations: number }
}
const baselines = new Map<Lane, Baseline>()
const normal = (text: string): string => text.replace(/nonce-[A-Za-z0-9+/=_-]+/g, 'nonce-*')
const violationKey = (violation: { effectiveDirective: string; blockedURI: string; target: string }): string => `${violation.effectiveDirective} ${violation.blockedURI} (${violation.target})`

async function readBaseline(browser: Browser, lane: Lane, path: string, observeMs: number): Promise<Baseline> {
  const handle = await newPage(browser)
  try {
    await handle.page.goto(lane.control.url + path, { waitUntil: 'load' })
    await sleep(observeMs)
    const baseline: Baseline = {
      errors: new Set(handle.record.consoleErrors().map((entry) => normal(entry.text))),
      violations: new Set(handle.record.cspViolations.map(violationKey)),
      counts: { errors: handle.record.consoleErrors().length, violations: handle.record.cspViolations.length },
    }
    baselines.set(lane, baseline)
    return baseline
  } finally {
    await handle.close()
  }
}

function hygiene(page: DockPage, lane: Lane): string[] {
  const baseline = baselines.get(lane)
  const problems: string[] = []
  const errors = page.record.consoleErrors().filter((entry) => baseline?.errors.has(normal(entry.text)) !== true)
  if (errors.length > 0) problems.push(`console errors: ${errors.map((entry) => entry.text).slice(0, 3).join(' | ')}`)
  const warnings = page.record.console.filter((entry) => entry.text.includes('[primp]'))
  if (warnings.length > 0) problems.push(`primp logged: ${warnings.map((entry) => entry.text).slice(0, 3).join(' | ')}`)
  if (page.record.pageErrors.length > 0) problems.push(`page errors: ${page.record.pageErrors.slice(0, 2).join(' | ')}`)
  // A violation counts against primp unless the same one happens on the page without it; anything
  // on primp's own host or in the dock's document counts in any case. (The source file is no
  // guide: with stack capture on, the page's own DOM insertions run through a wrapper in hook.js,
  // and the browser then names hook.js for a <style> that Next's dev tools inserted.)
  const violations = page.record.cspViolations.filter(
    (violation) => baseline?.violations.has(violationKey(violation)) !== true || violation.target === 'primp-root' || violation.documentURI === 'about:blank',
  )
  if (violations.length > 0) {
    problems.push(`CSP violations: ${violations.map((violation) => `${violationKey(violation)} in ${violation.documentURI}`).slice(0, 4).join(' | ')}`)
  }
  // The server validates every `session:*` message against the protocol's schema and warns about one it drops.
  const refused = lane.logs.filter((line) => line.includes('did not match the protocol') || line.startsWith('error'))
  if (refused.length > 0) problems.push(`the server complained: ${refused.slice(0, 3).join(' | ')}`)
  return problems
}

/** `0 console errors, 0 CSP violations`, or how many the fixture produces by itself. */
function hygieneText(page: DockPage, lane: Lane): string {
  const own = { errors: page.record.consoleErrors().length, violations: page.record.cspViolations.length }
  const without = baselines.get(lane)?.counts
  const fixture = own.errors + own.violations === 0 ? '' : ` (the page's own, of the kinds it has without primp: ${own.violations} CSP violations and ${own.errors} console errors here, ${without?.violations} and ${without?.errors} on one load without primp)`
  return `0 console errors, 0 CSP violations, 0 page errors from primp${fixture}`
}

// ---------------------------------------------------------------------------
// Every fixture: the dock mounts, breaks nothing, adds no layout shift
// ---------------------------------------------------------------------------

async function mountChecks(browser: Browser, lane: Lane, path: string, observeMs: number): Promise<void> {
  const baseline = await readBaseline(browser, lane, path, observeMs)
  if (baseline.errors.size + baseline.violations.size > 0) {
    report.info(`without primp this page already has ${baseline.violations.size} kind(s) of CSP violation (${[...baseline.violations].join('; ')}) and ${baseline.errors.size} console error(s); only what comes on top counts against the dock`)
  }
  await report.attempt('the dock mounts: one host in the top layer, its own document, session state received', async () => {
    const page = await openDock(browser, lane, path)
    try {
      const facts = await page.page.evaluate(() => {
        const hosts = document.querySelectorAll('primp-root')
        const host = hosts[0]
        const frame = host?.shadowRoot?.querySelector('iframe[data-primp-dock="bar"]')
        const box = frame?.getBoundingClientRect()
        const pop = host?.shadowRoot?.querySelector('iframe[data-primp-dock="pop"]')
        return {
          hosts: hosts.length,
          marked: host?.hasAttribute('data-primp-root') ?? false,
          parent: host?.parentElement?.localName,
          topLayer: host?.matches(':popover-open') ?? false,
          position: host === undefined ? '' : getComputedStyle(host).position,
          hostBox: host === undefined ? '' : `${host.getBoundingClientRect().width}x${host.getBoundingClientRect().height}`,
          frame: box === undefined ? undefined : { w: Math.round(box.width), h: Math.round(box.height), inView: box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight },
          popHidden: pop === null || pop === undefined ? false : getComputedStyle(pop).display === 'none',
          leftoverScript: document.querySelectorAll('script[data-primp-root]').length,
          focusStolen: document.activeElement !== document.body && document.activeElement !== null && document.activeElement.localName === 'primp-root',
          hook: typeof window.__primp?.recording === 'function',
          bus: typeof window.__primp_bus?.send === 'function',
        }
      })
      const state = await testState(page.page)
      const launcher = await page.bar.evaluate(() => ({ label: document.querySelector('.launcher')?.getAttribute('aria-label') ?? '', lang: document.documentElement.lang }))
      expect(facts.hosts === 1 && facts.marked && facts.parent === 'html', `host: ${JSON.stringify(facts)}`)
      expect(facts.topLayer && facts.position === 'fixed' && facts.hostBox === '0x0', `host is not a 0x0 fixed box in the top layer: ${JSON.stringify(facts)}`)
      expect(facts.frame !== undefined && facts.frame.w === 44 && facts.frame.h === 44 && facts.frame.inView && facts.popHidden, `closed on load: launcher frame ${JSON.stringify(facts.frame)}, popover hidden ${facts.popHidden}`)
      expect(facts.hook && facts.bus, 'window.__primp or window.__primp_bus is missing')
      expect(facts.leftoverScript === 0, 'the loader script element was left in the document')
      expect(!facts.focusStolen, 'the dock took focus on load')
      expect(state.connected && state.ready && state.mounted, `state: ${JSON.stringify(state)}`)
      expect(launcher.label.startsWith('Open primp') && launcher.lang === 'en', `launcher: ${JSON.stringify(launcher)}`)
      // The project is named in the settings of the open dock.
      await page.page.evaluate(() => window.__primp_test!.panel('settings'))
      const project = await waitFor(() => page.dock.evaluate(() => document.querySelector('.project')?.textContent ?? undefined), { timeoutMs: 3000, what: 'the settings to show the project' })
      expect(project.includes(lane.name), `settings name the project as "${project}"`)
      await page.page.evaluate(() => window.__primp_test!.open(false))
      const documents = lane.primp.session.documents()
      await waitFor(() => lane.primp.detector.status().browsers === 1, { timeoutMs: 3000, what: 'the settle detector to count the document' })
      expect(documents.length === 1 && documents[0]?.url.endsWith(path) === true, `the session knows ${documents.length} document(s): ${JSON.stringify(documents).slice(0, 200)}`)
      const problems = hygiene(page, lane)
      expect(problems.length === 0, problems.join('; '))
      const sockets = page.record.webSockets.filter((url) => url.includes('/__primp/'))
      expect(sockets.length === 1, `expected ONE overlay socket, the page opened ${sockets.length}: ${sockets.join(', ')}`)
      return `host 0x0 fixed in the top layer, closed: launcher ${facts.frame.w}x${facts.frame.h} and no popover; settings name "${project}"; 1 overlay socket serving the session (1 document) and the settle detector (1 browser), ${hygieneText(page, lane)}`
    } finally {
      await page.close()
    }
  })

  await report.attempt('the dock adds no layout-shift entry (2 loads with it, 2 without)', async () => {
    const read = async (withDock: boolean): Promise<PlainEntry[]> => {
      if (withDock) {
        const page = await openDock(browser, lane, path)
        try {
          await sleep(observeMs)
          return await readPlainEntries(page.page)
        } finally {
          await page.close()
        }
      }
      const handle = await newPage(browser)
      try {
        await handle.page.goto(lane.control.url + path, { waitUntil: 'load' })
        await sleep(observeMs)
        const clean = await handle.page.evaluate(() => window.__primp === undefined && document.querySelector('primp-root') === null)
        expect(clean, 'the control page has primp in it')
        return await readPlainEntries(handle.page)
      } finally {
        await handle.close()
      }
    }
    const control = [await read(false), await read(false)]
    const dock = [await read(true), await read(true)]
    const line = `without ${control.map(describeEntries).join(' ')} | with dock ${dock.map(describeEntries).join(' ')}`
    const counts = (runs: PlainEntry[][]): string => JSON.stringify(runs.map((run) => scored(run).length).sort())
    expect(counts(dock) === counts(control), `entry counts differ: ${line}`)
    const total = (runs: PlainEntry[][]): number => Math.max(...runs.map((run) => sum(scored(run).map((entry) => entry.value))))
    expect(Math.abs(total(dock) - total(control)) <= 1e-4, `summed values differ: ${line}`)
    return `entries per load (count, summed value): ${line}`
  })
}

// ---------------------------------------------------------------------------
// vite-react-19
// ---------------------------------------------------------------------------

const CARD = '[data-label="card"]'
const BANNER = '[data-label="banner"]'

async function viteSelection(browser: Browser, lane: Lane): Promise<void> {
  const page = await openDock(browser, lane, '/')
  try {
    await report.attempt('select through the test handle: Ref, unique selector, instances, source badge', async () => {
      const ref = await page.page.evaluate((selector) => window.__primp_test!.select(selector), CARD)
      const matches = await page.page.evaluate((selector) => document.querySelectorAll(selector).length, ref.selector)
      expect(matches === 1, `selector ${ref.selector} matches ${matches} elements`)
      expect(ref.label.startsWith('article.card "'), `label is ${ref.label}`)
      expect(ref.instanceCount === 6, `instanceCount is ${ref.instanceCount}`)
      expect(ref.locator.tag === 'article' && ref.locator.role === 'article' && ref.locator.indexPath.length === ref.locator.ancestors.length, `locator: ${JSON.stringify(ref.locator)}`)
      expect(!JSON.stringify(ref.locator).includes('_card_'), 'the locator contains a class name')
      const state = await waitFor(async () => {
        const now = await testState(page.page)
        return now.source?.state === 'done' ? now : undefined
      })
      // Ground truth: the fixture's labels.json.
      const truth = lane.fixture.labels.find((entry) => entry.label === 'card')
      expect(truth !== undefined && state.source?.file === truth.file && state.source.line === truth.line && state.source.level === 'exact', `source: ${JSON.stringify(state.source)}, labels.json says ${truth?.file}:${truth?.line}`)
      const badge = await page.dock.evaluate(() => ({ text: document.querySelector('.target .source')?.textContent ?? '', title: document.querySelector('.target .source')?.getAttribute('title') ?? '' }))
      expect(badge.text.includes(`Card.tsx:${truth.line}`) && badge.title.includes(truth.file), `badge shows "${badge.text}" with tooltip "${badge.title}"`)
      return `${ref.label} -> selector "${ref.selector}" (1 match), 6 instances, locator without class names; the real resolver answered ${state.source.file}:${state.source.line} (${state.source.level}) = labels.json; badge "${badge.text.trim()}", full path in the tooltip`
    })

    await report.attempt('selection with a real mouse while the dock is open: hover highlight, click selects, the app\'s own click handler does not fire, a link is not followed; closed, the click is the app\'s', async () => {
      const documents = page.record.documentRequests.length
      // Selecting through the handle opened the dock; start from the launcher.
      await page.page.evaluate(() => window.__primp_test!.open(false))
      await page.bar.locator('.launcher').click()
      expect((await testState(page.page)).open, 'the dock did not open')
      const dismiss = await rect(page.page, '[data-label="banner-dismiss"]')
      const x = dismiss.x + dismiss.w / 2
      const y = dismiss.y + dismiss.h / 2
      await page.page.mouse.move(x, y)
      const hover = await waitFor(() =>
        page.page.evaluate(() => {
          const box = document.querySelector('primp-root')?.shadowRoot?.querySelector<HTMLElement>('.box.hover')
          if (box === null || box === undefined || getComputedStyle(box).display === 'none') return undefined
          const r = box.getBoundingClientRect()
          return { x: r.left, y: r.top, w: r.width, h: r.height }
        }),
      )
      expect(Math.abs(hover.x - dismiss.x) <= 1 && Math.abs(hover.y - dismiss.y) <= 1 && Math.abs(hover.w - dismiss.w) <= 1, `hover box ${JSON.stringify(hover)} is not on the button ${JSON.stringify(dismiss)}`)
      await page.page.mouse.click(x, y)
      const afterPick = await page.page.evaluate(() => ({ selected: window.__primp_test!.selection()?.label, banner: document.querySelector('[data-label="banner"]') !== null, open: window.__primp_test!.state().open }))
      expect(afterPick.selected?.startsWith('button.banner__dismiss') === true, `selected ${afterPick.selected}`)
      expect(afterPick.banner, 'the Dismiss handler of the app ran: the banner is gone')
      expect(afterPick.open, 'the dock closed after the click: selection must stay on while it is open')
      // A link is not followed either.
      const link = await rect(page.page, '[data-label="nav-big"]')
      await page.page.mouse.click(link.x + link.w / 2, link.y + link.h / 2)
      await sleep(150)
      expect(page.record.documentRequests.length === documents && new URL(page.page.url()).pathname === '/', `the link was followed: ${page.page.url()}`)
      expect((await page.page.evaluate(() => window.__primp_test!.selection()?.tag)) === 'a', 'the link was not selected')
      // With the dock closed the same click reaches the app.
      await page.page.evaluate(() => window.__primp_test!.open(false))
      await page.page.mouse.click(x, y)
      const dismissed = await waitFor(() => page.page.evaluate(() => document.querySelector('[data-label="banner"]') === null))
      expect(dismissed, 'with the dock closed the click did not reach the app')
      return `hover box on the button (${Math.round(hover.w)}x${Math.round(hover.h)}); click selected ${afterPick.selected}, banner still mounted, the dock stayed open; link not followed; the same click with the dock closed dismissed the banner`
    })

    await report.attempt('keyboard while open: arrows walk parent / child / siblings, Escape closes the inspector and then the dock (from the page and from the popover)', async () => {
      await page.page.evaluate((selector) => window.__primp_test!.select(`${selector}:nth-of-type(2)`), CARD)
      await page.page.locator('body').focus()
      const label = (): Promise<string | undefined> => page.page.evaluate(() => window.__primp_test!.selection()?.label)
      await page.page.keyboard.press('ArrowRight')
      const next = await label()
      await page.page.keyboard.press('ArrowLeft')
      await page.page.keyboard.press('ArrowUp')
      const parent = await page.page.evaluate(() => window.__primp_test!.selection()?.locator.testId ?? window.__primp_test!.selection()?.tag)
      await page.page.keyboard.press('ArrowDown')
      const child = await label()
      expect(next?.includes('03') === true && parent === 'div' && child?.includes('01') === true, `right -> ${next}; up -> ${parent}; down -> ${child}`)
      await page.page.keyboard.press('Escape')
      const one = await testState(page.page)
      await page.page.keyboard.press('Escape')
      const two = await testState(page.page)
      expect(one.open && one.panel === null && !two.open, `Escape from the page: ${JSON.stringify({ one: [one.open, one.panel], two: two.open })}`)
      // From inside the popover: focus a button of the inspector, then Escape twice.
      await page.page.evaluate((selector) => window.__primp_test!.select(selector), CARD)
      await page.dock.locator('.inspector button[aria-label="Close the inspector"]').focus()
      await page.dock.locator('.inspector button[aria-label="Close the inspector"]').press('Escape')
      const three = await testState(page.page)
      expect(three.open && three.panel === null, `Escape in the popover: ${JSON.stringify([three.open, three.panel])}`)
      await page.page.evaluate(() => window.__primp_test!.open(false))
      return `ArrowRight -> card 03, ArrowUp -> the grid div, ArrowDown -> card 01; Escape closed the inspector and then the dock with focus on the page, and closed the inspector with focus in it`
    })
  } finally {
    await page.close()
  }
}

// ---------------------------------------------------------------------------
// The interaction model: closed by default, selection while open, popover, pins, pause
// ---------------------------------------------------------------------------

/** The two frames and the layer's nodes, read with code that shares nothing with the overlay. */
async function dockBoxes(page: DockPage['page']) {
  return page.evaluate(() => {
    const shadow = document.querySelector('primp-root')!.shadowRoot!
    const box = (node: Element | null): { x: number; y: number; w: number; h: number; shown: boolean } | null => {
      if (node === null) return null
      const r = node.getBoundingClientRect()
      return { x: r.left, y: r.top, w: r.width, h: r.height, shown: getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden' }
    }
    const chip = shadow.querySelector('.label-chip')
    return {
      bar: box(shadow.querySelector('iframe[data-primp-dock="bar"]'))!,
      pop: box(shadow.querySelector('iframe[data-primp-dock="pop"]'))!,
      chip: { ...box(chip)!, text: chip?.textContent ?? '' },
      pins: [...shadow.querySelectorAll<HTMLElement>('.pin')].filter((pin) => pin.style.display !== 'none').map((pin) => ({ ...box(pin)!, number: pin.textContent ?? '', status: pin.dataset.status ?? '' })),
      view: { w: document.documentElement.clientWidth, h: innerHeight },
    }
  })
}

/** "All CSS" (every declared rule, raw) is collapsed until opened; it stays open for the next element. */
async function openAllCss(page: DockPage): Promise<void> {
  await waitFor(() => page.dock.evaluate(() => document.querySelector('details.all') !== null), { timeoutMs: 3000, what: 'the inspector' })
  if (!(await page.dock.evaluate(() => (document.querySelector('details.all') as HTMLDetailsElement).open))) await page.dock.locator('details.all > summary').click()
}

const inside = (r: { x: number; y: number; w: number; h: number }, view: { w: number; h: number }): boolean => r.x >= -0.5 && r.y >= -0.5 && r.x + r.w <= view.w + 0.5 && r.y + r.h <= view.h + 0.5

async function viteDockUx(browser: Browser, lane: Lane): Promise<void> {
  const page = await openDock(browser, lane, '/')
  const t = page.page
  const first = `${CARD}:nth-of-type(1)`
  const second = `${CARD}:nth-of-type(2)`
  try {
    const shiftsBefore = await unmarkedShifts(t)

    await report.attempt('the dock starts closed: a round launcher in the bottom-right corner, no popover, and the page gets its clicks', async () => {
      const state = await testState(t)
      const boxes = await dockBoxes(t)
      const launcher = await page.bar.evaluate(() => ({ label: document.querySelector('.launcher')?.getAttribute('aria-label') ?? '', toolbar: document.querySelector('[role="toolbar"]') !== null }))
      expect(!state.open && state.panel === null && !boxes.pop.shown, `state ${JSON.stringify({ open: state.open, panel: state.panel })}, popover ${JSON.stringify(boxes.pop)}`)
      expect(boxes.bar.w === 44 && boxes.bar.h === 44 && near(boxes.view.w - boxes.bar.x - boxes.bar.w, 16) && near(boxes.view.h - boxes.bar.y - boxes.bar.h, 16), `launcher frame ${JSON.stringify(boxes.bar)}`)
      expect(launcher.label.startsWith('Open primp') && !launcher.toolbar, `launcher: ${JSON.stringify(launcher)}`)
      // Closed, a click on the page is the app's.
      await countAppEvents(t, '[data-label="banner-dismiss"]')
      const dismiss = await rect(t, '[data-label="nav-big"]')
      await t.mouse.move(dismiss.x + 4, dismiss.y + 4)
      const hover = (await dockBoxes(t)).chip
      expect(!hover.shown, `a label chip is shown while closed: ${JSON.stringify(hover)}`)
      // Open once, then load the page again: closed again.
      await t.evaluate(() => window.__primp_test!.open(true))
      await t.reload({ waitUntil: 'load' })
      await t.waitForFunction(() => window.__primp_test !== undefined)
      await t.evaluate(() => window.__primp_test!.ready())
      page.dock = await dockFrame(t)
      page.bar = await dockFrame(t, 'bar')
      const again = await testState(t)
      expect(!again.open, 'the dock was open again after a reload')
      return `closed on load and after a reload that followed an open dock: launcher 44x44, 16px from the right and bottom edges ("${launcher.label}"), no toolbar, no popover, no label chip`
    })

    await report.attempt('the first time the dock is open with nothing selected, a hint says what to do; after the first selection it is gone for good', async () => {
      await t.evaluate(() => localStorage.removeItem('primp:coached'))
      await t.reload({ waitUntil: 'load' })
      await t.waitForFunction(() => window.__primp_test !== undefined)
      await t.evaluate(() => window.__primp_test!.ready())
      page.dock = await dockFrame(t)
      page.bar = await dockFrame(t, 'bar')
      const coach = (): Promise<string | null> => t.evaluate(() => {
        const node = document.querySelector('primp-root')?.shadowRoot?.querySelector<HTMLElement>('.toast.coach')
        return node === null || node === undefined || node.style.display === 'none' ? null : node.textContent
      })
      const closed = await coach()
      await t.evaluate(() => window.__primp_test!.open(true))
      const shown = await waitFor(coach, { what: 'the first-time hint', timeoutMs: 2000 })
      await t.evaluate((selector) => window.__primp_test!.select(selector), `${'[data-label="card"]'}:nth-of-type(1)`)
      const afterSelect = await coach()
      await t.evaluate(() => window.__primp_test!.open(false))
      await t.evaluate(() => window.__primp_test!.open(true))
      const later = await coach()
      await t.evaluate(() => window.__primp_test!.open(false))
      expect(closed === null && shown.startsWith('Click anything on the page') && afterSelect === null && later === null, `closed ${closed}, open ${shown}, after a selection ${afterSelect}, opened again ${later}`)
      return `"${shown}" while open with nothing selected; gone after the first selection, and not shown when opened again`
    })

    await report.attempt('Ctrl+Shift+E and the launcher open the toolbar; every toolbar button has a name and a tooltip', async () => {
      await t.locator('body').focus()
      await t.keyboard.press('Control+Shift+E')
      const opened = (await testState(t)).open
      await t.keyboard.press('Control+Shift+E')
      const closed = !(await testState(t)).open
      await page.bar.locator('.launcher').click()
      await waitFor(async () => (await testState(t)).open, { timeoutMs: 2000, what: 'the dock to open from the launcher' })
      const buttons = await page.bar.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>('[role="toolbar"] button')].map((button) => button.getAttribute('aria-label') ?? ''))
      const wanted = ['Changes', 'Layout shifts', 'Verification', 'Pause animations', 'Hide pins', 'Copy prompt', 'Send to your agent', 'Settings', 'Close primp']
      const missing = wanted.filter((label) => !buttons.includes(label))
      // A tooltip outside the frame, above the toolbar.
      await page.bar.locator('button[aria-label="Pause animations"]').hover()
      const tip = await waitFor(() =>
        t.evaluate(() => {
          const node = document.querySelector('primp-root')!.shadowRoot!.querySelector<HTMLElement>('.tip')!
          return node.style.display === 'block' ? { text: node.textContent ?? '', y: node.getBoundingClientRect().bottom } : undefined
        }),
      )
      const boxes = await dockBoxes(t)
      expect(opened && closed && missing.length === 0, `opened ${opened}, closed again ${closed}; toolbar buttons ${buttons.join(', ')}; missing ${missing.join(', ')}`)
      expect(tip.text.includes('Pause animations') && tip.text.includes('P') && tip.y <= boxes.bar.y, `tooltip ${JSON.stringify(tip)}, toolbar at y ${boxes.bar.y}`)
      return `Ctrl+Shift+E opened and closed, the launcher opened: toolbar ${Math.round(boxes.bar.w)}x${boxes.bar.h} with ${buttons.length} named buttons; hover shows "${tip.text}" above it`
    })

    await report.attempt('open: a real click selects with no pick button, the app does not get it, Alt+click goes through, the inspector opens next to the element', async () => {
      await t.mouse.move(2, 2)
      await countAppEvents(t, '[data-label="banner-dismiss"]')
      const dismiss = await rect(t, '[data-label="banner-dismiss"]')
      const x = dismiss.x + dismiss.w / 2
      const y = dismiss.y + dismiss.h / 2
      const pickButton = await page.dock.evaluate(() => [...document.querySelectorAll('button')].some((button) => /pick/i.test(button.textContent ?? '')))
      await t.mouse.move(x, y)
      const chip = await waitFor(async () => {
        const boxes = await dockBoxes(t)
        return boxes.chip.shown ? boxes.chip : undefined
      })
      await t.mouse.click(x, y)
      const picked = await t.evaluate(() => ({ label: window.__primp_test!.selection()?.label, banner: document.querySelector('[data-label="banner"]') !== null }))
      const events = await appEvents(t)
      const state = await testState(t)
      await waitFor(async () => (await dockBoxes(t)).pop.shown, { timeoutMs: 2000, what: 'the inspector to show' })
      const boxes = await dockBoxes(t)
      const name = await page.dock.evaluate(() => document.querySelector('.inspector .title-row .label')?.textContent ?? '')
      expect(!pickButton, 'the popover still has a pick button')
      expect(chip.text.startsWith('button.banner__dismiss'), `label chip "${chip.text}"`)
      expect(picked.label?.startsWith('button.banner__dismiss') === true && picked.banner && Object.keys(events).length === 0, `selected ${picked.label}; banner still there ${picked.banner}; the app saw ${JSON.stringify(events)}`)
      expect(state.open && state.panel === 'inspector' && name.startsWith('button.banner__dismiss') && inside(boxes.pop, boxes.view), `panel ${state.panel}, inspector "${name}" at ${JSON.stringify(boxes.pop)}`)
      // Alt+click: the app's own handler runs and nothing is selected.
      await t.keyboard.down('Alt')
      await t.mouse.click(x, y)
      await t.keyboard.up('Alt')
      const dismissed = await waitFor(() => t.evaluate(() => document.querySelector('[data-label="banner"]') === null), { timeoutMs: 2000, what: 'the Alt+click to reach the app' })
      const still = await t.evaluate(() => window.__primp_test!.selection()?.label)
      expect(dismissed && still?.startsWith('button.banner__dismiss') === true, `Alt+click: banner dismissed ${dismissed}, selection ${still}`)
      return `hover chip "${chip.text}"; click selected ${picked.label} with the app seeing no event and the inspector opened inside the viewport at ${Math.round(boxes.pop.x)},${Math.round(boxes.pop.y)} (${Math.round(boxes.pop.w)}x${Math.round(boxes.pop.h)}); Alt+click dismissed the banner (the app's handler ran)`
    })

    await report.attempt('the hover chip names the source once it is known; Escape closes the inspector, then the dock', async () => {
      await t.evaluate((selector) => window.__primp_test!.select(selector), first)
      await waitFor(async () => (await testState(t)).source?.state === 'done', { timeoutMs: 10_000 })
      await t.evaluate((selector) => window.__primp_test!.select(selector), second)
      const card = await rect(t, first)
      await t.evaluate((selector) => document.querySelector(selector)?.scrollIntoView({ block: 'center' }), first)
      const now = await t.evaluate((selector) => document.querySelector(selector)!.getBoundingClientRect().toJSON() as DOMRect, first)
      await t.mouse.move(now.x + now.width - 6, now.y + now.height - 6)
      const chip = await waitFor(async () => {
        const boxes = await dockBoxes(t)
        return boxes.chip.shown && boxes.chip.text.includes('Card.tsx') ? boxes.chip : undefined
      }, { timeoutMs: 3000, what: `the chip to name Card.tsx (card at ${card.x},${card.y})` })
      await t.keyboard.press('Escape')
      const afterOne = await testState(t)
      await t.keyboard.press('Escape')
      const afterTwo = await testState(t)
      expect(afterOne.open && afterOne.panel === null && t !== null, `after one Escape: open ${afterOne.open}, panel ${afterOne.panel}`)
      expect(!afterTwo.open && (await t.evaluate(() => window.__primp_test!.selection())) === null, `after two: open ${afterTwo.open}`)
      return `chip "${chip.text}"; Escape closed the inspector (dock still open), a second Escape closed the dock`
    })

    await report.attempt('pins: numbered in change order on their elements, coloured by status, hidden with H; a click on a pin selects its element', async () => {
      await t.evaluate((selector) => window.__primp_test!.select(selector), first)
      await t.evaluate(() => window.__primp_test!.setStyle('gap', '6px'))
      await t.evaluate((selector) => window.__primp_test!.select(selector), second)
      await t.evaluate(() => window.__primp_test!.addNote('Say "Layout shifts, explained" here'))
      await t.evaluate(() => window.__primp_test!.panel(null))
      await sleep(150)
      const pins = await t.evaluate(() => window.__primp_test!.pins())
      const drawn = (await dockBoxes(t)).pins
      const cards = await t.evaluate(([a, b]) => [a, b].map((selector) => document.querySelector(selector)!.getBoundingClientRect().toJSON() as DOMRect), [first, second] as const)
      const at = (number: number) => pins.find((pin) => pin.number === number)
      const onCorner = (pin: { x: number; y: number; width: number; height: number } | undefined, r: DOMRect): boolean => pin !== undefined && Math.abs(pin.x + pin.width / 2 - r.left) <= 1 && Math.abs(pin.y + pin.height / 2 - r.top) <= 1
      expect(pins.length === 2 && onCorner(at(1), cards[0]!) && onCorner(at(2), cards[1]!), `pins ${JSON.stringify(pins)}; cards at ${cards.map((r) => `${r.left},${r.top}`).join(' / ')}`)
      expect(drawn.length === 2 && drawn.map((pin) => pin.number).join() === '1,2' && drawn.every((pin) => pin.status === 'draft'), `drawn: ${JSON.stringify(drawn)}`)
      await t.locator('body').focus()
      await t.keyboard.press('h')
      const hidden = await waitFor(async () => ((await dockBoxes(t)).pins.length === 0 ? 0 : undefined), { timeoutMs: 2000, what: 'H to hide the pins' }).catch(() => (dockBoxes(t) as Promise<{ pins: unknown[] }>).then((boxes) => boxes.pins.length))
      await t.keyboard.press('h')
      await waitFor(async () => (await dockBoxes(t)).pins.length === 2, { timeoutMs: 2000, what: 'H to show the pins again' }).catch(() => undefined)
      const pin = at(1)!
      await countAppEvents(t, first)
      await t.mouse.click(pin.x + pin.width / 2, pin.y + pin.height / 2)
      const selected = await t.evaluate(() => window.__primp_test!.selection()?.label)
      const panel = (await testState(t)).panel
      expect(hidden === 0 && (await dockBoxes(t)).pins.length === 2, `H hid ${2 - hidden} pins`)
      expect(selected?.startsWith('article.card "01') === true && panel === 'inspector' && Object.keys(await appEvents(t)).length === 0, `pin click selected ${selected}, panel ${panel}, app saw ${JSON.stringify(await appEvents(t))}`)
      return `pin 1 on card 01 (a gap edit), pin 2 on card 02 (a note), both centred on the top-left corner and "draft" blue; H hid and showed them; clicking pin 1 selected card 01 and opened the inspector, the card's handlers saw nothing`
    })

    await report.attempt('the inspector stays inside the viewport at 1280 px, and is a bottom sheet at 390 px', async () => {
      const results: string[] = []
      for (const selector of [first, `${CARD}:nth-of-type(3)`, '[data-label="header-inner"]']) {
        await t.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: 'center' }), selector)
        await t.evaluate((sel) => window.__primp_test!.select(sel), selector)
        await sleep(150)
        const boxes = await dockBoxes(t)
        expect(boxes.pop.shown && inside(boxes.pop, boxes.view), `${selector}: inspector at ${JSON.stringify(boxes.pop)} in ${JSON.stringify(boxes.view)}`)
        results.push(`${Math.round(boxes.pop.x)},${Math.round(boxes.pop.y)} ${Math.round(boxes.pop.w)}x${Math.round(boxes.pop.h)}`)
      }
      await t.setViewportSize({ width: 390, height: 844 })
      await sleep(300)
      await t.evaluate((sel) => window.__primp_test!.select(sel), first)
      await sleep(200)
      const narrow = await dockBoxes(t)
      const geometry = await t.evaluate(() => window.__primp_test!.geometry())
      await t.setViewportSize({ width: 1280, height: 800 })
      await sleep(200)
      expect(narrow.pop.shown && geometry.pop?.sheet === true && near(narrow.pop.x, 0) && near(narrow.pop.w, narrow.view.w) && inside(narrow.pop, narrow.view) && inside(narrow.bar, narrow.view) && narrow.pop.y + narrow.pop.h <= narrow.bar.y + 0.5, `390px: pop ${JSON.stringify(narrow.pop)}, bar ${JSON.stringify(narrow.bar)}, view ${JSON.stringify(narrow.view)}`)
      return `1280px: ${results.join(' | ')}; 390px: a ${Math.round(narrow.pop.w)}px wide sheet from y ${Math.round(narrow.pop.y)}, ending above the toolbar`
    })

    await report.attempt('pause stops a running CSS animation and resume plays it again; the rule is taken away', async () => {
      await t.evaluate(() => {
        const style = document.createElement('style')
        style.textContent = '@keyframes ux-spin { to { transform: rotate(360deg) } } .ux-spin { position: fixed; left: 4px; bottom: 4px; width: 8px; height: 8px; background: red; animation: ux-spin 1s linear infinite; }'
        const node = document.createElement('div')
        node.className = 'ux-spin'
        document.head.append(style)
        document.body.append(node)
      })
      await sleep(200)
      const time = (): Promise<number> => t.evaluate(() => Number(document.querySelector('.ux-spin')!.getAnimations()[0]!.currentTime))
      const sheets = (): Promise<number> => t.evaluate(() => document.adoptedStyleSheets.length)
      const before = await sheets()
      await t.locator('body').focus()
      await t.keyboard.press('p')
      // A pause takes hold on the next frame.
      await sleep(60)
      const pausedAt = await time()
      await sleep(250)
      const stillAt = await time()
      const during = await t.evaluate(() => ({ state: document.querySelector('.ux-spin')!.getAnimations()[0]!.playState, paused: window.__primp_test!.state().paused }))
      const withRule = await sheets()
      await t.keyboard.press('p')
      await sleep(250)
      const runningAt = await time()
      const after = await t.evaluate(() => document.querySelector('.ux-spin')!.getAnimations()[0]!.playState)
      expect(during.paused && during.state === 'paused' && Math.abs(stillAt - pausedAt) < 1 && withRule === before + 1, `paused: ${JSON.stringify(during)}, time ${pausedAt} -> ${stillAt}, sheets ${before} -> ${withRule}`)
      expect(after === 'running' && runningAt > stillAt + 100 && (await sheets()) === before, `resumed: ${after}, time ${stillAt} -> ${runningAt}, sheets ${await sheets()}`)
      await t.evaluate(() => document.querySelector('.ux-spin')?.remove())
      return `P: the animation paused at ${Math.round(pausedAt)} ms and stayed there, a pause rule added; P again: running (${Math.round(runningAt)} ms), rule gone`
    })

    await report.attempt('window.__primp_dock: open, close, toggle and panel do what the launcher and the toolbar do', async () => {
      await t.evaluate(() => window.__primp_test!.open(false))
      const steps = await t.evaluate(() => {
        const api = window.__primp_dock!
        const seen: string[] = []
        const now = (): string => `${window.__primp_test!.state().open ? 'open' : 'closed'}/${window.__primp_test!.state().panel ?? '-'}`
        api.open()
        seen.push(now())
        api.panel('changes')
        seen.push(now())
        api.panel(null)
        seen.push(now())
        seen.push(String(api.toggle()), now())
        api.panel('verify')
        seen.push(now())
        api.close()
        seen.push(now(), String(api.isOpen()))
        return seen
      })
      expect(JSON.stringify(steps) === JSON.stringify(['open/-', 'open/changes', 'open/-', 'false', 'closed/-', 'open/verify', 'closed/-', 'false']), `steps: ${steps.join(' ')}`)
      await t.evaluate(() => window.__primp_test!.open(true))
      return `open, panel('changes'), panel(null), toggle() -> false, panel('verify') opens the dock with it, close(): ${steps.join(' ')}`
    })

    await report.attempt('the toolbar, popovers, pins, chip and tooltips added no layout-shift entry that is not tagged as primp\'s own', async () => {
      for (const label of ['Changes', 'Layout shifts', 'Verification', 'Settings']) {
        await page.bar.locator(`button[aria-label="${label}"]`).click()
        await sleep(120)
      }
      await t.evaluate((selector) => window.__primp_test!.select(selector), second)
      await t.mouse.move(300, 300)
      await t.mouse.move(600, 500)
      await sleep(200)
      await t.evaluate(() => window.__primp_test!.open(false))
      await sleep(200)
      const after = await unmarkedShifts(t)
      expect(after.unmarked === shiftsBefore.unmarked, `untagged entries: ${shiftsBefore.unmarked} before, ${after.unmarked} after`)
      return `${after.unmarked - shiftsBefore.unmarked} untagged entries over opening, four panels, the inspector, hovering, pins and closing`
    })
  } finally {
    await page.close()
  }
}

async function viteEdits(browser: Browser, lane: Lane): Promise<void> {
  const page = await openDock(browser, lane, '/')
  const t = page.page
  const first = `${CARD}:nth-of-type(1)`
  try {
    await t.evaluate((selector) => window.__primp_test!.select(selector), first)
    await waitFor(async () => (await testState(t)).source?.state === 'done')

    let itemId = ''
    await report.attempt('padding on a card: computed style, before/after, longhands, origin, and a side-effect summary that matches an independent measurement', async () => {
      const pricingBefore = await rect(t, '#pricing')
      const neighbourBefore = await rect(t, `${CARD}:nth-of-type(2)`)
      const result = await t.evaluate(() => window.__primp_test!.setStyle('padding', '28px'))
      expect(result.ok, `rejected: ${result.error}`)
      const item = style(result.item)
      itemId = item.id
      const paddings = await computedAll(t, CARD, 'padding')
      expect(paddings[0] === '28px' && paddings.slice(1).every((value) => value === '20px'), `computed padding of the six cards: ${paddings.join(', ')}`)
      expect(item.before.computed === '20px' && item.before.authored === '20px' && item.after.computed === '28px' && item.after.authored === '28px', `before ${JSON.stringify(item.before)} after ${JSON.stringify(item.after)}`)
      const sides = ['padding-top', 'padding-right', 'padding-bottom', 'padding-left']
      expect(sides.every((side) => item.longhands?.[side]?.before === '20px' && item.longhands[side].after === '28px') && Object.keys(item.longhands ?? {}).length === 4, `longhands: ${JSON.stringify(item.longhands)}`)
      expect(item.status === 'draft' && item.page === '/' && item.scope === 'instance' && item.condition.media === undefined, `item: ${JSON.stringify({ status: item.status, page: item.page, scope: item.scope, condition: item.condition })}`)
      expect(item.condition.viewport.w === 1280 && item.condition.viewport.h === 800 && item.condition.colorScheme === 'light', `condition: ${JSON.stringify(item.condition)}`)
      expect(item.origin?.via === 'rule' && item.origin.selector?.includes('_card_') === true && item.origin.sheet?.includes('Card.module.css') === true, `origin: ${JSON.stringify(item.origin)}`)
      expect(item.stylingSystem === 'css-modules', `styling system: ${item.stylingSystem}`)
      expect(item.target.source?.file === 'src/components/Card.tsx' && item.target.source.line === 12, `target source: ${JSON.stringify(item.target.source)}`)
      const own = item.expect.filter((entry) => entry.type === 'computed')
      expect(own.length === 4 && own.every((entry) => entry.type === 'computed' && entry.value === '28px'), `expect: ${JSON.stringify(own)}`)
      // "This element" only: the rule also styles the five other cards, which are bystanders. Three are recorded, each with its four paddings as they were.
      const kept = item.expect.filter((entry) => entry.type === 'unchanged')
      const bystanders = item.bystanders ?? []
      expect(item.origin?.alsoStyles === 5 && bystanders.length === 3 && bystanders.every((entry) => entry.label.startsWith('article.card') && sides.every((side) => entry.values[side] === '20px')), `alsoStyles ${item.origin?.alsoStyles}; bystanders: ${JSON.stringify(bystanders.map((entry) => [entry.label, entry.values]))}`)
      expect(kept.length === 12 && kept.every((entry) => entry.type === 'unchanged' && entry.value === '20px') && item.expect.length === 16, `expect: ${JSON.stringify(item.expect.map((entry) => entry.type))}`)

      const pricingAfter = await rect(t, '#pricing')
      const neighbourAfter = await rect(t, `${CARD}:nth-of-type(2)`)
      const dy = pricingAfter.y - pricingBefore.y
      const dh = neighbourAfter.h - neighbourBefore.h
      expect(near(dy, 16) && near(dh, 16), `independent measurement: #pricing moved ${dy}px, the neighbour card grew ${dh}px (expected 16 and 16)`)
      const pricing = item.sideEffects.find((effect) => effect.selector === '#pricing')
      expect(pricing !== undefined, `no side effect for #pricing among ${item.sideEffects.map((effect) => effect.selector).join(', ')}`)
      expect(pricing.type === 'moved' && near(pricing.before.y, pricingBefore.y) && near(pricing.after.y, pricingAfter.y) && pricing.verdict === 'unreviewed', `#pricing effect: ${JSON.stringify(pricing)} vs measured ${pricingBefore.y} -> ${pricingAfter.y}`)
      const neighbour = item.sideEffects.find((effect) => effect.selector.endsWith('article:nth-of-type(2)'))
      expect(neighbour?.type === 'resized' && near(neighbour.after.h - neighbour.before.h, dh), `neighbour effect: ${JSON.stringify(neighbour)}`)
      expect(!item.sideEffects.some((effect) => effect.selector === item.target.selector), 'the edited element is listed as its own side effect')
      const summary = await t.evaluate((id) => window.__primp_test!.summary(id), item.id)
      expect(summary.includes(`moved down ${px(dy)}`) && summary.includes(`${px(dh)} taller`), `summary "${summary}" does not say "moved down ${px(dy)}" and "${px(dh)} taller"`)
      const cost = (await testState(t)).lastEffects
      const stored = await waitFor(() => lane.primp.session.item(item.id), { timeoutMs: 3000, what: 'the server to store the item' })
      expect(stored.kind === 'style' && stored.after.authored === '28px' && stored.status === 'draft', `the server stored ${JSON.stringify(stored).slice(0, 160)}`)
      return `card padding 20px -> 28px (others unchanged); longhands 4/4; origin ${item.origin.selector} in ${item.origin.sheet.split('/').pop()}; #pricing measured ${pricingBefore.y} -> ${pricingAfter.y} = recorded effect; neighbour +${dh}px = recorded; summary "${summary}"; ${item.sideEffects.length} effects in ${cost?.ms.toFixed(1)} ms over ${cost?.elements} elements`
    })

    await report.attempt('editing the same property again keeps ONE item with the original before value', async () => {
      const result = await t.evaluate(() => window.__primp_test!.setStyle('padding', '32px'))
      const item = style(result.item)
      const all = await items(t)
      expect(all.length === 1 && item.id === itemId, `${all.length} items; id ${item.id} vs ${itemId}`)
      expect(item.before.computed === '20px' && item.before.authored === '20px' && item.after.computed === '32px', `before ${JSON.stringify(item.before)} after ${JSON.stringify(item.after)}`)
      expect(item.longhands?.['padding-top']?.before === '20px' && item.longhands['padding-top'].after === '32px', `longhands: ${JSON.stringify(item.longhands?.['padding-top'])}`)
      expect((await computed(t, first, 'padding')) === '32px', 'the page does not show 32px')
      const pricing = item.sideEffects.find((effect) => effect.selector === '#pricing')
      expect(pricing !== undefined && near(pricing.after.y - pricing.before.y, 24), `side effects are not measured against the original page: ${JSON.stringify(pricing)}`)
      // The bystanders are the ones of the first edit, with the values they had then; the tray says the rule is shared.
      const bystanders = item.bystanders ?? []
      expect(item.origin?.alsoStyles === 5 && bystanders.length === 3 && bystanders.every((entry) => entry.values['padding-top'] === '20px'), `after the second edit: alsoStyles ${item.origin?.alsoStyles}; ${JSON.stringify(bystanders.map((entry) => entry.values))}`)
      const sharedLine = await waitFor(() => page.dock.evaluate(() => {
        const line = document.querySelector('.tray .item .shared')
        return line === null ? undefined : { text: line.textContent ?? '', title: line.getAttribute('title') ?? '' }
      }), { timeoutMs: 3000, what: 'the line about the shared rule in the tray' })
      expect(sharedLine.text === `rule ${item.origin?.selector} also styles 5 other elements`, `the tray says "${sharedLine.text}"`)
      expect(bystanders.every((entry) => sharedLine.title.includes(entry.label)) && sharedLine.title.includes('and 2 more'), `tooltip: ${sharedLine.title}`)
      await waitFor(() => {
        const stored = lane.primp.session.item(itemId)
        return stored?.kind === 'style' && stored.after.authored === '32px' && stored.before.computed === '20px'
      }, { timeoutMs: 3000, what: 'the server to hold the updated item' })
      expect(lane.primp.session.items().length === 1, `the server holds ${lane.primp.session.items().length} items`)
      return `1 item, same id; before 20px (authored and computed), after 32px; side effects re-measured against the original (#pricing +24px); 3 bystanders still at their original 20px; the tray says "${sharedLine.text}"`
    })

    await report.attempt('setting the property back to its original value deletes the item', async () => {
      const result = await t.evaluate(() => window.__primp_test!.setStyle('padding', '20px'))
      expect(result.ok && result.item === null, `result: ${JSON.stringify(result).slice(0, 200)}`)
      const state = await testState(t)
      expect((await items(t)).length === 0 && state.previewCss === '' && (await marks(t)) === 0, `items ${(await items(t)).length}, preview css "${state.previewCss}", marks ${await marks(t)}`)
      expect((await computed(t, first, 'padding')) === '20px', 'the page is not back at 20px')
      await waitFor(() => lane.primp.session.items().length === 0, { timeoutMs: 3000, what: 'the server to drop the item' })
      return '0 items, empty preview stylesheet, no mark left on the page, session:delete sent'
    })

    await report.attempt('an invalid value or an unknown property is rejected with a message, and nothing is recorded', async () => {
      const bad = await t.evaluate(() => window.__primp_test!.setStyle('padding', '12pxx'))
      const unknown = await t.evaluate(() => window.__primp_test!.setStyle('paddding', '12px'))
      const important = await t.evaluate(() => window.__primp_test!.setStyle('padding', '12px !important'))
      expect(!bad.ok && bad.error?.includes('not a valid value for padding') === true, `12pxx: ${JSON.stringify(bad)}`)
      expect(!unknown.ok && unknown.error?.includes('not a CSS property') === true, `paddding: ${JSON.stringify(unknown)}`)
      expect(!important.ok, '"12px !important" was accepted')
      expect((await items(t)).length === 0 && (await computed(t, first, 'padding')) === '20px', 'something was recorded or applied')
      // The same through the dock: type into the padding row and press Enter.
      await openAllCss(page)
      const input = page.dock.locator('#v-padding')
      await input.fill('12pxx')
      await input.press('Enter')
      const message = await waitFor(() => page.dock.evaluate(() => document.querySelector('.prop .msg[role="alert"]')?.textContent ?? undefined))
      const invalid = await input.getAttribute('aria-invalid')
      expect(message.includes('not a valid value') && invalid === 'true', `row message "${message}", aria-invalid ${invalid}`)
      await input.press('Escape')
      expect((await input.inputValue()) === '20px' && (await items(t)).length === 0, 'Escape did not restore the value')
      return `"12pxx" -> "${bad.error}"; "paddding" -> "${unknown.error}"; in the dock the row shows the message with aria-invalid, Escape restores 20px`
    })

    await report.attempt('the dock\'s own inputs: Enter applies, ArrowUp nudges by 1 and Shift+ArrowUp by 10', async () => {
      await openAllCss(page)
      const input = page.dock.locator('#v-padding')
      await input.fill('24px')
      await input.press('Enter')
      await waitFor(async () => (await computed(t, first, 'padding')) === '24px')
      await input.press('ArrowUp')
      await waitFor(async () => (await computed(t, first, 'padding')) === '25px')
      await input.press('Shift+ArrowUp')
      await waitFor(async () => (await computed(t, first, 'padding')) === '35px')
      await input.press('ArrowDown')
      // The item is committed a frame after the preview shows.
      await waitFor(async () => (await computed(t, first, 'padding')) === '34px' && style((await items(t))[0]).after.authored === '34px')
      await t.evaluate(() => window.__primp_overlay!.controller.idle())
      const all = await items(t)
      expect(all.length === 1 && style(all[0]).before.computed === '20px' && style(all[0]).after.authored === '34px', `items: ${JSON.stringify(all.map((item) => (item.kind === 'style' ? [item.before.computed, item.after.authored] : item.kind === 'structure' ? item.op : item.kind)))}`)
      const tray = await page.dock.evaluate(() => document.querySelector('.tray .item .change')?.textContent ?? '')
      expect(tray.includes('padding') && tray.includes('20px') && tray.includes('34px'), `tray line: "${tray}"`)
      // The run of Up/Down presses is one undo step after the Enter: two steps in all.
      await t.evaluate(() => window.__primp_test!.undo())
      const afterOne = style((await items(t))[0]).after.authored
      await t.evaluate(() => window.__primp_test!.undo())
      expect(afterOne === '24px' && (await items(t)).length === 0, `one undo: ${afterOne} (the Enter step); two undos: ${(await items(t)).length} items`)
      return `24px (Enter) -> 25px (ArrowUp) -> 35px (Shift+ArrowUp) -> 34px (ArrowDown), shown at once and recorded once the keys rested: one item, before 20px, two undo steps; the tray reads "${tray.trim()}"`
    })

    await report.attempt('undo and redo restore the page and the item list exactly', async () => {
      // `seq` is the server's numbering (a re-created item gets a new number); everything else must be identical.
      const snapshot = async () => ({
        items: JSON.stringify((await items(t)).map((item) => ({ ...item, seq: 0 }))),
        padding: await computed(t, first, 'padding'),
        gap: await computed(t, first, 'gap'),
        marks: await marks(t),
        css: (await testState(t)).previewCss,
      })
      const s0 = await snapshot()
      await t.evaluate(() => window.__primp_test!.setStyle('padding', '28px'))
      const s1 = await snapshot()
      await t.evaluate(() => window.__primp_test!.setStyle('gap', '2px'))
      const s2 = await snapshot()
      expect(s2.padding === '28px' && s2.gap === '2px' && JSON.parse(s2.items).length === 2, `after two edits: ${s2.padding}, ${s2.gap}, ${JSON.parse(s2.items).length} items`)
      await t.evaluate(() => window.__primp_test!.undo())
      const u1 = await snapshot()
      expect(JSON.stringify(u1) === JSON.stringify(s1), `after one undo the state differs from the state after the first edit:\n${JSON.stringify(u1).slice(0, 300)}\n${JSON.stringify(s1).slice(0, 300)}`)
      // The second undo with the keyboard, on the page with the dock open.
      await t.evaluate(() => window.__primp_test!.pick(true))
      await t.locator('body').focus()
      await t.keyboard.press('Control+z')
      const u0 = await snapshot()
      expect(JSON.stringify(u0) === JSON.stringify(s0), `after two undos the state differs from the start: ${JSON.stringify(u0).slice(0, 300)}`)
      await t.keyboard.press('Control+Shift+z')
      const r1 = await snapshot()
      expect(JSON.stringify(r1) === JSON.stringify(s1), 'after redo the state differs from the state after the first edit')
      await t.evaluate(() => window.__primp_test!.redo())
      const r2 = await snapshot()
      expect(JSON.stringify(r2) === JSON.stringify(s2), 'after the second redo the state differs from the state after both edits')
      const state = await testState(t)
      expect(state.canUndo && !state.canRedo, `canUndo ${state.canUndo}, canRedo ${state.canRedo}`)
      await waitFor(() => lane.primp.session.items().length === 2, { timeoutMs: 3000 })
      await t.evaluate(() => window.__primp_test!.undo())
      await t.evaluate(() => window.__primp_test!.undo())
      await waitFor(() => lane.primp.session.items().length === 0, { timeoutMs: 3000 })
      return 'two edits; undo, undo (Ctrl+Z in pick mode), redo (Ctrl+Shift+Z), redo: items JSON, computed styles, marks and preview stylesheet identical at every step; the server followed (2 items, then 0)'
    })

    await report.attempt('scope "all instances" changes all 6 cards', async () => {
      const result = await t.evaluate(() => window.__primp_test!.setStyle('border-radius', '2px', { scope: 'all-instances' }))
      const item = style(result.item)
      const radii = await computedAll(t, CARD, 'border-radius')
      expect(radii.length === 6 && radii.every((value) => value === '2px'), `border-radius of the cards: ${radii.join(', ')}`)
      expect(item.scope === 'all-instances' && item.target.instanceCount === 6 && (await marks(t)) === 6, `scope ${item.scope}, instanceCount ${item.target.instanceCount}, marks ${await marks(t)}`)
      const label = await page.dock.evaluate(() => [...document.querySelectorAll('.seg button')].map((button) => button.textContent).join(' | '))
      await t.evaluate(() => window.__primp_test!.undo())
      const back = await computedAll(t, CARD, 'border-radius')
      expect(back.every((value) => value === '12px') && (await marks(t)) === 0, `after undo: ${back.join(', ')}, marks ${await marks(t)}`)
      return `6 of 6 cards at 2px with 6 marks; the scope control reads "${label}"; undo restores 12px and removes every mark`
    })

    await report.attempt('an edit scoped to a matching @media query applies, and stops applying outside the query', async () => {
      const featured = '.plan--featured'
      await t.evaluate((selector) => window.__primp_test!.select(selector), featured)
      const options = await page.dock.evaluate(() => [...document.querySelectorAll('select option')].map((option) => option.textContent ?? ''))
      expect(options.some((option) => option.includes('(min-width: 768px)')) && options[0] === 'No media query', `media control offers: ${options.join(' | ')}`)
      const before = await computed(t, featured, 'padding-top')
      const result = await t.evaluate(() => window.__primp_test!.setStyle('padding-top', '40px', { media: '(min-width: 768px)' }))
      const item = style(result.item)
      const state = await testState(t)
      expect(item.condition.media === '(min-width: 768px)' && item.before.computed === '32px' && item.after.computed === '40px', `item: ${JSON.stringify({ condition: item.condition, before: item.before, after: item.after })}`)
      expect(item.origin?.media === '(min-width: 768px)', `origin: ${JSON.stringify(item.origin)}`)
      expect(item.expect.every((entry) => entry.type !== 'computed' || entry.condition.media === '(min-width: 768px)'), 'the expectation lost the media condition')
      expect(state.previewCss.startsWith('@media (min-width: 768px) {'), `preview rule: ${state.previewCss}`)
      const wide = await computed(t, featured, 'padding-top')
      await t.setViewportSize({ width: 600, height: 800 })
      const narrow = await computed(t, featured, 'padding-top')
      const refused = await t.evaluate(() => window.__primp_test!.setStyle('padding-bottom', '40px', { media: '(min-width: 768px)' }))
      await t.setViewportSize({ width: 1280, height: 800 })
      const again = await computed(t, featured, 'padding-top')
      expect(before === '32px' && wide === '40px' && narrow === '24px' && again === '40px', `padding-top: ${before} before, ${wide} at 1280, ${narrow} at 600, ${again} back at 1280`)
      expect(!refused.ok && refused.error?.includes('does not match') === true, `an edit under a query that does not match was accepted: ${JSON.stringify(refused).slice(0, 160)}`)
      await t.evaluate(() => window.__primp_test!.undo())
      return `padding-top 32px -> 40px inside @media (min-width: 768px) at 1280px; 24px (the unscoped rule) at 600px; 40px again at 1280px; editing under the query at 600px is refused`
    })

    await report.attempt('styling systems are told apart', async () => {
      const system = async (selector: string, property: string, value: string): Promise<string> => {
        await t.evaluate((sel) => window.__primp_test!.select(sel), selector)
        const result = await t.evaluate(([prop, val]) => window.__primp_test!.setStyle(prop, val), [property, value] as const)
        const item = style(result.item)
        await t.evaluate(() => window.__primp_test!.undo())
        return `${item.stylingSystem} (${item.origin?.via}${item.origin?.selector === undefined ? '' : ` ${item.origin.selector}`})`
      }
      const card = await system(first, 'gap', '4px')
      const header = await system('[data-label="header-inner"]', 'gap', '8px')
      const banner = await system(BANNER, 'gap', '8px')
      expect(card.startsWith('css-modules') && header.startsWith('tailwind') && banner.startsWith('plain-css'), `card: ${card}; header: ${header}; banner: ${banner}`)
      return `Card -> ${card}; Header -> ${header}; Banner -> ${banner}`
    })

    await report.attempt('hide and remove preview as display:none, the node stays, and the content below is reported as moving up by the element\'s height', async () => {
      const banner = await rect(t, BANNER)
      const mainBefore = await rect(t, '[data-label="main"]')
      await t.evaluate((selector) => window.__primp_test!.select(selector), BANNER)
      const hidden = await t.evaluate(() => window.__primp_test!.hide())
      expect(hidden.ok && hidden.item?.kind === 'structure' && hidden.item.op === 'hide', `hide: ${JSON.stringify(hidden).slice(0, 160)}`)
      const mainAfter = await rect(t, '[data-label="main"]')
      const up = mainBefore.y - mainAfter.y
      expect((await computed(t, BANNER, 'display')) === 'none' && near(up, banner.h) && banner.h > 20, `display ${await computed(t, BANNER, 'display')}; main moved up ${up}px, banner height ${banner.h}px`)
      const effect = hidden.item.sideEffects.find((entry) => entry.selector === 'main' || entry.label.startsWith('main'))
      expect(effect?.type === 'moved' && near(effect.before.y - effect.after.y, up), `effect for <main>: ${JSON.stringify(effect)}; measured ${up}px`)
      const summary = await t.evaluate((id) => window.__primp_test!.summary(id), hidden.item.id)
      expect(summary.includes(`moved up ${px(up)}`), `summary "${summary}" does not say "moved up ${px(up)}"`)
      expect(JSON.stringify(hidden.item.expect) === JSON.stringify([{ type: 'hidden' }]), `expect: ${JSON.stringify(hidden.item.expect)}`)

      const removed = await t.evaluate(() => window.__primp_test!.remove())
      const afterRemove = await items(t)
      expect(removed.ok && removed.item?.kind === 'structure' && removed.item.op === 'remove' && afterRemove.length === 1, `remove: ${JSON.stringify(removed).slice(0, 120)}; ${afterRemove.length} items`)
      expect(JSON.stringify(removed.item.expect) === JSON.stringify([{ type: 'absent' }]), `expect: ${JSON.stringify(removed.item.expect)}`)
      const removeEffect = removed.item.sideEffects.find((entry) => entry.selector === 'main' || entry.label.startsWith('main'))
      expect(removeEffect?.type === 'moved' && near(removeEffect.before.y - removeEffect.after.y, up), `effect of remove for <main>: ${JSON.stringify(removeEffect)}`)
      const still = await t.evaluate((selector) => document.querySelector(selector)?.isConnected === true, BANNER)
      expect(still && (await computed(t, BANNER, 'display')) === 'none', 'the banner node was taken out of the DOM')

      await t.evaluate(() => window.__primp_test!.undo())
      const undone = await items(t)
      expect(undone.length === 1 && undone[0]?.kind === 'structure' && undone[0].op === 'hide' && (await computed(t, BANNER, 'display')) === 'none', 'undo did not bring the hide back')
      await t.evaluate(() => window.__primp_test!.undo())
      const restored = await rect(t, '[data-label="main"]')
      expect((await items(t)).length === 0 && (await computed(t, BANNER, 'display')) === 'flex' && near(restored.y, mainBefore.y), `after undo: display ${await computed(t, BANNER, 'display')}, main at ${restored.y} (was ${mainBefore.y})`)
      return `banner ${banner.h}px high: hide -> display none, <main> measured ${mainBefore.y} -> ${mainAfter.y}, effect recorded with the same numbers, summary "${summary}"; remove replaces hide (expect absent), node still in the DOM; two undos restore the page`
    })

    await report.attempt('add-property autocomplete: every supported property, shorthands included', async () => {
      const names = await t.evaluate(() => window.__primp_test!.properties())
      const wanted = ['padding', 'margin', 'border', 'gap', 'inset', 'background', 'font', 'flex', 'grid-template-columns', 'transition']
      const missing = wanted.filter((name) => !names.includes(name))
      expect(names.length >= 300 && missing.length === 0, `${names.length} properties; missing: ${missing.join(', ')}`)
      expect(names.every((name) => name === name.toLowerCase() || name.startsWith('--')) && new Set(names).size === names.length && !names.includes('cssText') && !names.includes('css-text'), 'the list has names that are not kebab-case properties, or duplicates')
      await t.evaluate((selector) => window.__primp_test!.select(selector), first)
      await openAllCss(page)
      const input = page.dock.locator('input[aria-label="Property to add"]')
      await input.fill('pad')
      const options = await waitFor(() => page.dock.evaluate(() => {
        const list = [...document.querySelectorAll('[role="listbox"] [role="option"]')].map((option) => option.textContent ?? '')
        return list.length > 0 ? list : undefined
      }))
      expect(options[0] === 'padding' && options.includes('padding-top'), `suggestions for "pad": ${options.join(', ')}`)
      await input.press('Enter')
      await page.dock.locator('input[aria-label="Value of the property to add"]').fill('0.5')
      await page.dock.locator('input[aria-label="Property to add"]').fill('opacity')
      await page.dock.locator('input[aria-label="Value of the property to add"]').press('Enter')
      await waitFor(async () => (await computed(t, first, 'opacity')) === '0.5' && (await items(t)).length === 1)
      const added = style((await items(t))[0])
      expect(added.property === 'opacity' && added.before.computed === '1' && added.origin?.via === 'default', `added: ${JSON.stringify({ property: added.property, before: added.before, origin: added.origin })}`)
      await t.evaluate(() => window.__primp_test!.undo())
      return `${names.length} properties, all of ${wanted.join(', ')} present; typing "pad" suggests ${options.slice(0, 4).join(', ')}...; "opacity: 0.5" added through the row (before 1, origin default)`
    })
  } finally {
    await page.close()
  }
}

async function viteVerdictAndSend(browser: Browser, lane: Lane): Promise<void> {
  const page = await openDock(browser, lane, '/', { context: { permissions: ['clipboard-read', 'clipboard-write'] } })
  const t = page.page
  const first = `${CARD}:nth-of-type(1)`
  try {
    const resolved = (): Promise<unknown> => waitFor(async () => (await testState(t)).source?.state === 'done', { timeoutMs: 20_000, what: 'the source position to resolve' })
    await report.attempt('marking a side effect unwanted sets the verdict and derives a must-not-move expectation', async () => {
      await t.evaluate((selector) => window.__primp_test!.select(selector), first)
      await resolved()
      const result = await t.evaluate(() => window.__primp_test!.setStyle('padding', '28px'))
      const item = style(result.item)
      const index = item.sideEffects.findIndex((effect) => effect.selector === '#pricing')
      expect(index >= 0, 'no #pricing side effect')
      // Through the dock: open the chip, tick "unwanted".
      await page.dock.locator('.tray .item button.chip').click()
      await page.dock.locator('.effects .effect').nth(index).locator('input[type="checkbox"]').check()
      const updated = await waitFor(async () => {
        const now = (await items(t)).find((entry) => entry.id === item.id)
        return now?.sideEffects[index]?.verdict === 'unwanted' ? now : undefined
      })
      const noMove = updated.expect.find((entry): entry is Extract<Expectation, { type: 'no-move' }> => entry.type === 'no-move')
      expect(noMove !== undefined && noMove.rect.y === item.sideEffects[index]!.before.y && noMove.locator.id === 'pricing' && noMove.tolerancePx > 0, `expect: ${JSON.stringify(updated.expect).slice(0, 300)}`)
      const back = await t.evaluate(([id, at]) => window.__primp_test!.setVerdict(id, at, 'unreviewed'), [item.id, index] as const)
      expect(back?.expect.every((entry) => entry.type !== 'no-move') === true, 'clearing the verdict left the constraint')
      await t.evaluate(([id, at]) => window.__primp_test!.setVerdict(id, at, 'unwanted'), [item.id, index] as const)
      await waitFor(() => {
        const stored = lane.primp.session.item(item.id)
        return stored?.sideEffects[index]?.verdict === 'unwanted' && stored.expect.some((entry) => entry.type === 'no-move')
      }, { timeoutMs: 3000, what: 'the server to hold the verdict' })
      return `ticking "unwanted" for #pricing in the dock: verdict unwanted, expectation no-move at y=${noMove.rect.y} (the BEFORE rectangle), sent to the server; unticking removes it`
    })

    await report.attempt('Send (clicked in the dock): prompt on the clipboard, previews off, items queued, the message shown', async () => {
      await t.evaluate((selector) => window.__primp_test!.select(selector), BANNER)
      await resolved()
      await t.evaluate(() => window.__primp_test!.hide())
      await t.evaluate((id) => window.__primp_test!.setNote(id, 'Keep the pricing section where it is.'), (await items(t))[0]!.id)
      expect((await computed(t, first, 'padding')) === '28px' && (await computed(t, BANNER, 'display')) === 'none', 'the two previews are not applied before sending')
      await page.bar.locator('button[aria-label="Changes"]').click()
      const button = page.dock.locator('.foot button.primary')
      const label = (await button.textContent()) ?? ''
      expect(label.includes('Send 2 changes'), `Send button reads "${label}"`)
      await button.click()
      const notice = await waitFor(() => page.dock.evaluate(() => document.querySelector('.notice')?.textContent ?? undefined), { timeoutMs: 5000 })
      expect(notice.includes(SENT_TEXT), `the dock says "${notice}"`)
      const clipboard = await t.evaluate(() => navigator.clipboard.readText())
      const batches = lane.primp.session.batches()
      expect(batches.length === 1 && batches[0]?.itemIds.length === 2, `batches on the server: ${JSON.stringify(batches).slice(0, 200)}`)
      // The prompt is the engine's; it must carry what was recorded here.
      const wanted = ['src/components/Card.tsx', 'padding', '20px', '28px', 'src/components/Banner.tsx', 'Keep the pricing section where it is.', '#pricing']
      const missing = wanted.filter((text) => !clipboard.includes(text))
      expect(missing.length === 0, `the prompt on the clipboard lacks ${missing.join(', ')}:\n${clipboard.slice(0, 600)}`)
      const state = await testState(t)
      expect((await computed(t, first, 'padding')) === '20px' && (await computed(t, BANNER, 'display')) === 'flex' && state.previewCss === '' && (await marks(t)) === 0, `previews are still on: padding ${await computed(t, first, 'padding')}, banner ${await computed(t, BANNER, 'display')}, css "${state.previewCss}", marks ${await marks(t)}`)
      const all = await items(t)
      expect(all.length === 2 && all.every((item) => item.status === 'queued' && item.batchId !== undefined), `items: ${all.map((item) => item.status).join(', ')}`)
      expect(all[0]?.note === 'Keep the pricing section where it is.', `note: ${all[0]?.note}`)
      expect(!state.canUndo && state.sent?.copied === true && state.sent.count === 2, `state: ${JSON.stringify({ canUndo: state.canUndo, sent: state.sent })}`)
      await t.evaluate(() => window.__primp_test!.openTab('verify'))
      const verify = await waitFor(() => page.dock.evaluate(() => {
        const rows = [...document.querySelectorAll('[data-item] [data-status]')].map((chip) => chip.getAttribute('data-status'))
        return rows.length === 2 ? rows : undefined
      }))
      expect(verify.every((status) => status === 'queued'), `Verify tab: ${verify.join(', ')}`)
      return `"${label.trim()}" -> one batch of 2 on the server; the clipboard holds the engine's prompt (${clipboard.length} chars, naming Card.tsx, Banner.tsx, the values, the note and the must-not-move constraint); previews off (padding 20px, banner shown, no marks); both items queued; Verify tab lists them; the dock says "${SENT_TEXT}"`
    })

    await report.attempt('Verify tab renders what the server sends: statuses and per-check results', async () => {
      const [a, b] = await items(t)
      expect(a !== undefined && b !== undefined && a.kind === 'style', 'expected two sent items')
      const check = a.expect[0]!
      lane.primp.session.patchItem(a.id, {
        status: 'failed',
        verification: {
          itemId: a.id,
          attempt: 1,
          at: Date.now(),
          status: 'fail',
          checks: [{ expectation: check, status: 'fail', expected: '28px', actual: '24px', delta: 4 }],
          settle: { status: 'settled', signal: 'hmr', ms: 412, filesChanged: ['src/components/Card.module.css'] },
          hint: 'padding-top is 24px, expected 28px.',
        },
      })
      lane.primp.session.patchItem(b.id, { status: 'verified' })
      const text = await waitFor(() => page.dock.evaluate(() => {
        const body = document.querySelector('#panel')?.textContent ?? ''
        return body.includes('expected 28px') ? body : undefined
      }))
      const statuses = await page.dock.evaluate(() => [...document.querySelectorAll('[data-item] [data-status]')].map((chip) => chip.getAttribute('data-status')))
      expect(statuses.includes('failed') && statuses.includes('verified'), `statuses: ${statuses.join(', ')}`)
      // The settle signal is on the result chip's tooltip; the agent's hint is folded under "What your agent was told".
      const settled = await page.dock.evaluate(() => [...document.querySelectorAll('#panel [data-item] .chip[title]')].map((chip) => chip.getAttribute('title') ?? '').find((title) => title.includes('settled')) ?? '')
      expect(text.includes('got 24px') && text.includes('The page does not show what you asked for yet.') && text.includes('What your agent was told') && text.includes('padding-top is 24px, expected 28px.') && settled.includes('hmr'), `Verify tab text: ${text.slice(0, 400)}; settle tooltip "${settled}"`)
      // A verification that starts is shown as running; a failed item can be handed back as a fix-up prompt.
      lane.primp.session.broadcastVerifying([b.id])
      const running = await waitFor(() => page.dock.evaluate((id) => document.querySelector(`[data-item="${id}"] [data-checking]`)?.textContent ?? undefined, b.id), { what: 'the checking chip', timeoutMs: 3000 })
      const fixupButton = await page.dock.evaluate(() => [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Copy fix-up'))
      expect(running.includes('checking') && fixupButton, `checking chip "${running}", Copy fix-up button ${fixupButton}`)
      // Its result arriving ends the checking state.
      const previous = lane.primp.session.item(b.id)!.verification ?? { itemId: b.id, attempt: 0, at: 0, status: 'pass' as const, checks: [], hint: '' }
      lane.primp.session.patchItem(b.id, { verification: { ...previous, attempt: previous.attempt + 1, at: Date.now() } })
      const after = await waitFor(() => page.dock.evaluate((id) => {
        const chip = document.querySelector(`[data-item="${id}"] .item-head [data-status]`)
        return chip === null || chip.hasAttribute('data-checking') ? undefined : chip.getAttribute('data-status')
      }, b.id), { what: 'the checking chip to go once the result is in', timeoutMs: 3000 })
      expect(after === 'verified', `after the result: ${after}`)
      await t.evaluate(() => window.__primp_test!.openTab('edits'))
      return `a failed item shows "fail", what it means for the person, the check (expected 28px, got 24px, off by 4), the agent's hint folded away and the settle signal "${settled}" on the chip; the other shows "verified"`
    })

    await report.attempt('send() through the test handle returns the prompt; without clipboard access the prompt is shown for manual copying', async () => {
      const denied = await openDock(browser, lane, '/', { keepSession: true })
      try {
        await denied.page.evaluate((selector) => window.__primp_test!.select(selector), first)
        await denied.page.evaluate(() => window.__primp_test!.setStyle('gap', '2px'))
        // Make the clipboard refuse, as it does without focus or permission.
        for (const frame of [denied.dock, denied.bar]) {
          await frame.evaluate(() => {
            Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) } })
          })
        }
        await denied.page.evaluate(() => {
          Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) } })
        })
        const prompt = await denied.page.evaluate(() => window.__primp_test!.send())
        const state = await testState(denied.page)
        const shown = await waitFor(() => denied.dock.evaluate(() => (document.querySelector('textarea.prompt') as HTMLTextAreaElement | null)?.value ?? undefined))
        expect(prompt.includes('gap') && prompt.includes('2px') && prompt.includes('Card.tsx') && shown === prompt && state.sent?.copied === false, `shown ${shown === prompt}, copied ${state.sent?.copied}, prompt:\n${prompt}`)
        expect((await computed(denied.page, first, 'gap')) === '8px' && state.previewCss === '', 'the preview is still on after send()')
        return `send() -> "${prompt.split('\n')[0]}" (${prompt.length} chars); clipboard refused -> the same text in a read-only textarea; preview off`
      } finally {
        await denied.close()
      }
    })
  } finally {
    await page.close()
  }
}

async function viteHmr(browser: Browser, lane: Lane): Promise<void> {
  const page = await openDock(browser, lane, '/')
  const t = page.page
  const third = `${CARD}:nth-of-type(3)`
  const RED = 'rgb(255, 0, 0)'
  try {
    await waitFor(() => page.record.webSockets.some((url) => !url.includes('/__primp/')) && lane.primp.hmr.status().live, { what: 'the HMR socket' })
    await t.evaluate((selector) => window.__primp_test!.select(selector), third)
    const result = await t.evaluate((value) => window.__primp_test!.setStyle('background-color', value), RED)
    const item = style(result.item)
    expect((await computed(t, third, 'background-color')) === RED, 'the preview was not applied')

    const reverts: (() => void)[] = []
    await report.attempt('hot update that re-renders the component: the pending preview is still applied', async () => {
      reverts.push(editFile(lane.fixture, 'src/components/Card.tsx', replaceOnce('<article data-label="card" className={styles.card}>', '<article data-label="card" data-rev="2" className={styles.card}>')).revert)
      await waitFor(() => t.evaluate(() => document.querySelectorAll('[data-rev="2"]').length === 6), { what: 'the hot update' })
      await sleep(200)
      const state = await testState(t)
      expect((await computed(t, third, 'background-color')) === RED && state.detached.length === 0, `background ${await computed(t, third, 'background-color')}, detached ${state.detached.join(',')}`)
      expect(page.record.documentRequests.length === 1, 'the page reloaded')
      return 'Card.tsx edited (new attribute), React re-rendered in place: card 3 still red, nothing detached, no reload'
    })

    await report.attempt('hot update that REPLACES the nodes: the preview follows the new node (found again by its locator)', async () => {
      await t.evaluate((selector) => {
        ;(window as unknown as { __old: Element | null }).__old = document.querySelector(selector)
      }, third)
      reverts.push(editFile(lane.fixture, 'src/components/Features.tsx', replaceOnce('key={card.id}', "key={card.id + '-remounted'}")).revert)
      await waitFor(() => t.evaluate(() => (window as unknown as { __old: Element | null }).__old?.isConnected === false), { what: 'React to replace the card nodes' })
      const followed = await waitFor(async () => ((await computed(t, third, 'background-color')) === RED ? true : undefined), { timeoutMs: 3000, what: 'the preview to be applied to the new node' })
      const facts = await t.evaluate(([selector, uid]) => ({ mark: document.querySelector(selector)?.getAttribute('data-primp-id'), marks: document.querySelectorAll('[data-primp-id]').length, uid }), [third, item.target.uid] as const)
      const state = await testState(t)
      expect(followed && facts.mark === item.target.uid && facts.marks === 1 && state.detached.length === 0, `mark ${facts.mark} (want ${facts.uid}), ${facts.marks} marks, detached ${state.detached.join(',')}`)
      expect((await items(t)).length === 1, 'the item was lost')
      return `Features.tsx edited (new keys), all six cards remounted: the new third card carries the mark ${facts.mark} and is red; 1 item, nothing detached`
    })

    await report.attempt('hot update after which the element cannot be found: the item is flagged detached, not lost; it re-attaches when the element is back', async () => {
      const toSection = editFile(lane.fixture, 'src/components/Card.tsx', (source) => source.replace('<article data-label="card"', '<section data-label="card"').replace('</article>', '</section>'))
      await waitFor(() => t.evaluate(() => document.querySelectorAll('section[data-label="card"]').length === 6), { what: 'the cards to become <section>' })
      const detached = await waitFor(async () => {
        const state = await testState(t)
        return state.detached.includes(item.id) ? state : undefined
      }, { timeoutMs: 3000, what: 'the item to be flagged detached' })
      const chip = await page.dock.evaluate(() => document.querySelector('.tray .item.detached .chip.warn')?.textContent ?? '')
      const all = await items(t)
      expect(all.length === 1 && all[0]?.id === item.id && chip.includes('not found'), `${all.length} items; chip "${chip}"; detached ${detached.detached.join(',')}`)
      const wrongly = await t.evaluate(() => document.querySelectorAll('[data-primp-id]').length)
      expect(wrongly === 0, `${wrongly} element(s) carry the mark although the target is gone`)
      toSection.revert()
      await waitFor(() => t.evaluate(() => document.querySelectorAll('article[data-label="card"]').length === 6), { what: 'the cards to be <article> again' })
      await waitFor(async () => (await computed(t, third, 'background-color')) === RED && (await testState(t)).detached.length === 0, { timeoutMs: 3000, what: 'the preview to re-attach' })
      return `cards turned into <section>: item kept, flagged detached, the tray says "${chip.trim()}", no other element marked; reverted: re-attached and red again`
    })
    // Leave the working copy as it was for the checks that follow.
    for (const revert of reverts.reverse()) revert()
    await waitFor(() => t.evaluate(() => document.querySelectorAll('[data-rev="2"]').length === 0), { what: 'the fixture source to be restored' })
  } finally {
    await page.close()
  }
}

async function viteMeasure(browser: Browser, lane: Lane): Promise<void> {
  const page = await openDock(browser, lane, '/')
  const t = page.page
  const first = `${CARD}:nth-of-type(1)`
  /** The card rule is in the stylesheet with this padding and the cards carry a class that rule matches (the module hash changes with the file). */
  const sourceApplied = (padding: string): Promise<boolean> =>
    t.evaluate(([selector, value]) => {
      const sheet = [...document.querySelectorAll('style')].find((style) => (style.getAttribute('data-vite-dev-id') ?? '').includes('Card.module.css'))
      const card = document.querySelector(selector)
      return sheet !== undefined && card !== null && (sheet.textContent ?? '').includes(`padding: ${value}`) && (sheet.textContent ?? '').includes(`.${card.classList[0]} `) && getComputedStyle(card).display === 'flex'
    }, [first, padding] as const)
  let revert: (() => void) | undefined
  try {
    await waitFor(() => page.record.webSockets.some((url) => !url.includes('/__primp/')) && lane.primp.hmr.status().live, { what: 'the HMR socket' })
    await t.evaluate((selector) => window.__primp_test!.select(selector), first)
    const result = await t.evaluate(() => window.__primp_test!.setStyle('padding', '28px', { scope: 'all-instances' }))
    const item = style(result.item)
    const ask = async () => {
      const outcome = await lane.primp.session.measure([item], 5000)
      if (outcome.status !== 'measured') throw new Error(`session.measure: ${outcome.status}`)
      return outcome
    }

    await report.attempt('session:measure before the source changed: previews are switched off for the measurement, so nothing reads as done', async () => {
      const answer = await ask()
      const checks = answer.results[0]?.checks ?? []
      expect(answer.visible && answer.results.length === 1 && answer.results[0]?.found === true && (answer.results[0]?.locatorConfidence ?? 0) >= 0.9, `answer: ${JSON.stringify(answer).slice(0, 300)}`)
      expect(checks.length === 4 && checks.every((check) => check.status === 'fail' && check.expected === '28px' && check.actual === '20px'), `checks: ${JSON.stringify(checks.map((check) => [check.status, check.expected, check.actual]))}`)
      const state = await testState(t)
      expect(!state.previewsSuspended && (await computed(t, first, 'padding')) === '28px', 'the previews were not switched back on')
      return `the server asked over the socket: 4 raw checks, expected 28px / actual 20px (fail) although the preview shows 28px; locator confidence ${answer.results[0]?.locatorConfidence}; previews back on afterwards`
    })

    await report.attempt('session:measure after the source was edited to match (hot update): raw results that read as pass', async () => {
      revert = editFile(lane.fixture, 'src/components/Card.module.css', replaceOnce('padding: 20px;', 'padding: 28px;')).revert
      await waitFor(() => sourceApplied('28px'), { what: 'the stylesheet hot update to be applied to the cards' })
      const answer = await ask()
      const checks = answer.results[0]?.checks ?? []
      expect(checks.length === 4 && checks.every((check) => check.status === 'pass' && check.expected === '28px' && check.actual === '28px'), `checks: ${JSON.stringify(checks.map((check) => [check.status, check.expected, check.actual]))}`)
      expect(page.record.documentRequests.length === 1, 'the page reloaded')
      return `Card.module.css changed to padding: 28px, applied by HMR (new module class on the cards): 4 raw checks pass (expected 28px, actual 28px), measured with previews off`
    })

    await report.attempt('raw measurements: relative values resolved on the element, wrong values, structure and position', async () => {
      const condition = item.condition
      const locator = item.target.locator
      const now = await rect(t, first)
      const answer = await t.evaluate(
        ([loc, cond, box]) =>
          window.__primp_test!.measure([
            {
              itemId: 'probe',
              locator: loc,
              expect: [
                { type: 'computed', property: 'padding-top', value: '1.75rem', condition: cond },
                { type: 'computed', property: 'padding-top', value: '30px', condition: cond },
                { type: 'computed', property: 'padding', value: '28px', condition: cond },
                { type: 'computed', property: 'border', value: '1px solid #e2e8f0', condition: cond },
                { type: 'hidden' },
                { type: 'absent' },
                { type: 'no-move', label: 'card', locator: loc, rect: box, tolerancePx: 1 },
                { type: 'no-move', label: 'card', locator: loc, rect: { ...box, y: box.y + 40 }, tolerancePx: 1 },
              ],
            },
            { itemId: 'gone', locator: { tag: 'video', indexPath: [0, 9], ancestors: ['body'] }, expect: [{ type: 'absent' }, { type: 'hidden' }] },
          ]),
        [locator, condition, now] as const,
      )
      const checks = answer.results[0]!.checks
      const gone = answer.results[1]!
      const lines = checks.map((check) => `${check.expectation.type}: ${check.status} (${check.expected} | ${check.actual})`)
      expect(JSON.stringify(checks.map((check) => check.status)) === JSON.stringify(['pass', 'fail', 'pass', 'pass', 'fail', 'fail', 'pass', 'fail']), lines.join('\n'))
      expect(checks[0]!.expected === '28px' && checks[1]!.expected === '30px' && checks[1]!.actual === '28px', `1.75rem was resolved to "${checks[0]!.expected}"; ${lines[1]}`)
      expect(checks[3]!.expected === '1px solid rgb(226, 232, 240)', `the border value was resolved to "${checks[3]!.expected}"`)
      expect(checks[4]!.actual === 'rendered' && checks[5]!.actual === 'rendered', `hidden/absent on a visible element: ${lines[4]}; ${lines[5]}`)
      const rectNow = JSON.parse(checks[6]!.actual) as { x: number; y: number; w: number; h: number }
      expect(near(rectNow.y, now.y) && near(rectNow.h, now.h) && near(checks[7]!.delta ?? 0, 40) && JSON.parse(checks[7]!.expected).y === now.y + 40, `no-move: ${lines[6]}; ${lines[7]}`)
      expect(!gone.found && gone.checks[0]!.status === 'pass' && gone.checks[0]!.actual === 'absent' && gone.checks[1]!.status === 'unresolved', `missing element: ${JSON.stringify(gone)}`)
      // The selection cursor of the open dock is a sheet of its own; it is not part of measuring.
      const left = await t.evaluate(() => document.adoptedStyleSheets.filter((sheet) => ![...sheet.cssRules].some((rule) => rule.cssText.includes('crosshair'))).map((sheet) => sheet.cssRules.length))
      expect((await computed(t, first, 'padding')) === '28px' && left.filter((rules) => rules > 0).length === 1, `after measuring: adopted sheets with rules ${JSON.stringify(left)}`)
      return `1.75rem -> expected "28px" (pass); 30px fail; shorthand padding pass; "1px solid #e2e8f0" -> "1px solid rgb(226, 232, 240)" (pass); hidden/absent report "rendered"; no-move carries the rectangle now as JSON (pass; fail with delta 40 against a shifted one); a missing element: absent "absent" (pass), hidden unresolved; the probe rule is gone afterwards`
    })

    await report.attempt('a media-scoped expectation outside its viewport is not_measurable, never pass', async () => {
      const featured = await t.evaluate(() => window.__primp_test!.select('.plan--featured'))
      const expectation: Expectation = { type: 'computed', property: 'padding-top', value: '32px', condition: { media: '(min-width: 768px)', viewport: { w: 1280, h: 800, dpr: 1 }, colorScheme: 'light' } }
      const measureNow = () => t.evaluate(([loc, exp]) => window.__primp_test!.measure([{ itemId: 'media', locator: loc, expect: [exp] }]), [featured.locator, expectation] as const)
      const wide = (await measureNow()).results[0]!.checks[0]!
      await t.setViewportSize({ width: 600, height: 800 })
      const narrow = (await measureNow()).results[0]!.checks[0]!
      await t.setViewportSize({ width: 1280, height: 800 })
      expect(wide.status === 'pass' && wide.actual === '32px', `at 1280: ${JSON.stringify(wide)}`)
      expect(narrow.status === 'not_measurable' && narrow.note?.includes('600x800') === true, `at 600: ${JSON.stringify(narrow)}`)
      return `at 1280px the check is measured (pass, 32px); at 600px: not_measurable ("${narrow.note}")`
    })

    await report.attempt('end to end with the real verifier: send, the source already matches, "Check again" in the dock -> verified', async () => {
      await t.evaluate(() => window.__primp_test!.send())
      expect(lane.primp.session.item(item.id)?.status === 'queued', `status on the server: ${lane.primp.session.item(item.id)?.status}`)
      await t.evaluate(() => window.__primp_test!.openTab('verify'))
      await page.dock.locator('[data-item] button', { hasText: 'Check again' }).click()
      const verified = await waitFor(() => {
        const stored = lane.primp.session.item(item.id)
        return stored?.verification !== undefined ? stored : undefined
      }, { timeoutMs: 15_000, what: 'the server to verify the item' })
      const shown = await waitFor(() => page.dock.evaluate(() => {
        const row = document.querySelector('[data-item]')
        const status = row?.querySelector('[data-status]')?.getAttribute('data-status')
        return status === 'queued' || status === undefined ? undefined : { status, text: row?.textContent ?? '' }
      }), { timeoutMs: 5000, what: 'the Verify tab to show the result' })
      expect(verified.verification?.status === 'pass' && verified.status === 'verified', `the server judged: ${JSON.stringify(verified.verification).slice(0, 400)}`)
      expect(shown.status === 'verified' && shown.text.includes('pass') && shown.text.includes('padding-top'), `Verify tab: ${JSON.stringify(shown).slice(0, 300)}`)
      return `the dock sent session:reverify; the server settled, asked the dock to measure, judged the raw checks with the engine: ${verified.verification.status} (${verified.verification.checks.length} checks, settle ${verified.verification.settle?.status}/${verified.verification.settle?.signal}); the Verify tab shows "verified" with the per-check rows`
    })

    await report.attempt('Take back: a sent change nobody has taken becomes a draft again, with its preview back on the page', async () => {
      await t.evaluate(() => window.__primp_test!.select('[data-label="hero-title"]'))
      const edit = await t.evaluate(() => window.__primp_test!.setStyle('letter-spacing', '3px'))
      expect(edit.ok && edit.item !== null, `not recorded: ${edit.error}`)
      const id = edit.item!.id
      await t.evaluate(() => window.__primp_test!.send())
      const sentLooks = await computed(t, '[data-label="hero-title"]', 'letter-spacing')
      expect(lane.primp.session.item(id)?.status === 'queued' && sentLooks !== '3px', `after Send: ${lane.primp.session.item(id)?.status}, letter-spacing ${sentLooks}`)
      await t.evaluate(() => window.__primp_test!.openTab('verify'))
      await page.dock.locator(`[data-item="${id}"] button`, { hasText: 'Take back' }).click()
      await waitFor(() => lane.primp.session.item(id)?.status === 'draft', { what: 'the server to take it back', timeoutMs: 3000 })
      const back = await waitFor(async () => {
        const value = await computed(t, '[data-label="hero-title"]', 'letter-spacing')
        return value === '3px' ? value : undefined
      }, { what: 'the preview to come back', timeoutMs: 3000 })
      const drafts = (await items(t)).filter((one) => one.status === 'draft').map((one) => one.id)
      expect(drafts.includes(id), `drafts in the dock: ${drafts.join(', ')}`)
      await t.evaluate((one) => window.__primp_overlay!.controller.deleteItem(one), id)
      return `queued -> Take back -> draft on the server and in the dock; letter-spacing ${back} shown again`
    })

    await report.attempt('Show what you asked: the sent change on the page again while it is on, never in a measurement, gone when off', async () => {
      await t.evaluate(() => window.__primp_test!.select('[data-label="hero-title"]'))
      const edit = await t.evaluate(() => window.__primp_test!.setStyle('letter-spacing', '4px'))
      const id = edit.item!.id
      await t.evaluate(() => window.__primp_test!.send())
      const before = await computed(t, '[data-label="hero-title"]', 'letter-spacing')
      await t.evaluate(() => window.__primp_test!.openTab('verify'))
      await page.dock.locator('button', { hasText: 'Show what you asked' }).click()
      const shown = await computed(t, '[data-label="hero-title"]', 'letter-spacing')
      // A measurement switches it off: the check sees the page as the source makes it.
      const measured = await t.evaluate((one) => {
        const item = window.__primp_overlay!.controller.store.items.value.find((entry) => entry.id === one)!
        return window.__primp_test!.measure([{ itemId: one, locator: item.target.locator, expect: item.expect }])
      }, id)
      const actual = measured.results[0]?.checks[0]?.actual
      await page.dock.locator('button', { hasText: 'Showing what you asked' }).click()
      const after = await computed(t, '[data-label="hero-title"]', 'letter-spacing')
      expect(before !== '4px' && shown === '4px' && after === before, `before ${before}, shown ${shown}, after ${after}`)
      expect(actual === before, `measured with it on: ${actual} (the page without it: ${before})`)
      return `letter-spacing ${before} -> ${shown} while shown, measured as ${actual}, ${after} after`
    })
  } finally {
    revert?.()
    if (revert !== undefined) await waitFor(() => sourceApplied('20px'), { what: 'the fixture source to be restored' }).catch(() => undefined)
    await page.close()
  }
}

async function viteKeyboardAndConnection(browser: Browser, lane: Lane): Promise<void> {
  const page = await openDock(browser, lane, '/')
  const t = page.page
  const first = `${CARD}:nth-of-type(1)`
  try {
    await t.evaluate((selector) => window.__primp_test!.select(selector), first)
    await t.evaluate(() => window.__primp_test!.setStyle('padding', '30px'))
    await t.evaluate(() => window.__primp_test!.setStyle('gap', '2px'))

    await report.attempt('keyboard: Tab reaches every control of the dock, in order', async () => {
      const total = await page.dock.evaluate(() => {
        const controls = [...document.querySelectorAll<HTMLElement>('button, input, select, textarea, summary, [tabindex]')].filter(
          // `checkVisibility` is false inside a closed <details>, whose content keeps its boxes.
          (control) => !(control as HTMLButtonElement).disabled && control.tabIndex >= 0 && control.checkVisibility(),
        )
        controls.forEach((control, index) => control.setAttribute('data-k', String(index)))
        controls[0]?.focus()
        return controls.length
      })
      const visited = ['0']
      for (let i = 0; i < total + 3; i++) {
        await t.keyboard.press('Tab')
        const key = await page.dock.evaluate(() => (document.hasFocus() ? (document.activeElement?.getAttribute('data-k') ?? null) : null))
        if (key === null) break
        visited.push(key)
      }
      const expected = Array.from({ length: total }, (_, index) => String(index))
      const missing = expected.filter((key) => !visited.includes(key))
      const labels = await page.dock.evaluate((keys) => keys.map((key) => {
        const control = document.querySelector(`[data-k="${key}"]`)
        return `${control?.localName}:${(control?.getAttribute('aria-label') ?? control?.textContent ?? control?.id ?? '').trim().slice(0, 24)}`
      }), missing)
      expect(total >= 25 && missing.length === 0 && JSON.stringify(visited) === JSON.stringify(expected), `${visited.length} of ${total} controls reached; missing: ${labels.join(', ')}; order ${visited.join(',')}`)
      const unlabelled = await page.dock.evaluate(() => [...document.querySelectorAll<HTMLElement>('button, input, select, textarea')].filter((control) => {
        const text = (control.getAttribute('aria-label') ?? control.textContent ?? '').trim()
        const labelled = control.id !== '' && document.querySelector(`label[for="${control.id}"]`) !== null
        return text === '' && !labelled && control.closest('label') === null
      }).length)
      expect(unlabelled === 0, `${unlabelled} controls have no accessible name`)
      const ring = await page.dock.evaluate(() => {
        const control = document.querySelector<HTMLElement>('[data-k="1"]')
        control?.focus()
        return control === null ? '' : getComputedStyle(control).outlineStyle
      })
      expect(ring === 'solid', `a control focused from the keyboard shows outline-style "${ring}"`)
      return `${total} focusable controls (header, tabs, pick, breadcrumb, scope, media, property inputs, add row, hide/remove, tray, undo/redo/send), all reached by Tab in DOM order; every control has a name; keyboard focus draws a ring`
    })

    await report.attempt('close to the launcher and open again, move to another corner', async () => {
      await page.bar.locator('button[aria-label="Close primp"]').click()
      await sleep(350)
      const small = await t.evaluate(() => {
        const frame = document.querySelector('primp-root')!.shadowRoot!.querySelector('iframe[data-primp-dock="bar"]')!
        const r = frame.getBoundingClientRect()
        return { w: r.width, h: r.height, right: document.documentElement.clientWidth - r.right, bottom: innerHeight - r.bottom }
      })
      await waitFor(() => page.bar.evaluate(() => document.activeElement?.classList.contains('launcher') === true), { timeoutMs: 2000, what: 'focus to land on the launcher' })
      const launcher = await page.bar.evaluate(() => ({ label: document.querySelector('.launcher')?.getAttribute('aria-label') ?? '', focused: document.activeElement?.classList.contains('launcher') ?? false }))
      expect(small.w === 44 && small.h === 44 && near(small.right, 16) && near(small.bottom, 16) && launcher.label.includes('2 unsent changes') && launcher.focused, `closed: ${JSON.stringify(small)}, ${JSON.stringify(launcher)}`)
      await page.bar.locator('.launcher').press('Enter')
      expect((await testState(t)).open, 'Enter on the launcher did not open the dock')
      await page.bar.locator('button[aria-label="Settings"]').click()
      await page.dock.locator('button[aria-label="Move the dock to the next corner"]').click()
      await sleep(400)
      const moved = await t.evaluate(() => {
        const r = document.querySelector('primp-root')!.shadowRoot!.querySelector('iframe[data-primp-dock="bar"]')!.getBoundingClientRect()
        return { left: Math.round(r.left), bottom: Math.round(innerHeight - r.bottom), w: Math.round(r.width) }
      })
      expect(moved.left === 16 && moved.bottom === 16 && moved.w > 300, `after moving: ${JSON.stringify(moved)}`)
      return `closed to the 44x44 launcher in the corner (label "${launcher.label}", focus kept on it), opened with Enter, moved to the bottom-left corner from the settings`
    })

    await report.attempt('primp is restarted under a Vite app (whose own client then reloads the page): no draft is lost', async () => {
      const loads = page.record.documentRequests.length
      const closing = lane.primp.close()
      await waitFor(async () => !(await testState(t)).connected, { timeoutMs: 3000, what: 'the dock to notice the lost connection' })
      const indicator = await waitFor(() => page.bar.evaluate(() => (document.querySelector('.conn')?.getAttribute('aria-label') === 'Reconnecting' ? 'Reconnecting' : undefined)), { timeoutMs: 1500, what: 'the indicator to say Reconnecting' })
      const header = await page.dock.evaluate(() => document.querySelector('.project')?.textContent ?? '')
      // An edit made while primp is down is kept too. (Closing the dock let go of the selection.)
      await t.evaluate((selector) => window.__primp_test!.select(selector), first)
      const offline = await t.evaluate(() => window.__primp_test!.setStyle('border-radius', '6px'))
      expect(offline.ok && indicator === 'Reconnecting' && header.includes('reconnecting'), `edit while down: ${JSON.stringify(offline).slice(0, 100)}; indicator "${indicator}", header "${header}"`)
      await closing
      await sleep(500)
      await restartPrimp(lane)
      await waitFor(() => lane.primp.session.items().length === 3, { timeoutMs: 20_000, what: `the three drafts to arrive at the new, empty session (it has ${lane.primp.session.items().length})` })
      await waitFor(() => t.evaluate(() => window.__primp_test?.state().connected === true).catch(() => false), { timeoutMs: 5000, what: 'the dock to be connected' })
      const reloaded = page.record.documentRequests.length - loads
      await waitFor(async () => (await computed(t, first, 'padding')) === '30px' && (await computed(t, first, 'gap')) === '2px' && (await computed(t, first, 'border-radius')) === '6px', { timeoutMs: 5000, what: 'the previews to be on the page' })
      const all = await items(t)
      expect(all.length === 3 && all.every((item) => item.status === 'draft') && (await testState(t)).detached.length === 0, `${all.length} items after the restart`)
      return `primp stopped: indicator "Reconnecting", an edit made meanwhile accepted; primp started again with an empty session: ${reloaded === 0 ? 'the same document reconnected' : `Vite's client reloaded the page (${reloaded} load)`}, the tab's 3 drafts were sent to the new session and all three previews are on the page`
    })

    await report.attempt('after a page reload the drafts of this page come back from the server with their previews', async () => {
      // Without the tab's own copy, so that this is the server's state alone.
      await t.evaluate(() => sessionStorage.removeItem('primp:drafts'))
      await t.reload({ waitUntil: 'load' })
      await t.waitForFunction(() => window.__primp_test !== undefined)
      await t.evaluate(() => window.__primp_test!.ready())
      const restored = await waitFor(async () => ((await computed(t, first, 'padding')) === '30px' && (await computed(t, first, 'gap')) === '2px' && (await computed(t, first, 'border-radius')) === '6px' ? true : undefined), { timeoutMs: 4000, what: 'the previews to be restored' })
      const all = await items(t)
      const state = await testState(t)
      expect(restored && all.length === 3 && all.every((item) => item.status === 'draft') && state.detached.length === 0, `${all.length} items, detached ${state.detached.join(',')}`)
      const left = await t.evaluate(() => Math.round(document.querySelector('primp-root')!.shadowRoot!.querySelector('iframe[data-primp-dock="bar"]')!.getBoundingClientRect().left))
      expect(left === 16, `the dock did not keep its corner over the reload: left ${left}`)
      return 'reload: 3 drafts adopted from session:state, all three previews applied again to the re-found card, the dock is still in the corner it was moved to'
    })

    await report.attempt('the closed launcher is dragged by a REAL mouse anywhere and stays there (not opened by the drop, kept over a reload, Esc puts it back)', async () => {
      const barRect = () =>
        t.evaluate(() => {
          const r = document.querySelector('primp-root')!.shadowRoot!.querySelector('iframe[data-primp-dock="bar"]')!.getBoundingClientRect()
          return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), vw: document.documentElement.clientWidth, vh: innerHeight }
        })
      if ((await testState(t)).open) await t.evaluate(() => window.__primp_test!.open(false))
      await sleep(300)
      const start = await barRect()
      expect(start.w === 44 && start.x === 16, `the launcher is not in the bottom-left corner: ${JSON.stringify(start)}`)
      const drag = async (to: { x: number; y: number }, beforeUp?: () => Promise<void>): Promise<void> => {
        const from = await barRect()
        await t.mouse.move(from.x + 22, from.y + 22)
        await t.mouse.down()
        await t.mouse.move(to.x, to.y, { steps: 12 })
        if (beforeUp !== undefined) await beforeUp()
        await t.mouse.up()
        await sleep(300)
      }
      // Into the upper-right quarter, away from every edge.
      const target = { x: Math.round(start.vw * 0.7), y: 220 }
      await drag(target)
      const dropped = await barRect()
      const state = await testState(t)
      expect(!state.open && near(dropped.x + 22, target.x, 2) && near(dropped.y + 22, target.y, 2), `dropped at ${JSON.stringify(dropped)} for a pointer at ${JSON.stringify(target)}; open ${state.open}`)
      // Open: the toolbar grows from the same right edge.
      await t.evaluate(() => window.__primp_test!.open(true))
      await sleep(350)
      const open = await barRect()
      expect(open.w > 300 && near(open.x + open.w, dropped.x + dropped.w, 2) && near(open.y, dropped.y, 2), `open toolbar at ${JSON.stringify(open)}, launcher was ${JSON.stringify(dropped)}`)
      await t.evaluate(() => window.__primp_test!.open(false))
      await sleep(350)
      // Esc during a drag puts it back, and the release does not open the dock.
      await drag({ x: 200, y: start.vh - 200 }, async () => {
        await t.keyboard.press('Escape')
        await sleep(100)
      })
      const kept = await barRect()
      expect(!(await testState(t)).open && near(kept.x, dropped.x, 2) && near(kept.y, dropped.y, 2), `after Esc: ${JSON.stringify(kept)}, expected ${JSON.stringify(dropped)}; open ${(await testState(t)).open}`)
      // Next to an edge it rests in line with the corners.
      await drag({ x: start.vw - 30, y: 300 })
      const snapped = await barRect()
      expect(snapped.x + snapped.w === snapped.vw - 16 && near(snapped.y + 22, 300, 2), `dropped by the right edge: ${JSON.stringify(snapped)}`)
      await t.reload({ waitUntil: 'load' })
      await t.waitForFunction(() => window.__primp_test !== undefined)
      await t.evaluate(() => window.__primp_test!.ready())
      await sleep(300)
      const reloaded = await barRect()
      expect(reloaded.x === snapped.x && reloaded.y === snapped.y, `after a reload: ${JSON.stringify(reloaded)}, before ${JSON.stringify(snapped)}`)
      // A plain click still opens it.
      await t.mouse.click(reloaded.x + 22, reloaded.y + 22)
      await sleep(300)
      expect((await testState(t)).open, 'a click on the launcher did not open the dock')
      return `dragged from the corner to ${dropped.x},${dropped.y} (the drop did not open the dock; opened, the toolbar kept its right edge); Esc mid-drag put it back; dropped 14px from the right edge it rests 16px from it; the place survived a reload; a click still opens it`
    })
  } finally {
    await page.close()
  }
}

async function viteBigPage(browser: Browser, lane: Lane): Promise<void> {
  const page = await openDock(browser, lane, '/big')
  const t = page.page
  const cell = '.big-table tbody tr:nth-child(3) td:nth-child(2)'
  const edits = async (): Promise<{ runs: number[]; parts: string; last: StyleChange; elements: number; partial: boolean }> => {
    const runs: number[] = []
    let last: StyleChange | undefined
    for (const value of ['12px', '14px', '16px', '18px', '20px', '22px']) {
      const result = await t.evaluate((next) => window.__primp_test!.setStyle('padding-top', next), value)
      last = style(result.item)
      runs.push((await testState(t)).lastEffects?.ms ?? Infinity)
    }
    const cost = (await testState(t)).lastEffects
    if (cost === null || last === undefined) throw new Error('no side-effect measurement was recorded')
    const parts = `first snapshot ${cost.parts.before.toFixed(1)}, second ${cost.parts.after.toFixed(1)}, diff + classify ${cost.parts.classify.toFixed(1)}, describing ${cost.parts.describe.toFixed(1)} ms`
    return { runs, parts, last, elements: cost.elements, partial: cost.partial }
  }
  try {
    await report.attempt('a page with 13,000 elements: the side-effect check looks at 2,500 of them and says so', async () => {
      const elements = await t.evaluate(() => document.querySelectorAll('body *').length)
      const started = Date.now()
      const ref = await t.evaluate((selector) => window.__primp_test!.select(selector), cell)
      const selectMs = Date.now() - started
      const { runs, parts, last, elements: checked, partial } = await edits()
      expect(elements > 10_000 && checked === 2500 && partial && last.sideEffectsPartial === true, `${elements} elements; checked ${checked}; partial ${partial}; flag on the item ${last.sideEffectsPartial}`)
      const summary = await t.evaluate((id) => window.__primp_test!.summary(id), last.id)
      expect(last.sideEffects.length > 0 && summary.includes('checked 2500 of'), `summary: ${summary}`)
      const chip = await page.dock.evaluate(() => document.querySelector('.tray .item .chip')?.textContent ?? '')
      expect(chip.includes('partly checked'), `the tray chip does not say that the check was partial: "${chip}"`)
      await t.evaluate(() => window.__primp_test!.undo())
      report.info(`13,000-element page: the snapshot reads every element's box before it applies the cap, so the cost follows the page, not the cap: ${runs.map((ms) => ms.toFixed(1)).join(', ')} ms per edit (last: ${parts}). Selecting a cell with ${ref.instanceCount} instances took ${selectMs} ms.`)
      return `${elements} elements, 2,500 checked, sideEffectsPartial set, summary "${summary}", the tray says "partly checked"`
    })

    await report.attempt(`2,500 elements: both snapshots, the diff and the conversion stay under ${EFFECTS_BUDGET_MS} ms`, async () => {
      // The same page cut down to the size the budget is stated for (the test removes rows; React is not involved again).
      const elements = await t.evaluate(() => {
        const rows = [...document.querySelectorAll('.big-table tbody tr')]
        for (const row of rows.slice(497)) row.remove()
        return document.querySelectorAll('body *').length
      })
      await t.evaluate((selector) => window.__primp_test!.select(selector), cell)
      const { runs, parts, last, elements: checked, partial } = await edits()
      const sorted = [...runs].sort((a, b) => a - b)
      const worst = sorted[sorted.length - 1] ?? Infinity
      expect(elements >= 2450 && elements <= 2550 && checked >= 2400 && !partial && last.sideEffectsPartial === undefined, `${elements} elements, ${checked} checked, partial ${partial}`)
      expect(worst < EFFECTS_BUDGET_MS, `side-effect measurement took ${runs.map((ms) => ms.toFixed(1)).join(', ')} ms (${parts})`)
      return `${elements} elements, ${checked} in the snapshot, 6 edits: ${runs.map((ms) => ms.toFixed(1)).join(', ')} ms (last: ${parts}); ${last.sideEffects.length} effects recorded`
    })
  } finally {
    await page.close()
  }
}

// ---------------------------------------------------------------------------
// Interaction states (:hover, :focus-visible) on vite-react-19 and static-html
// ---------------------------------------------------------------------------

const PLAN_CTA = '[data-label="plan-cta"]'
const SLATE_900 = 'rgb(15, 23, 42)' // .plan__cta at rest, #0f172a
const SLATE_800 = 'rgb(30, 41, 59)' // .plan__cta:hover, #1e293b
const BLUE = 'rgb(37, 99, 235)' // #2563eb
const VIOLET = 'rgb(124, 58, 237)' // #7c3aed

/** What primp's forcing left on the page: marked elements and page rules that carry the marker selector. */
function forceMarks(page: DockPage['page']): Promise<{ elements: number; rules: number }> {
  return page.evaluate(() => {
    let rules = 0
    const visit = (list: CSSRuleList): void => {
      for (const rule of list) {
        if ((rule as CSSStyleRule).selectorText?.includes('data-primp-force') === true) rules++
        const inner = (rule as CSSGroupingRule).cssRules
        if (inner !== undefined) visit(inner)
      }
    }
    for (const sheet of document.styleSheets) {
      try {
        visit(sheet.cssRules)
      } catch {
        // Another origin.
      }
    }
    return { elements: document.querySelectorAll('[data-primp-force]').length, rules }
  })
}

/** Layout-shift entries of the page's recording that are neither the user's nor tagged as primp's own. */
async function unmarkedShifts(page: DockPage['page']): Promise<{ unmarked: number; own: number }> {
  const recording = await page.evaluate(() => window.__primp!.recording())
  return {
    unmarked: recording.shifts.filter((entry) => entry.selfInduced === undefined && !entry.hadRecentInput).length,
    own: recording.shifts.filter((entry) => entry.selfInduced !== undefined).length,
  }
}

async function viteStates(browser: Browser, lane: Lane): Promise<void> {
  const page = await openDock(browser, lane, '/')
  const t = page.page
  const away = async (): Promise<void> => {
    await t.mouse.move(2, 2)
    await sleep(50)
  }
  let revert: (() => void) | undefined
  try {
    await waitFor(() => page.record.webSockets.some((url) => !url.includes('/__primp/')) && lane.primp.hmr.status().live, { what: 'the HMR socket' })
    await t.evaluate((selector) => document.querySelector(selector)?.scrollIntoView({ block: 'center' }), PLAN_CTA)
    await away()
    await t.evaluate((selector) => window.__primp_test!.select(selector), PLAN_CTA)
    await waitFor(async () => (await testState(t)).source?.state === 'done', { timeoutMs: 20_000, what: 'the source of the button to resolve' })

    type Snapshot = { items: string; css: string; marks: number; background: string; force: { elements: number; rules: number } }
    const snapshot = async (): Promise<Snapshot> => ({
      items: JSON.stringify((await items(t)).map((item) => ({ ...item, seq: 0 }))),
      css: (await testState(t)).previewCss,
      marks: await marks(t),
      background: await computed(t, PLAN_CTA, 'background-color'),
      force: await forceMarks(t),
    })
    let s0: Snapshot | undefined
    let s1: Snapshot | undefined
    let hoverItem: StyleChange | undefined

    await report.attempt(':hover without the pointer: the State control shows the hover background, marks the states with rules, and the dock lists the hover rule', async () => {
      const rest = await computed(t, PLAN_CTA, 'background-color')
      const state0 = await testState(t)
      const dots = await page.dock.evaluate(() => [...document.querySelectorAll('.seg.states button')].map((button) => `${button.textContent?.replace(', has rules', '')}${button.classList.contains('has') ? '*' : ''}`))
      expect(rest === SLATE_900 && state0.activeState === null && state0.forced === null, `at rest: ${rest}, ${JSON.stringify({ active: state0.activeState, forced: state0.forced })}`)
      expect(state0.statesWithRules.includes('hover') && dots.includes(':hover*') && dots[0] === 'Rest', `statesWithRules ${JSON.stringify(state0.statesWithRules)}; control: ${dots.join(' ')}`)
      // A real click in the dock.
      await openAllCss(page)
      await page.dock.locator('.seg.states button[data-state="hover"]').click()
      await away()
      const shown = await waitFor(async () => ((await computed(t, PLAN_CTA, 'background-color')) === SLATE_800 ? true : undefined), { timeoutMs: 3000, what: 'the hover background' })
      const facts = await t.evaluate((selector) => ({ hovered: document.querySelector(selector)!.matches(':hover'), marker: document.querySelector(selector)!.getAttribute('data-primp-force') }), PLAN_CTA)
      const state1 = await testState(t)
      expect(shown && !facts.hovered && facts.marker === 'hover', `the button is ${facts.hovered ? '' : 'not '}under the pointer, marker "${facts.marker}"`)
      expect(state1.activeState === 'hover' && state1.forced?.state === 'hover' && state1.forced.rules > 0 && state1.forced.unreadable === 0, `state: ${JSON.stringify({ active: state1.activeState, forced: state1.forced })}`)
      const dock = await waitFor(() =>
        page.dock.evaluate(() => {
          const group = [...document.querySelectorAll('.rule')].find((rule) => rule.querySelector('.sel')?.textContent === '.plan__cta:hover')
          const input = group?.querySelector<HTMLInputElement>('#v-background-color')
          return input === null || input === undefined
            ? undefined
            : {
                value: input.value,
                pressed: document.querySelector('.seg.states button[aria-pressed="true"]')?.textContent ?? '',
                showing: document.querySelector('.chip.showing')?.textContent ?? '',
                groups: [...document.querySelectorAll('.rule .sel')].map((sel) => sel.textContent).join(' | '),
              }
        }),
        { timeoutMs: 3000, what: 'the dock to list background-color from .plan__cta:hover' },
      )
      expect(dock.value === SLATE_800 && dock.pressed.startsWith(':hover') && dock.showing === 'showing :hover', `dock: ${JSON.stringify(dock)}`)
      const label = await t.evaluate(() => [...document.querySelector('primp-root')!.shadowRoot!.querySelectorAll<HTMLElement>('.box.selected')].map((box) => box.textContent?.trim() ?? '').join('|'))
      expect(label === ':hover', `the selection outline on the page is labelled "${label}"`)
      s0 = await snapshot()
      return `at rest ${rest}; control "${dots.join(' ')}" (* = has rules); clicked :hover: ${SLATE_800} with the pointer elsewhere (matches(':hover') false), ${state1.forced.rules} page rules given the marker; the dock lists background-color ${dock.value} under "${dock.groups}", says "${dock.showing}", outline label ":hover"`
    })

    await report.attempt('an edit under :hover records condition.state, the hover colour as before, no bystanders, and the tray says :hover', async () => {
      const result = await t.evaluate((value) => window.__primp_test!.setStyle('background-color', value), '#2563eb')
      expect(result.ok, `rejected: ${result.error}`)
      const item = style(result.item)
      hoverItem = item
      expect(item.condition.state === 'hover' && item.before.computed === SLATE_800 && item.before.authored === SLATE_800 && item.after.computed === BLUE && item.after.authored === '#2563eb', `item: ${JSON.stringify({ condition: item.condition, before: item.before, after: item.after })}`)
      expect(item.origin?.via === 'rule' && item.origin.selector === '.plan__cta:hover' && item.origin.sheet?.endsWith('site.css') === true && item.origin.alsoStyles === undefined && item.bystanders === undefined, `origin ${JSON.stringify(item.origin)}, bystanders ${JSON.stringify(item.bystanders)}`)
      const computedChecks = item.expect.filter((entry) => entry.type === 'computed')
      expect(computedChecks.length > 0 && computedChecks.every((entry) => entry.type === 'computed' && entry.condition.state === 'hover') && !item.expect.some((entry) => entry.type === 'unchanged'), `expect: ${JSON.stringify(item.expect)}`)
      expect((await computed(t, PLAN_CTA, 'background-color')) === BLUE, 'the forced button does not show the new colour')
      const tray = await waitFor(() => page.dock.evaluate(() => {
        const row = document.querySelector('.tray .item')
        return row === null ? undefined : { chip: row.querySelector('.chip.state')?.textContent ?? '', line: row.querySelector('.change')?.textContent ?? '' }
      }))
      expect(tray.chip === ':hover' && tray.line.startsWith(`background-color on :hover: ${SLATE_800}`) && tray.line.includes('#2563eb'), `tray: ${JSON.stringify(tray)}`)
      const stored = await waitFor(() => lane.primp.session.item(item.id), { timeoutMs: 3000, what: 'the server to store the item' })
      expect(stored.kind === 'style' && stored.condition.state === 'hover', `the server stored ${JSON.stringify(stored).slice(0, 200)}`)
      const problems = hygiene(page, lane)
      expect(problems.length === 0, problems.join('; '))
      s1 = await snapshot()
      return `condition.state "hover", before ${item.before.computed} (authored ${item.before.authored}), after ${item.after.computed}; origin ${item.origin.selector}, no bystanders, ${computedChecks.length} computed check(s) for :hover and no "unchanged"; tray "${tray.line.trim()}" with chip "${tray.chip}"; stored by the server`
    })

    await report.attempt('the preview applies under a REAL mouse hover too; back at Rest the resting colour is unchanged and nothing stays forced', async () => {
      await page.dock.locator('.seg.states button', { hasText: 'Rest' }).click()
      await away()
      const rest = await computed(t, PLAN_CTA, 'background-color')
      const left = await forceMarks(t)
      const state = await testState(t)
      expect(rest === SLATE_900 && left.elements === 0 && left.rules === 0 && state.activeState === null && state.forced === null, `at Rest: ${rest}, marks left ${JSON.stringify(left)}, ${JSON.stringify({ active: state.activeState, forced: state.forced })}`)
      await t.locator(PLAN_CTA).first().hover()
      const hovered = await waitFor(async () => ((await computed(t, PLAN_CTA, 'background-color')) === BLUE ? true : undefined), { timeoutMs: 2000, what: 'the preview under a real hover' })
      const other = await computed(t, `.plan:nth-of-type(2) ${PLAN_CTA}`, 'background-color')
      await away()
      const after = await computed(t, PLAN_CTA, 'background-color')
      expect(hovered && after === SLATE_900 && other === SLATE_900, `real hover ${hovered}, after leaving ${after}, the second plan's button ${other}`)
      return `State control back at Rest: ${rest}, no marker left; the mouse over the button shows ${BLUE} (the preview's :hover selector), leaving it ${after}; the other plans' buttons untouched`
    })

    await report.attempt('a resting edit of the same property afterwards is a second item and does not alter the hover item', async () => {
      const result = await t.evaluate((value) => window.__primp_test!.setStyle('background-color', value), '#7c3aed')
      const resting = style(result.item)
      const all = await items(t)
      const hover = all.find((item) => item.id === hoverItem?.id)
      expect(all.length === 2 && resting.id !== hoverItem?.id && resting.condition.state === undefined && resting.before.computed === SLATE_900 && resting.after.computed === VIOLET, `resting item: ${JSON.stringify({ condition: resting.condition, before: resting.before, after: resting.after })}; ${all.length} items`)
      // `seq` is the server's numbering, given after the dock's own copy was taken.
      const unnumbered = (item: ChangeItem | undefined): string => JSON.stringify(item === undefined ? null : { ...item, seq: 0 })
      expect(unnumbered(hover) === unnumbered(hoverItem), `the hover item changed:\n${JSON.stringify(hover).slice(0, 300)}\n${JSON.stringify(hoverItem).slice(0, 300)}`)
      // The resting rule is ordinary; its bystanders are the two other buttons.
      expect(resting.origin?.selector === '.plan__cta' && resting.origin.alsoStyles === 2, `resting origin ${JSON.stringify(resting.origin)}`)
      const atRest = await computed(t, PLAN_CTA, 'background-color')
      await t.locator(PLAN_CTA).first().hover()
      const real = await waitFor(async () => {
        const value = await computed(t, PLAN_CTA, 'background-color')
        return value === BLUE ? value : undefined
      }, { timeoutMs: 2000, what: 'the hover preview to win under a real hover' })
      await away()
      await t.evaluate(() => window.__primp_test!.setState('hover'))
      const forced = await computed(t, PLAN_CTA, 'background-color')
      const rows = await waitFor(() => page.dock.evaluate(() => {
        const value = document.querySelector<HTMLInputElement>('#v-background-color')?.value
        return value === '#2563eb' ? value : undefined
      }), { timeoutMs: 2000, what: 'the dock row to show the hover draft' })
      expect(atRest === VIOLET && forced === BLUE, `at rest ${atRest}, forced :hover ${forced}, real hover ${real}`)
      return `2 items; the hover item identical (but for the server's seq); at rest ${atRest}, under a real hover ${real}, under the forced :hover ${forced}; the dock row under :hover shows ${rows}`
    })

    await report.attempt('undo and redo restore items, previews, page colours and the forced state exactly', async () => {
      if (s0 === undefined || s1 === undefined) throw new Error('the earlier checks did not run')
      const s2 = await snapshot()
      const steps: string[] = []
      const same = (a: Snapshot, b: Snapshot, what: string): void => {
        expect(JSON.stringify(a) === JSON.stringify(b), `${what}:\n${JSON.stringify(a).slice(0, 400)}\n${JSON.stringify(b).slice(0, 400)}`)
        steps.push(`${what}: ${a.background}`)
      }
      await t.evaluate(() => window.__primp_test!.undo())
      same(await snapshot(), s1, 'undo')
      await t.evaluate(() => window.__primp_test!.undo())
      same(await snapshot(), s0, 'undo')
      await t.evaluate(() => window.__primp_test!.redo())
      same(await snapshot(), s1, 'redo')
      await t.evaluate(() => window.__primp_test!.redo())
      same(await snapshot(), s2, 'redo')
      return `with :hover held throughout: ${steps.join(', ')}; items JSON, preview stylesheet, marks, colour and the marker selectors (${s2.force.rules} rules, ${s2.force.elements} elements) identical at every step`
    })

    await report.attempt('session:measure of the :hover item: the old colour before the source changes, then actual == expected with the note "measured with :hover emulated"', async () => {
      if (hoverItem === undefined) throw new Error('no hover item')
      const item = hoverItem
      const ask = async () => {
        const outcome = await lane.primp.session.measure([item], 5000)
        if (outcome.status !== 'measured') throw new Error(`session.measure: ${outcome.status}`)
        return outcome.results[0]?.checks[0]
      }
      const before = await ask()
      expect(before?.status === 'fail' && before.expected === BLUE && before.actual === SLATE_800 && before.note === 'measured with :hover emulated', `before the edit: ${JSON.stringify(before)}`)
      revert = editFile(lane.fixture, 'src/styles/site.css', replaceOnce('.plan__cta:hover {\n  background-color: #1e293b;', '.plan__cta:hover {\n  background-color: #2563eb;')).revert
      await waitFor(() => t.evaluate(() => [...document.querySelectorAll('style')].some((node) => (node.textContent ?? '').includes('background-color: #2563eb'))), { what: 'the stylesheet hot update' })
      await sleep(200)
      const after = await ask()
      expect(after?.status === 'pass' && after.expected === BLUE && after.actual === BLUE && after.note === 'measured with :hover emulated', `after the edit: ${JSON.stringify(after)}`)
      // The State control was at :hover all along: it is held again, on the new rules, with the previews back on.
      const state = await testState(t)
      expect(state.activeState === 'hover' && state.forced?.state === 'hover' && state.forced.rules > 0 && !state.previewsSuspended && (await computed(t, PLAN_CTA, 'background-color')) === BLUE, `after measuring: ${JSON.stringify({ active: state.activeState, forced: state.forced, suspended: state.previewsSuspended })}`)
      expect(page.record.documentRequests.length === 1, 'the page reloaded')
      return `before: ${before.status} (expected ${before.expected}, actual ${before.actual}, "${before.note}"); site.css edited so .plan__cta:hover is #2563eb, applied by HMR: ${after.status} (actual ${after.actual}, "${after.note}"); the dock's :hover is held again afterwards`
    })

    await report.attempt('Send: the State control goes back to Rest, no [data-primp-force] remains and every selector is restored', async () => {
      const held = await forceMarks(t)
      const prompt = await t.evaluate(() => window.__primp_test!.send())
      const state = await testState(t)
      const left = await forceMarks(t)
      await away()
      const rest = await computed(t, PLAN_CTA, 'background-color')
      // Send shows what was sent in the Changes panel; the State control is the inspector's, on the element again.
      await t.evaluate((selector) => window.__primp_test!.select(selector), PLAN_CTA)
      await waitFor(() => page.dock.evaluate(() => document.querySelector('.seg.states') !== null), { timeoutMs: 3000, what: 'the inspector' })
      const pressed = await page.dock.evaluate(() => document.querySelector('.seg.states button[aria-pressed="true"]')?.textContent ?? '')
      const showing = await page.dock.evaluate(() => document.querySelector('.chip.showing') !== null)
      expect(held.elements > 0 && held.rules > 0, `nothing was forced before Send: ${JSON.stringify(held)}`)
      expect(left.elements === 0 && left.rules === 0 && state.activeState === null && state.forced === null && state.previewCss === '' && (await marks(t)) === 0, `after Send: ${JSON.stringify({ left, active: state.activeState, forced: state.forced, css: state.previewCss })}`)
      expect(rest === SLATE_900 && pressed === 'Rest' && !showing, `after Send: background ${rest}, control "${pressed}", indicator ${showing}`)
      expect(prompt.includes('background-color') && prompt.includes('#2563eb'), `prompt: ${prompt.slice(0, 300)}`)
      if (!prompt.includes(':hover')) report.info('the prompt the engine wrote does not mention :hover (packages/engine is being changed by another agent)')
      return `before Send ${held.elements} marked elements and ${held.rules} marked rules; after: 0 and 0, control at Rest, no indicator, no previews, the button ${rest}; the prompt names background-color and #2563eb${prompt.includes(':hover') ? ' and :hover' : ''}`
    })
  } finally {
    revert?.()
    if (revert !== undefined) await waitFor(() => t.evaluate(() => [...document.querySelectorAll('style')].some((node) => (node.textContent ?? '').includes('background-color: #1e293b'))), { what: 'the fixture source to be restored' }).catch(() => undefined)
    await page.close()
  }

  // A fresh page: forcing a state that moves things, and what the shift recorder and the settle detector make of it.
  const quiet = await openDock(browser, lane, '/')
  try {
    const q = quiet.page
    await report.attempt('a resting edit alone leaves the page\'s own :hover value in place, forced and real, as the source edit would', async () => {
      await q.evaluate((selector) => document.querySelector(selector)?.scrollIntoView({ block: 'center' }), PLAN_CTA)
      await q.mouse.move(2, 2)
      await q.evaluate((selector) => window.__primp_test!.select(selector), PLAN_CTA)
      const result = await q.evaluate((value) => window.__primp_test!.setStyle('background-color', value), '#7c3aed')
      const item = style(result.item)
      const rest = await computed(q, PLAN_CTA, 'background-color')
      await q.evaluate(() => window.__primp_test!.setState('hover'))
      const forced = await computed(q, PLAN_CTA, 'background-color')
      await openAllCss(quiet)
      const row = await waitFor(() => quiet.dock.evaluate(() => document.querySelector<HTMLInputElement>('#v-background-color')?.value))
      await q.evaluate(() => window.__primp_test!.setState(null))
      await q.locator(PLAN_CTA).first().hover()
      const real = await computed(q, PLAN_CTA, 'background-color')
      await q.mouse.move(2, 2)
      const css = (await testState(q)).previewCss
      expect(item.condition.state === undefined && rest === VIOLET, `resting edit: ${JSON.stringify(item.condition)}, at rest ${rest}`)
      expect(forced === SLATE_800 && real === SLATE_800 && row === SLATE_800, `under :hover: forced ${forced}, real ${real}, the dock row ${row}`)
      expect(css.includes(':not(:where(:hover, [data-primp-force~="hover"]'), `preview rule: ${css}`)
      await q.evaluate(() => window.__primp_test!.undo())
      return `resting background-color #7c3aed: at rest ${rest}; under the forced :hover ${forced} and under a real hover ${real} (the page's .plan__cta:hover), and the dock row says ${row}; preview rule "${css.slice(0, 140)}"`
    })

    await report.attempt('forcing a state that changes the layout adds no untagged layout-shift entry and is no page update for the settle detector', async () => {
      await q.evaluate((selector) => document.querySelector(selector)?.scrollIntoView({ block: 'center' }), PLAN_CTA)
      await q.mouse.move(2, 2)
      await q.evaluate((selector) => window.__primp_test!.select(selector), PLAN_CTA)
      // A :hover edit that makes the button taller: forcing :hover now moves what is below it.
      const edit = await q.evaluate(() => window.__primp_test!.setStyle('padding', '24px 16px', { state: 'hover' }))
      expect(edit.ok && edit.item?.kind === 'style' && edit.item.condition.state === 'hover', `edit: ${JSON.stringify(edit).slice(0, 200)}`)
      await sleep(700)
      const before = await unmarkedShifts(q)
      const mark = lane.primp.detector.journal().length
      const heights: number[] = []
      for (let i = 0; i < 3; i++) {
        await q.evaluate(() => window.__primp_test!.setState('hover'))
        await sleep(150)
        heights.push(Math.round((await rect(q, PLAN_CTA)).h))
        await q.evaluate(() => window.__primp_test!.setState(null))
        await sleep(150)
        heights.push(Math.round((await rect(q, PLAN_CTA)).h))
      }
      await sleep(700)
      const after = await unmarkedShifts(q)
      const updates = lane.primp.detector.journal().slice(mark).filter((entry) => entry.source === 'browser' && (entry.name === 'mutation' || entry.name === 'sheet-loaded'))
      expect(new Set(heights).size === 2, `the forced state did not change the layout: heights ${heights.join(', ')}`)
      expect(after.unmarked === before.unmarked, `untagged layout-shift entries: ${before.unmarked} before, ${after.unmarked} after (tagged: ${before.own} -> ${after.own})`)
      expect(updates.length === 0, `the settle detector saw ${updates.length} page change(s): ${JSON.stringify(updates).slice(0, 300)}`)
      return `button height ${heights.join(' / ')} px over three :hover/Rest toggles; untagged shift entries ${before.unmarked} -> ${after.unmarked}, tagged as primp's ${before.own} -> ${after.own}; 0 browser mutation notices in the settle journal`
    })
  } finally {
    await quiet.close()
  }
}

/** A server on another port that serves one stylesheet without CORS headers: the page may use it but not read it. */
// ---------------------------------------------------------------------------
// Reorder and resize (vite-react-19)
// ---------------------------------------------------------------------------

const PLAN = '[data-label="plan"]'
const PLAN_NAMES = ['Starter', 'Team', 'Scale']

/** The plan names in document order. */
function planOrder(page: DockPage['page']): Promise<string[]> {
  return page.evaluate((selector) => [...document.querySelectorAll(selector)].map((plan) => plan.querySelector('[data-label="plan-name"]')?.textContent?.trim() ?? '?'), PLAN)
}

const structure = (item: ChangeItem | null | undefined): StructuralChange => {
  if (item === null || item === undefined || item.kind !== 'structure') throw new Error(`expected a structural change, got ${JSON.stringify(item)?.slice(0, 160)}`)
  return item
}

/** Counts the app's own pointer, mouse and click handlers firing on `selector` and on the document (bubble phase, as an app listens). */
function countAppEvents(page: DockPage['page'], selector: string): Promise<void> {
  return page.evaluate((sel) => {
    const counts: Record<string, number> = {}
    ;(window as unknown as { __appEvents: Record<string, number> }).__appEvents = counts
    const count = (event: Event): void => {
      counts[event.type] = (counts[event.type] ?? 0) + 1
    }
    const types = ['click', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'pointerover', 'mouseover', 'dblclick', 'contextmenu']
    for (const element of document.querySelectorAll(sel)) for (const type of types) element.addEventListener(type, count)
    for (const type of types) document.addEventListener(type, count)
  }, selector)
}

/** Forgets what was counted (the pointer travelling to a handle passes over the page, as it does without primp). */
const resetAppEvents = (page: DockPage['page']): Promise<void> =>
  page.evaluate(() => {
    const counts = (window as unknown as { __appEvents: Record<string, number> }).__appEvents
    for (const key of Object.keys(counts)) delete counts[key]
  })

const appEvents = (page: DockPage['page']): Promise<Record<string, number>> => page.evaluate(() => ({ ...(window as unknown as { __appEvents: Record<string, number> }).__appEvents }))

const centre = (box: { x: number; y: number; width: number; height: number }): { x: number; y: number } => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 })

async function viteReorder(browser: Browser, lane: Lane): Promise<void> {
  const page = await openDock(browser, lane, '/')
  const t = page.page
  const first = `${PLAN}:nth-of-type(1)`
  const reverts: (() => void)[] = []
  let itemId = ''
  try {
    await waitFor(() => page.record.webSockets.some((url) => !url.includes('/__primp/')) && lane.primp.hmr.status().live, { what: 'the HMR socket' })
    await t.evaluate((selector) => document.querySelector(selector)?.scrollIntoView({ block: 'center' }), PLAN)
    await sleep(100)
    const shiftsBefore = await unmarkedShifts(t)

    await report.attempt('reorder refusals: the first cannot move earlier, a position out of range, an only child, an element hidden by a recorded change', async () => {
      await t.evaluate((selector) => window.__primp_test!.select(selector), first)
      const earlier = await t.evaluate(() => window.__primp_test!.move(-1))
      const outside = await t.evaluate(() => window.__primp_test!.reorder(3))
      const buttons = await page.dock.evaluate(() => [...document.querySelectorAll('[aria-label="Move among siblings"] button')].map((button) => ({ text: button.textContent, disabled: (button as HTMLButtonElement).disabled })))
      await t.evaluate(() => window.__primp_test!.select('.plan__period'))
      const only = await t.evaluate(() => window.__primp_test!.move(1))
      const onlyButtons = await page.dock.evaluate(() => [...document.querySelectorAll('[aria-label="Move among siblings"] button')].every((button) => (button as HTMLButtonElement).disabled))
      const onlyHandles = await t.evaluate(() => window.__primp_test!.handles())
      const firstPlan = await t.evaluate((selector) => document.querySelector(selector)!.getBoundingClientRect().toJSON() as DOMRect, PLAN)
      await t.evaluate(() => window.__primp_test!.select('[data-label="plan-features"] li'))
      await t.evaluate(() => window.__primp_test!.hide())
      const hidden = await t.evaluate(() => window.__primp_test!.move(1))
      await t.evaluate(() => window.__primp_test!.undo())
      expect(!earlier.ok && earlier.error?.includes('already the first') === true, `move(-1) on the first plan: ${JSON.stringify(earlier)}`)
      expect(!outside.ok && outside.error?.includes('positions 1 to 3') === true, `reorder(3): ${JSON.stringify(outside)}`)
      expect(buttons.length === 2 && buttons[0]?.disabled === true && buttons[1]?.disabled === false, `buttons on the first plan: ${JSON.stringify(buttons)}`)
      // The period has no siblings to move among, but it sits in a plan, one of three: the grip stands on that plan instead.
      const onPlan = onlyHandles.grip !== undefined && Math.abs(centre(onlyHandles.grip).x - centre(firstPlan).x) < 2 && onlyHandles.grip.y + onlyHandles.grip.height <= firstPlan.top
      expect(!only.ok && only.error?.includes('only child') === true && onlyButtons && onPlan, `only child: ${JSON.stringify(only)}, buttons disabled ${onlyButtons}, handles ${JSON.stringify(onlyHandles)}, first plan ${JSON.stringify(firstPlan)}`)
      expect(!hidden.ok && hidden.error?.includes('hidden by a recorded change') === true, `hidden: ${JSON.stringify(hidden)}`)
      expect((await items(t)).length === 0 && JSON.stringify(await planOrder(t)) === JSON.stringify(PLAN_NAMES), 'something was recorded or moved')
      return `"${earlier.error}"; "${outside.error}"; "${only.error}"; "${hidden.error}"; Move earlier disabled on the first plan; for the only child both buttons disabled and the grip on the plan around it`
    })

    await report.attempt('Move later on the first pricing plan: a reorder item with indexes, anchors and an order check; the DOM order changes; the tray says where', async () => {
      await t.evaluate((selector) => window.__primp_test!.select(selector), first)
      await waitFor(async () => (await testState(t)).source?.state === 'done', { timeoutMs: 5000 })
      const result = await t.evaluate(() => window.__primp_test!.move(1))
      expect(result.ok, `refused: ${result.error}`)
      const item = structure(result.item)
      itemId = item.id
      const move = item.move
      expect(item.op === 'reorder' && move !== undefined, `item: ${JSON.stringify(item).slice(0, 300)}`)
      expect(move.fromIndex === 0 && move.toIndex === 1 && move.siblingCount === 3 && move.parent === 'div.pricing-grid', `move: ${JSON.stringify({ ...move, was: undefined, now: undefined })}`)
      expect(move.was.prev === undefined && move.was.next?.label.includes('Team') === true && move.now.prev?.label.includes('Team') === true && move.now.next?.label.includes('Scale') === true, `anchors: was ${JSON.stringify([move.was.prev?.label, move.was.next?.label])}, now ${JSON.stringify([move.now.prev?.label, move.now.next?.label])}`)
      expect(move.now.prev?.locator.indexPath.at(-1) === 0 && move.was.next?.locator.indexPath.at(-1) === 1, `anchor locators: was.next ${JSON.stringify(move.was.next?.locator.indexPath)}, now.prev ${JSON.stringify(move.now.prev?.locator.indexPath)}`)
      expect(item.target.label.includes('Starter') && item.target.locator.indexPath.at(-1) === 1 && item.target.source?.file === 'src/components/PricingTable.tsx', `target recorded after the move: ${item.target.label} at ${JSON.stringify(item.target.locator.indexPath)}, source ${JSON.stringify(item.target.source)}`)
      const order = item.expect.find((entry) => entry.type === 'order')
      expect(order?.type === 'order' && order.siblings.map((sibling) => `${sibling.self === true ? '*' : ''}${sibling.label.split(' "')[1]?.slice(0, 5)}`).join(',') === 'Team ,*Start,Scale' && item.expect.length === 1, `expect: ${JSON.stringify(item.expect).slice(0, 400)}`)
      const plans = await planOrder(t)
      expect(JSON.stringify(plans) === JSON.stringify(['Team', 'Starter', 'Scale']), `DOM order ${plans.join(', ')}`)
      // The siblings sliding along are the reorder itself, not side effects.
      const siblingEffects = item.sideEffects.filter((effect) => effect.label.startsWith('div.plan'))
      expect(siblingEffects.length === 0, `siblings listed as side effects: ${siblingEffects.map((effect) => effect.label).join(', ')}`)
      const line = await waitFor(() => page.dock.evaluate(() => document.querySelector('.tray .item .change')?.textContent ?? undefined), { timeoutMs: 3000, what: 'the tray line' })
      expect(line.startsWith('Moved: position 2 of 3 in div.pricing-grid (was 1), now after div.plan "Team'), `tray: "${line}"`)
      const stored = await waitFor(() => lane.primp.session.item(item.id), { timeoutMs: 3000, what: 'the server to store the item' })
      expect(stored.kind === 'structure' && stored.op === 'reorder' && stored.move?.toIndex === 1, `stored: ${JSON.stringify(stored).slice(0, 200)}`)
      const css = (await testState(t)).previewCss
      expect(css === '' && (await marks(t)) === 1, `preview css "${css}", ${await marks(t)} marks`)
      return `fromIndex 0 -> toIndex 1 of 3 in ${move.parent}; was next ${move.was.next?.label}; now between ${move.now.prev?.label} and ${move.now.next?.label}; order check over ${order.siblings.length} siblings; target re-recorded at index ${item.target.locator.indexPath.at(-1)}; DOM ${plans.join(', ')}; ${item.sideEffects.length} side effects, no plan among them; tray "${line}"`
    })

    await report.attempt('reorder: undo puts the plan back, redo moves it again; a second move is one item that keeps where it started; back at the start there is no item', async () => {
      await t.evaluate(() => window.__primp_test!.undo())
      const undone = await planOrder(t)
      const afterUndo = await items(t)
      const marksUndone = await marks(t)
      await t.evaluate(() => window.__primp_test!.redo())
      const redone = await planOrder(t)
      expect(JSON.stringify(undone) === JSON.stringify(PLAN_NAMES) && afterUndo.length === 0 && marksUndone === 0, `after undo: ${undone.join(', ')}, ${afterUndo.length} items, ${marksUndone} marks`)
      expect(JSON.stringify(redone) === JSON.stringify(['Team', 'Starter', 'Scale']) && (await items(t)).length === 1, `after redo: ${redone.join(', ')}`)
      const second = structure((await t.evaluate(() => window.__primp_test!.reorder(2))).item)
      const secondOrder = await planOrder(t)
      expect(second.id === itemId && second.move?.fromIndex === 0 && second.move.toIndex === 2 && second.move.was.next?.label.includes('Team') === true && second.move.now.prev?.label.includes('Scale') === true, `second move: ${JSON.stringify(second.move).slice(0, 300)}`)
      expect(JSON.stringify(secondOrder) === JSON.stringify(['Team', 'Scale', 'Starter']) && (await items(t)).length === 1, `after reorder(2): ${secondOrder.join(', ')}`)
      const back = await t.evaluate(() => window.__primp_test!.reorder(0))
      const backOrder = await planOrder(t)
      expect(back.ok && back.item === null && (await items(t)).length === 0 && JSON.stringify(backOrder) === JSON.stringify(PLAN_NAMES) && (await marks(t)) === 0, `moved back: ${JSON.stringify(back).slice(0, 200)}, ${backOrder.join(', ')}`)
      await waitFor(() => lane.primp.session.items().length === 0, { timeoutMs: 3000, what: 'the server to drop the item' })
      // Again, for the checks that follow.
      itemId = structure((await t.evaluate(() => window.__primp_test!.move(1))).item).id
      return `undo: ${undone.join(', ')} (0 items, no mark); redo: ${redone.join(', ')}; reorder(2): one item, fromIndex still 0, ${secondOrder.join(', ')}; reorder(0): item deleted, ${backOrder.join(', ')}`
    })

    await report.attempt('moving, undoing, redoing and moving back added no layout-shift entry that is not tagged as primp\'s own', async () => {
      const after = await unmarkedShifts(t)
      expect(after.unmarked === shiftsBefore.unmarked, `untagged entries: ${shiftsBefore.unmarked} before, ${after.unmarked} after`)
      return `${after.unmarked - shiftsBefore.unmarked} untagged entries added; ${after.own - shiftsBefore.own} tagged as primp's own`
    })
    await report.attempt('reorder: hot updates of PricingTable.tsx do not throw; the move preview stays applied, and follows nodes React replaces', async () => {
      const errorsBefore = page.record.pageErrors.length
      reverts.push(editFile(lane.fixture, 'src/components/PricingTable.tsx', replaceOnce('className="pricing__lead"', 'className="pricing__lead" data-rev="2"')).revert)
      await waitFor(() => t.evaluate(() => document.querySelector('[data-rev="2"]') !== null), { what: 'the hot update' })
      await sleep(300)
      const inPlace = await planOrder(t)
      const state = await testState(t)
      expect(JSON.stringify(inPlace) === JSON.stringify(['Team', 'Starter', 'Scale']) || state.detached.includes(itemId), `after a re-render: ${inPlace.join(', ')}, detached ${state.detached.join(',')}`)
      await t.evaluate((selector) => {
        ;(window as unknown as { __oldPlan: Element | null }).__oldPlan = document.querySelector(selector)
      }, PLAN)
      reverts.push(editFile(lane.fixture, 'src/components/PricingTable.tsx', replaceOnce('key={plan.id}', "key={plan.id + '-remounted'}")).revert)
      await waitFor(() => t.evaluate(() => (window as unknown as { __oldPlan: Element | null }).__oldPlan?.isConnected === false), { what: 'React to replace the plan nodes' })
      const followed = await waitFor(async () => {
        const order = await planOrder(t)
        const detached = (await testState(t)).detached
        return JSON.stringify(order) === JSON.stringify(['Team', 'Starter', 'Scale']) || detached.includes(itemId) ? { order, detached } : undefined
      }, { timeoutMs: 4000, what: 'the move to be made again on the new nodes, or the item flagged detached' })
      expect(page.record.pageErrors.length === errorsBefore, `page errors: ${page.record.pageErrors.slice(errorsBefore).join(' | ')}`)
      expect(page.record.documentRequests.length === 1, 'the page reloaded')
      expect((await items(t)).length === 1, 'the item was lost')
      for (const revert of reverts.splice(0).reverse()) revert()
      await waitFor(() => t.evaluate(() => document.querySelector('[data-rev="2"]') === null), { what: 'the fixture source to be restored' })
      const restored = await waitFor(async () => {
        const order = await planOrder(t)
        return JSON.stringify(order) === JSON.stringify(['Team', 'Starter', 'Scale']) ? order : undefined
      }, { timeoutMs: 4000, what: 'the move after the source was restored' })
      return `re-render in place: ${inPlace.join(', ')}, nothing detached; new keys (every plan node replaced): ${followed.detached.includes(itemId) ? 'flagged detached' : `the new Starter node moved again: ${followed.order.join(', ')}`}; no page error, no reload; source restored: ${restored.join(', ')}`
    })

    await report.attempt('measure an order check: fail while the page still has its own order (the preview is suspended for it), pass once plans.json has the new order', async () => {
      const item = structure((await items(t)).find((entry) => entry.id === itemId))
      const ask = async () => {
        const outcome = await lane.primp.session.measure([item], 5000)
        if (outcome.status !== 'measured') throw new Error(`session.measure: ${outcome.status}`)
        return outcome.results[0]!.checks.find((check) => check.expectation.type === 'order')!
      }
      const before = await ask()
      const shown = await planOrder(t)
      expect(before.status === 'fail' && JSON.parse(before.expected).length === 3 && JSON.stringify((JSON.parse(before.actual) as string[]).map((label) => label.split('"')[1]?.split(/[$ ]/)[0])) === JSON.stringify(PLAN_NAMES), `before the source edit: ${JSON.stringify(before)}`)
      expect(JSON.stringify(shown) === JSON.stringify(['Team', 'Starter', 'Scale']), `the preview did not come back after measuring: ${shown.join(', ')}`)
      // Send first: the agent's edit must land on the page's own order.
      const shiftsBeforeSend = await unmarkedShifts(t)
      const prompt = await t.evaluate(() => window.__primp_test!.send())
      const afterSend = await planOrder(t)
      await sleep(200)
      const shiftsAfterSend = await unmarkedShifts(t)
      expect(shiftsAfterSend.unmarked === shiftsBeforeSend.unmarked && shiftsAfterSend.own > shiftsBeforeSend.own, `putting the plans back on Send: untagged ${shiftsBeforeSend.unmarked} -> ${shiftsAfterSend.unmarked}, tagged ${shiftsBeforeSend.own} -> ${shiftsAfterSend.own}`)
      const state = await testState(t)
      expect(JSON.stringify(afterSend) === JSON.stringify(PLAN_NAMES) && (await marks(t)) === 0 && state.detached.length === 0, `after Send: ${afterSend.join(', ')}, ${await marks(t)} marks`)
      expect(prompt.includes('reorder the data') || prompt.toLowerCase().includes('move'), `prompt: ${prompt.slice(0, 400)}`)
      reverts.push(
        editFile(lane.fixture, 'src/data/plans.json', (source) => {
          const lines = source.split('\n')
          const starter = lines.findIndex((text) => text.includes('"id": "starter"'))
          const team = lines.findIndex((text) => text.includes('"id": "team"'))
          const swapped = [...lines]
          swapped[starter] = lines[team]!.replace(/,\s*$/, '') + ','
          swapped[team] = lines[starter]!.replace(/,\s*$/, '') + ','
          return swapped.join('\n')
        }).revert,
      )
      await waitFor(async () => JSON.stringify(await planOrder(t)) === JSON.stringify(['Team', 'Starter', 'Scale']), { timeoutMs: 8000, what: 'the data change to reach the page' })
      const after = await ask()
      expect(after.status === 'pass' && after.expected === before.expected && after.actual === after.expected, `after the source edit: ${JSON.stringify(after)}`)
      return `before: fail, actual ${after.expected === before.actual ? '' : before.actual} (measured with the preview off; the page showed ${shown.join(', ')} again right after); Send put the plans back (${afterSend.join(', ')}) before any edit; plans.json reordered: pass, actual = expected = ${after.actual}`
    })
    for (const revert of reverts.splice(0).reverse()) revert()
    await waitFor(async () => JSON.stringify(await planOrder(t)) === JSON.stringify(PLAN_NAMES), { timeoutMs: 8000, what: 'plans.json to be restored' })

  } finally {
    for (const revert of reverts.reverse()) revert()
    await page.close()
  }
}

async function viteDrags(browser: Browser, lane: Lane): Promise<void> {
  mkdirSync(SHOTS, { recursive: true })
  const page = await openDock(browser, lane, '/')
  const t = page.page
  try {
    await t.evaluate((selector) => document.querySelector(selector)?.scrollIntoView({ block: 'center' }), PLAN)
    await t.mouse.move(2, 2)
    await sleep(100)
    const shiftsBefore = await unmarkedShifts(t)

    await report.attempt('reorder by a REAL mouse drag on the grip: an insertion line between the plans, the drop index it shows is recorded, the app gets no pointer or click event', async () => {
      await t.evaluate((selector) => window.__primp_test!.select(selector), `${PLAN}:nth-of-type(1)`)
      await countAppEvents(t, `${PLAN}, ${PLAN_CTA}`)
      const handles = await t.evaluate(() => window.__primp_test!.handles())
      const grip = handles.grip
      expect(grip !== undefined && handles.se !== undefined, `handles shown: ${JSON.stringify(handles)}`)
      const team = await t.evaluate((selector) => document.querySelectorAll(selector)[1]!.getBoundingClientRect().toJSON() as DOMRect, PLAN)
      const scale = await t.evaluate((selector) => document.querySelectorAll(selector)[2]!.getBoundingClientRect().toJSON() as DOMRect, PLAN)
      const cta = await t.evaluate((selector) => document.querySelectorAll(selector)[2]!.getBoundingClientRect().toJSON() as DOMRect, PLAN_CTA)
      const start = centre(grip)
      await t.mouse.move(start.x, start.y)
      await resetAppEvents(t)
      await t.mouse.down()
      // Over the third plan's button first (it must not be pressed), then into the gap between Team and Scale.
      await t.mouse.move(cta.x + cta.width / 2, cta.y + cta.height / 2, { steps: 8 })
      const overButton = await t.evaluate(() => window.__primp_test!.drag())
      // The move is shown live, nothing is recorded yet, and the dock's frames are faded out of the way.
      const liveOver = await planOrder(t)
      const midItems = (await items(t)).length
      const faded = await t.evaluate(() => [...document.querySelector('primp-root')!.shadowRoot!.querySelectorAll('iframe')].map((frame) => frame.classList.contains('faded')))
      const gap = { x: (team.right + scale.left) / 2, y: team.top + team.height / 2 }
      await t.mouse.move(gap.x, gap.y, { steps: 8 })
      const dragging = await t.evaluate(() => window.__primp_test!.drag())
      const liveGap = await planOrder(t)
      const chip = await t.evaluate(() => {
        const tag = document.querySelector('primp-root')!.shadowRoot!.querySelector<HTMLElement>('.drag-tag')!
        const r = tag.getBoundingClientRect()
        return { text: tag.textContent, shown: tag.style.display !== 'none', inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight }
      })
      await sleep(200)
      await t.screenshot({ path: join(SHOTS, 'reorder-drag-light.png') })
      await t.mouse.up()
      await t.evaluate(() => window.__primp_overlay!.controller.idle())
      await sleep(100)
      const all = await items(t)
      const order = await planOrder(t)
      const events = await appEvents(t)
      expect(overButton?.kind === 'reorder' && overButton.toIndex === 2, `over the third plan's button: ${JSON.stringify(overButton)}`)
      expect(JSON.stringify(liveOver) === JSON.stringify(['Team', 'Scale', 'Starter']) && midItems === 0, `live, over Scale: ${liveOver.join(', ')}, ${midItems} items recorded mid-drag`)
      expect(faded.length === 2 && faded.every(Boolean), `dock frames faded mid-drag: ${JSON.stringify(faded)}`)
      expect(JSON.stringify(liveGap) === JSON.stringify(['Team', 'Starter', 'Scale']), `live, in the gap: ${liveGap.join(', ')}`)
      expect(chip.shown && chip.inside && chip.text?.startsWith('after “Team') === true && chip.text.endsWith('· 2 of 3'), `chip: ${JSON.stringify(chip)}`)
      expect(dragging?.kind === 'reorder' && dragging.toIndex === 1 && dragging.line !== null && dragging.line.width === 2 && Math.abs(dragging.line.x + 1 - gap.x) < 2, `in the gap: ${JSON.stringify(dragging)} (gap at x ${gap.x})`)
      const item = structure(all[0])
      expect(all.length === 1 && item.move?.fromIndex === 0 && item.move.toIndex === dragging.toIndex && JSON.stringify(order) === JSON.stringify(['Team', 'Starter', 'Scale']), `after the drop: ${all.length} items, move ${JSON.stringify(item.move).slice(0, 120)}, order ${order.join(', ')}`)
      expect(Object.keys(events).length === 0, `the app saw: ${JSON.stringify(events)}`)
      expect((await t.evaluate(() => window.__primp_test!.drag())) === null, 'the drag did not end')
      const unfaded = await t.evaluate(() => [...document.querySelector('primp-root')!.shadowRoot!.querySelectorAll('iframe')].every((frame) => !frame.classList.contains('faded')))
      expect(unfaded, 'the dock frames stayed faded after the drop')
      return `grip at ${Math.round(start.x)},${Math.round(start.y)}; over the third plan's button the page showed ${liveOver.join(', ')} live (nothing recorded, dock faded), position 3; in the gap between Team and Scale a 2px vertical line at x ${dragging.line.x + 1} for position ${dragging.toIndex + 1}, the page showing ${liveGap.join(', ')}, chip "${chip.text}"; dropped: one reorder 0 -> ${item.move.toIndex}, order ${order.join(', ')}; the app's handlers on the plans, their buttons and the document saw nothing`
    })
    await t.evaluate(() => window.__primp_test!.undo())

    await report.attempt('reorder from inside a plan: the grip stands on the plan, Escape mid-drag puts it back, a drop moves the plan; Alt+Down moves it one place; the page scrolls at the edge', async () => {
      const name = `${PLAN}:nth-of-type(1) [data-label="plan-name"]`
      await t.evaluate((selector) => window.__primp_test!.select(selector), name)
      const plans = await t.evaluate((selector) => [...document.querySelectorAll(selector)].map((plan) => plan.getBoundingClientRect().toJSON() as DOMRect), PLAN)
      const grip = (await t.evaluate(() => window.__primp_test!.handles())).grip
      expect(grip !== undefined && Math.abs(centre(grip).x - centre(plans[0]!).x) < 2 && grip.y + grip.height <= plans[0]!.top, `grip for the plan's name: ${JSON.stringify(grip)}, plan ${JSON.stringify(plans[0])}`)
      const start = centre(grip!)
      await t.mouse.move(start.x, start.y)
      await sleep(50)
      const outlined = await t.evaluate(() => document.querySelector('primp-root')!.shadowRoot!.querySelector<HTMLElement>('.move-target')!.style.display === 'block')
      // Escape mid-drag: the live move goes back, nothing is recorded; the plan is now the selection.
      await t.mouse.down()
      await t.mouse.move(centre(plans[2]!).x, centre(plans[2]!).y, { steps: 8 })
      const live = await planOrder(t)
      await t.keyboard.press('Escape')
      const afterEscape = await planOrder(t)
      await t.mouse.up()
      await t.evaluate(() => window.__primp_overlay!.controller.idle())
      const selected = await t.evaluate(() => window.__primp_test!.selection()?.label ?? '')
      expect(outlined, 'the plan the grip moves was not outlined while the grip was hovered')
      expect(JSON.stringify(live) === JSON.stringify(['Team', 'Scale', 'Starter']) && JSON.stringify(afterEscape) === JSON.stringify(PLAN_NAMES) && (await items(t)).length === 0, `live ${live.join(', ')}, after Escape ${afterEscape.join(', ')}`)
      expect(selected.startsWith('div.plan "Starter'), `selection after pressing the grip: ${selected}`)
      // A drop over Team: the plan takes Team's place.
      const again = centre((await t.evaluate(() => window.__primp_test!.handles())).grip!)
      await t.mouse.move(again.x, again.y)
      await t.mouse.down()
      await t.mouse.move(centre(plans[1]!).x, centre(plans[1]!).y, { steps: 8 })
      await t.mouse.up()
      await t.evaluate(() => window.__primp_overlay!.controller.idle())
      const dropped = await planOrder(t)
      const recorded = await items(t)
      expect(JSON.stringify(dropped) === JSON.stringify(['Team', 'Starter', 'Scale']) && recorded.length === 1 && structure(recorded[0]).move?.toIndex === 1, `dropped over Team: ${dropped.join(', ')}, ${recorded.length} items`)
      await t.evaluate(() => window.__primp_test!.undo())
      // Alt+Down with the name selected: the plan goes one place later.
      await t.evaluate((selector) => window.__primp_test!.select(selector), name)
      await t.keyboard.press('Alt+ArrowDown')
      await t.evaluate(() => window.__primp_overlay!.controller.idle())
      const byKey = await planOrder(t)
      const keyState = await testState(t)
      const keyFocus = await t.evaluate(() => `${document.activeElement?.localName} ${document.hasFocus()}`)
      expect(JSON.stringify(byKey) === JSON.stringify(['Team', 'Starter', 'Scale']) && (await items(t)).length === 1, `Alt+Down: ${byKey.join(', ')}; error ${keyState.error}; selection ${await t.evaluate(() => window.__primp_test!.selection()?.label)}; focus ${keyFocus}`)
      await t.evaluate(() => window.__primp_test!.undo())
      // Held near the bottom edge, a drag scrolls the page.
      const grip3 = centre((await t.evaluate(() => window.__primp_test!.handles())).grip!)
      const scrollBefore = await t.evaluate(() => scrollY)
      const height = await t.evaluate(() => innerHeight)
      await t.mouse.move(grip3.x, grip3.y)
      await t.mouse.down()
      await t.mouse.move(grip3.x, height - 4, { steps: 6 })
      await sleep(400)
      const scrollDuring = await t.evaluate(() => scrollY)
      await t.keyboard.press('Escape')
      await t.mouse.up()
      await t.evaluate(() => window.__primp_overlay!.controller.idle())
      expect(scrollDuring > scrollBefore + 40 && (await items(t)).length === 0 && JSON.stringify(await planOrder(t)) === JSON.stringify(PLAN_NAMES), `scroll ${scrollBefore} -> ${scrollDuring}`)
      await t.evaluate((selector) => document.querySelector(selector)?.scrollIntoView({ block: 'center' }), PLAN)
      return `grip on the plan around its name, the plan outlined while hovered; live ${live.join(', ')}, Escape back to ${afterEscape.join(', ')}, selection ${selected.slice(0, 20)}; dropped over Team: ${dropped.join(', ')}; Alt+Down: ${byKey.join(', ')}; edge scroll ${scrollBefore} -> ${scrollDuring}`
    })

    await report.attempt('resize by a REAL mouse drag on the corner handle of a card: width and height, one undo step, the border box is the dragged size; Escape during a drag cancels', async () => {
      const card = `${CARD}:nth-of-type(1)`
      await t.evaluate((selector) => document.querySelector(selector)?.scrollIntoView({ block: 'center' }), card)
      await t.mouse.move(2, 2)
      await t.evaluate((selector) => window.__primp_test!.select(selector), card)
      await waitFor(async () => (await testState(t)).source?.state === 'done', { timeoutMs: 5000 })
      await countAppEvents(t, CARD)
      const startBox = await rect(t, card)
      const boxSizing = await computed(t, card, 'box-sizing')
      const handles = await t.evaluate(() => window.__primp_test!.handles())
      expect(handles.se !== undefined && handles.e !== undefined && handles.s !== undefined && handles.grip !== undefined, `handles: ${JSON.stringify(handles)}`)
      await t.screenshot({ path: join(SHOTS, 'handles-light.png') })
      const corner = centre(handles.se)
      const [dx, dy] = [44, 31]
      await t.mouse.move(corner.x, corner.y)
      await resetAppEvents(t)
      await t.mouse.down()
      await t.mouse.move(corner.x + dx, corner.y + dy, { steps: 10 })
      const live = await t.evaluate(() => window.__primp_test!.drag())
      const liveBox = await rect(t, card)
      const midHistory = (await items(t)).length
      await t.mouse.up()
      await t.evaluate(() => window.__primp_overlay!.controller.idle())
      await sleep(100)
      const all = await items(t)
      const box = await rect(t, card)
      const width = style(all.find((item) => item.kind === 'style' && item.property === 'width'))
      const height = style(all.find((item) => item.kind === 'style' && item.property === 'height'))
      const want = { w: Math.round(startBox.w + dx), h: Math.round(startBox.h + dy) }
      expect(live?.kind === 'resize' && live.size.width === want.w && live.size.height === want.h && near(liveBox.w, want.w) && midHistory === 0, `during the drag: ${JSON.stringify(live)}, box ${liveBox.w} x ${liveBox.h}, ${midHistory} items`)
      expect(all.length === 2 && Math.abs(box.w - want.w) <= 1 && Math.abs(box.h - want.h) <= 1, `${all.length} items; border box ${box.w} x ${box.h}, wanted ${want.w} x ${want.h}`)
      const extra = boxSizing === 'border-box' ? { w: 0, h: 0 } : { w: 42, h: 42 }
      expect(Number.parseFloat(width.after.authored) + extra.w === want.w && Number.parseFloat(height.after.authored) + extra.h === want.h, `values ${width.after.authored} / ${height.after.authored} (box-sizing ${boxSizing}) for a ${want.w} x ${want.h} border box`)
      expect(width.after.computed === `${want.w}px` && width.expect.some((entry) => entry.type === 'computed' && entry.property === 'width') && height.expect.some((entry) => entry.type === 'computed' && entry.property === 'height'), `computed ${width.after.computed}; expect ${JSON.stringify(width.expect.map((entry) => entry.type))}`)
      // One undo step takes both away.
      await t.evaluate(() => window.__primp_test!.undo())
      const undone = await items(t)
      const undoneBox = await rect(t, card)
      const canUndo = (await testState(t)).canUndo
      await t.evaluate(() => window.__primp_test!.redo())
      expect(undone.length === 0 && near(undoneBox.w, startBox.w) && near(undoneBox.h, startBox.h) && !canUndo && (await items(t)).length === 2, `undo: ${undone.length} items, box ${undoneBox.w} x ${undoneBox.h}, canUndo ${canUndo}`)
      // Width and height are one gesture with the same side effects: one verdict marks both, and the tray lists them once.
      expect(width.sideEffects.length > 0, 'the corner resize moved nothing else on the page, so there is no shared side effect to mark')
      await t.evaluate((id) => window.__primp_test!.setVerdict(id, 0, 'unwanted'), width.id)
      const marked = await items(t)
      const heightAfter = style(marked.find((item) => item.kind === 'style' && item.property === 'height'))
      const sameShown = await page.dock.evaluate(() => [...document.querySelectorAll('.tray .chip')].filter((chip) => chip.textContent === 'same side effects as above').length)
      expect(heightAfter.sideEffects.filter((effect) => effect.verdict === 'unwanted').length === 1 && heightAfter.expect.some((entry) => entry.type === 'no-move'), `height after marking the width's first effect unwanted: ${JSON.stringify(heightAfter.sideEffects.map((effect) => effect.verdict))}`)
      expect(sameShown === 1, `"same side effects as above" shown ${sameShown} times`)
      await t.evaluate(() => window.__primp_test!.undo())
      const unmarked = style((await items(t)).find((item) => item.kind === 'style' && item.property === 'height'))
      expect(unmarked.sideEffects.every((effect) => effect.verdict !== 'unwanted') && (await items(t)).length === 2, 'one undo did not take the verdict back from both')
      // Escape during a drag: the size shown goes back, nothing is recorded.
      const before = await rect(t, card)
      const se = centre((await t.evaluate(() => window.__primp_test!.handles())).se!)
      await t.mouse.move(se.x, se.y)
      const seenBefore = await appEvents(t)
      await t.mouse.down()
      await t.mouse.move(se.x + 60, se.y + 50, { steps: 6 })
      const grown = await rect(t, card)
      await t.keyboard.press('Escape')
      await sleep(50)
      const cancelled = await rect(t, card)
      await t.mouse.up()
      await t.evaluate(() => window.__primp_overlay!.controller.idle())
      await sleep(100)
      const kept = await items(t)
      const events = await appEvents(t)
      // The move to the second press is the page's (the pointer passes over the card): only what came after it counts.
      for (const [type, count] of Object.entries(seenBefore)) {
        events[type] = (events[type] ?? 0) - count
        if (events[type] === 0) delete events[type]
      }
      expect(grown.w > before.w + 50 && near(cancelled.w, before.w) && near(cancelled.h, before.h) && kept.length === 2 && style(kept.find((item) => item.kind === 'style' && item.property === 'width')).after.authored === width.after.authored, `Escape: ${before.w} -> ${grown.w} during the drag -> ${cancelled.w} after Escape; ${kept.length} items`)
      expect(Object.keys(events).length === 0, `the app saw: ${JSON.stringify(events)}`)
      return `box-sizing ${boxSizing}; dragged +${dx},+${dy} from ${startBox.w} x ${startBox.h}: live preview ${liveBox.w} x ${liveBox.h} with nothing recorded, then width ${width.after.authored} and height ${height.after.authored} in one undo step, border box ${box.w} x ${box.h}; Escape mid-drag: ${grown.w} back to ${cancelled.w}, still 2 items; the card's and document's handlers saw nothing`
    })

    await report.attempt('resize refusals: an inline element (no handles either), and a size the layout does not let change', async () => {
      await t.evaluate(() => window.__primp_test!.select('.plan__period'))
      const inline = await t.evaluate(() => window.__primp_test!.resize({ width: 120 }))
      const inlineHandles = await t.evaluate(() => window.__primp_test!.handles())
      // A table row: width does not apply to it.
      const row = '[data-label="pricing-compare-support"]'
      await t.evaluate((selector) => window.__primp_test!.select(selector), row)
      const box = await rect(t, row)
      const cssBefore = (await testState(t)).previewCss
      const wide = await t.evaluate((w) => window.__primp_test!.resize({ width: w }), box.w + 80)
      const after = await rect(t, row)
      const css = (await testState(t)).previewCss
      expect(!inline.ok && inline.error?.includes('inline element') === true && inlineHandles.se === undefined && inlineHandles.e === undefined, `inline: ${JSON.stringify(inline)}, handles ${JSON.stringify(inlineHandles)}`)
      expect(!wide.ok && wide.error?.includes('did not change') === true && near(after.w, box.w) && css === cssBefore, `table row: ${JSON.stringify(wide)}; width ${box.w} -> ${after.w}; preview css "${css}"`)
      expect((await items(t)).length === 2, `items: ${(await items(t)).length}`)
      return `"${inline.error}"; a table row: "${wide.error}"; nothing recorded, no preview left`
    })

    await report.attempt('the handles and the drags added no layout-shift entry that is not tagged as primp\'s own', async () => {
      // Handles coming and going: the dock opened and closed, another selection, none.
      await t.evaluate(() => window.__primp_test!.pick(true))
      await sleep(150)
      const inPick = await t.evaluate(() => window.__primp_test!.handles())
      await t.evaluate(() => window.__primp_test!.pick(false))
      await t.evaluate((selector) => window.__primp_test!.select(selector), `${PLAN}:nth-of-type(2)`)
      await sleep(150)
      await t.evaluate(() => window.__primp_overlay!.controller.select(null))
      await sleep(150)
      const none = await t.evaluate(() => window.__primp_test!.handles())
      const after = await unmarkedShifts(t)
      expect(Object.keys(inPick).length > 0 && Object.keys(none).length === 0, `handles on the selection of the open dock ${JSON.stringify(inPick)}, without a selection ${JSON.stringify(none)}`)
      expect(after.unmarked === shiftsBefore.unmarked, `untagged entries: ${shiftsBefore.unmarked} before, ${after.unmarked} after (${after.own - shiftsBefore.own} tagged)`)
      return `handles on the selection while the dock is open, none without a selection; ${after.unmarked - shiftsBefore.unmarked} untagged entries added over two drags, a resize and handles shown and hidden; ${after.own - shiftsBefore.own} tagged as primp's own (the previews)`
    })

    await report.attempt('screenshots: the selection with its handles, a reorder drag with its insertion line, and the tray with a move and a resize', async () => {
      await t.evaluate((selector) => window.__primp_test!.select(selector), `${PLAN}:nth-of-type(1)`)
      await t.evaluate(() => window.__primp_test!.move(1))
      await sleep(300)
      await page.dock.evaluate(() => document.querySelector('#panel')?.scrollTo(0, 100000))
      await sleep(200)
      await t.screenshot({ path: join(SHOTS, 'reorder-tray-light.png') })
      return 'handles-light.png, reorder-drag-light.png, reorder-tray-light.png in .tmp/m1-overlay-shots/'
    })
  } finally {
    await page.close()
  }
}

async function foreignStylesheet(css: string): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' })
    response.end(css)
  })
  await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve))
  const address = server.address() as AddressInfo
  const close = (): Promise<void> => new Promise((resolve) => server.close(() => resolve()))
  onCleanup(close)
  return { url: `http://localhost:${address.port}/foreign.css`, close }
}

async function staticStates(browser: Browser, lane: Lane): Promise<void> {
  const page = await openDock(browser, lane, '/')
  const t = page.page
  const CTA = '[data-label="hero-cta"]'
  const AMBER = 'rgb(183, 121, 31)' // --warn
  let revert: (() => void) | undefined
  try {
    await t.mouse.move(2, 2)
    const ref = await t.evaluate((selector) => window.__primp_test!.select(selector), CTA)
    let item: StyleChange | undefined

    await report.attempt(':focus-visible on plain HTML: the page\'s :focus-visible ring without focus, an edit recorded for it, measured with the state emulated', async () => {
      const state0 = await testState(t)
      const restOutline = await computed(t, CTA, 'outline-style')
      await t.evaluate(() => window.__primp_test!.setState('focus-visible'))
      const ring = { style: await computed(t, CTA, 'outline-style'), color: await computed(t, CTA, 'outline-color'), focused: await t.evaluate((selector) => document.activeElement === document.querySelector(selector), CTA) }
      // The bare :focus-visible rule does not apply to a plain :focus.
      await t.evaluate(() => window.__primp_test!.setState('focus'))
      const plainFocus = await computed(t, CTA, 'outline-style')
      await t.evaluate(() => window.__primp_test!.setState('focus-visible'))
      expect(state0.statesWithRules.includes('focus-visible') && state0.statesWithRules.includes('hover') && !state0.statesWithRules.includes('focus'), `statesWithRules ${JSON.stringify(state0.statesWithRules)}`)
      expect(restOutline === 'none' && ring.style === 'solid' && ring.color === AMBER && !ring.focused && plainFocus === 'none', `outline at rest ${restOutline}; forced :focus-visible ${JSON.stringify(ring)}; forced :focus ${plainFocus}`)
      await openAllCss(page)
      const listed = await waitFor(() => page.dock.evaluate(() => [...document.querySelectorAll('.rule')].find((rule) => rule.querySelector('.sel')?.textContent === ':focus-visible')?.querySelector<HTMLInputElement>('#v-outline')?.value))
      const result = await t.evaluate(() => window.__primp_test!.setStyle('outline-color', '#2563eb'))
      item = style(result.item)
      expect(item.condition.state === 'focus-visible' && item.before.computed === AMBER && item.after.computed === BLUE && item.origin?.selector === ':focus-visible' && item.bystanders === undefined, `item: ${JSON.stringify({ condition: item.condition, before: item.before, after: item.after, origin: item.origin })}`)
      const measured = await lane.primp.session.measure([item], 5000)
      const check = measured.status === 'measured' ? measured.results[0]?.checks[0] : undefined
      expect(check?.status === 'fail' && check.actual === AMBER && check.expected === BLUE && check.note === 'measured with :focus-visible emulated', `before the source changed: ${JSON.stringify(check)}`)
      // The source gets the new colour; plain HTML has no hot update, so the page is loaded again (the draft comes back from the server).
      revert = editFile(lane.fixture, 'css/site.css', replaceOnce('outline: 2px solid var(--warn);', 'outline: 2px solid #2563eb;')).revert
      await t.reload({ waitUntil: 'load' })
      await t.waitForFunction(() => window.__primp_test !== undefined)
      await t.evaluate(() => window.__primp_test!.ready())
      const again = await lane.primp.session.measure([item], 5000)
      const pass = again.status === 'measured' ? again.results[0]?.checks[0] : undefined
      expect(pass?.status === 'pass' && pass.actual === BLUE && pass.note === 'measured with :focus-visible emulated', `after the source changed: ${JSON.stringify(pass)}`)
      expect((await forceMarks(t)).elements === 0, 'the reloaded page has a marker on it')
      return `statesWithRules ${JSON.stringify(state0.statesWithRules)}; outline at rest ${restOutline}, forced :focus-visible ${ring.style} ${ring.color} with the focus elsewhere, forced :focus ${plainFocus}; the dock lists outline "${listed}" under :focus-visible; outline-color edit recorded for :focus-visible (before ${item.before.computed}); measured: ${check.status} (${check.actual}), after site.css changed and a reload: ${pass.status} (${pass.actual}), both "${pass.note}"`
    })

    await report.attempt('a rule the page cannot read (another origin) and a state value equal to rest: not_measurable "the state could not be emulated: ..."', async () => {
      const foreign = await foreignStylesheet('.button:focus { color: rgb(255, 0, 0); }\n')
      try {
        await t.evaluate((href) => new Promise<void>((resolve, reject) => {
          const link = document.createElement('link')
          link.rel = 'stylesheet'
          link.href = href
          link.id = 'foreign-sheet'
          link.onload = () => resolve()
          link.onerror = () => reject(new Error('the foreign stylesheet did not load'))
          document.head.append(link)
        }), foreign.url)
        const facts = await t.evaluate(() => {
          const sheet = (document.getElementById('foreign-sheet') as HTMLLinkElement).sheet
          let readable = true
          try {
            void sheet?.cssRules
          } catch {
            readable = false
          }
          return { loaded: sheet !== null, readable }
        })
        // The sheet applies (a real focus would turn the text red) but cannot be read.
        await t.locator(CTA).focus()
        const realFocus = await computed(t, CTA, 'color')
        await t.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
        const condition = { ...(item?.condition ?? { viewport: { w: 1280, h: 800, dpr: 1 }, colorScheme: 'light' as const }) }
        delete condition.state
        const answer = await t.evaluate(([locator, cond]) => window.__primp_test!.measure([{
          itemId: 'foreign',
          locator,
          expect: [
            { type: 'computed', property: 'color', value: 'rgb(255, 0, 0)', condition: { ...cond, state: 'focus' } },
            // The same page, a state that does change the value: measured.
            { type: 'computed', property: 'outline-style', value: 'solid', condition: { ...cond, state: 'focus-visible' } },
          ],
        }]), [ref.locator, condition] as const)
        const [blocked, measured] = answer.results[0]!.checks
        expect(facts.loaded && !facts.readable && realFocus === 'rgb(255, 0, 0)', `foreign sheet ${JSON.stringify(facts)}, colour under a real focus ${realFocus}`)
        expect(blocked?.status === 'not_measurable' && blocked.note?.startsWith('the state could not be emulated: ') === true && blocked.note.includes('another origin'), `blocked: ${JSON.stringify(blocked)}`)
        expect(measured?.status === 'pass' && measured.note === 'measured with :focus-visible emulated', `measured: ${JSON.stringify(measured)}`)
        const server = await lane.primp.session.measure([{ ...style(item), expect: [{ type: 'computed', property: 'color', value: 'rgb(255, 0, 0)', condition: { ...condition, state: 'focus' } }] }], 5000)
        const viaServer = server.status === 'measured' ? server.results[0]?.checks[0] : undefined
        expect(viaServer?.status === 'not_measurable' && viaServer.note === blocked.note, `through the server: ${JSON.stringify(viaServer)}`)
        await t.evaluate(() => document.getElementById('foreign-sheet')?.remove())
        return `a <link> to ${foreign.url.replace(/^http:\/\/localhost/, 'localhost')} (no CORS): applies (real focus -> red) but cannot be read; color under :focus -> ${blocked.status} "${blocked.note}"; outline-style under :focus-visible on the same page -> ${measured.status} ("${measured.note}"); the server's session:measure gets the same note`
      } finally {
        await foreign.close()
      }
    })
  } finally {
    revert?.()
    await page.close()
  }
}

// ---------------------------------------------------------------------------
// next-16-turbopack and static-html
// ---------------------------------------------------------------------------

async function nextEdits(browser: Browser, lane: Lane): Promise<void> {
  const page = await openDock(browser, lane, '/')
  const t = page.page
  const card = '[data-label="home-card-edits"]'
  try {
    await report.attempt('under a strict nonce CSP: select, edit all instances, undo, send, with zero CSP violations', async () => {
      const policy = await t.evaluate(async () => (await fetch(location.href)).headers.get('content-security-policy') ?? '')
      expect(policy.includes("'strict-dynamic'") && /style-src 'self' 'nonce-/.test(policy), `this page is not under the strict policy: ${policy}`)
      const ref = await t.evaluate((selector) => window.__primp_test!.select(selector), card)
      const source = (await waitFor(async () => {
        const now = await testState(t)
        return now.source?.state === 'done' ? now : undefined
      }, { timeoutMs: 20_000, what: 'the source of the card to resolve' })).source
      const truth = lane.fixture.labels.find((entry) => entry.label === 'home-card-edits')
      expect(source !== null && truth !== undefined && source.file === truth.file && source.line === truth.line, `source ${JSON.stringify(source)}, labels.json says ${truth?.file}:${truth?.line}`)
      const result = await t.evaluate(() => window.__primp_test!.setStyle('padding', '24px', { scope: 'all-instances' }))
      const item = style(result.item)
      const paddings = await computedAll(t, 'li[data-label^="home-card-"]', 'padding')
      expect(ref.instanceCount === 3 && paddings.length === 3 && paddings.every((value) => value === '24px'), `instances ${ref.instanceCount}; paddings ${paddings.join(', ')}`)
      expect(item.before.computed === '16px' && item.stylingSystem === 'css-modules' && item.origin?.via === 'rule', `item: ${JSON.stringify({ before: item.before, system: item.stylingSystem, origin: item.origin })}`)
      const hidden = await (async () => {
        await t.evaluate(() => window.__primp_test!.select('[data-label="home-hero"]'))
        const before = await rect(t, '[data-label="home-card-grid"]')
        const hero = await rect(t, '[data-label="home-hero"]')
        const outcome = await t.evaluate(() => window.__primp_test!.hide())
        const after = await rect(t, '[data-label="home-card-grid"]')
        return { ok: outcome.ok, moved: before.y - after.y, hero: hero.h, effects: outcome.item?.sideEffects.length ?? 0 }
      })()
      expect(hidden.ok && hidden.moved > 0 && hidden.effects > 0, `hide: ${JSON.stringify(hidden)}`)
      await t.evaluate(() => window.__primp_test!.undo())
      const prompt = await t.evaluate(() => window.__primp_test!.send())
      await page.bar.locator('button[aria-label="Verification"]').click()
      await page.bar.locator('button[aria-label="Layout shifts"]').click()
      await page.bar.locator('button[aria-label="Changes"]').click()
      await sleep(200)
      expect(prompt.includes('padding') && prompt.includes('24px') && prompt.includes(truth.file) && (await computedAll(t, 'li[data-label^="home-card-"]', 'padding')).every((value) => value === '16px'), `prompt "${prompt.slice(0, 200)}"`)
      const problems = hygiene(page, lane)
      expect(problems.length === 0, problems.join('; '))
      return `policy "${policy.slice(0, 70)}...": 3 instances edited through one constructable stylesheet (16px -> 24px, css-modules), source ${source.file}:${source.line} (${source.level}) = labels.json, hide moved the grid up ${hidden.moved}px with ${hidden.effects} effects, undo, send, all three tabs opened; ${hygieneText(page, lane)}`
    })

    await report.attempt('a client-side navigation (next/link, then Back): new edits are recorded for the new page, each page shows only its own previews, the Changes panel follows', async () => {
      await t.evaluate((selector) => window.__primp_test!.select(selector), card)
      const home = style((await t.evaluate(() => window.__primp_test!.setStyle('padding', '30px'))).item)
      // A marker that survives only a client-side navigation.
      await t.evaluate(() => ((window as unknown as { __spa: number }).__spa = 1))
      await t.evaluate(() => window.__primp_test!.open(false))
      await t.click('header nav a[href="/actions"]')
      await waitFor(async () => (await t.evaluate(() => location.pathname)) === '/actions' && (await t.locator('[data-label="actions-title"]').count()) === 1, { timeoutMs: 20_000, what: 'the client-side navigation to /actions' })
      const spa = await t.evaluate(() => (window as unknown as { __spa?: number }).__spa === 1)
      await sleep(1200)
      const homeRuleOnActions = (await testState(t)).previewCss.includes('30px')
      await t.evaluate(() => window.__primp_test!.select('[data-label="actions-title"]'))
      const actions = style((await t.evaluate(() => window.__primp_test!.setStyle('letter-spacing', '2px'))).item)
      await page.bar.locator('button[aria-label="Changes"]').click()
      await sleep(200)
      const panel = await page.dock.evaluate(() => document.body.textContent ?? '')
      // Back: a popstate; the home page's preview comes back, the actions page's goes.
      await t.evaluate(() => window.__primp_test!.open(false))
      await t.goBack()
      await waitFor(async () => (await t.evaluate(() => location.pathname)) === '/' && (await t.locator(card).count()) > 0, { timeoutMs: 20_000, what: 'Back to /' })
      await waitFor(async () => (await computed(t, card, 'padding')) === '30px', { timeoutMs: 5000, what: "the home page's preview to come back" }).catch(() => undefined)
      const back = { padding: await computed(t, card, 'padding'), css: (await testState(t)).previewCss }
      expect(spa, 'the navigation reloaded the document; this check needs a client-side one')
      expect(home.page === '/' && actions.page === '/actions', `pages recorded: ${home.page}, ${actions.page}`)
      expect(!homeRuleOnActions, "the home page's preview stayed applied on /actions")
      expect(panel.includes('1 more on other pages') || panel.includes('more on other pages'), `Changes panel on /actions: ${panel.slice(0, 300)}`)
      expect(back.padding === '30px' && !back.css.includes('2px'), `after Back: padding ${back.padding}, preview css ${back.css.slice(0, 200)}`)
      await t.evaluate(() => window.__primp_test!.undo())
      await t.evaluate(() => window.__primp_test!.undo())
      return `home card padding recorded for /, letter-spacing on /actions recorded for /actions; on /actions the home preview was off and the Changes panel listed the other page's draft; Back to /: padding ${back.padding} again, the /actions preview off`
    })
  } finally {
    await page.close()
  }
}

async function staticEdits(browser: Browser, lane: Lane): Promise<void> {
  const page = await openDock(browser, lane, '/')
  const t = page.page
  try {
    await report.attempt('plain HTML and CSS: instances, a custom-property value, hide with its side effect, undo', async () => {
      const ref = await t.evaluate(() => window.__primp_test!.select('.card'))
      const result = await t.evaluate(() => window.__primp_test!.setStyle('border-radius', 'calc(var(--radius) * 2)', { scope: 'all-instances' }))
      const item = style(result.item)
      const radii = await computedAll(t, '.card', 'border-radius')
      expect(ref.instanceCount === 3 && radii.every((value) => value === '16px') && item.stylingSystem === 'plain-css', `instances ${ref.instanceCount}; radii ${radii.join(', ')}; system ${item.stylingSystem}`)
      expect(item.origin?.sheet?.endsWith('/css/site.css') === true, `origin: ${JSON.stringify(item.origin)}`)
      const hero = await rect(t, '.hero')
      const before = await rect(t, '.cards')
      await t.evaluate(() => window.__primp_test!.select('.hero'))
      const hidden = await t.evaluate(() => window.__primp_test!.hide())
      const after = await rect(t, '.cards')
      const effect = hidden.item?.sideEffects.find((entry) => entry.label.startsWith('section.cards'))
      expect(before.y - after.y > 0 && effect !== undefined && near(effect.before.y - effect.after.y, before.y - after.y), `cards moved ${before.y - after.y}px; effect ${JSON.stringify(effect)}`)
      await t.evaluate(() => window.__primp_test!.undo())
      await t.evaluate(() => window.__primp_test!.undo())
      expect((await items(t)).length === 0 && (await marks(t)) === 0 && near((await rect(t, '.cards')).y, before.y), 'undo did not restore the page')
      const problems = hygiene(page, lane)
      expect(problems.length === 0, problems.join('; '))
      return `3 cards at calc(var(--radius) * 2) = 16px (plain-css, site.css); hiding the ${hero.h}px hero moved section.cards up ${before.y - after.y}px, recorded with the same number; undo x2 restores everything`
    })

    await report.attempt('primp is restarted and the page stays: the ONE socket reconnects, the same document says hello again, drafts are re-sent', async () => {
      await t.evaluate(() => window.__primp_test!.select('.hero-title'))
      await t.evaluate(() => window.__primp_test!.setStyle('font-size', '50px'))
      await waitFor(() => lane.primp.session.items().length === 1, { timeoutMs: 3000 })
      const doc = lane.primp.session.documents()[0]?.doc
      const loads = page.record.documentRequests.length
      await lane.primp.close()
      await waitFor(async () => !(await testState(t)).connected, { timeoutMs: 3000, what: 'the dock to notice the lost connection' })
      await t.evaluate(() => window.__primp_test!.setStyle('letter-spacing', '1px'))
      await sleep(1200)
      await restartPrimp(lane)
      await waitFor(async () => (await testState(t)).connected, { timeoutMs: 12_000, what: 'the reconnect' })
      await waitFor(() => lane.primp.session.items().length === 2, { timeoutMs: 3000, what: `the drafts to arrive (the new session has ${lane.primp.session.items().length})` })
      await waitFor(() => lane.primp.detector.status().browsers === 1, { timeoutMs: 3000, what: 'the settle detector to know the document again' })
      const again = lane.primp.session.documents()
      expect(again.length === 1 && again[0]?.doc === doc && page.record.documentRequests.length === loads, `document ${doc} -> ${again.map((entry) => entry.doc).join(', ')}; ${page.record.documentRequests.length - loads} reloads`)
      expect((await computed(t, '.hero-title', 'font-size')) === '50px' && (await computed(t, '.hero-title', 'letter-spacing')) === '1px', 'the previews did not survive')
      const refused = lane.logs.filter((line) => line.includes('did not match the protocol') || line.includes('before session:hello'))
      expect(refused.length === 0, refused.join(' | '))
      const sockets = page.record.webSockets.filter((url) => url.includes('/__primp/')).length
      await t.evaluate(() => window.__primp_test!.undo())
      await t.evaluate(() => window.__primp_test!.undo())
      return `no reload; ${sockets} socket attempts in all (backoff while primp was down); the same document id said hello to the new session, both drafts (one made while down) were stored again, the settle detector has its browser back, previews untouched`
    })
  } finally {
    await page.close()
  }
}

// ---------------------------------------------------------------------------
// cls-corpus: the Shifts tab
// ---------------------------------------------------------------------------

const SHIFT_PAGE = '/injected-content/banner-innerhtml/'

async function shiftsTab(browser: Browser, lane: Lane, bundles: Bundles): Promise<void> {
  const page = await openDock(browser, lane, SHIFT_PAGE)
  const t = page.page
  try {
    await report.attempt('the recording is sent by itself about 3 s after the page went quiet, and the tab shows the culprit', async () => {
      await t.evaluate(() => window.__primp_test!.openTab('shifts'))
      const waiting = await page.dock.evaluate(() => document.querySelector('#panel')?.textContent ?? '')
      const started = Date.now()
      const row = await waitFor(() => page.dock.evaluate(() => {
        const issue = document.querySelector('[data-issue]')
        return issue === null ? undefined : { text: issue.textContent ?? '', who: issue.querySelector('.who')?.textContent ?? '', badge: issue.querySelector('.source')?.textContent ?? '', cls: document.querySelector('.cls .value')?.textContent ?? '' }
      }), { timeoutMs: 9000, what: 'the shift report to appear in the dock' })
      const seconds = (Date.now() - started) / 1000
      const stored = lane.primp.session.shifts()
      expect(stored !== undefined && stored.report.status === 'ok', `the session holds: ${JSON.stringify(stored?.report.status)}`)
      // expected.json of the corpus page: the culprit is written by the script at index.html:38.
      expect(row.who === 'div#promo-banner' && row.text.includes('injected content') && row.badge.includes('index.html:38'), `row: ${JSON.stringify(row)}`)
      expect(Math.abs(Number(row.cls) - 0.039) < 0.002, `CLS shown: ${row.cls}`)
      expect(row.text.includes('header#site-header') && row.text.includes('down 96px'), `victims: ${row.text}`)
      // A shift with a named cause can be handed to an agent: the server renders its instructions for the clipboard.
      const prompt = await t.evaluate(() => {
        const controller = window.__primp_overlay!.controller
        const issue = controller.store.shifts.value?.report.issues.find((one) => one.scored && one.cause === 'injected-content')
        return issue === undefined ? Promise.resolve('') : controller.shiftPrompt([issue.id])
      })
      const button = await page.dock.evaluate(() => [...document.querySelectorAll('button')].some((one) => one.textContent?.trim() === 'Copy fix prompt'))
      expect(button && prompt.includes('## Layout shifts (1)') && prompt.includes('promo-banner'), `Copy fix prompt button ${button}; prompt ${prompt.slice(0, 200)}`)
      return `before the report: "${waiting.trim().slice(0, 60)}..."; ${seconds.toFixed(1)} s later, unprompted: CLS ${row.cls}, culprit ${row.who} (${row.badge.trim()}), "injected content", victims moved down 96px; Copy fix prompt renders ${prompt.split('\n').length} lines naming #promo-banner`
    })

    await report.attempt('shiftReport(): the attributed report names the expected culprit, and the dock added nothing to the recording', async () => {
      const state = await t.evaluate(() => window.__primp_test!.shiftReport())
      const report_: ShiftReport = state.report
      const top = report_.issues.find((issue) => issue.scored)
      expect(report_.status === 'ok' && top?.culprit?.node.id === 'promo-banner' && top.cause === 'injected-content', `report: ${JSON.stringify({ status: report_.status, culprit: top?.culprit?.node.id, cause: top?.cause })}`)
      const plain = await readPlainEntries(t)
      const control = await newPage(browser)
      let controlEntries: PlainEntry[]
      try {
        await control.page.goto(lane.control.url + SHIFT_PAGE, { waitUntil: 'load' })
        await sleep(2500)
        controlEntries = await readPlainEntries(control.page)
      } finally {
        await control.close()
      }
      const scoredIssues = report_.issues.filter((issue) => issue.scored).length
      expect(scored(plain).length === scored(controlEntries).length && scoredIssues === 1, `with the dock ${describeEntries(plain)}, without ${describeEntries(controlEntries)}, ${scoredIssues} scored issues`)
      expect(Math.abs((report_.cls ?? 0) - sum(scored(controlEntries).map((entry) => entry.value))) < 1e-6, `CLS ${report_.cls} vs the control's ${sum(scored(controlEntries).map((entry) => entry.value))}`)
      return `status ok, CLS ${fixed(report_.cls ?? 0, 6)} = the page without primp (${describeEntries(controlEntries)}), top culprit #promo-banner, cause injected-content, confidence ${top.confidence}`
    })

    await report.attempt('hovering an issue outlines the victims (before and after) and the culprit on the page', async () => {
      const box = await page.dock.locator('[data-issue]').first().boundingBox()
      expect(box !== null, 'the issue row has no box')
      // Playwright reports the box of an element in a frame in page coordinates.
      await t.mouse.move(box.x + 20, box.y + 12)
      const boxes = await waitFor(() => t.evaluate(() => {
        const shown = [...document.querySelector('primp-root')!.shadowRoot!.querySelectorAll<HTMLElement>('.box')].filter((node) => getComputedStyle(node).display !== 'none')
        const kinds = shown.map((node) => `${node.className.replace('box ', '')}@${Math.round(node.getBoundingClientRect().top)}`)
        return kinds.some((kind) => kind.startsWith('culprit')) ? kinds : undefined
      }))
      expect(boxes.filter((kind) => kind.startsWith('previous')).length === 2 && boxes.filter((kind) => kind.startsWith('current')).length === 2 && boxes.includes('culprit@0'), `boxes: ${boxes.join(', ')}`)
      expect(boxes.includes('previous@0') && boxes.includes('current@96'), `the header's rectangles are not at 0 and 96: ${boxes.join(', ')}`)
      await t.mouse.move(5, 400)
      // While the panel is open the main culprit stays outlined; the victims' rectangles go with the pointer.
      // (The outline of the page element under the pointer is the open dock's hover, not the issue's.)
      const left = await waitFor(() =>
        t.evaluate(() => {
          const kinds = [...document.querySelector('primp-root')!.shadowRoot!.querySelectorAll<HTMLElement>('.box')].filter((node) => getComputedStyle(node).display !== 'none' && !node.classList.contains('hover')).map((node) => node.className.replace('box ', ''))
          return kinds.length === 1 && kinds[0] === 'culprit' ? kinds : undefined
        }),
      )
      const entries = scored(await readPlainEntries(t)).length
      expect(entries === 1, `drawing the outlines added layout-shift entries: ${entries}`)
      return `on hover: ${boxes.join(', ')}; when the pointer leaves only the main culprit stays outlined (${left.join(', ')}); still 1 layout-shift entry on the page`
    })

    await report.attempt('a report that could not measure is shown as such (tab_hidden), not as "no shifts" [fake session server]', async () => {
      // The real attributor only says this for a tab that really was hidden; a fake server says it on demand.
      const fake = await startFakeLane(lane.fixture, bundles)
      const hidden = await openDock(browser, lane, SHIFT_PAGE, { origin: fake.proxy.url })
      try {
        await hidden.page.evaluate(() => window.__primp_test!.openTab('shifts'))
        fake.session.pushShiftReport({ status: 'tab_hidden', reason: 'the tab was hidden from 0 to 412 ms', cls: null, windows: [], issues: [], cachedResources: [], notes: [] })
        const text = await waitFor(() => hidden.dock.evaluate(() => {
          const alert = document.querySelector('[data-shift-status="tab_hidden"]')
          return alert === null ? undefined : (document.querySelector('#panel')?.textContent ?? '')
        }))
        const badge = await hidden.bar.evaluate(() => document.querySelector('#tab-shifts .pill')?.textContent ?? '')
        expect(text.includes('Not measured: the tab was in the background') && text.includes('hidden from 0 to 412 ms') && !/no layout shifts/i.test(text) && !text.includes('CLS of this load'), `Shifts tab: ${text.slice(0, 300)}`)
        fake.session.pushShiftReport({ status: 'not_measurable', reason: 'no layout-shift entry type', cls: null, windows: [], issues: [], cachedResources: [], notes: [] })
        const other = await waitFor(() => hidden.dock.evaluate(() => (document.querySelector('[data-shift-status="not_measurable"]') === null ? undefined : (document.querySelector('#panel')?.textContent ?? ''))))
        expect(other.includes('cannot be measured') && !/no layout shifts/i.test(other), `not_measurable: ${other.slice(0, 200)}`)
        expect(fake.session.invalid.length === 0, `messages the fake server could not parse: ${fake.session.invalid.join(' | ')}`)
        return `tab_hidden -> "Not measured: the tab was in the background..." with the reason, tab badge "${badge}"; not_measurable -> "Layout shifts cannot be measured here..."; neither says "no layout shifts"`
      } finally {
        await hidden.close()
        await fake.proxy.close()
      }
    })

    await report.attempt('a session that says what happened to the batch (session:sent note) replaces the dock\'s own words after Send [fake session server]', async () => {
      const fake = await startFakeLane(lane.fixture, bundles)
      const other = await openDock(browser, lane, SHIFT_PAGE, { origin: fake.proxy.url, context: { permissions: ['clipboard-read', 'clipboard-write'] } })
      try {
        fake.session.sentNote = 'Nothing is sent from this page: copy the prompt into your agent.'
        await other.page.evaluate(() => window.__primp_test!.select('#title'))
        await other.page.evaluate(() => window.__primp_test!.setStyle('letter-spacing', '1px'))
        await other.page.evaluate(() => window.__primp_test!.send())
        const notice = await waitFor(() => other.dock.evaluate(() => document.querySelector('.notice')?.textContent ?? undefined), { timeoutMs: 5000, what: 'the notice after Send' })
        expect(notice.includes('Nothing is sent from this page') && !notice.includes('over MCP'), `the dock says "${notice}"`)
        return `after Send the dock says "${notice.replace('Dismiss', '').trim()}" (the session's note), not the MCP text`
      } finally {
        await other.close()
        await fake.proxy.close()
      }
    })

    await report.attempt('the dock\'s own updates (source badge, reports, tab switches without input) add no layout-shift entry', async () => {
      const fresh = await openDock(browser, lane, SHIFT_PAGE)
      try {
        await sleep(1500)
        const before = scored(await readPlainEntries(fresh.page)).length
        // No user input in any of this: everything is driven through the handle and the socket.
        await fresh.page.evaluate(() => window.__primp_test!.select('#title'))
        await waitFor(async () => (await testState(fresh.page)).source?.state === 'done')
        await fresh.page.evaluate(() => window.__primp_test!.setStyle('color', 'rgb(0, 0, 255)'))
        await fresh.page.evaluate(() => window.__primp_test!.openTab('shifts'))
        await fresh.page.evaluate(() => window.__primp_test!.shiftReport())
        await fresh.page.evaluate(() => window.__primp_test!.openTab('edits'))
        await fresh.page.evaluate(() => window.__primp_test!.collapse(true))
        await sleep(200)
        await fresh.page.evaluate(() => window.__primp_test!.collapse(false))
        await sleep(700)
        const recording = await fresh.page.evaluate(() => window.__primp!.recording())
        const after = scored(await readPlainEntries(fresh.page)).length
        const unmarked = recording.shifts.filter((entry) => entry.selfInduced === undefined && !entry.hadRecentInput).length
        expect(before === 1 && after === 1 && unmarked === 1, `entries before ${before}, after ${after}; unmarked in the recording ${unmarked}`)
        return `1 entry (the page's own) before and after: selecting, the badge resolving, a colour edit, two tab switches, a report arriving and collapsing/expanding the dock added none`
      } finally {
        await fresh.close()
      }
    })
  } finally {
    await page.close()
  }
}

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------

async function screenshots(browser: Browser, vite: Lane, cls: Lane): Promise<void> {
  mkdirSync(SHOTS, { recursive: true })
  await report.attempt('screenshots of the dock: closed, toolbar, hover, inspector, pins, panels, bottom sheet; dark and light', async () => {
    const files: string[] = []
    const shot = async (page: DockPage['page'], name: string): Promise<void> => {
      await sleep(250)
      files.push(name)
      await page.screenshot({ path: join(SHOTS, name) })
    }
    const verdict = (status: 'pass' | 'drift' | 'fail', item: ChangeItem): NonNullable<ChangeItem['verification']> => ({
      itemId: item.id,
      attempt: 1,
      at: Date.now(),
      status,
      checks: item.expect.slice(0, 1).map((expectation) => ({ expectation, status, expected: '28px', actual: status === 'pass' ? '28px' : status === 'drift' ? '27px' : '20px' })),
      hint: status === 'pass' ? '' : status === 'drift' ? 'padding-top is 27px, close to the 28px asked for.' : 'padding-top is 20px, expected 28px.',
    })
    for (const scheme of ['dark', 'light'] as const) {
      const p = await openDock(browser, vite, '/', { context: { colorScheme: scheme } })
      const t = p.page
      try {
        if (scheme === 'dark') await shot(t, 'closed-dark.png')
        await t.evaluate(() => window.__primp_test!.open(true))
        if (scheme === 'dark') await shot(t, 'toolbar-dark.png')
        const card = await rect(t, `${CARD}:nth-of-type(2)`)
        await t.mouse.move(card.x + card.w - 30, card.y + card.h - 12)
        await shot(t, `hover-${scheme}.png`)
        await t.mouse.click(card.x + card.w - 30, card.y + card.h - 12)
        await waitFor(async () => (await testState(t)).source?.state === 'done')
        await t.evaluate(() => window.__primp_test!.setStyle('padding', '28px'))
        await t.mouse.move(card.x + card.w - 30, card.y + card.h + 40)
        await shot(t, `inspector-${scheme}.png`)
        // Three more changed elements, then pins in every status.
        for (const selector of [`${CARD}:nth-of-type(1)`, `${CARD}:nth-of-type(3)`, '[data-label="hero-cta-primary"]']) {
          await t.evaluate((sel) => window.__primp_test!.select(sel), selector)
          await t.evaluate(() => window.__primp_test!.setStyle('border-radius', '20px'))
        }
        await t.evaluate(() => window.__primp_test!.select('[data-label="banner"]'))
        await t.evaluate(() => window.__primp_test!.addNote('Shorter copy: "Side effects, in every report."'))
        await t.evaluate(() => window.__primp_test!.panel('changes'))
        await t.mouse.move(640, 560)
        await shot(t, `changes-${scheme}.png`)
        if (scheme === 'dark') {
          await t.evaluate(() => window.__primp_test!.send())
          const sent = vite.primp.session.items().filter((item) => item.kind !== 'note')
          const statuses = ['pass', 'drift', 'fail'] as const
          sent.slice(0, 3).forEach((item, index) => vite.primp.session.patchItem(item.id, { status: index === 2 ? 'failed' : 'verified', verification: verdict(statuses[index]!, item) }))
          await waitFor(async () => (await t.evaluate(() => window.__primp_test!.pins())).filter((pin) => pin.status !== 'draft').length >= 3, { timeoutMs: 5000, what: 'the pins to take their statuses' })
          await t.evaluate(() => window.__primp_test!.panel(null))
          await t.evaluate(() => scrollTo(0, 380))
          await t.mouse.move(5, 790)
          await sleep(200)
          const pins = await t.evaluate(() => window.__primp_test!.pins())
          const pin = pins.find((one) => one.status === 'fail') ?? pins[0]!
          await t.mouse.move(pin.x + pin.width / 2, pin.y + pin.height / 2, { steps: 4 })
          await shot(t, 'pins-dark.png')
          await t.evaluate(() => window.__primp_test!.panel('verify'))
          await t.mouse.move(5, 790)
          await shot(t, 'verify-dark.png')
        }
      } finally {
        await p.close()
      }
      // :hover chosen: the State control and the indicator.
      if (scheme === 'light') {
        const states = await openDock(browser, vite, '/', { context: { colorScheme: scheme } })
        try {
          await states.page.evaluate((selector) => document.querySelector(selector)?.scrollIntoView({ block: 'center' }), PLAN_CTA)
          await states.page.mouse.move(2, 2)
          await states.page.evaluate((selector) => window.__primp_test!.select(selector), PLAN_CTA)
          await waitFor(async () => (await testState(states.page)).source?.state === 'done')
          await states.page.evaluate(() => window.__primp_test!.setState('hover'))
          await states.page.evaluate(() => window.__primp_test!.setStyle('background-color', '#2563eb'))
          await openAllCss(states)
          await shot(states.page, 'states-light.png')
        } finally {
          await states.close()
        }
      }
      const shifts = await openDock(browser, cls, SHIFT_PAGE, { context: { colorScheme: scheme } })
      try {
        await shifts.page.evaluate(() => window.__primp_test!.openTab('shifts'))
        await shifts.page.evaluate(() => window.__primp_test!.shiftReport())
        await waitFor(() => shifts.dock.evaluate(() => (document.querySelector('[data-issue] .source')?.textContent ?? '').includes('index.html')), { timeoutMs: 5000 })
        await shifts.page.mouse.move(300, 500)
        await shot(shifts.page, `shifts-${scheme}.png`)
      } finally {
        await shifts.close()
      }
    }
    // 390 px: the inspector is a bottom sheet above the toolbar.
    const phone = await openDock(browser, vite, '/', { viewport: { width: 390, height: 844 }, context: { colorScheme: 'dark' } })
    try {
      await phone.page.evaluate((selector) => document.querySelector(selector)?.scrollIntoView({ block: 'center' }), `${CARD}:nth-of-type(1)`)
      await phone.page.evaluate((selector) => window.__primp_test!.select(selector), `${CARD}:nth-of-type(1)`)
      await waitFor(async () => (await testState(phone.page)).source?.state === 'done')
      await shot(phone.page, 'sheet-390-dark.png')
    } finally {
      await phone.close()
    }
    return `${files.length} files in .tmp/m1-overlay-shots/: ${files.join(', ')}`
  })
}

// ---------------------------------------------------------------------------

function bundleChecks(bundles: Bundles): void {
  report.section('bundles')
  const zod = [...bundles.hook.inputs, ...bundles.overlay.inputs].filter((file) => /node_modules\/(\.pnpm\/)?zod/.test(file))
  report.check('no schema library in the injected bundles', zod.length === 0, zod.length === 0 ? `hook: ${bundles.hook.inputs.length} modules, overlay: ${bundles.overlay.inputs.length} modules, none from zod` : zod.join(', '))
  // What this milestone can answer for: the M0 recorder and settle client are in the bundle as they were.
  const added = bundles.hook.minified - bundles.parts.recorder - bundles.parts.settle
  report.check(
    `the socket, bus and loader add under ${HOOK_ADDED_BYTES} bytes to the head script`,
    added < HOOK_ADDED_BYTES,
    `head script ${bundles.hook.minified} bytes minified / ${bundles.hook.gzipped} gzipped = recorder ${bundles.parts.recorder} + settle client ${bundles.parts.settle} + ${added} added here`,
  )
  report.info(
    `head script size against the ${HOOK_TARGET_BYTES / 1000} kB target: ${bundles.hook.minified} bytes minified (${bundles.hook.gzipped} gzipped) with stack capture, ` +
      `${bundles.hookNoStacks.minified} (${bundles.hookNoStacks.gzipped} gzipped) without. ` +
      `${bundles.hook.minified < HOOK_TARGET_BYTES ? 'Target met.' : 'TARGET NOT MET: the M0 recorder and settle client alone are ' + (bundles.parts.recorder + bundles.parts.settle) + ' bytes.'}`,
  )
  report.info(`dock bundle: ${bundles.overlay.minified} bytes minified, ${bundles.overlay.gzipped} gzipped`)
}

async function main(): Promise<void> {
  const only = process.argv.slice(2)
  const wants = (name: string): boolean => only.length === 0 || only.includes(name)
  const bundles = await buildBundles()
  bundleChecks(bundles)
  const browser = await launchBrowser()

  let vite: Lane | undefined
  let cls: Lane | undefined
  if (wants('vite')) {
    report.section('vite-react-19')
    vite = await startLane('vite-react-19')
    report.info(`primp built the bundles itself from packages/overlay/src/entry: hook.js ${vite.primp.assets.hook.bytes} bytes (${vite.primp.assets.hook.from}), overlay.js ${vite.primp.assets.overlay.bytes} bytes`)
    await mountChecks(browser, vite, '/', 1200)
    await viteSelection(browser, vite)
    await viteDockUx(browser, vite)
    await viteEdits(browser, vite)
    await viteVerdictAndSend(browser, vite)
    await viteHmr(browser, vite)
    await viteMeasure(browser, vite)
    await viteKeyboardAndConnection(browser, vite)
    await viteBigPage(browser, vite)
    await viteStates(browser, vite)
    await viteReorder(browser, vite)
    await viteDrags(browser, vite)
  }
  // Only the interaction-model checks of vite-react-19 (they also run as part of `vite`).
  if (only.includes('vite-ux') && !wants('vite')) {
    report.section('vite-react-19 interaction model')
    vite ??= await startLane('vite-react-19')
    await viteDockUx(browser, vite)
  }
  // Only the state checks of vite-react-19 (they also run as part of `vite`).
  if (only.includes('vite-states') && !wants('vite')) {
    report.section('vite-react-19 states')
    vite = await startLane('vite-react-19')
    await viteStates(browser, vite)
  }
  // Only the reorder and resize checks of vite-react-19 (they also run as part of `vite`).
  if (only.includes('vite-moves') && !wants('vite')) {
    report.section('vite-react-19 reorder and resize')
    vite ??= await startLane('vite-react-19')
    await viteReorder(browser, vite)
    await viteDrags(browser, vite)
  }
  if (wants('next')) {
    report.section('next-16-turbopack')
    const next = await startLane('next-16-turbopack')
    // One unmeasured load: the dev server compiles the page on its first request.
    await (await fetch(next.fixture.url + '/')).arrayBuffer()
    await mountChecks(browser, next, '/', 2000)
    await nextEdits(browser, next)
    await next.primp.close()
    await next.fixture.stop()
  }
  if (wants('static')) {
    report.section('static-html')
    const fixture = await startLane('static-html')
    await mountChecks(browser, fixture, '/', 1000)
    await staticEdits(browser, fixture)
    await staticStates(browser, fixture)
  }
  if (wants('cls')) {
    report.section('cls-corpus injected-content/banner-innerhtml')
    cls = await startLane('cls-corpus')
    await mountChecks(browser, cls, SHIFT_PAGE, 2200)
    await shiftsTab(browser, cls, bundles)
  }
  if (wants('shots')) {
    report.section('screenshots')
    vite ??= await startLane('vite-react-19')
    cls ??= await startLane('cls-corpus')
    await screenshots(browser, vite, cls)
  }
}

try {
  await main()
} catch (error) {
  report.check('the check ran to completion', false, error instanceof Error ? (error.stack ?? error.message) : String(error))
} finally {
  await runCleanups()
  report.finish()
}
