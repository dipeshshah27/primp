/**
 * Spike S4: settle detection.
 *
 *   pnpm spike:s4                 everything (about 3 minutes)
 *   pnpm spike:s4 -- --only vite  one framework: vite | next | svelte
 *   pnpm spike:s4 -- --record     also rewrites packages/server/test/fixtures/hmr-*.json from the frames seen
 *   pnpm spike:s4 -- --journal    prints the journal of every edit, not only of failed ones
 *
 * After a coding agent edits source files, primp has to know when the page
 * has finished updating, so that what it measures next is the edited page.
 * This spike drives the real detector (packages/server/src/settle.ts, fed by
 * packages/server/src/hmr-tee.ts and packages/overlay/src/probe/settle-client.ts)
 * against the real dev servers behind the real proxy, and after every
 * `waitForSettle` reads the page ONCE, without polling: if settle resolved
 * before the edit was on screen, that read sees the old value and the check
 * fails.
 *
 * Per framework (Vite + React, Next + Turbopack):
 *   - 20 scripted edits (text, className, inline style, CSS file, CSS module;
 *     on Next both server and client components): each must settle within 5 s
 *     and the page must show the edit at that moment;
 *   - 3 no-op waits: `no_update_observed`, and only after the timeout;
 *   - an edit to a file the page does not use: reported, not judged;
 *   - a syntax error: `build_error` within the timeout; after the fix, settled again;
 *   - edit, wait 2 s, then ask with `since` before the edit: settled at once from the journal;
 *   - the same with the HMR tee switched off ("blind"): the baseline of file
 *     watching plus DOM quiet, and build errors found through the error overlay;
 *   - Next only: server edits on /stream, where every server render takes 1.5 s,
 *     so the update lands long after the HMR message;
 *   - Vite only: all 20 edits again in a tab made to behave like a background
 *     tab, and a tab whose main thread is blocked, which must end in a result
 *     rather than hang.
 * Then, beyond the pass criteria, a shorter run on SvelteKit (Vite's socket,
 * Svelte's runtime): 6 edits, no-ops and a syntax error.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from '@playwright/test'
import {
  createReport,
  editFile,
  expect,
  launchBrowser,
  newPage,
  onCleanup,
  percentile,
  REPO_ROOT,
  runCleanups,
  sleep,
  startFixture,
  startProxy,
  waitFor,
  type FixtureHandle,
  type FixtureName,
  type PageHandle,
  type ProxyHandle,
  type Report,
} from './lib/index.ts'
import { createHmrTee, epochNow, type HmrTee } from '../packages/server/src/hmr-tee.ts'
import type { FrameDirection, TunnelInfo, WsMessage } from '../packages/server/src/index.ts'
import {
  createSettleDetector,
  type JournalEntry,
  type SettleDetector,
  type SettleResult,
} from '../packages/server/src/settle.ts'

const SETTLE_CLIENT_ENTRY = fileURLToPath(new URL('../packages/overlay/src/probe/settle-client.ts', import.meta.url))
const FIXTURE_DIR = fileURLToPath(new URL('../packages/server/test/fixtures/', import.meta.url))
const SETTLE_PATH = '/__primp/settle'

const SETTLE_LIMIT_MS = 5000
const NO_OP_TIMEOUT_MS = 1500
/** "At once" for the edit-before-wait case: one probe round trip, not a wait for a new event. */
const IMMEDIATE_MS = 300

const args = process.argv.slice(2)
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined
const record = args.includes('--record')
/** Print the journal of every edit, not only of failed ones. */
const verbose = args.includes('--journal')

// ---------------------------------------------------------------------------
// Scripted edits
// ---------------------------------------------------------------------------

type Read = 'text' | { style: string }

interface Expectation {
  selector: string
  read: Read
}

interface EditPair {
  /** Short name; the reverse edit gets a `revert ` prefix. */
  name: string
  kind: string
  file: string
  /** Exactly one occurrence of `from` is replaced by `to`. */
  from: string
  to: string
  expect: Expectation
  /** Value read from the page before and after the forward edit. */
  before: string
  after: string
}

interface ScriptedEdit {
  name: string
  kind: string
  file: string
  search: string
  replacement: string
  expect: Expectation
  expected: string
  previous: string
}

function bothWays(pairs: EditPair[]): ScriptedEdit[] {
  const forward = pairs.map((pair) => ({
    name: pair.name,
    kind: pair.kind,
    file: pair.file,
    search: pair.from,
    replacement: pair.to,
    expect: pair.expect,
    expected: pair.after,
    previous: pair.before,
  }))
  const backward = pairs.map((pair) => ({
    name: `revert ${pair.name}`,
    kind: pair.kind,
    file: pair.file,
    search: pair.to,
    replacement: pair.from,
    expect: pair.expect,
    expected: pair.before,
    previous: pair.after,
  }))
  return [...forward, ...backward]
}

const label = (name: string): string => `[data-label="${name}"]`

const VITE_EDITS = bothWays([
  {
    name: 'hero title text',
    kind: 'text',
    file: 'src/components/Hero.tsx',
    from: 'Ship the layout you meant to ship\n',
    to: 'Ship the layout you meant to ship today\n',
    expect: { selector: label('hero-title'), read: 'text' },
    before: 'Ship the layout you meant to ship',
    after: 'Ship the layout you meant to ship today',
  },
  {
    name: 'hero subtitle Tailwind class',
    kind: 'className',
    file: 'src/components/Hero.tsx',
    from: 'className="mt-4 text-lg text-slate-600"',
    to: 'className="mt-[23px] text-lg text-slate-600"',
    expect: { selector: label('hero-subtitle'), read: { style: 'margin-top' } },
    before: '16px',
    after: '23px',
  },
  {
    name: 'footer inline style',
    kind: 'inline style',
    file: 'src/components/Footer.tsx',
    from: '<p data-label="footer-copy">',
    to: `<p data-label="footer-copy" style={{ letterSpacing: '3px' }}>`,
    expect: { selector: label('footer-copy'), read: { style: 'letter-spacing' } },
    before: 'normal',
    after: '3px',
  },
  {
    name: 'banner font size in site.css',
    kind: 'CSS file',
    file: 'src/styles/site.css',
    from: 'color: #3730a3;\n  font-size: 14px;',
    to: 'color: #3730a3;\n  font-size: 17px;',
    expect: { selector: label('banner'), read: { style: 'font-size' } },
    before: '14px',
    after: '17px',
  },
  {
    name: 'card title size in Card.module.css',
    kind: 'CSS module',
    file: 'src/components/Card.module.css',
    from: '.title {\n  font-size: 17px;',
    to: '.title {\n  font-size: 19px;',
    expect: { selector: label('card-title'), read: { style: 'font-size' } },
    before: '17px',
    after: '19px',
  },
  {
    name: 'banner link text',
    kind: 'text',
    file: 'src/components/Banner.tsx',
    from: '          See plans\n',
    to: '          See all plans\n',
    expect: { selector: label('banner-link'), read: 'text' },
    before: 'See plans',
    after: 'See all plans',
  },
  {
    name: 'header logo Tailwind class',
    kind: 'className',
    file: 'src/components/Header.tsx',
    from: 'className="text-lg font-bold tracking-tight text-indigo-600"',
    to: 'className="text-[21px] font-bold tracking-tight text-indigo-600"',
    expect: { selector: label('header-logo'), read: { style: 'font-size' } },
    before: '18px',
    after: '21px',
  },
  {
    name: 'card title inline style',
    kind: 'inline style',
    file: 'src/components/Card.tsx',
    from: '<h3 data-label="card-title" className={styles.title}>',
    to: `<h3 data-label="card-title" className={styles.title} style={{ textTransform: 'uppercase' }}>`,
    expect: { selector: label('card-title'), read: { style: 'text-transform' } },
    before: 'none',
    after: 'uppercase',
  },
  {
    name: 'nav link padding in site.css',
    kind: 'CSS file',
    file: 'src/styles/site.css',
    from: '.site-nav a {\n  padding: 6px 10px;',
    to: '.site-nav a {\n  padding: 6px 14px;',
    expect: { selector: label('nav-features'), read: { style: 'padding-left' } },
    before: '10px',
    after: '14px',
  },
  {
    name: 'hero bar height in Hero.module.css',
    kind: 'CSS module',
    file: 'src/components/Hero.module.css',
    from: 'width: 40%;\n  height: 14px;',
    to: 'width: 40%;\n  height: 18px;',
    expect: { selector: label('hero-art-bar'), read: { style: 'height' } },
    before: '14px',
    after: '18px',
  },
])

const NEXT_EDITS = bothWays([
  {
    name: 'page title text',
    kind: 'server component text',
    file: 'app/page.tsx',
    from: 'Edit it visually, verify it for real</h1>',
    to: 'Edit it visually, verify it for real, twice</h1>',
    expect: { selector: label('home-title'), read: 'text' },
    before: 'Edit it visually, verify it for real',
    after: 'Edit it visually, verify it for real, twice',
  },
  {
    name: 'counter reset text',
    kind: 'client component text',
    file: 'components/client/Counter.tsx',
    from: '        Reset\n',
    to: '        Reset count\n',
    expect: { selector: label('counter-reset'), read: 'text' },
    before: 'Reset',
    after: 'Reset count',
  },
  {
    name: 'stats heading inline style',
    kind: 'inline style (server component)',
    file: 'components/server/StatsPanel.tsx',
    from: '<h2 data-label="stats-heading">',
    to: `<h2 data-label="stats-heading" style={{ letterSpacing: '2px' }}>`,
    expect: { selector: label('stats-heading'), read: { style: 'letter-spacing' } },
    before: 'normal',
    after: '2px',
  },
  {
    name: 'tabs root className',
    kind: 'className (client component)',
    file: 'components/client/Tabs.tsx',
    from: '<div data-label="tabs-root">',
    to: '<div data-label="tabs-root" className="row">',
    expect: { selector: label('tabs-root'), read: { style: 'display' } },
    before: 'block',
    after: 'flex',
  },
  {
    name: 'radius variable in globals.css',
    kind: 'CSS file',
    file: 'app/globals.css',
    from: '--radius: 8px;',
    to: '--radius: 14px;',
    expect: { selector: label('home-hero'), read: { style: 'border-top-left-radius' } },
    before: '8px',
    after: '14px',
  },
  {
    name: 'hero padding in page.module.css',
    kind: 'CSS module (server page)',
    file: 'app/page.module.css',
    from: '.hero {\n  padding: 24px;',
    to: '.hero {\n  padding: 30px;',
    expect: { selector: label('home-hero'), read: { style: 'padding-top' } },
    before: '24px',
    after: '30px',
  },
  {
    name: 'counter gap in Counter.module.css',
    kind: 'CSS module (client component)',
    file: 'components/client/Counter.module.css',
    from: 'gap: 12px;',
    to: 'gap: 20px;',
    expect: { selector: label('counter-root'), read: { style: 'column-gap' } },
    before: '12px',
    after: '20px',
  },
  {
    name: 'frame note text',
    kind: 'server component in a client frame',
    file: 'components/server/FrameNote.tsx',
    from: 'source file</em>',
    to: 'source module</em>',
    expect: { selector: label('frame-server-em'), read: 'text' },
    before: 'source file',
    after: 'source module',
  },
  {
    name: 'tab label text',
    kind: 'client component text',
    file: 'components/client/Tabs.tsx',
    from: '          CSS edits\n',
    to: '          Style edits\n',
    expect: { selector: label('tabs-tab-css'), read: 'text' },
    before: 'CSS edits',
    after: 'Style edits',
  },
  {
    name: 'footer note in the root layout',
    kind: 'server layout text',
    file: 'app/layout.tsx',
    from: 'primp fixture. Server components,',
    to: 'primp fixture: server components,',
    expect: { selector: label('footer-note'), read: 'text' },
    before: 'primp fixture. Server components, client components, a nonce CSP and a Server Action.',
    after: 'primp fixture: server components, client components, a nonce CSP and a Server Action.',
  },
])

/** Edits on /stream, where the server holds a Suspense boundary open for 1.5 s on every render. */
const NEXT_SLOW_EDITS = bothWays([
  {
    name: 'slow section title',
    kind: 'server component behind a 1.5 s Suspense boundary',
    file: 'components/server/SlowContent.tsx',
    from: 'Slow content arrived</h2>',
    to: 'Slow content arrived, edited</h2>',
    expect: { selector: label('stream-resolved-title'), read: 'text' },
    before: 'Slow content arrived',
    after: 'Slow content arrived, edited',
  },
  {
    name: 'stream page title',
    kind: 'server page whose render takes 1.5 s',
    file: 'app/stream/page.tsx',
    from: 'Streaming with Suspense</h1>',
    to: 'Streaming with Suspense, edited</h1>',
    expect: { selector: label('stream-title'), read: 'text' },
    before: 'Streaming with Suspense',
    after: 'Streaming with Suspense, edited',
  },
])

const SVELTE_HERO = 'src/lib/components/Hero.svelte'

const SVELTE_EDITS = bothWays([
  {
    name: 'hero call-to-action text',
    kind: 'Svelte component text',
    file: SVELTE_HERO,
    from: 'Sign in to continue</a>',
    to: 'Sign in to continue now</a>',
    expect: { selector: label('hero-cta'), read: 'text' },
    before: 'Sign in to continue',
    after: 'Sign in to continue now',
  },
  {
    name: 'hero lede font size',
    kind: 'Svelte scoped style',
    file: SVELTE_HERO,
    from: '.lede {\n\t\tfont-size: 19px;',
    to: '.lede {\n\t\tfont-size: 22px;',
    expect: { selector: label('hero-lede'), read: { style: 'font-size' } },
    before: '19px',
    after: '22px',
  },
  {
    name: 'hero lede inline style',
    kind: 'Svelte inline style',
    file: SVELTE_HERO,
    from: '<p class="lede" data-label="hero-lede">',
    to: '<p class="lede" data-label="hero-lede" style="letter-spacing: 1px">',
    expect: { selector: label('hero-lede'), read: { style: 'letter-spacing' } },
    before: 'normal',
    after: '1px',
  },
])

interface SyntaxCase {
  name: string
  file: string
  /** Inserted to break the file. */
  from: string
  broken: string
  /** The fix restores `from` and also makes this visible change, so "settled" can be checked in the page. */
  fixEdit: { from: string; to: string }
  expect: Expectation
  fixed: string
  original: string
}

interface FrameworkPlan {
  fixture: FixtureName
  title: string
  path: string
  edits: ScriptedEdit[]
  syntax: SyntaxCase[]
  /** Files the page under test does not use. */
  unrelated: { name: string; file: string; transform: (source: string) => string }[]
  /** Whether the settle client is expected to hook Vite's HMR client. */
  vite: boolean
  /** A page whose server render is slow, so the update lands long after the HMR message. */
  slowPage?: { path: string; ready: string; edits: ScriptedEdit[] }
}

const PLANS: Record<string, FrameworkPlan> = {
  vite: {
    fixture: 'vite-react-19',
    title: 'Vite 8 + React 19',
    path: '/',
    edits: VITE_EDITS,
    vite: true,
    syntax: [
      {
        name: 'component',
        file: 'src/components/Hero.tsx',
        from: 'export function Hero() {',
        broken: 'export function Hero() { const broken = ;',
        fixEdit: { from: 'Ship the layout you meant to ship\n', to: 'Ship the layout you meant to ship, fixed\n' },
        expect: { selector: label('hero-title'), read: 'text' },
        fixed: 'Ship the layout you meant to ship, fixed',
        original: 'Ship the layout you meant to ship',
      },
    ],
    unrelated: [{ name: 'README.md', file: 'README.md', transform: (source) => `${source}\nA line the page does not use.\n` }],
  },
  next: {
    fixture: 'next-16-turbopack',
    title: 'Next 16.4 + Turbopack',
    path: '/',
    edits: NEXT_EDITS,
    vite: false,
    slowPage: { path: '/stream', ready: label('stream-resolved-title'), edits: NEXT_SLOW_EDITS },
    syntax: [
      {
        name: 'client component',
        file: 'components/client/Counter.tsx',
        from: 'export function Counter(',
        broken: 'const broken = ;\nexport function Counter(',
        fixEdit: { from: '        Reset\n', to: '        Reset, fixed\n' },
        expect: { selector: label('counter-reset'), read: 'text' },
        fixed: 'Reset, fixed',
        original: 'Reset',
      },
      {
        name: 'server component',
        file: 'components/server/StatsPanel.tsx',
        from: 'export async function StatsPanel() {',
        broken: 'const broken = ;\nexport async function StatsPanel() {',
        fixEdit: { from: 'Server-rendered stats</h2>', to: 'Server-rendered stats, fixed</h2>' },
        expect: { selector: label('stats-heading'), read: 'text' },
        fixed: 'Server-rendered stats, fixed',
        original: 'Server-rendered stats',
      },
    ],
    unrelated: [
      { name: 'README.md', file: 'README.md', transform: (source) => `${source}\nA line the page does not use.\n` },
      {
        name: 'a component only /broken-toggle renders',
        file: 'components/client/BreakTargetClient.tsx',
        transform: (source) => source.replace('Client target compiled.', 'Client target compiled!'),
      },
    ],
  },
  svelte: {
    fixture: 'sveltekit-svelte-5',
    title: 'SvelteKit 3 + Svelte 5 (beyond the pass criteria)',
    path: '/',
    edits: SVELTE_EDITS,
    vite: true,
    syntax: [
      {
        name: 'Svelte component',
        file: SVELTE_HERO,
        from: '</section>',
        broken: '</sectio>',
        fixEdit: { from: 'Sign in to continue</a>', to: 'Sign in to continue, fixed</a>' },
        expect: { selector: label('hero-cta'), read: 'text' },
        fixed: 'Sign in to continue, fixed',
        original: 'Sign in to continue',
      },
    ],
    unrelated: [],
  },
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

interface S4Window {
  __name?: (value: unknown) => unknown
  __s4bg?: { on: boolean; held: number; timersDelayed: number; wakeups: number; native: { setInterval: typeof setInterval; clearInterval: typeof clearInterval } }
  __s4watch?: { firstAt: number | null; stop(): void }
}

interface ReadSpec {
  selector: string
  style: string | null
  expected: string
}

function readSpec(expectation: Expectation, expected: string): ReadSpec {
  return { selector: expectation.selector, style: expectation.read === 'text' ? null : expectation.read.style, expected }
}

/** One read of the page, no retry. Also returns when the in-page watcher first saw the expected value. */
async function readOnce(page: Page, spec: ReadSpec): Promise<{ value: string | null; firstAt: number | null; pageNow: number; visibility: string }> {
  return page.evaluate((s) => {
    const element = document.querySelector(s.selector)
    const value =
      element === null
        ? null
        : s.style === null
          ? (element.textContent ?? '').replace(/\s+/g, ' ').trim()
          : getComputedStyle(element).getPropertyValue(s.style)
    const watch = (window as unknown as S4Window).__s4watch
    return {
      value,
      firstAt: watch?.firstAt ?? null,
      pageNow: performance.timeOrigin + performance.now(),
      visibility: document.visibilityState,
    }
  }, spec)
}

/**
 * Installs a watcher in the page that notes the first moment the expected
 * value is there. It is only used to report how long after the real update
 * settle resolved; the pass/fail read is `readOnce`.
 */
async function watchFor(page: Page, spec: ReadSpec): Promise<void> {
  await page.evaluate((s) => {
    const w = window as unknown as S4Window
    w.__s4watch?.stop()
    const timers = w.__s4bg?.native ?? { setInterval: window.setInterval.bind(window), clearInterval: window.clearInterval.bind(window) }
    const state: { firstAt: number | null; stop(): void } = {
      firstAt: null,
      stop() {
        timers.clearInterval(interval)
        observer.disconnect()
      },
    }
    const check = (): void => {
      if (state.firstAt !== null) return
      const element = document.querySelector(s.selector)
      if (element === null) return
      const value = s.style === null ? (element.textContent ?? '').replace(/\s+/g, ' ').trim() : getComputedStyle(element).getPropertyValue(s.style)
      if (value === s.expected) state.firstAt = performance.timeOrigin + performance.now()
    }
    const observer = new MutationObserver(check)
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
    const interval = timers.setInterval(check, 4)
    w.__s4watch = state
  }, spec)
}

/**
 * Makes a page behave like a background tab, switched on with `__s4bg.on`.
 * Headless Chromium keeps every page "visible" whatever is brought to front
 * (measured: visibilityState stays `visible`, timers and rAF run at full speed,
 * with or without Playwright's anti-throttling flags), so the three things a
 * hidden tab does are reproduced in the page before any of its scripts run:
 *   - `document.visibilityState` is `hidden` and `visibilitychange` fires;
 *   - `requestAnimationFrame` callbacks are held and never run;
 *   - `setTimeout` callbacks set while hidden run only on whole seconds (Chromium's
 *     background timer alignment), in the order they fall due, each as its own task;
 *     `setInterval` runs at most once a second.
 * WebSocket messages, fetches, microtasks and MessageChannel are not delayed, as in a real
 * hidden tab.
 */
const BACKGROUND_EMULATION = `(() => {
  const native = {
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    setInterval: window.setInterval.bind(window),
    clearInterval: window.clearInterval.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
  };
  const bg = (window.__s4bg = { on: false, held: 0, timersDelayed: 0, wakeups: 0, native });
  // Timers set while "hidden" wait here and run on the next whole second, in the order they
  // fall due (then in the order they were set), each as a task of its own.
  const queue = new Map();
  let seq = 0;
  let driver = null;
  const arm = () => {
    if (driver !== null || queue.size === 0) return;
    const now = performance.now();
    driver = native.setTimeout(wake, Math.floor(now / 1000) * 1000 + 1000 - now + 1);
  };
  const wake = () => {
    driver = null;
    bg.wakeups += 1;
    const now = performance.now();
    const due = [...queue.entries()].filter(([, entry]) => entry.due <= now).sort((a, b) => a[1].due - b[1].due || a[1].seq - b[1].seq);
    for (const [id, entry] of due) {
      native.setTimeout(() => {
        if (queue.delete(id)) entry.run();
      }, 0);
    }
    native.setTimeout(arm, 0);
  };
  window.setTimeout = (handler, delay, ...rest) => {
    if (!bg.on) return native.setTimeout(handler, delay, ...rest);
    bg.timersDelayed += 1;
    seq += 1;
    const id = 1e9 + seq;
    const run = typeof handler === 'function' ? () => handler(...rest) : () => (0, eval)(String(handler));
    queue.set(id, { due: performance.now() + Math.max(0, Number(delay) || 0), seq, run });
    arm();
    return id;
  };
  window.clearTimeout = (id) => {
    if (!queue.delete(id)) native.clearTimeout(id);
  };
  window.setInterval = (handler, delay, ...rest) =>
    native.setInterval(handler, bg.on ? Math.max(1000, Number(delay) || 0) : delay, ...rest);
  window.requestAnimationFrame = (callback) => {
    if (!bg.on) return native.requestAnimationFrame(callback);
    bg.held += 1;
    return 1e9 + bg.held;
  };
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (bg.on ? 'hidden' : 'visible') });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => bg.on });
})();`

// ---------------------------------------------------------------------------
// One proxy + detector + page in front of a fixture
// ---------------------------------------------------------------------------

interface RecordedMessage {
  direction: FrameDirection
  tunnel: { id: number; path: string; protocols: string[] }
  opcode: number
  text?: string
  base64?: string
  bytes: number
}

interface Stage {
  plan: FrameworkPlan
  fixture: FixtureHandle
  proxy: ProxyHandle
  tee: HmrTee
  detector: SettleDetector
  handle: PageHandle
  page: Page
  blind: boolean
  recorded: RecordedMessage[]
  close(): Promise<void>
}

async function openStage(
  plan: FrameworkPlan,
  fixture: FixtureHandle,
  browser: Browser,
  options: { blind?: boolean; background?: boolean; path?: string; ready?: string } = {},
): Promise<Stage> {
  const tee = createHmrTee()
  const recorded: RecordedMessage[] = []
  // A blind stage still runs a tee (for the frame table) but the detector is not given it.
  const detector = createSettleDetector({ projectDir: fixture.dir, hmr: options.blind === true ? undefined : tee })
  onCleanup(() => detector.close())
  await detector.ready()
  const proxy = await startProxy(fixture, {
    headScripts: [{ name: 'settle.js', entry: SETTLE_CLIENT_ENTRY, define: { __PRIMP_SETTLE_AUTOSTART__: 'true' } }],
    onWebSocket(socket, request) {
      if ((request.url ?? '').split('?', 1)[0] === SETTLE_PATH) detector.attachBrowser(socket)
      else socket.close()
    },
    proxy: {
      onUpgradeFrame(direction: FrameDirection, tunnel: TunnelInfo, message: WsMessage) {
        tee.onFrame(direction, tunnel, message)
        if (record) {
          const entry: RecordedMessage = {
            direction,
            tunnel: { id: tunnel.id, path: tunnel.path, protocols: tunnel.protocols },
            opcode: message.opcode,
            bytes: message.data.length,
          }
          if (message.text !== undefined) entry.text = message.text
          else entry.base64 = message.data.subarray(0, 96).toString('base64')
          recorded.push(entry)
        }
      },
    },
  })
  const handle = await newPage(browser)
  // tsx compiles with esbuild's keepNames, which wraps named functions inside page.evaluate
  // callbacks in a helper the page does not have.
  await handle.context.addInitScript({ content: 'window.__name = (value) => value;' })
  if (options.background === true) await handle.context.addInitScript({ content: BACKGROUND_EMULATION })
  const page = handle.page
  await page.goto(proxy.url + (options.path ?? plan.path), { waitUntil: 'load' })
  if (options.ready !== undefined) await page.waitForSelector(options.ready, { timeout: 15_000 })
  await waitFor(() => detector.status().browsers > 0, { what: 'the settle client to connect' })
  await waitFor(() => tee.status().live, { what: 'the HMR socket to pass through the proxy' })
  if (plan.vite && options.blind !== true) {
    await waitFor(() => detector.journal().some((entry) => entry.source === 'browser' && entry.name.startsWith('vite-hook')), {
      what: "the settle client to hook Vite's HMR client",
    })
  }
  // Let hydration and the first compile finish before the first edit.
  await sleep(600)
  const watch = detector.status()
  console.log(
    `  info  stage ${options.blind === true ? '(blind) ' : ''}${options.path ?? plan.path}: watching ${watch.watchedDirectories ?? '?'} directories of ${fixture.dir.replace(REPO_ROOT, '.')} (${watch.watchBackend} backend)` +
      (watch.watchErrors.length > 0 ? `; WATCHER ERRORS: ${watch.watchErrors.join(' | ')}` : ''),
  )
  return {
    plan,
    fixture,
    proxy,
    tee,
    detector,
    handle,
    page,
    blind: options.blind === true,
    recorded,
    async close() {
      await handle.close()
      await proxy.close()
      await detector.close()
    },
  }
}

// ---------------------------------------------------------------------------
// Running edits
// ---------------------------------------------------------------------------

interface EditOutcome {
  name: string
  kind: string
  result: SettleResult
  /** File write to settle resolved. */
  writeToSettleMs: number
  /** File write to the value first being on the page (in-page watcher), when known. */
  writeToPageMs: number | null
  value: string | null
  expected: string
  ok: boolean
  /** The journal of the window, for the evidence of a failed check. */
  journal: string
  /** Offsets from the write of the first journal entry of each source. */
  first: { fs?: number; hmr?: number; browser?: number; hmrName?: string }
}

function firstSignals(journal: JournalEntry[], writeEpoch: number): EditOutcome['first'] {
  const first: EditOutcome['first'] = {}
  for (const entry of journal) {
    const offset = Math.round(entry.at - writeEpoch)
    if (entry.source === 'fs' && first.fs === undefined) first.fs = offset
    else if (entry.source === 'hmr' && first.hmr === undefined) {
      first.hmr = offset
      first.hmrName = `${entry.event.kind}:${entry.event.detail.message}`
    } else if (entry.source === 'browser' && first.browser === undefined && (entry.name === 'mutation' || entry.name === 'hello')) {
      first.browser = offset
    }
  }
  return first
}

function describeFirst(first: EditOutcome['first']): string {
  const parts: [string, number][] = []
  if (first.fs !== undefined) parts.push(['fs', first.fs])
  if (first.hmr !== undefined) parts.push([`hmr(${first.hmrName})`, first.hmr])
  if (first.browser !== undefined) parts.push(['dom', first.browser])
  parts.sort((a, b) => a[1] - b[1])
  return parts.map(([name, offset]) => `${name}+${offset}`).join(' ') || 'nothing journalled'
}

/** The journal of one window as one line per entry, offsets in ms from the file write. */
function describeJournal(journal: JournalEntry[], writeEpoch: number, limit = 40): string {
  const lines = journal.slice(0, limit).map((entry) => {
    const offset = `${entry.at - writeEpoch >= 0 ? '+' : ''}${Math.round(entry.at - writeEpoch)}`
    if (entry.source === 'fs') return `${offset} fs ${entry.event} ${entry.path}`
    if (entry.source === 'hmr') {
      const detail = entry.event.detail
      const extra = [
        detail.timestamp !== undefined ? `t=${detail.timestamp}` : '',
        detail.applied === true ? 'applied' : '',
        detail.server === true ? 'server' : '',
        detail.paths !== undefined && detail.paths.length > 0 ? detail.paths.slice(0, 2).join(',').slice(0, 80) : '',
      ]
        .filter(Boolean)
        .join(' ')
      return `${offset} hmr ${entry.event.kind}:${detail.message} (${detail.direction === 'upstream-to-client' ? 'server' : 'browser'}) ${extra}`
    }
    return `${offset} page ${entry.name}${entry.detail !== undefined ? ` ${String(entry.detail).slice(0, 60)}` : ''}`
  })
  if (journal.length > limit) lines.push(`... ${journal.length - limit} more`)
  return `journal:\n  ${lines.join('\n  ')}`
}

function watcherLine(stage: Stage): string {
  const status = stage.detector.status()
  return `file watcher: ${status.watchBackend} backend, ${status.watchedDirectories ?? '?'} directories, errors: ${status.watchErrors.join(' | ') || 'none'}`
}

function outcomeDetail(outcome: EditOutcome, withJournal: boolean): string {
  const detail =
    `${outcome.result.status} by ${outcome.result.signal} in ${ms(outcome.writeToSettleMs)} from the write ` +
    `(on the page at ${ms(outcome.writeToPageMs)}); first: ${describeFirst(outcome.first)}; files ${JSON.stringify(outcome.result.filesChanged)}\n` +
    `page read ${JSON.stringify(outcome.value)}, expected ${JSON.stringify(outcome.expected)}; ${outcome.result.reason}`
  return withJournal ? `${detail}\n${outcome.journal}` : detail
}

function replaceExactlyOnce(source: string, search: string, replacement: string): string {
  const first = source.indexOf(search)
  if (first === -1) throw new Error(`${JSON.stringify(search)} not found`)
  if (source.indexOf(search, first + search.length) !== -1) throw new Error(`${JSON.stringify(search)} occurs more than once`)
  return source.slice(0, first) + replacement + source.slice(first + search.length)
}

/** One scripted edit: write, waitForSettle, read the page once. */
async function runEdit(stage: Stage, edit: ScriptedEdit): Promise<EditOutcome> {
  const spec = readSpec(edit.expect, edit.expected)
  const before = await readOnce(stage.page, readSpec(edit.expect, edit.previous))
  if (before.value !== edit.previous) {
    throw new Error(`precondition: ${edit.expect.selector} reads ${JSON.stringify(before.value)}, expected ${JSON.stringify(edit.previous)} before the edit`)
  }
  await watchFor(stage.page, spec)
  const since = epochNow()
  const write = editFile(stage.fixture, edit.file, (source) => replaceExactlyOnce(source, edit.search, edit.replacement))
  const writeEpoch = performance.timeOrigin + write.writtenAt
  const result = await stage.detector.waitForSettle({ since, timeoutMs: SETTLE_LIMIT_MS })
  const read = await readOnce(stage.page, spec)
  const journal = stage.detector.journal(since)
  return {
    name: edit.name,
    kind: edit.kind,
    result,
    writeToSettleMs: result.at - writeEpoch,
    writeToPageMs: read.firstAt === null ? null : read.firstAt - writeEpoch,
    value: read.value,
    expected: edit.expected,
    ok: result.status === 'settled' && result.at - writeEpoch <= SETTLE_LIMIT_MS && read.value === edit.expected,
    journal: `${describeJournal(journal, writeEpoch)}\n${watcherLine(stage)}`,
    first: firstSignals(journal, writeEpoch),
  }
}

function ms(value: number | null | undefined): string {
  return value === null || value === undefined ? '-' : `${Math.round(value)} ms`
}

function timingSummary(outcomes: EditOutcome[]): string {
  const settle = outcomes.map((outcome) => outcome.writeToSettleMs)
  const lag = outcomes.filter((outcome) => outcome.writeToPageMs !== null).map((outcome) => outcome.writeToSettleMs - (outcome.writeToPageMs as number))
  const line = (name: string, values: number[]): string =>
    values.length === 0
      ? `${name}: no data`
      : `${name}: p50 ${Math.round(percentile(values, 0.5))} ms, p95 ${Math.round(percentile(values, 0.95))} ms, max ${Math.round(Math.max(...values))} ms`
  return `${line('write to settle', settle)}\n${line('settle after the edit was on the page', lag)}`
}

async function runEdits(
  stage: Stage,
  report: Report,
  edits: ScriptedEdit[],
  tag: string,
  expectSignal?: string,
  /** Called before each edit, for labelling recorded frames. */
  mark?: (name: string) => void,
): Promise<EditOutcome[]> {
  const outcomes: EditOutcome[] = []
  for (const [index, edit] of edits.entries()) {
    const name = `${tag} ${String(index + 1).padStart(2, '0')}/${edits.length} ${edit.kind}: ${edit.name}`
    mark?.(`edit (${edit.kind}): ${edit.name}`)
    await report.attempt(name, async () => {
      const outcome = await runEdit(stage, edit)
      outcomes.push(outcome)
      const detail = outcomeDetail(outcome, verbose)
      const failure = outcomeDetail(outcome, true)
      expect(outcome.result.status === 'settled', `not settled: ${failure}`)
      expect(outcome.value === edit.expected, `SETTLED BEFORE THE EDIT WAS ON THE PAGE: ${failure}`)
      expect(outcome.writeToSettleMs <= SETTLE_LIMIT_MS, `too slow: ${failure}`)
      expect(outcome.result.filesChanged.includes(edit.file), `filesChanged lacks ${edit.file}: ${failure}`)
      if (expectSignal !== undefined) expect(outcome.result.signal === expectSignal, `expected signal ${expectSignal}: ${failure}`)
      return detail
    })
    // Leave the dev server's trailing messages of this edit out of the next window.
    await sleep(200)
  }
  return outcomes
}

async function noOps(stage: Stage, report: Report, tag: string): Promise<void> {
  for (let round = 1; round <= 3; round += 1) {
    await report.attempt(`${tag} no-op ${round}/3 returns no_update_observed, and only after the timeout`, async () => {
      const result = await stage.detector.waitForSettle({ since: stage.detector.mark(), timeoutMs: NO_OP_TIMEOUT_MS })
      const detail = `${result.status} by ${result.signal} after ${ms(result.ms)} (timeout ${NO_OP_TIMEOUT_MS} ms); ${result.reason}`
      expect(result.status === 'no_update_observed', detail)
      expect(result.ms >= NO_OP_TIMEOUT_MS - 5 && result.ms < NO_OP_TIMEOUT_MS + 400, `returned at the wrong time: ${detail}`)
      expect(result.filesChanged.length === 0, `files reported for a no-op: ${JSON.stringify(result.filesChanged)}`)
      return detail
    })
  }
}

async function unrelatedEdits(stage: Stage, report: Report, tag: string): Promise<void> {
  for (const unrelated of stage.plan.unrelated) {
    const since = epochNow()
    const write = editFile(stage.fixture, unrelated.file, unrelated.transform)
    const result = await stage.detector.waitForSettle({ since, timeoutMs: SETTLE_LIMIT_MS })
    const writeEpoch = performance.timeOrigin + write.writtenAt
    report.info(
      `${tag} edit that does not affect the page (${unrelated.name}): ${result.status} by ${result.signal} after ${ms(result.at - writeEpoch)}, ` +
        `domChanged=${result.domChanged}, files ${JSON.stringify(result.filesChanged)}; first: ${describeFirst(firstSignals(stage.detector.journal(since), writeEpoch))}; ${result.reason}`,
    )
    report.check(
      `${tag} unrelated edit (${unrelated.name}) ends in a result that does not claim a build error`,
      result.status !== 'build_error' && result.status !== 'timeout' && result.filesChanged.includes(unrelated.file),
      `${result.status} by ${result.signal}, domChanged=${result.domChanged}`,
    )
    write.revert()
    await stage.detector.waitForSettle({ since: epochNow(), timeoutMs: SETTLE_LIMIT_MS })
    await sleep(200)
  }
}

async function syntaxErrors(stage: Stage, report: Report, tag: string, expectSource: 'hmr' | 'overlay'): Promise<void> {
  for (const broken of stage.plan.syntax) {
    const fileName = broken.file.split('/').pop() as string
    let ok = await report.attempt(`${tag} syntax error in a ${broken.name} returns build_error`, async () => {
      const since = epochNow()
      const write = editFile(stage.fixture, broken.file, (source) => replaceExactlyOnce(source, broken.from, broken.broken))
      const result = await stage.detector.waitForSettle({ since, timeoutMs: SETTLE_LIMIT_MS })
      const writeEpoch = performance.timeOrigin + write.writtenAt
      const overlay = await stage.page.evaluate(() => ({
        vite: document.querySelector('vite-error-overlay') !== null,
        next: document.querySelector('nextjs-portal')?.shadowRoot?.querySelector('[data-nextjs-dialog-overlay]') != null,
      }))
      const detail =
        `${result.status} by ${result.signal} ${ms(result.at - writeEpoch)} after the write; error from ${result.error?.source}: ` +
        `${JSON.stringify((result.error?.message ?? '').slice(0, 160))} file=${result.error?.file ?? '-'} line=${result.error?.line ?? '-'}; ` +
        `overlay element in the page right after: vite=${overlay.vite} next=${overlay.next}`
      expect(result.status === 'build_error', detail)
      expect(result.ms <= SETTLE_LIMIT_MS, detail)
      expect(result.error !== undefined && `${result.error.message} ${result.error.file ?? ''}`.includes(fileName), `error does not name ${fileName}: ${detail}`)
      expect(result.error?.source === expectSource, `expected the error to come from ${expectSource}: ${detail}`)
      return detail
    })
    // The overlay is drawn a moment after the error message; give it time so the next step starts from a known page.
    await sleep(400)
    if (expectSource === 'hmr') {
      await report.attempt(`${tag} the page shows the framework's error overlay for the ${broken.name} error (what the fallback looks for)`, async () => {
        const seen = await waitFor(
          () =>
            stage.page.evaluate(() => {
              const vite = document.querySelector('vite-error-overlay')
              const next = document.querySelector('nextjs-portal')?.shadowRoot
              if (vite !== null) return { element: 'vite-error-overlay', text: (vite.shadowRoot?.querySelector('.message-body')?.textContent ?? '').slice(0, 80) }
              if (next != null && next.querySelector('[data-nextjs-dialog-overlay]') !== null) {
                return {
                  element: 'nextjs-portal >>> [data-nextjs-dialog-overlay]',
                  text: `${next.querySelector('#nextjs__container_errors_label')?.textContent ?? ''} | ${(next.querySelector('#nextjs__container_errors_desc')?.textContent ?? '').slice(0, 80)}`,
                }
              }
              return undefined
            }),
          { timeoutMs: 3000, what: 'the error overlay' },
        )
        return `${seen.element}: ${JSON.stringify(seen.text)}`
      })
    }
    ok = await report.attempt(`${tag} after fixing the ${broken.name}, settle works and the page shows the fix`, async () => {
      const spec = readSpec(broken.expect, broken.fixed)
      const since = epochNow()
      const write = editFile(stage.fixture, broken.file, (source) =>
        replaceExactlyOnce(replaceExactlyOnce(source, broken.broken, broken.from), broken.fixEdit.from, broken.fixEdit.to),
      )
      const result = await stage.detector.waitForSettle({ since, timeoutMs: SETTLE_LIMIT_MS })
      const read = await readOnce(stage.page, spec)
      const detail = `${result.status} by ${result.signal} ${ms(result.at - (performance.timeOrigin + write.writtenAt))} after the write; page read ${JSON.stringify(read.value)}; ${result.reason}`
      expect(result.status === 'settled', detail)
      expect(read.value === broken.fixed, `SETTLED BEFORE THE FIX WAS ON THE PAGE: ${detail}`)
      return detail
    })
    await sleep(200)
    // Back to the original text, as an ordinary edit.
    await report.attempt(`${tag} an ordinary edit settles after the ${broken.name} error episode`, async () => {
      const outcome = await runEdit(stage, {
        name: 'restore text',
        kind: 'text',
        file: broken.file,
        search: broken.fixEdit.to,
        replacement: broken.fixEdit.from,
        expect: broken.expect,
        expected: broken.original,
        previous: broken.fixed,
      })
      const detail = `${outcome.result.status} by ${outcome.result.signal} in ${ms(outcome.writeToSettleMs)}; page read ${JSON.stringify(outcome.value)}`
      expect(outcome.ok, detail)
      return detail
    })
    void ok
    await sleep(200)
  }
}

async function editBeforeWait(stage: Stage, report: Report, tag: string, edit: ScriptedEdit, reverse: ScriptedEdit): Promise<void> {
  await report.attempt(`${tag} edit, 2 s pause, then waitForSettle(since = before the edit) answers at once from the journal`, async () => {
    const spec = readSpec(edit.expect, edit.expected)
    const since = epochNow()
    editFile(stage.fixture, edit.file, (source) => replaceExactlyOnce(source, edit.search, edit.replacement))
    await sleep(2000)
    const result = await stage.detector.waitForSettle({ since, timeoutMs: SETTLE_LIMIT_MS })
    const read = await readOnce(stage.page, spec)
    const detail = `${result.status} by ${result.signal}, the call took ${ms(result.ms)}; page read ${JSON.stringify(read.value)}; files ${JSON.stringify(result.filesChanged)}; ${result.reason}`
    expect(result.status === 'settled', detail)
    expect(result.ms < IMMEDIATE_MS, `not immediate (limit ${IMMEDIATE_MS} ms): ${detail}`)
    expect(read.value === edit.expected, detail)
    expect(result.filesChanged.includes(edit.file), detail)
    return detail
  })
  await report.attempt(`${tag} a wait that starts after that edit sees nothing (the journal window is honoured)`, async () => {
    const result = await stage.detector.waitForSettle({ since: epochNow(), timeoutMs: NO_OP_TIMEOUT_MS })
    const detail = `${result.status} by ${result.signal} after ${ms(result.ms)}`
    expect(result.status === 'no_update_observed', detail)
    return detail
  })
  const outcome = await runEdit(stage, reverse)
  if (!outcome.ok) report.check(`${tag} restoring the file after the edit-before-wait case`, false, outcomeDetail(outcome, true))
  await sleep(200)
}

function frameTable(stage: Stage): string {
  const status = stage.tee.status()
  const rows = Object.entries(status.types).sort((a, b) => a[0].localeCompare(b[0]))
  const width = Math.max(...rows.map(([name]) => name.length), 10)
  return [
    `messages ${status.messages}, recognised ${status.recognised}, not recognised ${status.unrecognised}, blind=${status.blind}, live=${status.live}`,
    ...rows.map(([name, count]) => `${name.padEnd(width)}  ${String(count).padStart(4)}`),
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Recording frames for the unit tests
// ---------------------------------------------------------------------------

/** Shortens the long strings inside a JSON message (compiled code, source maps, stacks) so fixtures stay readable. */
function shorten(value: unknown): unknown {
  if (typeof value === 'string') return value.length > 400 ? `${value.slice(0, 400)}...[${value.length} chars]` : value
  if (Array.isArray(value)) return value.map(shorten)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, shorten(entry)]))
  }
  return value
}

function writeRecording(name: string, stage: Stage, steps: { step: string; from: number }[]): void {
  // Paths on this machine are replaced so the fixture names no user or directory.
  const scrub = (text: string): string =>
    text
      .split(stage.fixture.dir)
      .join('/project')
      .split(REPO_ROOT)
      .join('/repo')
      .replace(/\.tmp\/run-[a-z0-9]+-\d+\//g, '.tmp/run/')
      .replace(/_tmp_run-[a-z0-9]+-\d+_/g, '_tmp_run_')
  const all = stage.recorded.map((message, index) => {
    const step = [...steps].reverse().find((entry) => index >= entry.from)?.step ?? 'initial'
    const entry: Record<string, unknown> = {
      step,
      direction: message.direction,
      tunnel: { ...message.tunnel, path: message.tunnel.path.replace(/([?&](?:token|id)=)[^&]+/g, '$1x') },
      opcode: message.opcode,
      bytes: message.bytes,
    }
    if (message.text !== undefined) {
      let text = scrub(message.text)
      try {
        text = JSON.stringify(shorten(JSON.parse(text)))
      } catch {
        // Not JSON: kept as it is.
      }
      entry.text = text
    } else if (message.base64 !== undefined) {
      entry.base64 = message.base64
    }
    return entry
  })
  // "A few": the page load, each forward edit, the unrelated edit and the syntax error episode.
  const frames = all.filter((entry) => {
    const step = entry.step as string
    return !step.includes(': revert ') && step !== 'no-op' && step !== 'edit-before-wait'
  })
  mkdirSync(FIXTURE_DIR, { recursive: true })
  const file = join(FIXTURE_DIR, `hmr-${name}.json`)
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        about:
          `WebSocket messages recorded by spikes/s4-settle.ts --record from the ${stage.plan.fixture} dev server through the proxy tunnel ` +
          '(page load, each forward scripted edit, an edit the page does not use, a syntax error and its fix). ' +
          'Strings longer than 400 characters inside JSON messages are cut; binary payloads are cut to their first 96 bytes ' +
          '(bytes is the real length); machine paths, tokens and ids are replaced.',
        frames,
      },
      null,
      1,
    )}\n`,
  )
  console.log(`  recorded ${frames.length} frames to ${file}`)
}

// ---------------------------------------------------------------------------
// The spike
// ---------------------------------------------------------------------------

async function runFramework(key: string, report: Report, browser: Browser): Promise<void> {
  const plan = PLANS[key] as FrameworkPlan
  report.section(`${plan.title}: start`)
  const fixture = await startFixture(plan.fixture)
  report.info(`${plan.fixture} dev server up in ${ms(fixture.startupMs)} at ${fixture.url}, working copy ${fixture.dir.replace(REPO_ROOT, '.')}`)

  // --- main stage: tee on -----------------------------------------------------
  let stage = await openStage(plan, fixture, browser)
  const steps: { step: string; from: number }[] = []
  const step = (name: string): void => {
    steps.push({ step: name, from: stage.recorded.length })
  }
  try {
    const status = stage.tee.status()
    report.check(
      `${key}: the tee sees HMR traffic (not blind)`,
      !status.blind && status.live && status.framework === (plan.vite ? 'vite' : 'next'),
      `framework=${status.framework} recognised=${status.recognised} openTunnels=${status.openTunnels} viteClientPath=${status.viteClientPath ?? '-'}`,
    )
    if (plan.vite) {
      const hook = stage.detector.journal().find((entry) => entry.source === 'browser' && entry.name.startsWith('vite-hook'))
      report.check(
        `${key}: the settle client hooked Vite's HMR client`,
        hook !== undefined && hook.source === 'browser' && hook.name === 'vite-hooked',
        hook !== undefined && hook.source === 'browser' ? `${hook.name} ${hook.detail ?? ''}` : 'no answer',
      )
    }

    report.section(`${plan.title}: ${plan.edits.length} scripted edits`)
    const outcomes = await runEdits(stage, report, plan.edits, key, undefined, step)
    const passed = outcomes.filter((outcome) => outcome.ok).length
    report.check(
      `${key}: ${plan.edits.length}/${plan.edits.length} edits settled within ${SETTLE_LIMIT_MS / 1000} s with the edit on the page`,
      passed === plan.edits.length && outcomes.length === plan.edits.length,
      `${passed}/${plan.edits.length} passed\n${timingSummary(outcomes)}\nsignals: ${countBy(outcomes.map((outcome) => outcome.result.signal))}; ` +
        `first journalled: ${countBy(outcomes.map((outcome) => describeFirst(outcome.first).split('+')[0] as string))}`,
    )

    report.section(`${plan.title}: no-op, unrelated edit, syntax error, edit before wait`)
    step('no-op')
    await noOps(stage, report, key)
    step('unrelated')
    await unrelatedEdits(stage, report, key)
    step('syntax-error')
    await syntaxErrors(stage, report, key, 'hmr')
    step('edit-before-wait')
    await editBeforeWait(stage, report, key, plan.edits[0] as ScriptedEdit, plan.edits[plan.edits.length / 2] as ScriptedEdit)

    report.info(`frame types seen on ${plan.title} (tee):\n${frameTable(stage)}`)
    if (record) writeRecording(plan.vite ? (key === 'svelte' ? 'sveltekit' : 'vite') : 'next', stage, steps)
  } finally {
    await stage.close()
  }

  // --- blind stage: the detector gets no HMR events ---------------------------
  report.section(`${plan.title}: HMR tee switched off (file watching + DOM quiet only)`)
  stage = await openStage(plan, fixture, browser, { blind: true })
  try {
    const blindEdits = [plan.edits[0], plan.edits[3], plan.edits[4], plan.edits[10], plan.edits[13], plan.edits[14]] as ScriptedEdit[]
    await runEdits(stage, report, blindEdits, `${key} blind`, 'mutation-quiet')
    await noOps(stage, report, `${key} blind`)
    await syntaxErrors(stage, report, `${key} blind`, 'overlay')
  } finally {
    await stage.close()
  }

  // --- a page whose server render is slow ---------------------------------------
  if (plan.slowPage !== undefined) {
    const slow = plan.slowPage
    report.section(`${plan.title}: ${slow.path}, where every server render takes 1.5 s`)
    stage = await openStage(plan, fixture, browser, { path: slow.path, ready: slow.ready })
    try {
      const outcomes = await runEdits(stage, report, slow.edits, `${key} slow page`, 'hmr')
      const passed = outcomes.filter((outcome) => outcome.ok).length
      report.check(
        `${key} slow page: ${slow.edits.length}/${slow.edits.length} server edits settled only once the slow render was on the page`,
        passed === slow.edits.length && outcomes.length === slow.edits.length,
        `${passed}/${slow.edits.length} passed\n${timingSummary(outcomes)}`,
      )
    } finally {
      await stage.close()
    }
  }

  // --- background tab and blocked tab (Vite) ------------------------------------
  if (key === 'vite') {
    await backgroundTab(plan, fixture, report, browser)
  }

  report.section(`${plan.title}: cleanup`)
  await fixture.stop()
  report.check(`${key}: dev server stopped and working copy removed`, true, fixture.dir.replace(REPO_ROOT, '.'))
}

/**
 * The Vite cases again with the page behaving like a background tab, then with
 * its main thread blocked.
 *
 * A page driven by Playwright cannot be made really hidden here. Measured on
 * Chromium 159: with a second page brought to front, with focus emulation
 * switched off over CDP, with the window minimised (`Browser.setWindowBounds`),
 * headless and headed, with Playwright's anti-throttling switches removed,
 * `document.visibilityState` stayed `visible`, a 16 ms timer took 17 ms and rAF
 * ran; `Page.setWebLifecycleState({ state: 'frozen' })` froze nothing. So the
 * hidden tab is emulated inside the page by BACKGROUND_EMULATION, on top of
 * "another page in front, focus emulation off".
 */
async function backgroundTab(plan: FrameworkPlan, fixture: FixtureHandle, report: Report, browser: Browser): Promise<void> {
  const tag = 'vite background'
  report.section(`${plan.title}: background tab (emulated in the page) and blocked tab`)
  const stage = await openStage(plan, fixture, browser, { background: true })
  try {
    const front = await stage.handle.context.newPage()
    await front.goto('about:blank')
    await front.bringToFront()
    const cdp = await stage.handle.context.newCDPSession(stage.page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
    await stage.page.evaluate(() => {
      const bg = (window as unknown as S4Window).__s4bg
      if (bg === undefined) throw new Error('background emulation script missing')
      bg.on = true
      document.dispatchEvent(new Event('visibilitychange'))
    })
    const seen = await stage.page.evaluate(async () => {
      const samples: number[] = []
      for (let round = 0; round < 3; round += 1) {
        const started = performance.now()
        samples.push(await new Promise<number>((resolve) => setTimeout(() => resolve(performance.now() - started), 16)))
      }
      let frames = 0
      requestAnimationFrame(() => {
        frames += 1
      })
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      return { visibility: document.visibilityState, hidden: document.hidden, focus: document.hasFocus(), timers16: samples.map(Math.round), frames }
    })
    report.check(
      `${tag}: the tab is hidden to its scripts, a 16 ms timer is delayed, rAF does not run`,
      seen.visibility === 'hidden' && seen.hidden && seen.frames === 0 && Math.max(...seen.timers16) > 100,
      `visibilityState=${seen.visibility} hidden=${seen.hidden} hasFocus=${seen.focus} ` +
        '(another page is in front, focus emulation off; visibility, timers and rAF emulated in the page); ' +
        `three 16 ms timers took ${seen.timers16.join(', ')} ms; rAF callbacks run: ${seen.frames}`,
    )
    const outcomes = await runEdits(stage, report, plan.edits, tag)
    const passed = outcomes.filter((outcome) => outcome.ok).length
    const held = await stage.page.evaluate(() => {
      const bg = (window as unknown as S4Window).__s4bg
      return `page timers held for a whole-second wake-up: ${bg?.timersDelayed ?? -1} (in ${bg?.wakeups ?? -1} wake-ups); rAF callbacks held back: ${bg?.held ?? -1}`
    })
    report.check(
      `${tag}: ${plan.edits.length}/${plan.edits.length} edits settled without hanging, with the edit on the page`,
      passed === plan.edits.length && outcomes.length === plan.edits.length,
      `${passed}/${plan.edits.length} passed\n${timingSummary(outcomes)}\nsignals: ${countBy(outcomes.map((outcome) => outcome.result.signal))}; ` +
        `reported visibility: ${countBy(outcomes.map((outcome) => outcome.result.visibility ?? 'unknown'))}; ${held}`,
    )
    await noOps(stage, report, tag)

    const edit = plan.edits[0] as ScriptedEdit
    await report.attempt(`${tag}: edit, 2 s pause, then waitForSettle(since = before the edit) is settled from the journal`, async () => {
      const spec = readSpec(edit.expect, edit.expected)
      const since = epochNow()
      const write = editFile(stage.fixture, edit.file, (source) => replaceExactlyOnce(source, edit.search, edit.replacement))
      await sleep(2000)
      const result = await stage.detector.waitForSettle({ since, timeoutMs: SETTLE_LIMIT_MS })
      const read = await readOnce(stage.page, spec)
      const detail =
        `${result.status} by ${result.signal}, the call took ${ms(result.ms)} (one probe answer, which a hidden tab gives on its next timer wake-up); ` +
        `page read ${JSON.stringify(read.value)}\n${describeJournal(stage.detector.journal(since), performance.timeOrigin + write.writtenAt)}`
      expect(result.status === 'settled' && read.value === edit.expected, detail)
      expect(result.ms < 1000 + IMMEDIATE_MS, `waited for more than one probe: ${detail}`)
      return detail
    })
    await sleep(200)
    await report.attempt(`${tag}: the edit that restores the file settles too`, async () => {
      const outcome = await runEdit(stage, plan.edits[plan.edits.length / 2] as ScriptedEdit)
      expect(outcome.ok, outcomeDetail(outcome, true))
      return outcomeDetail(outcome, false)
    })

    // A tab whose main thread is busy runs nothing: no HMR message is handled and no probe is answered.
    await report.attempt('vite blocked tab (main thread busy for 4 s): waitForSettle(3 s) returns "timeout" on time instead of hanging or guessing', async () => {
      await stage.page.evaluate(() => {
        const bg = (window as unknown as S4Window).__s4bg
        if (bg !== undefined) bg.on = false
        document.dispatchEvent(new Event('visibilitychange'))
      })
      await sleep(1200)
      const BLOCK_MS = 4000
      const blocked = stage.page.evaluate((duration) => {
        const end = performance.now() + duration
        // eslint-disable-next-line no-empty
        while (performance.now() < end) {}
        return performance.now()
      }, BLOCK_MS)
      await sleep(100)
      const since = epochNow()
      editFile(stage.fixture, edit.file, (source) => replaceExactlyOnce(source, edit.search, edit.replacement))
      const started = performance.now()
      const result = await stage.detector.waitForSettle({ since, timeoutMs: 3000 })
      const took = performance.now() - started
      const detail = `${result.status} by ${result.signal} after ${ms(took)} (timeout 3000 ms); ${result.reason}`
      expect(took < 3000 + 300, `overran: ${detail}`)
      expect(result.status === 'timeout', `a page that answers nothing cannot be confirmed, expected timeout: ${detail}`)
      await blocked
      const after = await stage.detector.waitForSettle({ since, timeoutMs: SETTLE_LIMIT_MS })
      const read = await readOnce(stage.page, readSpec(edit.expect, edit.expected))
      const afterDetail = `once the page ran again, the same window: ${after.status} by ${after.signal} in ${ms(after.ms)}, page read ${JSON.stringify(read.value)}; ${after.reason}`
      expect(after.status === 'settled' && read.value === edit.expected, `${detail}\n${afterDetail}`)
      await sleep(200)
      const back = await runEdit(stage, plan.edits[plan.edits.length / 2] as ScriptedEdit)
      expect(back.ok, `restoring the file after the blocked-tab case failed: ${outcomeDetail(back, true)}`)
      return `${detail}\n${afterDetail}`
    })
  } finally {
    await stage.close()
  }
}

function countBy(values: string[]): string {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts.entries()].map(([value, count]) => `${value} x${count}`).join(', ')
}

/**
 * SvelteKit is Vite's socket with a different app runtime. It is not part of
 * the S4 pass criteria; it runs last and with fewer cases, and every check it
 * records counts like any other.
 */
async function runSvelte(report: Report, browser: Browser): Promise<void> {
  const plan = PLANS.svelte as FrameworkPlan
  report.section(`${plan.title}: start`)
  const fixture = await startFixture(plan.fixture)
  report.info(`${plan.fixture} dev server up in ${ms(fixture.startupMs)} at ${fixture.url}`)
  const stage = await openStage(plan, fixture, browser)
  try {
    const status = stage.tee.status()
    report.check(
      'svelte: the tee sees HMR traffic (not blind)',
      !status.blind && status.live && status.framework === 'vite',
      `framework=${status.framework} recognised=${status.recognised} openTunnels=${status.openTunnels} viteClientPath=${status.viteClientPath ?? '-'}`,
    )
    report.section(`${plan.title}: ${plan.edits.length} scripted edits, no-op, syntax error`)
    const steps: { step: string; from: number }[] = []
    const step = (name: string): void => {
      steps.push({ step: name, from: stage.recorded.length })
    }
    const outcomes = await runEdits(stage, report, plan.edits, 'svelte', undefined, step)
    const passed = outcomes.filter((outcome) => outcome.ok).length
    report.check(
      `svelte: ${plan.edits.length}/${plan.edits.length} edits settled within ${SETTLE_LIMIT_MS / 1000} s with the edit on the page`,
      passed === plan.edits.length && outcomes.length === plan.edits.length,
      `${passed}/${plan.edits.length} passed\n${timingSummary(outcomes)}\nsignals: ${countBy(outcomes.map((outcome) => outcome.result.signal))}`,
    )
    step('no-op')
    await noOps(stage, report, 'svelte')
    step('syntax-error')
    await syntaxErrors(stage, report, 'svelte', 'hmr')
    report.info(`frame types seen on ${plan.title} (tee):\n${frameTable(stage)}`)
    if (record) writeRecording('sveltekit', stage, steps)
  } finally {
    await stage.close()
    await fixture.stop()
  }
}

async function main(): Promise<void> {
  const report = createReport('S4 settle detection')
  try {
    const browser = await launchBrowser()
    report.info(`Chromium ${browser.version()}, headless`)
    for (const key of ['vite', 'next']) {
      if (only !== undefined && only !== key) continue
      try {
        await runFramework(key, report, browser)
      } catch (error) {
        report.check(`${key}: ran to completion`, false, error instanceof Error ? (error.stack ?? error.message) : String(error))
      }
    }
    if (only === undefined || only === 'svelte') {
      try {
        await runSvelte(report, browser)
      } catch (error) {
        report.check('svelte: ran to completion', false, error instanceof Error ? (error.stack ?? error.message) : String(error))
      }
    }
  } catch (error) {
    report.check('spike ran to completion', false, error instanceof Error ? (error.stack ?? error.message) : String(error))
  } finally {
    await runCleanups()
    report.finish()
  }
}

void main()
