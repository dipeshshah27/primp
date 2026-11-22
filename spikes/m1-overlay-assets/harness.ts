/**
 * Helpers of the overlay integration check (spikes/m1-overlay.ts): the real primp in front of a
 * fixture, the two bundles measured on their own, a fake session server for the few things the
 * real one cannot be made to say, and small page-side readers.
 */

import { build } from 'esbuild'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import type { Browser, Frame, Page } from '@playwright/test'
import { HOOK_ASSET_PATH, OVERLAY_ASSET_PATH, RESERVED_PREFIX } from '../../packages/protocol/src/messages.ts'
import { startPrimp, type PrimpHandle } from '../../packages/server/src/app.ts'
import {
  newPage,
  onCleanup,
  REPO_ROOT,
  startFixture,
  startProxy,
  TMP_ROOT,
  waitFor,
  type FixtureHandle,
  type FixtureName,
  type NewPageOptions,
  type PageHandle,
  type ProxyHandle,
} from '../lib/index.ts'
import { createFakeSession, type FakeSession } from './fake-session.ts'

export const HOOK_ENTRY = join(REPO_ROOT, 'packages/overlay/src/entry/hook.ts')
export const OVERLAY_ENTRY = join(REPO_ROOT, 'packages/overlay/src/entry/overlay.ts')

export interface Bundle {
  code: string
  minified: number
  gzipped: number
  /** Source files that ended up in the bundle. */
  inputs: string[]
}

export interface Bundles {
  hook: Bundle
  /** The head script without the DOM-call stack capture. */
  hookNoStacks: Bundle
  overlay: Bundle
  /** Minified size of the two M0 pieces the head script contains, each bundled alone with the same settings. */
  parts: { recorder: number; settle: number }
}

async function bundle(entry: string, define: Record<string, string>): Promise<Bundle> {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    define,
    write: false,
    metafile: true,
    logLevel: 'silent',
  })
  const code = result.outputFiles[0]?.text
  if (code === undefined) throw new Error(`esbuild produced no output for ${entry}`)
  const inputs = Object.values(result.metafile.outputs).flatMap((output) => Object.entries(output.inputs).filter(([, input]) => input.bytesInOutput > 0).map(([file]) => file))
  return { code, minified: Buffer.byteLength(code), gzipped: gzipSync(code, { level: 9 }).length, inputs }
}

/** Both bundles as the server will build them: minified IIFE, stack capture on, no stand-alone settle starter. */
export async function buildBundles(): Promise<Bundles> {
  const define = { __PRIMP_HOOK_STACKS__: 'true', __PRIMP_SETTLE_AUTOSTART__: 'false' }
  const [hook, hookNoStacks, overlay, recorder, settle] = await Promise.all([
    bundle(HOOK_ENTRY, define),
    bundle(HOOK_ENTRY, { ...define, __PRIMP_HOOK_STACKS__: 'false' }),
    bundle(OVERLAY_ENTRY, {}),
    bundle(join(REPO_ROOT, 'packages/overlay/src/hook/index.ts'), define),
    bundle(join(REPO_ROOT, 'packages/overlay/src/probe/settle-client.ts'), define),
  ])
  return { hook, hookNoStacks, overlay, parts: { recorder: recorder.minified, settle: settle.minified } }
}

export interface Lane {
  name: FixtureName
  fixture: FixtureHandle
  /** The real primp (proxy, session, settle detector) in front of the fixture. Replaced by `restartPrimp`. */
  primp: PrimpHandle
  /** The same fixture behind a proxy that injects nothing. */
  control: ProxyHandle
  /** Warnings and errors the primp process logged. */
  logs: string[]
}

const SESSION_DIR = join(TMP_ROOT, `m1-overlay-sessions-${process.pid}`)
onCleanup(() => rmSync(SESSION_DIR, { recursive: true, force: true }))

async function launch(lane: Pick<Lane, 'fixture' | 'logs'>, port?: number, assets?: PrimpHandle['assets']): Promise<PrimpHandle> {
  const primp = await startPrimp({
    projectRoot: lane.fixture.dir,
    target: lane.fixture.url,
    ...(port === undefined ? {} : { port }),
    // The first start bundles packages/overlay/src/entry/*.ts the way the product does; restarts reuse that build.
    ...(assets === undefined ? {} : { assets }),
    sessionDir: SESSION_DIR,
    handleSignals: false,
    version: '0.0.0-spike',
    log: (level, message, detail) => {
      if (level === 'warn' || level === 'error') lane.logs.push(`${level}: ${message}${detail === undefined ? '' : ` ${detail instanceof Error ? detail.message : JSON.stringify(detail)?.slice(0, 300)}`}`)
    },
  })
  onCleanup(() => primp.close())
  return primp
}

export async function startLane(name: FixtureName): Promise<Lane> {
  const fixture = await startFixture(name)
  const logs: string[] = []
  const primp = await launch({ fixture, logs })
  const control = await startProxy(fixture)
  return { name, fixture, primp, control, logs }
}

/** Stops primp and starts it again on the same port with an empty session, as after `npx @primpdev/cli` was restarted. */
export async function restartPrimp(lane: Lane): Promise<void> {
  const { port, assets } = lane.primp
  await lane.primp.close()
  lane.primp = await waitFor(() => launch(lane, port, assets), { timeoutMs: 5000, what: `primp to start again on port ${port}` })
}

/** A proxy with the same bundles and a FAKE session server, for what the real one cannot be made to say. */
export async function startFakeLane(fixture: FixtureHandle, bundles: Bundles): Promise<{ proxy: ProxyHandle; session: FakeSession }> {
  const asset = (path: string): string => path.slice(RESERVED_PREFIX.length)
  const session = createFakeSession({ target: fixture.url, framework: fixture.name, projectName: fixture.name, version: '0.0.0-spike' })
  const proxy = await startProxy(fixture, {
    headScripts: [{ name: asset(HOOK_ASSET_PATH), code: bundles.hook.code }],
    assets: { [asset(OVERLAY_ASSET_PATH)]: { body: bundles.overlay.code, contentType: 'text/javascript; charset=utf-8' } },
    onWebSocket: (socket, request) => session.onWebSocket(socket, request),
  })
  return { proxy, session }
}

export interface DockPage extends PageHandle {
  /** The popover's own document: the inspector of the selection, or the panel opened from the toolbar. */
  dock: Frame
  /** The toolbar's own document: the launcher while the dock is closed, the toolbar while it is open. */
  bar: Frame
}

export interface OpenOptions extends NewPageOptions {
  /** Keep the session of the page before (default: primp is restarted, so the page starts with an empty session). */
  keepSession?: boolean
  /** Open through this origin instead of the lane's primp. */
  origin?: string
}

/** Opens `path` through primp and waits until the dock is mounted and has its first session state. */
export async function openDock(browser: Browser, lane: Lane, path: string, options: OpenOptions = {}): Promise<DockPage> {
  if (options.keepSession !== true && options.origin === undefined && lane.primp.session.items().length > 0) await restartPrimp(lane)
  const handle = await newPage(browser, options)
  // tsx compiles named inner functions to `__name(fn, "name")`; the page does not have that helper.
  await handle.context.addInitScript({ content: 'globalThis.__name = globalThis.__name || function (f) { return f }' })
  await handle.page.goto((options.origin ?? lane.primp.url) + path, { waitUntil: 'load' })
  const dock = await dockFrame(handle.page)
  const bar = await dockFrame(handle.page, 'bar')
  await handle.page.evaluate(() => window.__primp_test!.ready())
  return { ...handle, dock, bar }
}

/** The document of one of the dock's two frames: `pop` (inspector and panels, the default) or `bar` (launcher and toolbar). */
export async function dockFrame(page: Page, which: 'pop' | 'bar' = 'pop'): Promise<Frame> {
  await page.waitForFunction(() => window.__primp_test !== undefined, undefined, { timeout: 15_000 })
  const element = await page.waitForSelector(`primp-root iframe[data-primp-dock="${which}"]`, { state: 'attached', timeout: 10_000 })
  const frame = await element.contentFrame()
  if (frame === null) throw new Error(`the dock's ${which} frame has no document`)
  return frame
}

export interface DocRect {
  x: number
  y: number
  w: number
  h: number
}

/** Border box of the first match in document coordinates, read with code that shares nothing with the overlay. */
export function rect(page: Page, selector: string): Promise<DocRect> {
  return page.evaluate((sel) => {
    const element = document.querySelector(sel)
    if (element === null) throw new Error(`no element matches ${sel}`)
    const r = element.getBoundingClientRect()
    return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }
  }, selector)
}

/** Computed value of `property` for every match of `selector`. */
export function computedAll(page: Page, selector: string, property: string): Promise<string[]> {
  return page.evaluate(([sel, prop]) => [...document.querySelectorAll(sel)].map((element) => getComputedStyle(element).getPropertyValue(prop)), [selector, property] as const)
}

export async function computed(page: Page, selector: string, property: string): Promise<string> {
  const values = await computedAll(page, selector, property)
  if (values[0] === undefined) throw new Error(`no element matches ${selector}`)
  return values[0]
}

/** Elements that carry primp's mark. */
export function marks(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('[data-primp-id]').length)
}

export function testState(page: Page) {
  return page.evaluate(() => window.__primp_test!.state())
}

export function items(page: Page) {
  return page.evaluate(() => window.__primp_test!.items())
}

export const px = (n: number): string => `${Math.round(Math.abs(n) * 2) / 2}px`
