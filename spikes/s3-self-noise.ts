/**
 * Spike S3: self-noise.
 *
 * Question: does primp itself disturb what it measures?
 *
 *   A. Zero added layout shift. Each page is loaded through the proxy three
 *      ways, three times each: untouched (control), with the hook and a stub
 *      overlay shown as a manual popover, and with the stub as a fixed box.
 *      The layout-shift entries of all loads are read by an observer created
 *      AFTER the load (buffered), so the control really has nothing in it.
 *      Counts and summed values must be the same.
 *   B. Main-thread cost of the hook: its top-level run plus all time inside its
 *      observers during the load window, on a 5 µs clock (the pages are served
 *      cross-origin isolated for this part). Target: under 5 ms.
 *   C. Self-tagging: an edit made through `markSelf()` produces entries tagged
 *      `selfInduced`; the same edit without the mark does not.
 *   D. Observed semantics of `hadRecentInput`, which the side-effect design
 *      depends on. Reported; only the two facts the design relies on are checks.
 *   E. Cost of capturing a JavaScript stack for DOM insertions (optional hook build).
 *
 * Run: pnpm spike:s3   (exit 0 = pass)
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Browser, Page } from '@playwright/test'
import { attributeShifts } from '../packages/engine/src/shift-attributor.ts'
import type { HookCost, ShiftRecording } from '../packages/protocol/src/shift.ts'
import {
  createReport,
  expect,
  launchBrowser,
  median,
  newPage,
  runCleanups,
  sleep,
  startFixture,
  startProxy,
  type FixtureHandle,
  type ProxyHandle,
} from './lib/index.ts'
import { fixed, hookScript, hookSize, readPlainEntries, readRecording, stubScript, sum, timerResolution, type PlainEntry } from './s7-assets/measure.ts'
import { isolated, startRelay } from './s7-assets/relay.ts'

const LOADS = 3
const COST_LOADS = 5
const COST_TARGET_MS = 5
const SIZE_TARGET_BYTES = 10_000
/** Two loads of an untouched deterministic page give the same sum to the last digit; this is the allowance for one that is not. */
const VALUE_NOISE = 1e-4

type Arm = 'control' | 'popover' | 'fixed'
const ARMS: Arm[] = ['control', 'popover', 'fixed']

interface Target {
  fixture: FixtureHandle
  path: string
  /** How long to watch after the `load` event. */
  observeMs: number
  /** The page is known to shift on its own: the point is that the entries stay the same. */
  shifts: boolean
}

interface LoadResult {
  entries: PlainEntry[]
  recording?: ShiftRecording
  problems: string[]
}

const report = createReport('S3 self-noise: the hook and the overlay add no layout shift')

const totalCost = (cost: HookCost): number => cost.topLevelMs + cost.shiftMs + cost.mutationMs + cost.resizeMs + cost.otherMs
const scoredSum = (entries: PlainEntry[]): number => sum(entries.filter((entry) => !entry.hadRecentInput).map((entry) => entry.value))
const describeEntries = (entries: PlainEntry[]): string => `${entries.length} (${fixed(scoredSum(entries), 6)})`

async function loadOnce(browser: Browser, proxy: ProxyHandle, target: Target, arm: Arm): Promise<LoadResult> {
  const { page, record, close } = await newPage(browser)
  const problems: string[] = []
  try {
    await page.goto(proxy.url + target.path, { waitUntil: 'load' })
    await sleep(target.observeMs)
    const entries = await readPlainEntries(page)
    let recording: ShiftRecording | undefined
    const injected = await page.evaluate(() => ({
      hook: window.__primp !== undefined,
      stub: window.__primpStub?.mode,
      host: (() => {
        const host = document.querySelector('[data-primp-root]')
        if (host === null) return undefined
        const dock = host.shadowRoot?.querySelector('.dock')?.getBoundingClientRect()
        return {
          popoverOpen: host.matches(':popover-open'),
          position: getComputedStyle(host).position,
          dock: dock === undefined ? undefined : { w: Math.round(dock.width), h: Math.round(dock.height), inView: dock.bottom <= innerHeight && dock.right <= innerWidth && dock.top >= 0 },
        }
      })(),
      visible: document.visibilityState,
    }))
    if (injected.visible !== 'visible') problems.push(`tab was ${injected.visible}`)
    if (arm === 'control') {
      if (injected.hook || injected.host !== undefined) problems.push('the control page has primp in it')
    } else {
      if (!injected.hook) problems.push('hook missing')
      if (injected.stub !== arm) problems.push(`stub mode is ${String(injected.stub)}`)
      const host = injected.host
      if (host === undefined) problems.push('overlay root not mounted')
      else {
        if (arm === 'popover' && !host.popoverOpen) problems.push('popover not open')
        if (host.position !== 'fixed') problems.push(`overlay root position is ${host.position}`)
        if (host.dock === undefined || host.dock.w < 100 || host.dock.h < 40 || !host.dock.inView) problems.push(`dock not visible: ${JSON.stringify(host.dock)}`)
      }
      recording = await readRecording(page)
      // The hook must have seen exactly what the independent observer saw.
      const own = recording.shifts.map((entry) => entry.value)
      const plain = entries.map((entry) => entry.value)
      if (own.length !== plain.length || own.some((value, index) => Math.abs(value - (plain[index] ?? NaN)) > 1e-9)) {
        problems.push(`hook recorded ${own.length} entries (${fixed(sum(own), 6)}), a plain observer ${plain.length} (${fixed(sum(plain), 6)})`)
      }
      if (!recording.visibility.visibleThroughout) problems.push('hook says the tab was not visible throughout')
    }
    if (record.pageErrors.length > 0) problems.push(`page errors: ${record.pageErrors[0]}`)
    return { entries, recording, problems }
  } finally {
    await close()
  }
}

// ---------------------------------------------------------------------------
// A. zero added shift
// ---------------------------------------------------------------------------

async function compareArms(browser: Browser, proxies: Record<Arm, ProxyHandle>, target: Target, label: string): Promise<void> {
  const results: Record<Arm, LoadResult[]> = { control: [], popover: [], fixed: [] }
  for (let load = 0; load < LOADS; load++) {
    // The three arms of a round load side by side, each in its own browser context.
    const round = await Promise.all(ARMS.map((arm) => loadOnce(browser, proxies[arm], target, arm)))
    ARMS.forEach((arm, index) => results[arm].push(round[index] as LoadResult))
  }
  const counts = (arm: Arm): number[] => results[arm].map((result) => result.entries.filter((entry) => !entry.hadRecentInput).length)
  const sums = (arm: Arm): number[] => results[arm].map((result) => scoredSum(result.entries))
  const controlSpread = Math.max(...sums('control')) - Math.min(...sums('control'))
  const tolerance = Math.max(VALUE_NOISE, controlSpread)
  const line = ARMS.map((arm) => `${arm} ${results[arm].map((result) => describeEntries(result.entries)).join(' ')}`).join(' | ')

  await report.attempt(`${label}: same layout-shift entries with and without primp`, () => {
    const problems = ARMS.flatMap((arm) => results[arm].flatMap((result, index) => result.problems.map((problem) => `${arm} load ${index + 1}: ${problem}`)))
    expect(problems.length === 0, `${problems.join('; ')} || ${line}`)
    for (const arm of ['popover', 'fixed'] as const) {
      expect(
        JSON.stringify([...counts(arm)].sort()) === JSON.stringify([...counts('control')].sort()),
        `entry counts differ: ${line}`,
      )
      const difference = Math.abs(median(sums(arm)) - median(sums('control')))
      expect(difference <= tolerance, `summed values differ by ${difference.toExponential(2)} (allowed ${tolerance.toExponential(1)}): ${line}`)
      const added = Math.max(...sums(arm)) - Math.max(...sums('control'))
      expect(added <= tolerance, `worst load is ${added.toExponential(2)} above the worst control load: ${line}`)
    }
    if (target.shifts) expect(counts('control').every((count) => count > 0), `this page was expected to shift on its own, the control saw nothing: ${line}`)
    return `entries per load (count, summed value): ${line}`
  })

  if (!target.shifts) {
    // What the product would show for this page: nothing.
    const issues = results.popover.flatMap((result) => (result.recording === undefined ? [] : attributeShifts(result.recording).issues))
    report.check(`${label}: the attributor reports no issue`, issues.length === 0, issues.length === 0 ? '0 issues in 3 loads' : issues.map((issue) => `${issue.cause} ${issue.value}`).join(', '))
  }
}

// ---------------------------------------------------------------------------
// B. cost
// ---------------------------------------------------------------------------

interface CostRun {
  cost: HookCost
  total: number
  resolution: number
  elements: number
}

async function measureCost(browser: Browser, proxy: ProxyHandle, path: string, observeMs: number, loads: number): Promise<CostRun[]> {
  const runs: CostRun[] = []
  // One unmeasured load first: the dev server compiles the page on its first request and competes for the CPU.
  for (let load = -1; load < loads; load++) {
    const { page, close } = await newPage(browser)
    try {
      await page.goto(proxy.url + path, { waitUntil: 'load' })
      await sleep(observeMs)
      const recording = await readRecording(page)
      const isolatedPage = await page.evaluate(() => crossOriginIsolated)
      if (!isolatedPage) throw new Error('page is not cross-origin isolated; the 5 µs clock is not available')
      if (load >= 0) {
        runs.push({
          cost: recording.cost,
          total: totalCost(recording.cost),
          resolution: await timerResolution(page),
          elements: await page.evaluate(() => document.querySelectorAll('*').length),
        })
      }
    } finally {
      await close()
    }
  }
  return runs
}

function costLine(runs: CostRun[]): string {
  const part = (pick: (cost: HookCost) => number): string => fixed(median(runs.map((run) => pick(run.cost))), 3)
  const totals = runs.map((run) => run.total)
  const first = runs[0]
  const worst = [...runs].sort((a, b) => b.total - a.total)[0]
  const worstParts = worst === undefined ? '' : `top-level ${fixed(worst.cost.topLevelMs, 3)} + mutation ${fixed(worst.cost.mutationMs, 3)} + resize ${fixed(worst.cost.resizeMs, 3)} + shift ${fixed(worst.cost.shiftMs, 3)} + other ${fixed(worst.cost.otherMs, 3)}`
  return (
    `total median ${fixed(median(totals), 3)} ms, per load ${totals.map((total) => fixed(total, 2)).join(' ')} (worst load: ${worstParts}); ` +
    `medians: top-level ${part((c) => c.topLevelMs)}, mutation observer ${part((c) => c.mutationMs)}, resize observer ${part((c) => c.resizeMs)}, ` +
    `shift observer ${part((c) => c.shiftMs)}, other ${part((c) => c.otherMs)} ms; ` +
    `${first?.elements ?? 0} elements, ${first?.cost.tracked ?? 0} size-tracked, ${first?.cost.untracked ?? 0} over the cap; clock step ${first?.resolution ?? 0} ms`
  )
}

/** Main-thread totals of the whole page from the browser's own counters, to see what self-timing cannot. */
async function browserTaskTime(browser: Browser, proxy: ProxyHandle, path: string, observeMs: number, loads: number): Promise<{ task: number; script: number; layout: number }> {
  const samples: { task: number; script: number; layout: number }[] = []
  for (let load = -1; load < loads; load++) {
    const { page, context, close } = await newPage(browser)
    try {
      const cdp = await context.newCDPSession(page)
      await cdp.send('Performance.enable')
      await page.goto(proxy.url + path, { waitUntil: 'load' })
      await sleep(observeMs)
      const { metrics } = await cdp.send('Performance.getMetrics')
      const get = (name: string): number => (metrics.find((metric) => metric.name === name)?.value ?? 0) * 1000
      if (load >= 0) samples.push({ task: get('TaskDuration'), script: get('ScriptDuration'), layout: get('LayoutDuration') + get('RecalcStyleDuration') })
    } finally {
      await close()
    }
  }
  return {
    task: median(samples.map((sample) => sample.task)),
    script: median(samples.map((sample) => sample.script)),
    layout: median(samples.map((sample) => sample.layout)),
  }
}

// ---------------------------------------------------------------------------
// C and D. self-tagging and hadRecentInput
// ---------------------------------------------------------------------------

interface NewEntry {
  value: number
  hadRecentInput: boolean
  selfInduced?: { reason: string; markedAt: number }
  startTime: number
}

/** Runs `action`, then returns the layout-shift entries the hook recorded since. */
async function entriesAfter(page: Page, action: () => Promise<void>, settleMs = 350): Promise<NewEntry[]> {
  const before = await page.evaluate(() => window.__primp?.recording().shifts.length ?? 0)
  await action()
  await sleep(settleMs)
  const recording = await readRecording(page)
  return recording.shifts.slice(before).map((entry) => ({ value: entry.value, hadRecentInput: entry.hadRecentInput, selfInduced: entry.selfInduced, startTime: entry.startTime }))
}

const show = (entries: NewEntry[]): string =>
  entries.length === 0
    ? 'no entry'
    : entries.map((entry) => `value ${fixed(entry.value, 5)} hadRecentInput=${entry.hadRecentInput} selfInduced=${entry.selfInduced === undefined ? 'no' : JSON.stringify(entry.selfInduced.reason)}`).join('; ')

async function selfTagging(browser: Browser, proxy: ProxyHandle, path: string, selector: string, label: string): Promise<void> {
  const { page, close } = await newPage(browser)
  try {
    await page.goto(proxy.url + path, { waitUntil: 'load' })
    await sleep(1200)
    let step = 0
    /** A style change that moves everything below `selector`, a different distance each time. */
    const edit = (mark?: string): Promise<void> => {
      step += 1
      return page.evaluate(([sel, px, reason]) => window.__primpStub?.edit(sel as string, 'margin-top', `${px}px`, reason as string | undefined), [selector, 24 + step * 12, mark] as const)
    }

    await report.attempt(`${label}: an edit announced with markSelf() is tagged selfInduced`, async () => {
      const entries = await entriesAfter(page, () => edit('preview: margin-top'))
      expect(entries.length > 0, 'the edit moved content but no layout-shift entry was recorded')
      expect(entries.every((entry) => entry.selfInduced?.reason === 'preview: margin-top'), `not every entry is tagged: ${show(entries)}`)
      return show(entries)
    })

    await sleep(650)
    await report.attempt(`${label}: the same edit by script with no mark and no user input is reported, untagged`, async () => {
      const entries = await entriesAfter(page, () => edit())
      expect(entries.length > 0, 'a scripted style change without user input produced no layout-shift entry')
      expect(entries.every((entry) => entry.selfInduced === undefined), `tagged without a mark: ${show(entries)}`)
      expect(entries.every((entry) => !entry.hadRecentInput), `hadRecentInput set without any input: ${show(entries)}`)
      return show(entries)
    })

    await report.attempt(`${label}: the tag covers 500 ms after the mark and no more`, async () => {
      await sleep(650)
      const inside = await entriesAfter(page, async () => {
        await page.evaluate(() => window.__primp?.markSelf('mark, then edit 300 ms later'))
        await sleep(300)
        await edit()
      })
      await sleep(650)
      const outside = await entriesAfter(page, async () => {
        await page.evaluate(() => window.__primp?.markSelf('mark, then edit 800 ms later'))
        await sleep(800)
        await edit()
      })
      expect(inside.length > 0 && inside.every((entry) => entry.selfInduced !== undefined), `300 ms after the mark: ${show(inside)}`)
      expect(outside.length > 0 && outside.every((entry) => entry.selfInduced === undefined), `800 ms after the mark: ${show(outside)}`)
      return `300 ms after the mark: ${show(inside)} | 800 ms after: ${show(outside)}`
    })

    await report.attempt(`${label}: an edit made inside requestAnimationFrame, 8 ms into the frame, is tagged`, async () => {
      await sleep(650)
      step += 1
      const entries = await entriesAfter(page, () =>
        page.evaluate(
          ([sel, px]) =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => {
                // The frame has begun; the mark and the style write come later in it.
                const started = performance.now()
                while (performance.now() - started < 8) {
                  /* busy */
                }
                window.__primpStub?.edit(sel as string, 'margin-top', `${px}px`, 'preview in a frame callback')
                resolve()
              })
            }),
          [selector, 24 + step * 12] as const,
        ),
      )
      expect(entries.length > 0 && entries.every((entry) => entry.selfInduced?.reason === 'preview in a frame callback'), show(entries))
      return show(entries)
    })

    await report.attempt(`${label}: self-induced entries are excluded from the score`, async () => {
      const recording = await readRecording(page)
      const result = attributeShifts(recording)
      const self = result.issues.filter((issue) => issue.excluded === 'self-induced')
      const tagged = recording.shifts.filter((entry) => entry.selfInduced !== undefined)
      expect(tagged.length > 0 && self.length > 0, `tagged entries ${tagged.length}, self-induced issues ${self.length}`)
      expect(self.every((issue) => !issue.scored && issue.window === undefined), 'a self-induced issue is scored')
      const scoredEntries = new Set(result.windows.flatMap((window) => window.entries))
      expect(tagged.every((entry) => !scoredEntries.has(entry.index)), 'a tagged entry is inside a session window')
      return `${tagged.length} tagged entries -> ${self.length} excluded issue(s); page CLS counts only the untagged ones (${fixed(result.cls ?? 0, 5)})`
    })
  } finally {
    await close()
  }
}

async function inputSemantics(browser: Browser, proxy: ProxyHandle, path: string, selector: string): Promise<void> {
  const { page, close } = await newPage(browser)
  try {
    await page.goto(proxy.url + path, { waitUntil: 'load' })
    await sleep(1200)
    let step = 0
    const scripted = (): Promise<void> => {
      step += 1
      return page.evaluate(([sel, px]) => window.__primpStub?.edit(sel as string, 'margin-top', `${px}px`), [selector, 20 + step * 10] as const)
    }
    /** `input`, then `delayMs`, then a scripted (unmarked) move; returns the entries. */
    const probe = async (input: () => Promise<void>, delayMs: number): Promise<NewEntry[]> => {
      await sleep(700) // let any earlier input age out
      return entriesAfter(page, async () => {
        await input()
        await sleep(delayMs)
        await scripted()
      })
    }
    const flagged = (entries: NewEntry[]): string => (entries.length === 0 ? 'no entry' : entries.every((entry) => entry.hadRecentInput) ? 'hadRecentInput=true' : entries.some((entry) => entry.hadRecentInput) ? 'mixed' : 'hadRecentInput=false')
    const dockPoint = async (inner: string): Promise<{ x: number; y: number }> =>
      page.evaluate((sel) => {
        const rect = document.querySelector('[data-primp-root]')!.shadowRoot!.querySelector(sel)!.getBoundingClientRect()
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      }, inner)

    const none = await probe(async () => {}, 0)
    const move = await probe(() => page.mouse.move(400, 300, { steps: 5 }), 50)
    const click100 = await probe(() => page.mouse.click(600, 500), 100)
    const click400 = await probe(() => page.mouse.click(600, 500), 400)
    const click700 = await probe(() => page.mouse.click(600, 500), 700)
    const downOnly = await probe(() => page.mouse.down(), 100)
    // The entry for a move made while the button is down is held back by the browser; see what the release delivers.
    const onRelease = await entriesAfter(page, () => page.mouse.up())
    const upAfterHold = await probe(async () => {
      await page.mouse.down()
      await sleep(700)
      await page.mouse.up()
    }, 100)
    const key = await probe(() => page.keyboard.press('a'), 100)
    const wheel = await probe(() => page.mouse.wheel(0, 0.5), 100)
    const dockButton = await dockPoint('#apply')
    const dockClick = await probe(() => page.mouse.click(dockButton.x, dockButton.y), 100)
    const dockInput = await dockPoint('#value')
    await page.mouse.click(dockInput.x, dockInput.y)
    const dockTyping = await probe(() => page.keyboard.type('4'), 100)
    // The real thing: the dock's own button applies an announced edit.
    await sleep(700)
    await page.evaluate(([sel]) => window.__primpStub?.onApply(() => window.__primpStub?.edit(sel as string, 'margin-top', '333px', 'dock: apply')), [selector] as const)
    const dockApply = await entriesAfter(page, () => page.mouse.click(dockButton.x, dockButton.y))

    report.info(
      [
        'hadRecentInput as observed (Chromium headless, a scripted style change that moves content, N ms after the input):',
        `no input at all:                         ${flagged(none)}`,
        `pointer movement only, 50 ms before:     ${flagged(move)}`,
        `click on the page, 100 ms before:        ${flagged(click100)}`,
        `click on the page, 400 ms before:        ${flagged(click400)}`,
        `click on the page, 700 ms before:        ${flagged(click700)}`,
        `mouse button pressed and still held:     ${flagged(downOnly)} while it is held; on release: ${flagged(onRelease)} (${onRelease.length} entries)`,
        `button released after a 700 ms hold:     ${flagged(upAfterHold)}`,
        `key press on the page, 100 ms before:    ${flagged(key)}`,
        `wheel event, 100 ms before:              ${flagged(wheel)}`,
        `click on a button inside the dock:       ${flagged(dockClick)}`,
        `typing in an input inside the dock:      ${flagged(dockTyping)}`,
        `dock button that applies a marked edit:  ${show(dockApply)}`,
      ].join('\n'),
    )
    report.check(
      'a scripted change with no input is delivered with hadRecentInput=false; pointer movement does not change that',
      none.length > 0 && none.every((entry) => !entry.hadRecentInput) && move.length > 0 && move.every((entry) => !entry.hadRecentInput),
      `no input: ${show(none)} | after pointer movement: ${show(move)}`,
    )
    report.check(
      'an edit applied from the dock is tagged selfInduced even though the click also sets hadRecentInput',
      dockApply.length > 0 && dockApply.every((entry) => entry.selfInduced?.reason === 'dock: apply'),
      show(dockApply),
    )
  } finally {
    await close()
  }
}

// ---------------------------------------------------------------------------
// E. stack capture
// ---------------------------------------------------------------------------

interface Bench {
  detachedAppend: number
  connectedAppend: number
  setAttribute: number
  manyParents: number
  /** Time the hook's MutationObserver callback spent on everything the benchmark did. */
  observerMs: number
  /** Nodes and attribute changes the benchmark produced in connected DOM. */
  mutations: number
}

/** Nanoseconds per DOM call, after the first frame, with whatever hook the page has. */
async function domBench(browser: Browser, proxy: ProxyHandle, path: string): Promise<Bench> {
  const { page, close } = await newPage(browser)
  try {
    await page.goto(proxy.url + path, { waitUntil: 'load' })
    await sleep(600)
    return await page.evaluate(async () => {
      const N = 20_000
      const costBefore = window.__primp?.cost().mutationMs ?? 0
      const box = document.createElement('div')
      box.style.display = 'none'
      document.body.append(box)
      const perCall: number[] = []
      const ROUNDS = 7
      for (let round = 0; round < ROUNDS; round++) {
        const detached = document.createElement('div')
        let start = performance.now()
        for (let i = 0; i < N; i++) detached.appendChild(document.createElement('i'))
        const a = performance.now() - start

        start = performance.now()
        for (let i = 0; i < N; i++) box.appendChild(document.createElement('i'))
        const b = performance.now() - start

        start = performance.now()
        for (let i = 0; i < N; i++) box.setAttribute('data-n', 'x')
        const c = performance.now() - start

        const parents = [...box.children].slice(0, 2000)
        start = performance.now()
        for (const parent of parents) parent.appendChild(document.createElement('b'))
        const d = performance.now() - start

        perCall.push((a / N) * 1e6, (b / N) * 1e6, (c / N) * 1e6, (d / parents.length) * 1e6)
        box.replaceChildren()
        await new Promise((resolve) => setTimeout(resolve, 30))
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
      box.remove()
      // Median of the rounds per column. (No named helper in here: tsx would wrap it in `__name`, which the page lacks.)
      const mid = [0, 1, 2, 3].map((offset) => Math.round(perCall.filter((_, index) => index % 4 === offset).sort((a, b) => a - b)[ROUNDS >> 1] ?? 0))
      return {
        detachedAppend: mid[0] ?? 0,
        connectedAppend: mid[1] ?? 0,
        setAttribute: mid[2] ?? 0,
        manyParents: mid[3] ?? 0,
        observerMs: Math.round(((window.__primp?.cost().mutationMs ?? 0) - costBefore) * 100) / 100,
        // Per round: N nodes added, N attribute writes, 2,000 more nodes added, and all of them removed again.
        mutations: ROUNDS * (N + N + 2000 + N + 2000),
      }
    })
  } finally {
    await close()
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  report.section('hook build')
  const size = await hookSize()
  const sizeWithStacks = await hookSize({ stacks: true })
  report.check(
    `hook is under ${SIZE_TARGET_BYTES} bytes minified`,
    size.minified < SIZE_TARGET_BYTES,
    `${size.minified} bytes minified, ${size.gzipped} bytes gzipped (with DOM-call stack capture compiled in: ${sizeWithStacks.minified} / ${sizeWithStacks.gzipped})`,
  )

  const browser = await launchBrowser()
  const vite = await startFixture('vite-react-19')
  const staticHtml = await startFixture('static-html')
  const corpus = await startFixture('cls-corpus')
  const observeOf = (page: string): number => (JSON.parse(readFileSync(join(corpus.sourceDir, page, 'expected.json'), 'utf8')) as { observeMs?: number }).observeMs ?? 2000

  const targets: { label: string; target: Target }[] = [
    { label: 'vite-react-19 /', target: { fixture: vite, path: '/', observeMs: 1500, shifts: false } },
    { label: 'static-html /', target: { fixture: staticHtml, path: '/', observeMs: 1500, shifts: false } },
    ...['negative/transform-animation', 'negative/below-fold-insert', 'negative/reserved-space', 'negative/fixed-overlay-insert'].map((page) => ({
      label: `cls-corpus ${page}`,
      target: { fixture: corpus, path: `/${page}/`, observeMs: observeOf(page), shifts: false },
    })),
    // Pages that DO shift: primp must not change what they report either.
    ...['unsized-media/img-block', 'font-swap/nav', 'injected-content/banner-innerhtml'].map((page) => ({
      label: `cls-corpus ${page}`,
      target: { fixture: corpus, path: `/${page}/`, observeMs: observeOf(page), shifts: true },
    })),
  ]

  const proxies = new Map<FixtureHandle, Record<Arm, ProxyHandle>>()
  for (const fixture of [vite, staticHtml, corpus]) {
    proxies.set(fixture, {
      control: await startProxy(fixture),
      popover: await startProxy(fixture, { headScripts: [hookScript(), stubScript('popover')] }),
      fixed: await startProxy(fixture, { headScripts: [hookScript(), stubScript('fixed')] }),
    })
  }
  const armsOf = (fixture: FixtureHandle): Record<Arm, ProxyHandle> => proxies.get(fixture) as Record<Arm, ProxyHandle>

  report.section('A. zero added layout shift (3 loads per arm)')
  // Warm the dev server (first-request compile) before anything is compared.
  for (const fixture of [vite, staticHtml]) await loadOnce(browser, armsOf(fixture).control, { fixture, path: '/', observeMs: 300, shifts: false }, 'control')
  for (const { label, target } of targets) await compareArms(browser, armsOf(target.fixture), target, label)

  report.section(`B. main-thread cost of the hook (${COST_LOADS} loads each, cross-origin isolated for a 5 µs clock)`)
  const costPages: { label: string; fixture: FixtureHandle; host?: string; path: string; observeMs: number }[] = [
    { label: 'vite-react-19 /', fixture: vite, host: 'localhost', path: '/', observeMs: 1200 },
    { label: 'vite-react-19 /big (13,000 elements)', fixture: vite, host: 'localhost', path: '/big', observeMs: 1200 },
    { label: 'static-html /', fixture: staticHtml, host: 'localhost', path: '/', observeMs: 1200 },
    { label: 'cls-corpus negative/reserved-space', fixture: corpus, path: '/negative/reserved-space/', observeMs: 1500 },
    { label: 'cls-corpus negative/below-fold-insert', fixture: corpus, path: '/negative/below-fold-insert/', observeMs: 1500 },
    { label: 'cls-corpus negative/fixed-overlay-insert', fixture: corpus, path: '/negative/fixed-overlay-insert/', observeMs: 1500 },
  ]
  const isolatedProxies = new Map<FixtureHandle, { control: ProxyHandle; hookOnly: ProxyHandle; hook: ProxyHandle; stacks: ProxyHandle }>()
  for (const fixture of [vite, staticHtml, corpus]) {
    const relay = await startRelay({ port: fixture.port, host: fixture === corpus ? undefined : 'localhost' }, [isolated()])
    isolatedProxies.set(fixture, {
      control: await startProxy(relay),
      hookOnly: await startProxy(relay, { headScripts: [hookScript()] }),
      hook: await startProxy(relay, { headScripts: [hookScript(), stubScript('popover')] }),
      stacks: await startProxy(relay, { headScripts: [hookScript({ stacks: true }), stubScript('popover')] }),
    })
  }
  const stackTotals: string[] = []
  for (const costPage of costPages) {
    const set = isolatedProxies.get(costPage.fixture)
    if (set === undefined) continue
    await report.attempt(`${costPage.label}: hook cost under ${COST_TARGET_MS} ms`, async () => {
      const runs = await measureCost(browser, set.hook, costPage.path, costPage.observeMs, COST_LOADS)
      const totals = runs.map((run) => run.total)
      const line = costLine(runs)
      expect(median(totals) < COST_TARGET_MS, line)
      const over = totals.filter((total) => total >= COST_TARGET_MS)
      expect(over.length <= 1, `${over.length} of ${runs.length} loads at or over ${COST_TARGET_MS} ms: ${line}`)
      return over.length === 0 ? line : `${line} [NOTE: 1 of ${runs.length} loads was over ${COST_TARGET_MS} ms: ${fixed(over[0] ?? 0, 3)} ms]`
    })
    const withStacks = await measureCost(browser, set.stacks, costPage.path, 800, 3)
    stackTotals.push(`${costPage.label}: ${fixed(median(withStacks.map((run) => run.total)), 3)} ms (top-level ${fixed(median(withStacks.map((run) => run.cost.topLevelMs)), 3)})`)
  }
  for (const costPage of costPages.slice(0, 3)) {
    const set = isolatedProxies.get(costPage.fixture)
    if (set === undefined) continue
    const without = await browserTaskTime(browser, set.control, costPage.path, 800, COST_LOADS)
    const hookOnly = await browserTaskTime(browser, set.hookOnly, costPage.path, 800, COST_LOADS)
    const withStub = await browserTaskTime(browser, set.hook, costPage.path, 800, COST_LOADS)
    const triple = (pick: (sample: { task: number; script: number; layout: number }) => number): string =>
      `${fixed(pick(without), 1)} / ${fixed(pick(hookOnly), 1)} / ${fixed(pick(withStub), 1)} ms`
    report.info(
      `${costPage.label}: the browser's own main-thread counters (CDP Performance.getMetrics), median of ${COST_LOADS} loads, ` +
        `no primp / hook only / hook + stub overlay: all tasks ${triple((s) => s.task)}, script ${triple((s) => s.script)}, style+layout ${triple((s) => s.layout)}. ` +
        `These include what self-timing cannot see (the browser's bookkeeping for the observers); their run-to-run spread is a few ms.`,
    )
  }

  report.section('C. self-tagging')
  await selfTagging(browser, armsOf(staticHtml).popover, '/', 'main', 'static-html')
  await selfTagging(browser, armsOf(vite).popover, '/', 'main', 'vite-react-19')

  report.section('D. hadRecentInput semantics')
  await inputSemantics(browser, armsOf(staticHtml).popover, '/', 'main')

  report.section('E. capturing the stack of DOM insertions (optional build)')
  const staticIsolated = isolatedProxies.get(staticHtml)
  if (staticIsolated !== undefined) {
    const plain = await domBench(browser, staticIsolated.control, '/')
    const hooked = await domBench(browser, staticIsolated.hook, '/')
    const stacks = await domBench(browser, staticIsolated.stacks, '/')
    const row = (name: string, bench: Bench): string =>
      `${name.padEnd(28)} appendChild detached ${String(bench.detachedAppend).padStart(5)} ns, connected ${String(bench.connectedAppend).padStart(5)} ns, ` +
      `setAttribute ${String(bench.setAttribute).padStart(5)} ns, appendChild to 2,000 different parents ${String(bench.manyParents).padStart(6)} ns/call; ` +
      `hook's mutation observer: ${bench.observerMs} ms for ${bench.mutations} mutations (${Math.round((bench.observerMs / bench.mutations) * 1e6)} ns each)`
    report.info(
      [
        'DOM call cost after the first frame, median of 7 rounds of 20,000 calls (run-to-run noise is about +-50 ns):',
        row('no primp', plain),
        row('hook', hooked),
        row('hook with stack capture', stacks),
        `size: +${sizeWithStacks.minified - size.minified} bytes minified, +${sizeWithStacks.gzipped - size.gzipped} gzipped`,
        `load cost with stack capture (median of 3): ${stackTotals.join('; ')}`,
      ].join('\n'),
    )
    report.check(
      'under heavy DOM churn the hook spends under 1 µs per mutation',
      hooked.observerMs / hooked.mutations < 0.001 && stacks.observerMs / stacks.mutations < 0.001,
      `${Math.round((hooked.observerMs / hooked.mutations) * 1e6)} ns per mutation (${hooked.observerMs} ms for ${hooked.mutations}); with stack capture ${Math.round((stacks.observerMs / stacks.mutations) * 1e6)} ns`,
    )
    report.check(
      'stack capture adds under 1 µs to an ordinary DOM call',
      stacks.detachedAppend - plain.detachedAppend < 1000 && stacks.connectedAppend - plain.connectedAppend < 1000 && stacks.setAttribute - plain.setAttribute < 1000,
      `added per call: appendChild detached ${stacks.detachedAppend - plain.detachedAppend} ns, connected ${stacks.connectedAppend - plain.connectedAppend} ns, setAttribute ${stacks.setAttribute - plain.setAttribute} ns; ` +
        `worst case (a new stack per call, 2,000 different parents): ${stacks.manyParents - plain.manyParents} ns`,
    )
  }
}

try {
  await main()
} catch (error) {
  report.check('spike ran to completion', false, error instanceof Error ? (error.stack ?? error.message) : String(error))
} finally {
  await runCleanups()
  report.finish()
}
