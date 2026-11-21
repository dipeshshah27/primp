#!/usr/bin/env node
// Validates the layout-shift corpus against headless Chromium.
//
//   node fixtures/cls-corpus/scripts/validate.mjs            (run from the repo root)
//
// Options
//   --only <text>    only pages whose path contains <text>
//   --loads <n>      consecutive cold loads per page (default 3)
//   --verbose        print every layout-shift entry with its sources
//   --write          record the measured values in each expected.json
//   --fix-lines      rewrite culpritLine / triggerLine from their "...LineContains" snippets
//   --headed         run a visible browser
//
// For every page it opens a fresh browser context (cold cache), installs a plain
// PerformanceObserver({ type: 'layout-shift', buffered: true }) before any page script,
// waits "observeMs", and compares the entries with expected.json:
//
//   positive page: every expected shift is matched by its own entry with hadRecentInput=false,
//                  value >= minValue and every victim selector among entry.sources nodes;
//                  the number of entries equals "entryCount" on every load.
//                  "culpritInSources" says whether the culprit itself is among entry.sources.
//                  Every victim, and every "alsoMoves" element (moved, but possibly left out of
//                  entry.sources by the 5-source cap or by containment), is at least 3px away
//                  from where it was when the HTML had been parsed.
//   negative page: no entries, or only entries with hadRecentInput=true (and at least
//                  "minEntriesWithRecentInput" of those, when the page claims an excused shift).
//   every page:    the "assertAfter" expressions are true at the end (so a page cannot pass
//                  because its late content never arrived), the tab was visible, and the
//                  culprit labels point at real lines and real elements.
//
// Exit code 0 when every page passes, 1 otherwise.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { startServer } from '../server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VIEWPORT = { width: 1280, height: 800 };
const CAUSES = ['unsized-media', 'font-swap', 'injected-content'];
const LINE_KINDS = ['opening-tag', 'script-insert'];

function parseArgs(argv) {
  const args = { only: null, loads: 3, verbose: false, write: false, fixLines: false, headed: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--only') args.only = argv[++i];
    else if (arg === '--loads') args.loads = Number(argv[++i]);
    else if (arg === '--verbose') args.verbose = true;
    else if (arg === '--write') args.write = true;
    else if (arg === '--fix-lines') args.fixLines = true;
    else if (arg === '--headed') args.headed = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(args.loads) || args.loads < 1) throw new Error('--loads needs a positive integer');
  return args;
}

function findExpectedFiles(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findExpectedFiles(full, found);
    else if (entry.name === 'expected.json') found.push(full);
  }
  return found.sort();
}

/** Checks one "<prefix>File / <prefix>Line / <prefix>LineContains" label against the file on disk. */
function checkLineLabel(shift, prefix, problems, fixLines) {
  const file = shift[`${prefix}File`];
  const line = shift[`${prefix}Line`];
  const snippet = shift[`${prefix}LineContains`];
  let lines;
  try {
    lines = readFileSync(path.join(ROOT, file), 'utf8').split('\n');
  } catch {
    problems.push(`${prefix}File "${file}" cannot be read`);
    return false;
  }
  if (typeof snippet !== 'string' || snippet === '') {
    problems.push(`${prefix}LineContains is missing`);
    return false;
  }
  const hits = lines.flatMap((text, index) => (text.includes(snippet) ? [index + 1] : []));
  if (hits.length !== 1) {
    problems.push(`${prefix}LineContains "${snippet}" matches ${hits.length} lines of ${file} (needs exactly 1)`);
    return false;
  }
  if (line !== hits[0]) {
    if (fixLines) {
      shift[`${prefix}Line`] = hits[0];
      return true;
    }
    problems.push(`${prefix}Line is ${line} but "${snippet}" is on line ${hits[0]} of ${file} (run with --fix-lines)`);
  }
  return false;
}

/** Static checks that need no browser. Returns true when --fix-lines changed the object. */
function checkLabels(expected, relDir, problems, fixLines) {
  let changed = false;
  if (expected.page !== `${relDir}/index.html`) problems.push(`"page" should be "${relDir}/index.html"`);
  if (typeof expected.positive !== 'boolean') problems.push('"positive" must be a boolean');
  if (!Array.isArray(expected.shifts)) {
    problems.push('"shifts" must be an array');
    return changed;
  }
  if (expected.positive && expected.shifts.length === 0) problems.push('a positive page needs at least one shift');
  if (!expected.positive && expected.shifts.length !== 0) problems.push('a negative page must have no shifts');
  if (expected.positive && !Number.isInteger(expected.entryCount)) problems.push('"entryCount" must be an integer');
  for (const shift of expected.shifts) {
    if (!CAUSES.includes(shift.cause)) problems.push(`unknown cause "${shift.cause}"`);
    if (!LINE_KINDS.includes(shift.culpritLineKind)) problems.push(`unknown culpritLineKind "${shift.culpritLineKind}"`);
    if (!(shift.minValue > 0)) problems.push('"minValue" must be a positive number');
    if (typeof shift.culpritInSources !== 'boolean') problems.push('"culpritInSources" must be a boolean');
    if (!Array.isArray(shift.victimSelectors) || shift.victimSelectors.length === 0) {
      problems.push('"victimSelectors" must list at least one selector');
    }
    if (shift.alsoMoves !== undefined && !(Array.isArray(shift.alsoMoves) && shift.alsoMoves.every((s) => typeof s === 'string'))) {
      problems.push('"alsoMoves" must be a list of selectors');
    }
    changed = checkLineLabel(shift, 'culprit', problems, fixLines) || changed;
    if (shift.triggerFile !== undefined) changed = checkLineLabel(shift, 'trigger', problems, fixLines) || changed;
  }
  return changed;
}

// Runs in the page before any page script. Kept as a string so it is injected verbatim.
const OBSERVER_SCRIPT = `(() => {
  const entries = [];
  const describe = (node) => {
    if (!node) return null;
    const el = node.nodeType === 1 ? node : node.parentElement;
    let label = el ? el.tagName.toLowerCase() : '?';
    if (el && el.id) label += '#' + el.id;
    else if (el && typeof el.className === 'string' && el.className) label += '.' + el.className.trim().split(/\\s+/).join('.');
    return node.nodeType === 1 ? label : '#text in ' + label;
  };
  const rect = (r) => ({ x: r.x, y: r.y, width: r.width, height: r.height });
  const record = (list) => {
    for (const entry of list) {
      entries.push({
        value: entry.value,
        startTime: entry.startTime,
        hadRecentInput: entry.hadRecentInput,
        lastInputTime: entry.lastInputTime,
        sources: entry.sources.map((source) => ({
          node: source.node,
          nodeType: source.node ? source.node.nodeType : null,
          label: describe(source.node),
          previousRect: rect(source.previousRect),
          currentRect: rect(source.currentRect),
        })),
      });
    }
  };
  const observer = new PerformanceObserver((list) => record(list.getEntries()));
  observer.observe({ type: 'layout-shift', buffered: true });
  // Where every element was when the HTML had been parsed, long before any late resource. This is
  // an independent check that labelled victims really move; it does not use the layout-shift API.
  const initial = new Map();
  document.addEventListener('DOMContentLoaded', () => {
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      initial.set(el, { x: r.x, y: r.y });
    }
  }, { once: true });
  window.__clsCorpus = {
    visibilityAtStart: document.visibilityState,
    displacement(selectors) {
      return selectors.map((selector) => {
        const el = document.querySelector(selector);
        const before = el ? initial.get(el) : undefined;
        if (!before) return { selector, known: false };
        const r = el.getBoundingClientRect();
        return { selector, known: true, dx: r.x - before.x, dy: r.y - before.y };
      });
    },
    collect(selectors) {
      record(observer.takeRecords());
      return entries.map((entry) => ({
        value: entry.value,
        startTime: entry.startTime,
        hadRecentInput: entry.hadRecentInput,
        lastInputTime: entry.lastInputTime,
        sources: entry.sources.map((source) => ({
          nodeType: source.nodeType,
          label: source.label,
          connected: source.node ? source.node.isConnected : false,
          previousRect: source.previousRect,
          currentRect: source.currentRect,
          matches: selectors.filter((selector) => source.node && source.node.nodeType === 1 && source.node.matches(selector)),
        })),
      }));
    },
  };
})();`;

async function loadOnce(browser, baseUrl, expected) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  try {
    await context.addInitScript({ content: OBSERVER_SCRIPT });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    await page.goto(`${baseUrl}/${expected.page}`, { waitUntil: 'commit' });
    const observeMs = expected.observeMs ?? 2500;
    const started = Date.now();
    for (const step of expected.interactions ?? []) {
      await page.waitForTimeout(step.afterMs ?? 0);
      // A real, trusted mouse click: this is what sets hadRecentInput on following shifts.
      if (step.click) await page.click(step.click);
    }
    await page.waitForTimeout(Math.max(0, observeMs - (Date.now() - started)));

    const selectors = [...new Set(expected.shifts.flatMap((shift) => [...shift.victimSelectors, shift.culpritSelector]))];
    const movers = [...new Set(expected.shifts.flatMap((shift) => [...shift.victimSelectors, ...(shift.alsoMoves ?? [])]))];
    const result = await page.evaluate(
      ({ selectors, movers, assertions, culprits }) => ({
        entries: window.__clsCorpus.collect(selectors),
        displacements: window.__clsCorpus.displacement(movers),
        visibilityAtStart: window.__clsCorpus.visibilityAtStart,
        visibilityAtEnd: document.visibilityState,
        assertions: assertions.map((expression) => {
          try {
            return { expression, ok: (0, eval)(expression) === true };
          } catch (error) {
            return { expression, ok: false, error: String(error) };
          }
        }),
        culpritCounts: culprits.map((selector) => document.querySelectorAll(selector).length),
        innerSize: { width: window.innerWidth, height: window.innerHeight },
      }),
      {
        selectors,
        movers,
        assertions: expected.assertAfter ?? [],
        culprits: expected.shifts.map((shift) => shift.culpritSelector),
      },
    );

    // Shifts inside subframes are reported on the subframe's own timeline, never on the parent's.
    let subframeEntries = 0;
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      subframeEntries += await frame
        .evaluate(() => (window.__clsCorpus ? window.__clsCorpus.collect([]).length : 0))
        .catch(() => 0);
    }
    return { ...result, subframeEntries, pageErrors };
  } finally {
    await context.close();
  }
}

/** Gives each expected shift its own entry. Returns the matched entry (or null) per shift. */
function matchShifts(expected, entries) {
  const candidates = entries.filter((entry) => !entry.hadRecentInput);
  const used = new Set();
  return expected.shifts.map((shift) => {
    const index = candidates.findIndex(
      (entry, i) =>
        !used.has(i) &&
        entry.value >= shift.minValue &&
        shift.victimSelectors.every((selector) => entry.sources.some((source) => source.matches.includes(selector))),
    );
    if (index === -1) return null;
    used.add(index);
    return candidates[index];
  });
}

function judgeLoad(expected, load) {
  const problems = [];
  if (load.visibilityAtStart !== 'visible' || load.visibilityAtEnd !== 'visible') {
    problems.push(`tab was not visible (${load.visibilityAtStart} -> ${load.visibilityAtEnd}); measurement is void`);
  }
  if (load.innerSize.width !== VIEWPORT.width || load.innerSize.height !== VIEWPORT.height) {
    problems.push(`viewport is ${load.innerSize.width}x${load.innerSize.height}`);
  }
  for (const error of load.pageErrors) problems.push(`page error: ${error}`);
  for (const assertion of load.assertions) {
    if (!assertion.ok) problems.push(`assertAfter failed: ${assertion.expression}${assertion.error ? ` (${assertion.error})` : ''}`);
  }
  const counted = load.entries.filter((entry) => !entry.hadRecentInput);
  let matched = [];
  if (expected.positive) {
    matched = matchShifts(expected, load.entries);
    matched.forEach((entry, i) => {
      const shift = expected.shifts[i];
      if (!entry) {
        problems.push(
          `no entry for shift ${i + 1} (${shift.cause}): needs value >= ${shift.minValue} and sources ${shift.victimSelectors.join(', ')}`,
        );
        return;
      }
      // Whether the browser lists the culprit itself among the moved nodes is part of the label:
      // the attribution engine must not assume that it does.
      const culpritInSources = entry.sources.some((source) => source.matches.includes(shift.culpritSelector));
      if (culpritInSources !== shift.culpritInSources) {
        problems.push(`shift ${i + 1}: culprit ${shift.culpritSelector} ${culpritInSources ? 'is' : 'is not'} among entry.sources, expected.json says culpritInSources ${shift.culpritInSources}`);
      }
    });
    for (const moved of load.displacements) {
      if (!moved.known) problems.push(`${moved.selector} (victim or alsoMoves) was not in the document when the HTML had been parsed`);
      else if (Math.abs(moved.dx) < 3 && Math.abs(moved.dy) < 3) {
        problems.push(`${moved.selector} (victim or alsoMoves) did not move: dx=${moved.dx.toFixed(1)} dy=${moved.dy.toFixed(1)}`);
      }
    }
    if (counted.length !== expected.entryCount) {
      problems.push(`${counted.length} entries without recent input, expected.json says entryCount ${expected.entryCount}`);
    }
    load.culpritCounts.forEach((count, i) => {
      if (count !== 1) problems.push(`culpritSelector "${expected.shifts[i].culpritSelector}" matches ${count} elements at the end of the load`);
    });
  } else {
    if (counted.length > 0) {
      problems.push(`${counted.length} entries without recent input on a negative page (values ${counted.map((e) => e.value.toFixed(4)).join(', ')})`);
    }
    // A page that claims "the shift is excused by user input" must actually produce that entry.
    const withInput = load.entries.length - counted.length;
    const minWithInput = expected.minEntriesWithRecentInput ?? 0;
    if (withInput < minWithInput) {
      problems.push(`${withInput} entries with hadRecentInput=true, expected.json says at least ${minWithInput}`);
    }
  }
  return { problems, matched, counted };
}

const round = (value) => Math.round(value * 1e6) / 1e6;
const roundRect = (r) => ({ x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height) });
const fmtRect = (r) => `[${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}]`;

function printEntries(load, loadIndex) {
  console.log(`    load ${loadIndex + 1}: ${load.entries.length} entries, ${load.subframeEntries} in subframes`);
  for (const entry of load.entries) {
    console.log(
      `      value=${entry.value.toFixed(6)} t=${entry.startTime.toFixed(0)}ms hadRecentInput=${entry.hadRecentInput} sources=${entry.sources.length}`,
    );
    for (const source of entry.sources) {
      console.log(`        ${source.label ?? '(null node)'}  ${fmtRect(source.previousRect)} -> ${fmtRect(source.currentRect)}`);
    }
  }
}

function pad(text, width) {
  text = String(text);
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = findExpectedFiles(ROOT).filter((file) => !args.only || file.includes(args.only));
  if (files.length === 0) throw new Error('no expected.json files found');

  const server = await startServer({ port: 0 });
  let browser;
  const rows = [];
  let failed = 0;
  // An interrupted run must not leave Chromium or the server behind.
  const abort = () => {
    Promise.resolve(browser?.close())
      .catch(() => {})
      .then(() => server.close())
      .finally(() => process.exit(1));
  };
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    browser = await chromium.launch({ headless: !args.headed });
    const browserVersion = browser.version();
    console.log(`cls-corpus validation: Chromium ${browserVersion}, viewport ${VIEWPORT.width}x${VIEWPORT.height}, ${args.loads} cold loads per page`);
    console.log(`server ${server.url}\n`);

    for (const file of files) {
      const relDir = path.relative(ROOT, path.dirname(file)).split(path.sep).join('/');
      const expected = JSON.parse(readFileSync(file, 'utf8'));
      const problems = [];
      let changed = checkLabels(expected, relDir, problems, args.fixLines);

      const loads = [];
      if (problems.length === 0) {
        for (let i = 0; i < args.loads; i++) {
          const load = await loadOnce(browser, server.url, expected);
          const judged = judgeLoad(expected, load);
          loads.push({ load, ...judged });
          for (const problem of judged.problems) problems.push(`load ${i + 1}: ${problem}`);
        }
      }

      const ok = problems.length === 0;
      if (!ok) failed++;
      const perLoad = loads.map(({ counted, load }) => {
        const total = counted.reduce((sum, entry) => sum + entry.value, 0);
        const withInput = load.entries.length - counted.length;
        return `${counted.length}:${total.toFixed(4)}${withInput ? `(+${withInput} input)` : ''}`;
      });
      rows.push({
        page: relDir,
        kind: expected.positive ? expected.shifts.map((shift) => shift.cause).join(' + ') : 'negative',
        min: expected.positive ? expected.shifts.map((shift) => shift.minValue).join(' / ') : '-',
        perLoad: perLoad.join('  '),
        result: ok ? 'PASS' : 'FAIL',
      });

      if (args.verbose || !ok) {
        console.log(`${ok ? 'PASS' : 'FAIL'} ${relDir}`);
        for (const problem of problems) console.log(`    ! ${problem}`);
        loads.forEach(({ load }, i) => printEntries(load, i));
      }

      if (args.write && ok) {
        expected.shifts.forEach((shift, i) => {
          shift.measuredValues = loads.map(({ matched }) => round(matched[i].value));
          // The sources of the first load, as the browser reported them (viewport CSS pixels).
          shift.measuredSources = loads[0].matched[i].sources.map((source) => ({
            node: source.label,
            previousRect: roundRect(source.previousRect),
            currentRect: roundRect(source.currentRect),
          }));
        });
        expected.measured = {
          browser: `Chromium ${browserVersion} (headless)`,
          platform: `${os.platform()} ${os.arch()}`,
          viewport: `${VIEWPORT.width}x${VIEWPORT.height}`,
          entriesPerLoad: loads.map(({ load, counted }) => ({
            withoutRecentInput: counted.length,
            withRecentInput: load.entries.length - counted.length,
            sumWithoutRecentInput: round(counted.reduce((sum, entry) => sum + entry.value, 0)),
          })),
        };
        changed = true;
      }
      if (changed && (ok || args.fixLines)) writeFileSync(file, JSON.stringify(expected, null, 2) + '\n');
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    await server.close();
  }

  const widths = {
    page: Math.max(4, ...rows.map((row) => row.page.length)),
    kind: Math.max(5, ...rows.map((row) => row.kind.length)),
    min: Math.max(8, ...rows.map((row) => row.min.length)),
    perLoad: Math.max(10, ...rows.map((row) => row.perLoad.length)),
  };
  console.log('');
  console.log(
    `${pad('page', widths.page)}  ${pad('cause', widths.kind)}  ${pad('minValue', widths.min)}  ${pad('entries:sum per load', widths.perLoad)}  result`,
  );
  console.log(`${'-'.repeat(widths.page)}  ${'-'.repeat(widths.kind)}  ${'-'.repeat(widths.min)}  ${'-'.repeat(widths.perLoad)}  ------`);
  for (const row of rows) {
    console.log(`${pad(row.page, widths.page)}  ${pad(row.kind, widths.kind)}  ${pad(row.min, widths.min)}  ${pad(row.perLoad, widths.perLoad)}  ${row.result}`);
  }
  console.log(`\n${rows.length - failed}/${rows.length} pages pass`);
  return failed === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
