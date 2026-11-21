/**
 * What spikes S3 and S7 share: building the hook, reading what it recorded,
 * and reading layout shifts WITHOUT the hook (the control measurement).
 */

import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import type { Page } from '@playwright/test'
import { ShiftRecordingSchema, type ShiftRecording } from '../../packages/protocol/src/shift.ts'
import { bundleBrowser, REPO_ROOT, type HeadScript } from '../lib/index.ts'

export const HOOK_ENTRY = join(REPO_ROOT, 'packages/overlay/src/hook/index.ts')
export const STUB_ENTRY = join(REPO_ROOT, 'spikes/s7-assets/overlay-stub.ts')

/** The hook as the proxy's first head script. `stacks` compiles in the DOM-call stack capture. */
export function hookScript(options: { stacks?: boolean } = {}): HeadScript {
  return { name: 'hook.js', entry: HOOK_ENTRY, minify: true, define: { __PRIMP_HOOK_STACKS__: options.stacks === true ? 'true' : 'false' } }
}

export function stubScript(mode: 'popover' | 'fixed'): HeadScript {
  return { name: 'overlay-stub.js', entry: STUB_ENTRY, minify: true, define: { __PRIMP_STUB_MODE__: JSON.stringify(mode) } }
}

export interface HookSize {
  minified: number
  gzipped: number
}

export async function hookSize(options: { stacks?: boolean } = {}): Promise<HookSize> {
  const code = await bundleBrowser(HOOK_ENTRY, { minify: true, define: { __PRIMP_HOOK_STACKS__: options.stacks === true ? 'true' : 'false' } })
  return { minified: Buffer.byteLength(code), gzipped: gzipSync(code, { level: 9 }).length }
}

/** The hook's recording, validated against the protocol schema: a recording that does not parse fails the caller. */
export async function readRecording(page: Page): Promise<ShiftRecording> {
  const raw = await page.evaluate(() => {
    const hook = window.__primp
    if (hook === undefined) throw new Error('window.__primp is missing: the hook was not injected')
    return hook.recording()
  })
  return ShiftRecordingSchema.parse(raw)
}

export interface PlainEntry {
  value: number
  startTime: number
  hadRecentInput: boolean
  sources: number
}

/**
 * Layout-shift entries read by a fresh `PerformanceObserver` created now, with
 * `buffered: true`. Nothing has to be in the page while it loads, so this is
 * the measurement of a page that primp did not touch, and an independent
 * second opinion on a page it did.
 */
export function readPlainEntries(page: Page): Promise<PlainEntry[]> {
  // No named helper inside the page function: tsx wraps those in a `__name` call that does not exist in the page.
  return page.evaluate(
    () =>
      new Promise<PlainEntry[]>((resolve) => {
        type Shift = PerformanceEntry & { value: number; hadRecentInput: boolean; sources: unknown[] }
        const raw: PerformanceEntry[] = []
        const observer = new PerformanceObserver((list) => raw.push(...list.getEntries()))
        observer.observe({ type: 'layout-shift', buffered: true })
        // Buffered entries arrive in a task of their own.
        setTimeout(() => {
          raw.push(...observer.takeRecords())
          observer.disconnect()
          resolve((raw as Shift[]).map((entry) => ({ value: entry.value, startTime: entry.startTime, hadRecentInput: entry.hadRecentInput, sources: entry.sources.length })))
        }, 60)
      }),
  )
}

/** Smallest step of the page's `performance.now()`: 0.005 ms when cross-origin isolated, 0.1 ms otherwise. */
export function timerResolution(page: Page): Promise<number> {
  return page.evaluate(() => {
    let smallest = Infinity
    let previous = performance.now()
    for (let i = 0; i < 200_000 && smallest > 0.006; i++) {
      const t = performance.now()
      if (t > previous) smallest = Math.min(smallest, t - previous)
      previous = t
    }
    return Math.round(smallest * 10000) / 10000
  })
}

export const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0)
export const fixed = (value: number, digits = 4): string => value.toFixed(digits)
