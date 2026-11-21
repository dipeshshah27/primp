#!/usr/bin/env node
// Checks that this fixture runs and still matches labels.json.
//
//   node scripts/verify.mjs                    HTTP checks, then browser checks
//   node scripts/verify.mjs --http-only        HTTP checks only
//   node scripts/verify.mjs --require-browser  a missing Playwright is a failure, not a skip
//
// It starts "pnpm dev" on a free port (PORT), runs the checks and always stops the server.
// Exit code 0 when no check failed, 1 otherwise. A skipped check is printed as SKIP and is
// never counted as passed.
//
// The browser checks need @playwright/test. The fixture does not depend on it: it is resolved
// from the primp repo root, so they run when the fixture sits inside the repo (in place or
// under .tmp/) and are skipped when it has been copied elsewhere.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const labels = JSON.parse(readFileSync(join(root, 'labels.json'), 'utf8'));

// ---------------------------------------------------------------------------------------------
// Report

const results = [];
function record(status, name, evidence) {
  results.push({ status, name });
  console.log(`${status.padEnd(4)} ${name}${evidence ? `: ${evidence}` : ''}`);
}
const check = (name, ok, evidence) => record(ok ? 'PASS' : 'FAIL', name, evidence);
const skip = (name, reason) => record('SKIP', name, reason);
const info = (text) => console.log(`     ${text}`);

// ---------------------------------------------------------------------------------------------
// Dev server

function freePort() {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, 'localhost', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

let child = null;
let childOutput = '';

function startDevServer(port) {
  // detached: the child leads its own process group, so pnpm, vite and anything vite spawns
  // can be stopped together.
  child = spawn('pnpm', ['dev'], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => (childOutput += chunk));
  child.stderr.on('data', (chunk) => (childOutput += chunk));
}

function signalGroup(signal) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // group already gone
  }
}

async function stopDevServer() {
  if (!child) return;
  const exited = child.exitCode !== null || child.signalCode !== null;
  if (!exited) {
    const gone = new Promise((done) => child.once('exit', done));
    signalGroup('SIGTERM');
    const timer = setTimeout(() => signalGroup('SIGKILL'), 3000);
    await gone;
    clearTimeout(timer);
  }
  signalGroup('SIGKILL'); // anything left in the group
  child = null;
}

async function waitUntilReady(origin, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`dev server exited early:\n${childOutput}`);
    try {
      const response = await fetch(origin, { signal: AbortSignal.timeout(2000) });
      await response.arrayBuffer();
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`dev server not ready after ${timeoutMs} ms:\n${childOutput}`);
}

function isListening(port) {
  return new Promise((done) => {
    const probe = createServer();
    probe.once('error', () => done(true));
    probe.listen(port, 'localhost', () => probe.close(() => done(false)));
  });
}

// ---------------------------------------------------------------------------------------------
// HTTP checks

async function get(origin, path, headers = {}) {
  const response = await fetch(origin + path, { headers, signal: AbortSignal.timeout(20_000) });
  return { status: response.status, type: response.headers.get('content-type') ?? '', body: await response.text() };
}

async function httpChecks(origin) {
  const shellMarkers = ['<div id="root"></div>', '/src/main.tsx', '/@vite/client'];
  for (const path of ['/', '/big']) {
    const page = await get(origin, path, { accept: 'text/html' });
    const missing = shellMarkers.filter((marker) => !page.body.includes(marker));
    check(
      `GET ${path} serves the app shell`,
      page.status === 200 && page.type.includes('text/html') && missing.length === 0,
      `${page.status} ${page.type}, ${page.body.length} bytes${missing.length ? `, missing ${missing.join(' ')}` : ''}`,
    );
  }

  // The entry module and everything it imports (react, react-dom/client, CSS, App) is served.
  // This also covers dependency pre-bundling when node_modules is a symlink.
  const entry = await get(origin, '/src/main.tsx');
  const imports = [...entry.body.matchAll(/\bfrom\s+"([^"]+)"|\bimport\s+"([^"]+)"/g)].map((match) => match[1] ?? match[2]);
  const statuses = [];
  for (const specifier of imports) statuses.push(`${(await get(origin, specifier)).status} ${specifier.replace(/\?.*$/, '')}`);
  check(
    'entry module and its imports are served',
    entry.status === 200 && imports.length >= 5 && statuses.every((line) => line.startsWith('200 ')),
    `${entry.status} /src/main.tsx; ${statuses.join(', ') || 'no imports found'}`,
  );

  // Every source file that labels.json refers to is served, transformed, with a source map,
  // and still contains each of its labels as a data-label prop.
  const files = [...new Set(labels.map((entry) => entry.file))];
  const broken = [];
  for (const file of files) {
    const module = await get(origin, `/${file}`);
    const expected = labels.filter((entry) => entry.file === file).map((entry) => entry.label);
    const missing = expected.filter((label) => !module.body.includes(`"data-label": "${label}"`));
    const mapped = module.body.includes('//# sourceMappingURL=data:application/json;base64,');
    if (module.status !== 200 || missing.length > 0 || !mapped) {
      broken.push(`${file} (${module.status}${mapped ? '' : ', no inline source map'}${missing.length ? `, missing ${missing.join(' ')}` : ''})`);
    }
  }
  check(
    'labelled modules are served with their labels and an inline source map',
    broken.length === 0,
    broken.length === 0 ? `${files.length} files, ${labels.length} labels` : broken.join('; '),
  );

  const tailwind = await get(origin, '/src/index.css', { accept: 'text/css' });
  const banner = tailwind.body.match(/tailwindcss v[\d.]+/)?.[0];
  const utilities = ['.max-w-5xl', '.min-h-screen', '.text-indigo-600'].filter((name) => tailwind.body.includes(name));
  check(
    'Tailwind stylesheet contains utilities used in src/',
    tailwind.status === 200 && Boolean(banner) && utilities.length === 3,
    `${tailwind.status}, ${banner ?? 'no tailwind banner'}, found ${utilities.join(' ') || 'none'}`,
  );

  const plain = await get(origin, '/src/styles/site.css', { accept: 'text/css' });
  const media = plain.body.match(/@media[^{]*768px[^{]*/)?.[0].trim();
  const hover = plain.body.includes('.site-nav a:hover');
  check(
    'plain stylesheet has the 768px media rule and a :hover rule',
    plain.status === 200 && Boolean(media) && hover,
    `${plain.status}, media "${media ?? 'not found'}", .site-nav a:hover ${hover ? 'found' : 'not found'}`,
  );

  const cssModule = await get(origin, '/src/components/Card.module.css', { accept: 'text/css' });
  const scoped = cssModule.body.match(/\._card_[\w-]+/)?.[0];
  check('CSS module class names are scoped', cssModule.status === 200 && Boolean(scoped), `${cssModule.status}, ${scoped ?? 'no ._card_* class'}`);
}

// ---------------------------------------------------------------------------------------------
// Browser checks

async function loadPlaywright() {
  try {
    return await import('@playwright/test');
  } catch {
    return null;
  }
}

/** Runs in the page: what the DOM says about every data-label, plus React's owner stacks. */
function inspectLabels() {
  const fiberOf = (element) => {
    const key = Object.keys(element).find((name) => name.startsWith('__reactFiber$'));
    return key ? element[key] : null;
  };
  const byLabel = {};
  for (const element of document.querySelectorAll('[data-label]')) {
    const label = element.getAttribute('data-label');
    const entry = (byLabel[label] ??= { count: 0, tags: [], stacks: [] });
    entry.count += 1;
    const tag = element.tagName.toLowerCase();
    if (!entry.tags.includes(tag)) entry.tags.push(tag);
    const stack = fiberOf(element)?._debugStack?.stack;
    // One line per instance: the first stack frame that is in the fixture's own source.
    entry.stacks.push(typeof stack === 'string' ? (stack.split('\n').find((line) => line.includes('/src/')) ?? '') : null);
  }
  return { byLabel, hostElements: document.querySelectorAll('#root *').length };
}

function compareWithLabels(page, dom) {
  const expected = labels.filter((entry) => entry.page === page);
  const problems = [];
  for (const entry of expected) {
    const found = dom.byLabel[entry.label];
    const want = entry.instances ?? 1;
    if (!found) problems.push(`${entry.label}: not in the DOM`);
    else if (found.count !== want) problems.push(`${entry.label}: ${found.count} nodes, expected ${want}`);
    else if (found.tags.join() !== entry.tag) problems.push(`${entry.label}: <${found.tags.join('|')}>, expected <${entry.tag}>`);
  }
  for (const label of Object.keys(dom.byLabel)) {
    if (!expected.some((entry) => entry.label === label)) problems.push(`${label}: in the DOM but not in labels.json for ${page}`);
  }
  const nodes = expected.reduce((sum, entry) => sum + (entry.instances ?? 1), 0);
  return { expected, problems, nodes };
}

/** How many instances of each label have an owner stack that names the labelled file. */
function ownerStackCoverage(expected, dom) {
  const rows = expected.map((entry) => {
    const stacks = dom.byLabel[entry.label]?.stacks ?? [];
    const file = entry.file.split('/').pop();
    return { label: entry.label, total: stacks.length, withStack: stacks.filter((frame) => frame?.includes(file)).length };
  });
  return { rows, full: rows.filter((row) => row.total > 0 && row.withStack === row.total).length };
}

const style = (page, label, property) =>
  page.evaluate(([l, p]) => getComputedStyle(document.querySelector(`[data-label="${l}"]`))[p], [label, property]);
const rect = (page, label) =>
  page.evaluate((l) => {
    const r = document.querySelector(`[data-label="${l}"]`).getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, height: r.height };
  }, label);

async function browserChecks(origin, playwright) {
  const browser = await playwright.chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console.error: ${message.text()}`);
    });

    // --- home page ---------------------------------------------------------------------------
    await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-label="footer"]');
    const home = await page.evaluate(inspectLabels);
    const homeLabels = compareWithLabels('/', home);
    check(
      '/ renders every label in labels.json with the recorded tag and instance count',
      homeLabels.problems.length === 0 && homeLabels.expected.length >= 30,
      homeLabels.problems.length === 0
        ? `${homeLabels.expected.length} labels, ${homeLabels.nodes} labelled nodes, ${home.hostElements} host elements`
        : homeLabels.problems.join('; '),
    );
    const homeStacks = ownerStackCoverage(homeLabels.expected, home);
    info(`/ owner stacks: ${homeStacks.full}/${homeLabels.expected.length} labels have a React owner stack that names the labelled file on every instance`);

    const tailwind = { display: await style(page, 'header-inner', 'display'), maxWidth: await style(page, 'header-inner', 'maxWidth') };
    check('Tailwind utilities apply (header-inner: flex, max-w-5xl)', tailwind.display === 'flex' && tailwind.maxWidth === '1024px', JSON.stringify(tailwind));

    const navPadding = await style(page, 'nav-features', 'padding');
    check('plain CSS applies (.site-nav a padding)', navPadding === '6px 10px', navPadding);

    const card = {
      padding: await style(page, 'card', 'padding'),
      className: await page.getAttribute('[data-label="card"]', 'class'),
    };
    check('CSS module applies (card padding, scoped class)', card.padding === '20px' && /^_card_[\w-]+$/.test(card.className ?? ''), JSON.stringify(card));

    const hoverBefore = await style(page, 'nav-features', 'backgroundColor');
    await page.hover('[data-label="nav-features"]');
    const hoverAfter = await style(page, 'nav-features', 'backgroundColor');
    await page.mouse.move(0, 0);
    check(':hover rule applies (.site-nav a:hover)', hoverBefore !== hoverAfter && hoverAfter === 'rgb(226, 232, 240)', `${hoverBefore} -> ${hoverAfter}`);

    const tracks = async () => (await style(page, 'pricing-grid', 'gridTemplateColumns')).split(' ').length;
    const wide = await tracks();
    await page.setViewportSize({ width: 600, height: 800 });
    const narrow = await tracks();
    await page.setViewportSize({ width: 1280, height: 800 });
    const mediaText = await page.evaluate(() => {
      for (const sheet of document.styleSheets) {
        for (const rule of sheet.cssRules) {
          if (rule instanceof CSSMediaRule && rule.cssText.includes('.pricing-grid')) return rule.conditionText;
        }
      }
      return null;
    });
    check('@media (min-width: 768px) switches the pricing grid', wide === 3 && narrow === 1, `1280px: ${wide} columns, 600px: ${narrow} column(s), CSSOM condition "${mediaText}"`);

    // --- login simulation --------------------------------------------------------------------
    const status = () => page.textContent('[data-label="session-status"]');
    const before = { status: await status(), cookie: await page.evaluate(() => document.cookie) };
    await page.click('[data-label="login-button"]');
    const after = { status: await status(), cookie: await page.evaluate(() => document.cookie) };
    check(
      'login button sets the cookie session=abc',
      before.status === 'Signed out' && before.cookie === '' && after.status === 'Signed in' && after.cookie === 'session=abc',
      `${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
    );
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('[data-label="session-status"]');
    const reloaded = await status();
    check('signed-in state is read from the cookie on load', reloaded === 'Signed in', `after reload: "${reloaded}"`);

    // --- banner above main -------------------------------------------------------------------
    const bannerRect = await rect(page, 'banner');
    const mainBefore = await rect(page, 'main');
    await page.click('[data-label="banner-dismiss"]');
    const mainAfter = await rect(page, 'main');
    const moved = mainBefore.top - mainAfter.top;
    check(
      'banner sits above main and removing it moves main up by its height',
      bannerRect.bottom <= mainBefore.top && bannerRect.height > 0 && Math.abs(moved - bannerRect.height) < 0.01,
      `banner height ${bannerRect.height}px, main top ${mainBefore.top}px -> ${mainAfter.top}px`,
    );

    // --- /big --------------------------------------------------------------------------------
    // Without StrictMode first: one render pass, so creation order is exactly source order.
    for (const path of ['/big?nostrict', '/big']) {
      await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
      await page.waitForSelector('[data-label="big-footer"]');
      const big = await page.evaluate(inspectLabels);
      const bigLabels = compareWithLabels('/big', big);
      check(
        `${path} renders more than 10,000 host elements and its 3 labels`,
        big.hostElements > 10_000 && bigLabels.problems.length === 0 && bigLabels.expected.length === 3,
        bigLabels.problems.length === 0 ? `${big.hostElements} host elements, ${bigLabels.nodes} labelled nodes` : bigLabels.problems.join('; '),
      );
      const coverage = ownerStackCoverage(bigLabels.expected, big).rows;
      const text = coverage.map((row) => `${row.label} ${row.withStack}/${row.total}`).join(', ');
      if (path === '/big?nostrict') {
        const of = (label) => coverage.find((row) => row.label === label);
        const cells = of('big-cell-name');
        check(
          `${path} crosses React's owner-stack cap (stack kept before it, lost after it)`,
          of('big-title').withStack === 1 && of('big-footer').withStack === 0 && cells.withStack > 0 && cells.withStack < cells.total,
          `instances with an owner stack naming Big.tsx: ${text}`,
        );
      } else {
        info(`${path} (StrictMode) instances with an owner stack naming Big.tsx: ${text}`);
      }
    }

    check('no page errors or console errors', errors.length === 0, errors.length === 0 ? '0 errors' : errors.slice(0, 5).join(' | '));
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------------------------

async function main() {
  const port = await freePort();
  const origin = `http://localhost:${port}`;
  startDevServer(port);
  try {
    const started = Date.now();
    await waitUntilReady(origin);
    check('dev server honours PORT', true, `"pnpm dev" answered on ${origin} after ${Date.now() - started} ms`);

    await httpChecks(origin);

    if (args.has('--http-only')) {
      skip('browser checks', '--http-only');
    } else {
      const playwright = await loadPlaywright();
      if (playwright) await browserChecks(origin, playwright);
      else if (args.has('--require-browser')) check('browser checks', false, '@playwright/test cannot be resolved from this directory');
      else skip('browser checks', '@playwright/test cannot be resolved from this directory');
    }
  } finally {
    await stopDevServer();
  }
  check('dev server stopped', !(await isListening(port)), `port ${port} is free again`);
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    signalGroup('SIGKILL');
    process.exit(1);
  });
}

try {
  await main();
} catch (error) {
  await stopDevServer();
  check('verify ran to completion', false, error instanceof Error ? (error.stack ?? error.message) : String(error));
}

const count = (status) => results.filter((result) => result.status === status).length;
console.log(`\n${count('PASS')} passed, ${count('FAIL')} failed, ${count('SKIP')} skipped`);
process.exit(count('FAIL') === 0 ? 0 : 1);
