/**
 * Two feasibility checks made before building state editing and drag to reorder.
 *
 *   A. A state forced by packages/overlay/src/probe/states.ts (a marker attribute plus an extra
 *      selector on the page's own rules) gives the same computed values as the real state:
 *      the pointer really over the element, the keyboard focus really on it.
 *   B. Moving an element among its siblings with insertBefore, in a tree a framework owns, and
 *      then letting the framework re-render and hot-update, throws nothing.
 *
 *   pnpm spike:m5-risks
 */

import type { Page } from '@playwright/test'
import { createReport, editFile, expect, launchBrowser, newPage, replaceOnce, runCleanups, sleep, startFixture, startProxy, waitFor } from './lib/index.ts'
import { fileURLToPath } from 'node:url'

const ENTRY = fileURLToPath(new URL('./m5-assets/states-entry.ts', import.meta.url))
const report = createReport('M5 risk checks: forced states match real ones; a reorder survives the framework')

/**
 * tsx compiles with esbuild's keep-names, which wraps inner named functions in a `__name()` call.
 * A function handed to page.evaluate is sent as text, so the page needs that helper too.
 */
const KEEP_NAMES = { content: 'globalThis.__name = (fn) => fn' }

interface Case {
  /** Index into the page's list of test elements (kept in the page as `window.__cases`). */
  index: number
  label: string
  properties: string[]
}

/** Finds elements that readable `:hover` rules can style, with the properties those rules set. Runs in the page. */
const discover = (state: string): Case[] => {
  const strip = (selector: string): string => selector.replace(new RegExp(`:${state}(?![\\w-])`, 'g'), '')
  const found = new Map<Element, Set<string>>()
  const visit = (rules: CSSRuleList): void => {
    for (const rule of rules) {
      const style = rule as CSSStyleRule
      if (typeof style.selectorText === 'string' && style.selectorText.includes(`:${state}`)) {
        for (const part of style.selectorText.split(',')) {
          if (!part.includes(`:${state}`) || part.includes('::')) continue
          let elements: Element[] = []
          try {
            elements = [...document.querySelectorAll(strip(part).trim() || '*')].slice(0, 2)
          } catch {
            continue
          }
          for (const element of elements) {
            const box = element.getBoundingClientRect()
            if (box.width === 0 || box.height === 0) continue
            const set = found.get(element) ?? new Set<string>()
            for (const name of style.style) set.add(name)
            found.set(element, set)
          }
        }
      }
      const inner = (rule as CSSGroupingRule).cssRules as CSSRuleList | undefined
      if (inner !== undefined) visit(inner)
    }
  }
  for (const sheet of document.styleSheets) {
    try {
      visit(sheet.cssRules)
    } catch {
      // Not readable: not part of this check.
    }
  }
  const cases = [...found.entries()]
  ;(window as unknown as { __cases: Element[] }).__cases = cases.map(([element]) => element)
  return cases.map(([element, properties], index) => ({
    index,
    label: `${element.localName}${element.id ? `#${element.id}` : ''}${typeof element.className === 'string' && element.className ? `.${element.className.split(/\s+/)[0]}` : ''}`,
    properties: [...properties],
  }))
}

const read = (page: Page, index: number, properties: string[]): Promise<Record<string, string>> =>
  page.evaluate(
    ([i, names]) => {
      const element = (window as unknown as { __cases: Element[] }).__cases[i as number] as Element
      const style = getComputedStyle(element)
      return Object.fromEntries((names as string[]).map((name) => [name, style.getPropertyValue(name)]))
    },
    [index, properties] as const,
  )

const readForced = (page: Page, index: number, properties: string[], state: string): Promise<{ values: Record<string, string>; rules: number; unreadable: number }> =>
  page.evaluate(
    ([i, names, forcedState]) => {
      const element = (window as unknown as { __cases: Element[] }).__cases[i as number] as Element
      const forced = (window as unknown as { __force: (el: Element, s: string) => { rules: number; unreadable: number; release(): void } }).__force(element, forcedState as string)
      const style = getComputedStyle(element)
      const values = Object.fromEntries((names as string[]).map((name) => [name, style.getPropertyValue(name)]))
      const out = { values, rules: forced.rules, unreadable: forced.unreadable }
      forced.release()
      return out
    },
    [index, properties, state] as const,
  )

/** Every selector text of every readable rule, to prove release() puts the page's CSS back. */
const selectors = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const out: string[] = []
    const visit = (rules: CSSRuleList): void => {
      for (const rule of rules) {
        if (typeof (rule as CSSStyleRule).selectorText === 'string') out.push((rule as CSSStyleRule).selectorText)
        const inner = (rule as CSSGroupingRule).cssRules as CSSRuleList | undefined
        if (inner !== undefined) visit(inner)
      }
    }
    for (const sheet of document.styleSheets) {
      try {
        visit(sheet.cssRules)
      } catch {
        // skip
      }
    }
    return out.join('\n')
  })

async function hoverChecks(name: 'vite-react-19' | 'static-html' | 'sveltekit-svelte-5', path: string, extraCss?: { css: string; className: string; on: string }): Promise<void> {
  const fixture = await startFixture(name)
  const proxy = await startProxy(fixture, { headScripts: [{ name: 'states.js', entry: ENTRY }] })
  const browser = await launchBrowser()
  const { page, record } = await newPage(browser, { viewport: { width: 1280, height: 900 } })
  await page.addInitScript(KEEP_NAMES)
  await report.attempt(`${name}: forced :hover equals real hover for every element a readable :hover rule styles`, async () => {
    await page.goto(proxy.url + path)
    await page.waitForLoadState('load')
    // Both readings are taken at the end state.
    await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important }' })
    if (extraCss !== undefined) {
      await page.addStyleTag({ content: extraCss.css })
      await page.evaluate(([selector, className]) => document.querySelector(selector as string)?.classList.add(...(className as string).split(' ')), [extraCss.on, extraCss.className] as const)
    }
    await sleep(200)
    const before = await selectors(page)
    const cases = await page.evaluate(discover, 'hover')
    expect(cases.length >= 3, `only ${cases.length} elements with hover rules were found`)
    const mismatches: string[] = []
    let changed = 0
    let compared = 0
    for (const item of cases) {
      const rest = await read(page, item.index, item.properties)
      const forced = await readForced(page, item.index, item.properties, 'hover')
      const handle = await page.evaluateHandle((i) => (window as unknown as { __cases: Element[] }).__cases[i] as Element, item.index)
      await handle.asElement()?.scrollIntoViewIfNeeded()
      await handle.asElement()?.hover({ force: true })
      const real = await read(page, item.index, item.properties)
      await page.mouse.move(0, 0)
      for (const property of item.properties) {
        compared += 1
        if (real[property] !== rest[property]) changed += 1
        if (forced.values[property] !== real[property]) mismatches.push(`${item.label} ${property}: forced "${forced.values[property]}", real "${real[property]}", at rest "${rest[property]}"`)
      }
    }
    expect(mismatches.length === 0, `${mismatches.length} of ${compared} values differ:\n${mismatches.slice(0, 8).join('\n')}`)
    expect(changed > 0, 'no property changed under real hover, so the check proves nothing')
    const after = await selectors(page)
    expect(after === before, 'release() did not restore the page\'s selectors')
    const leftovers = await page.evaluate(() => document.querySelectorAll('[data-primp-force]').length)
    expect(leftovers === 0, `${leftovers} elements still carry the marker`)
    const errors = record.pageErrors
    expect(errors.length === 0, `page errors: ${errors.join(' | ')}`)
    return `${cases.length} elements, ${compared} values compared, ${changed} of them change on hover, 0 differ; selectors restored; no marker left`
  })
  await runCleanups()
}

async function focusCheck(): Promise<void> {
  const fixture = await startFixture('static-html')
  const proxy = await startProxy(fixture, { headScripts: [{ name: 'states.js', entry: ENTRY }] })
  const browser = await launchBrowser()
  const { page } = await newPage(browser)
  await page.addInitScript(KEEP_NAMES)
  await report.attempt('static-html: forced :focus-visible equals real keyboard focus on the first focusable element', async () => {
    await page.goto(`${proxy.url}/`)
    await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important }' })
    await page.keyboard.press('Tab')
    const properties = ['outline-style', 'outline-width', 'outline-color', 'outline-offset', 'color', 'background-color', 'text-decoration-line', 'box-shadow']
    const real = await page.evaluate((names) => {
      const element = document.activeElement as Element
      ;(window as unknown as { __cases: Element[] }).__cases = [element]
      const style = getComputedStyle(element)
      return { tag: element.localName, matches: element.matches(':focus-visible'), values: Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name)])) }
    }, properties)
    expect(real.matches, `the focused ${real.tag} does not match :focus-visible`)
    await page.evaluate(() => (document.activeElement as HTMLElement).blur())
    const rest = await read(page, 0, properties)
    const forced = await readForced(page, 0, properties, 'focus-visible')
    // The browser's own focus ring (`outline: auto` from the user-agent sheet) is not in any readable rule.
    const authored = properties.filter((name) => forced.values[name] === real.values[name])
    const differing = properties.filter((name) => forced.values[name] !== real.values[name])
    const changed = properties.filter((name) => real.values[name] !== rest[name])
    expect(changed.length > 0, 'nothing changes on focus, so the check proves nothing')
    const pageRuleProps = await page.evaluate(() => {
      const names = new Set<string>()
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) if (typeof (rule as CSSStyleRule).selectorText === 'string' && /:focus/.test((rule as CSSStyleRule).selectorText)) for (const name of (rule as CSSStyleRule).style) names.add(name)
        } catch {
          // skip
        }
      }
      return [...names]
    })
    const wrongAuthored = differing.filter((name) => pageRuleProps.includes(name))
    expect(wrongAuthored.length === 0, `properties set by the page's own focus rules differ: ${wrongAuthored.map((name) => `${name} forced "${forced.values[name]}" real "${real.values[name]}"`).join('; ')}`)
    return `<${real.tag}>: ${changed.length} properties change on focus; ${authored.length} of ${properties.length} agree; differing (browser default ring, not in a readable rule): ${differing.join(', ') || 'none'}`
  })
  await runCleanups()
}

async function reorderCheck(name: 'vite-react-19' | 'sveltekit-svelte-5' | 'next-16-turbopack', selector: string, edit: { file: string; from: string; to: string }): Promise<void> {
  const fixture = await startFixture(name)
  const proxy = await startProxy(fixture)
  const browser = await launchBrowser()
  const { page, record } = await newPage(browser)
  await page.addInitScript(KEEP_NAMES)
  await report.attempt(`${name}: a sibling moved with insertBefore survives a hot update with no error`, async () => {
    await page.goto(`${proxy.url}/`)
    await waitFor(() => record.webSockets.length > 0, { what: 'the HMR socket', timeoutMs: 15_000 })
    await sleep(800)
    const moved = await page.evaluate((sel) => {
      const items = [...document.querySelectorAll(sel)]
      const second = items[1]
      const first = items[0]
      if (second === undefined || first === undefined || second.parentElement !== first.parentElement) return null
      const order = (): string[] => [...(first.parentElement as Element).children].map((child) => (child.textContent ?? '').trim().slice(0, 14))
      const before = order()
      ;(first.parentElement as Element).insertBefore(second, first)
      return { before, after: order(), count: items.length }
    }, selector)
    expect(moved !== null && moved.before.join('|') !== moved.after.join('|'), `the move did not happen: ${JSON.stringify(moved)}`)
    const errorsBefore = record.pageErrors.length + record.consoleErrors().length
    // The framework now re-renders the moved subtree: a text change in the component that renders the list.
    const change = editFile(fixture, edit.file, replaceOnce(edit.from, edit.to))
    await waitFor(async () => (await page.content()).includes('Reordered check'), { what: 'the hot update', timeoutMs: 15_000 })
    await sleep(500)
    change.revert()
    await sleep(1500)
    const count = await page.evaluate((sel) => document.querySelectorAll(sel).length, selector)
    const errors = [...record.pageErrors, ...record.consoleErrors().map((entry) => entry.text)].slice(errorsBefore)
    expect(errors.length === 0, `errors after the update: ${errors.slice(0, 3).join(' | ')}`)
    expect(count === (moved as { count: number }).count, `the list has ${count} items, had ${(moved as { count: number }).count}`)
    expect(record.documentRequests.length === 1, `the page reloaded (${record.documentRequests.length} loads)`)
    return `moved the second of ${count} before the first; two hot updates applied; 0 errors; no reload`
  })
  await runCleanups()
}

try {
  report.section('A. Forced states')
  await hoverChecks('vite-react-19', '/')
  await hoverChecks('static-html', '/', {
    // What a Tailwind v4 `hover:` utility compiles to: inside a layer and a hover media query.
    css: '@layer utilities { @media (hover: hover) { .hover\\:tw-bg:hover { background-color: rgb(1, 2, 3) } .group:hover .group-hover\\:tw-fg { color: rgb(4, 5, 6) } } }',
    className: 'hover:tw-bg group',
    on: '[data-label="hero"]',
  })
  await hoverChecks('sveltekit-svelte-5', '/')
  await focusCheck()

  report.section('B. Reorder in a framework-owned tree')
  await reorderCheck('vite-react-19', '[data-label="plan"]', { file: 'src/components/PricingTable.tsx', from: 'className="pricing__title">', to: 'className="pricing__title">Reordered check ' })
  await reorderCheck('sveltekit-svelte-5', '[data-label="feature-card"]', { file: 'src/routes/+page.svelte', from: '<Hero', to: '<p>Reordered check</p>\n<Hero' })
} catch (error) {
  report.check('spike ran to completion', false, error instanceof Error ? (error.stack ?? error.message) : String(error))
} finally {
  await runCleanups()
  report.finish()
}
