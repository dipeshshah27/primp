#!/usr/bin/env node
// Validates the held-out layout-shift pages against headless Chromium.
//
//   node fixtures/cls-heldout/scripts/validate.mjs            (run from the repo root)
//
// Options
//   --only <text>    only pages whose folder name contains <text>
//   --loads <n>      consecutive cold loads per page (default 3)
//   --verbose        print every layout-shift entry with its sources
//   --write          record measuredValues / entryCount / measured in each expected.json
//   --fix-lines      rewrite culpritLine (and acceptableCulpritLines[].line) from their "contains" snippets
//   --observe-ms <n> collect entries for <n> ms instead of 3000, to check that nothing else moves
//                    later (cannot be combined with --write)
//
// The browser is always headless. For every page and every load it opens a fresh browser context
// (cold cache) at 1280x800, installs a plain
//   new PerformanceObserver(...).observe({ type: 'layout-shift', buffered: true })
// before any page script, performs the page's interaction (if "interaction" is not null: a real mouse
// click on interaction.selector, interaction.afterMs after the load event), collects entries for
// "observeMs" (3000 ms unless expected.json says otherwise) and compares them with expected.json:
//
//   positive page: the entries without recent input sum to >= minValue on every load, their number
//                  is the same on every load, one entry carries at least 80% of the sum (the page
//                  has ONE dominant shift), at least one victim selector matches a node in the
//                  entries' sources, and every victim selector is >= 3px away from where it was at
//                  DOMContentLoaded (a check that does not use the layout-shift API).
//   negative page: no entries, or only entries with hadRecentInput = true (and at least
//                  "minEntriesWithRecentInput" of those when the page claims an excused shift).
//   every page:    culpritSelector and every acceptableCulpritSelector match exactly one element at
//                  the end of the load, every decoy selector matches at least one element and none
//                  of them is the culprit, an acceptable culprit, or inside/around the culprit, the "assertAfter" expressions are true (so a page cannot
//                  pass because its late content never arrived), no request failed, no page error,
//                  the tab was visible, and culpritLine points at the line that really holds the
//                  culprit's opening tag (tag name and id are compared with the live element) or
//                  the inserting statement inside an inline <script>.
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
const DEFAULT_OBSERVE_MS = 3000;
const DOMINANT_SHARE = 0.8;
// A "script-insert" line has to contain one of the DOM calls that put content into the page.
const INSERT_CALL =
  /\b(innerHTML|outerHTML|insertAdjacentHTML|insertAdjacentElement|appendChild|insertBefore|replaceChildren|replaceWith|append|prepend|before|after)\b/;

function parseArgs(argv) {
  const args = { only: null, loads: 3, verbose: false, write: false, fixLines: false, observeMs: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--only') args.only = argv[++i];
    else if (arg === '--loads') args.loads = Number(argv[++i]);
    else if (arg === '--verbose') args.verbose = true;
    else if (arg === '--write') args.write = true;
    else if (arg === '--fix-lines') args.fixLines = true;
    else if (arg === '--observe-ms') args.observeMs = Number(argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(args.loads) || args.loads < 1) throw new Error('--loads needs a positive integer');
  if (args.observeMs !== null && !(args.observeMs >= 1000)) throw new Error('--observe-ms needs a number of at least 1000');
  if (args.observeMs !== null && args.write) throw new Error('--observe-ms cannot be combined with --write (measuredValues are 3000 ms values)');
  return args;
}

function findExpectedFiles() {
  const found = [];
  for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || ['assets', 'scripts', 'node_modules'].includes(entry.name)) continue;
    try {
      readFileSync(path.join(ROOT, entry.name, 'expected.json'));
      found.push(path.join(ROOT, entry.name, 'expected.json'));
    } catch {
      // a folder without expected.json is not a page
    }
  }
  return found.sort();
}

/** Line numbers (1-based) that are inside an inline <script> element of an HTML file. */
function inlineScriptLines(lines) {
  const inside = new Set();
  let open = false;
  lines.forEach((text, index) => {
    const opens = /<script(?![^>]*\bsrc=)[^>]*>/i.test(text);
    const closes = /<\/script>/i.test(text);
    if (open || opens) inside.add(index + 1);
    if (opens && !closes) open = true;
    else if (closes) open = false;
  });
  return inside;
}

/**
 * Finds the one line of `file` that contains `snippet` and compares it with `label.line`.
 * Returns { line, text, changed } or null when the label is unusable.
 */
function locateLine(file, label, lineKey, snippetKey, what, problems, fixLines) {
  let lines;
  try {
    lines = readFileSync(path.join(ROOT, file), 'utf8').split('\n');
  } catch {
    problems.push(`${what}: file "${file}" cannot be read`);
    return null;
  }
  const snippet = label[snippetKey];
  if (typeof snippet !== 'string' || snippet.trim() === '') {
    problems.push(`${what}: "${snippetKey}" is missing`);
    return null;
  }
  const hits = lines.flatMap((text, index) => (text.includes(snippet) ? [index + 1] : []));
  if (hits.length !== 1) {
    problems.push(`${what}: "${snippet}" matches ${hits.length} lines of ${file} (needs exactly 1)`);
    return null;
  }
  let changed = false;
  if (label[lineKey] !== hits[0]) {
    if (fixLines) {
      label[lineKey] = hits[0];
      changed = true;
    } else {
      problems.push(`${what}: ${lineKey} is ${label[lineKey]} but "${snippet}" is on line ${hits[0]} of ${file} (run with --fix-lines)`);
    }
  }
  return { line: hits[0], text: lines[hits[0] - 1], changed, scriptLines: inlineScriptLines(lines) };
}

/** Static checks that need no browser. Returns { changed, located } (located: per shift, the culprit line). */
function checkLabels(expected, relDir, problems, fixLines) {
  let changed = false;
  const located = [];
  if (expected.page !== `${relDir}/index.html`) problems.push(`"page" should be "${relDir}/index.html"`);
  if (typeof expected.template !== 'string' || expected.template === '') problems.push('"template" is missing');
  if (typeof expected.positive !== 'boolean') problems.push('"positive" must be a boolean');
  if (typeof expected.notes !== 'string' || expected.notes === '') problems.push('"notes" is missing');
  if (!Array.isArray(expected.decoys) || expected.decoys.length === 0) problems.push('"decoys" must list at least one selector');
  if (!Array.isArray(expected.shifts)) {
    problems.push('"shifts" must be an array');
    return { changed, located };
  }
  if (expected.positive && expected.shifts.length !== 1) problems.push('a positive page has exactly one dominant shift');
  if (!expected.positive && expected.shifts.length !== 0) problems.push('a negative page must have no shifts');
  const interaction = expected.interaction;
  if (interaction === undefined) problems.push('"interaction" must be present (null or { selector, afterMs })');
  else if (interaction !== null) {
    const keys = typeof interaction === 'object' ? Object.keys(interaction).sort().join(',') : '';
    if (keys !== 'afterMs,selector' || typeof interaction.selector !== 'string' || interaction.selector === '' || !(interaction.afterMs >= 0)) {
      problems.push('"interaction" must be null or exactly { "selector": "<css selector>", "afterMs": <milliseconds after the load event> }');
    }
  }
  for (const shift of expected.shifts) {
    if (!CAUSES.includes(shift.cause)) problems.push(`unknown cause "${shift.cause}"`);
    if (!LINE_KINDS.includes(shift.culpritLineKind)) problems.push(`unknown culpritLineKind "${shift.culpritLineKind}"`);
    if (!(shift.minValue > 0)) problems.push('"minValue" must be a positive number');
    if (shift.culpritFile !== expected.page) problems.push(`"culpritFile" should be "${expected.page}"`);
    if (typeof shift.culpritSelector !== 'string' || shift.culpritSelector === '') problems.push('"culpritSelector" is missing');
    if (!Array.isArray(shift.acceptableCulpritSelectors)) problems.push('"acceptableCulpritSelectors" must be an array');
    if (!Array.isArray(shift.victimSelectors) || shift.victimSelectors.length === 0) {
      problems.push('"victimSelectors" must list at least one selector');
    }
    const main = locateLine(shift.culpritFile, shift, 'culpritLine', 'culpritLineContains', 'culprit line', problems, fixLines);
    if (main) {
      changed = main.changed || changed;
      if (shift.culpritLineKind === 'opening-tag' && !/<[a-zA-Z][\w-]*[\s>]/.test(main.text)) {
        problems.push(`culprit line ${main.line} holds no opening tag`);
      }
      if (shift.culpritLineKind === 'script-insert') {
        if (!main.scriptLines.has(main.line)) problems.push(`culprit line ${main.line} is not inside an inline <script>`);
        if (!INSERT_CALL.test(main.text)) problems.push(`culprit line ${main.line} holds no DOM insertion call`);
      }
    }
    located.push(main);
    for (const [i, alt] of (shift.acceptableCulpritLines ?? []).entries()) {
      if (typeof alt.kind !== 'string' || alt.kind === '') problems.push(`acceptableCulpritLines[${i}]: "kind" is missing`);
      const found = locateLine(shift.culpritFile, alt, 'line', 'contains', `acceptableCulpritLines[${i}]`, problems, fixLines);
      if (found) changed = found.changed || changed;
    }
  }
  return { changed, located };
}

// Runs in the page before any page script. Kept as a string so it is injected verbatim.
const OBSERVER_SCRIPT = `(() => {
  const entries = [];
  const describe = (node) => {
    if (!node) return null;
    const el = node.nodeType === 1 ? node : node.parentElement;
    let label = el ? el.tagName.toLowerCase() : '?';
    if (el && el.id) label += '#' + el.id;
    else if (el && typeof el.className === 'string' && el.className.trim()) label += '.' + el.className.trim().split(/\\s+/).join('.');
    return node.nodeType === 1 ? label : '#text in ' + label;
  };
  const rect = (r) => ({ x: r.x, y: r.y, width: r.width, height: r.height });
  const record = (list) => {
    for (const entry of list) {
      entries.push({
        value: entry.value,
        startTime: entry.startTime,
        hadRecentInput: entry.hadRecentInput,
        sources: entry.sources.map((source) => ({
          node: source.node,
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
  window.__clsHeldout = {
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
        sources: entry.sources.map((source) => ({
          nodeType: source.node ? source.node.nodeType : null,
          label: source.label,
          previousRect: source.previousRect,
          currentRect: source.currentRect,
          matches: selectors.filter((selector) => source.node && source.node.nodeType === 1 && source.node.matches(selector)),
        })),
      }));
    },
  };
})();`;

async function loadOnce(browser, baseUrl, expected, observeOverrideMs) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  try {
    await context.addInitScript({ content: OBSERVER_SCRIPT });
    const page = await context.newPage();
    const pageErrors = [];
    const badResponses = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    page.on('response', (response) => {
      if (response.status() >= 400) badResponses.push(`${response.status()} ${new URL(response.url()).pathname}`);
    });
    page.on('requestfailed', (request) => badResponses.push(`failed ${new URL(request.url()).pathname}`));
    await page.goto(`${baseUrl}/${expected.page}`, { waitUntil: 'commit' });
    const observeMs = observeOverrideMs ?? expected.observeMs ?? DEFAULT_OBSERVE_MS;
    const started = Date.now();
    if (expected.interaction) {
      // "afterMs" counts from the window's load event.
      await page.waitForLoadState('load');
      await page.waitForTimeout(expected.interaction.afterMs);
      // A real, trusted mouse click: this is what sets hadRecentInput on the shifts that follow.
      await page.click(expected.interaction.selector);
    }
    await page.waitForTimeout(Math.max(0, observeMs - (Date.now() - started)));

    const shift = expected.shifts[0];
    const victims = shift ? shift.victimSelectors : [];
    const singles = shift ? [shift.culpritSelector, ...shift.acceptableCulpritSelectors] : [];
    const result = await page.evaluate(
      ({ victims, singles, decoys, assertions }) => {
        const count = (selector) => {
          try {
            return document.querySelectorAll(selector).length;
          } catch {
            return -1;
          }
        };
        const culprit = singles.length ? document.querySelector(singles[0]) : null;
        const accepted = singles.slice(1).map((selector) => document.querySelector(selector)).filter(Boolean);
        return {
          entries: window.__clsHeldout.collect(victims),
          displacements: window.__clsHeldout.displacement(victims),
          visibilityAtStart: window.__clsHeldout.visibilityAtStart,
          visibilityAtEnd: document.visibilityState,
          singleCounts: singles.map(count),
          decoyCounts: decoys.map(count),
          decoysThatAreTheCulprit: decoys.filter((selector) => {
            try {
              if (culprit === null) return false;
              return Array.from(document.querySelectorAll(selector)).some(
                (el) => el === culprit || culprit.contains(el) || el.contains(culprit) || accepted.includes(el),
              );
            } catch {
              return false;
            }
          }),
          culprit: culprit ? { tag: culprit.tagName.toLowerCase(), id: culprit.id } : null,
          assertions: assertions.map((expression) => {
            try {
              return { expression, ok: (0, eval)(expression) === true };
            } catch (error) {
              return { expression, ok: false, error: String(error) };
            }
          }),
          innerSize: { width: window.innerWidth, height: window.innerHeight },
        };
      },
      { victims, singles, decoys: expected.decoys, assertions: expected.assertAfter ?? [] },
    );

    // Shifts inside subframes are reported on the subframe's own timeline, never on the parent's.
    let subframeEntries = 0;
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      subframeEntries += await frame
        .evaluate(() => (window.__clsHeldout ? window.__clsHeldout.collect([]).length : 0))
        .catch(() => 0);
    }
    return { ...result, singles, subframeEntries, pageErrors, badResponses };
  } finally {
    await context.close();
  }
}

function judgeLoad(expected, load, located) {
  const problems = [];
  if (load.visibilityAtStart !== 'visible' || load.visibilityAtEnd !== 'visible') {
    problems.push(`tab was not visible (${load.visibilityAtStart} -> ${load.visibilityAtEnd}); measurement is void`);
  }
  if (load.innerSize.width !== VIEWPORT.width || load.innerSize.height !== VIEWPORT.height) {
    problems.push(`viewport is ${load.innerSize.width}x${load.innerSize.height}`);
  }
  for (const error of load.pageErrors) problems.push(`page error: ${error}`);
  for (const bad of load.badResponses) problems.push(`request problem: ${bad}`);
  for (const assertion of load.assertions) {
    if (!assertion.ok) problems.push(`assertAfter failed: ${assertion.expression}${assertion.error ? ` (${assertion.error})` : ''}`);
  }
  expected.decoys.forEach((selector, i) => {
    if (load.decoyCounts[i] < 1) problems.push(`decoy selector "${selector}" matches ${load.decoyCounts[i] === -1 ? 'nothing (invalid selector)' : 'no element'}`);
  });
  for (const selector of load.decoysThatAreTheCulprit) {
    problems.push(`decoy selector "${selector}" matches the culprit, an acceptable culprit, or an element inside or around the culprit`);
  }

  const counted = load.entries.filter((entry) => !entry.hadRecentInput);
  const sum = counted.reduce((total, entry) => total + entry.value, 0);
  if (expected.positive) {
    const shift = expected.shifts[0];
    load.singles.forEach((selector, i) => {
      if (load.singleCounts[i] !== 1) {
        problems.push(`${i === 0 ? 'culpritSelector' : 'acceptableCulpritSelector'} "${selector}" matches ${load.singleCounts[i]} elements at the end of the load (needs exactly 1)`);
      }
    });
    if (counted.length === 0) problems.push('no layout-shift entries without recent input');
    if (sum < shift.minValue) problems.push(`entries sum to ${sum.toFixed(6)}, below minValue ${shift.minValue}`);
    const largest = Math.max(0, ...counted.map((entry) => entry.value));
    if (sum > 0 && largest / sum < DOMINANT_SHARE) {
      problems.push(`no single dominant shift: the largest entry is ${largest.toFixed(6)} of ${sum.toFixed(6)}`);
    }
    const victimsInSources = shift.victimSelectors.filter((selector) =>
      counted.some((entry) => entry.sources.some((source) => source.matches.includes(selector))),
    );
    if (victimsInSources.length === 0) problems.push(`none of the victim selectors is among the entries' source nodes`);
    for (const moved of load.displacements) {
      if (!moved.known) problems.push(`victim ${moved.selector} was not in the document when the HTML had been parsed`);
      else if (Math.abs(moved.dx) < 3 && Math.abs(moved.dy) < 3) {
        problems.push(`victim ${moved.selector} did not move: dx=${moved.dx.toFixed(1)} dy=${moved.dy.toFixed(1)}`);
      }
    }
    // The line label must hold the element the selector resolves to.
    const line = located[0];
    if (line && load.culprit && shift.culpritLineKind === 'opening-tag') {
      if (!new RegExp(`<${load.culprit.tag}[\\s>]`, 'i').test(line.text)) {
        problems.push(`culprit line ${line.line} has no <${load.culprit.tag}> opening tag, but culpritSelector resolves to a <${load.culprit.tag}>`);
      }
      if (load.culprit.id && !line.text.includes(`id="${load.culprit.id}"`)) {
        problems.push(`culprit line ${line.line} does not carry id="${load.culprit.id}"`);
      }
    }
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
  return { problems, counted, sum };
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
      const victim = source.matches.length ? `  <- victim ${source.matches.join(', ')}` : '';
      console.log(`        ${source.label ?? '(null node)'}  ${fmtRect(source.previousRect)} -> ${fmtRect(source.currentRect)}${victim}`);
    }
  }
  if (load.displacements.length) {
    console.log(`      moved since DOMContentLoaded: ${load.displacements.map((d) => `${d.selector} ${d.known ? `dx=${d.dx.toFixed(0)} dy=${d.dy.toFixed(0)}` : 'unknown'}`).join('; ')}`);
  }
}

function pad(text, width) {
  text = String(text);
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const allFiles = findExpectedFiles();
  const files = allFiles.filter((file) => !args.only || path.basename(path.dirname(file)).includes(args.only));
  if (files.length === 0) throw new Error('no expected.json files found');

  let indexHtml = '';
  try {
    indexHtml = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  } catch {
    // reported per page below
  }

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
    browser = await chromium.launch({ headless: true });
    const browserVersion = browser.version();
    console.log(`cls-heldout validation: Chromium ${browserVersion} (headless), viewport ${VIEWPORT.width}x${VIEWPORT.height}, ${args.loads} cold loads per page`);
    console.log(`server ${server.url}\n`);

    for (const file of files) {
      const relDir = path.basename(path.dirname(file));
      const expected = JSON.parse(readFileSync(file, 'utf8'));
      const problems = [];
      const labels = checkLabels(expected, relDir, problems, args.fixLines);
      let changed = labels.changed;
      if (!indexHtml.includes(`href="${relDir}/"`)) problems.push(`index.html has no link to "${relDir}/"`);

      const loads = [];
      if (problems.length === 0) {
        for (let i = 0; i < args.loads; i++) {
          const load = await loadOnce(browser, server.url, expected, args.observeMs);
          const judged = judgeLoad(expected, load, labels.located);
          loads.push({ load, ...judged });
          for (const problem of judged.problems) problems.push(`load ${i + 1}: ${problem}`);
        }
        const counts = new Set(loads.map(({ counted }) => counted.length));
        if (expected.positive && counts.size !== 1) {
          problems.push(`entry count differs between loads: ${loads.map(({ counted }) => counted.length).join(', ')}`);
        }
      }

      const ok = problems.length === 0;
      if (!ok) failed++;
      const perLoad = loads.map(({ counted, load, sum }) => {
        const withInput = load.entries.length - counted.length;
        return `${counted.length}:${sum.toFixed(4)}${withInput ? `(+${withInput} input)` : ''}`;
      });
      rows.push({
        page: relDir,
        template: expected.template ?? '?',
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
        expected.measuredValues = loads.map(({ sum }) => round(sum));
        expected.measured = {
          browser: `Chromium ${browserVersion} (headless)`,
          platform: `${os.platform()} ${os.arch()}`,
          viewport: `${VIEWPORT.width}x${VIEWPORT.height}`,
          entriesPerLoad: loads.map(({ load, counted }) => ({
            withoutRecentInput: counted.length,
            withRecentInput: load.entries.length - counted.length,
          })),
        };
        if (expected.positive) {
          // The largest entry of the first load, as the browser reported it (viewport CSS pixels).
          const dominant = [...loads[0].counted].sort((a, b) => b.value - a.value)[0];
          expected.measured.dominantEntry = {
            value: round(dominant.value),
            startTimeMs: Math.round(dominant.startTime),
            sources: dominant.sources.map((source) => ({
              node: source.label,
              previousRect: roundRect(source.previousRect),
              currentRect: roundRect(source.currentRect),
            })),
          };
        }
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
    template: Math.max(8, ...rows.map((row) => row.template.length)),
    kind: Math.max(5, ...rows.map((row) => row.kind.length)),
    min: Math.max(8, ...rows.map((row) => row.min.length)),
    perLoad: Math.max(20, ...rows.map((row) => row.perLoad.length)),
  };
  console.log('');
  console.log(
    `${pad('page', widths.page)}  ${pad('template', widths.template)}  ${pad('cause', widths.kind)}  ${pad('minValue', widths.min)}  ${pad('entries:sum per load', widths.perLoad)}  result`,
  );
  console.log(
    `${'-'.repeat(widths.page)}  ${'-'.repeat(widths.template)}  ${'-'.repeat(widths.kind)}  ${'-'.repeat(widths.min)}  ${'-'.repeat(widths.perLoad)}  ------`,
  );
  for (const row of rows) {
    console.log(
      `${pad(row.page, widths.page)}  ${pad(row.template, widths.template)}  ${pad(row.kind, widths.kind)}  ${pad(row.min, widths.min)}  ${pad(row.perLoad, widths.perLoad)}  ${row.result}`,
    );
  }
  const positives = rows.filter((row) => row.kind !== 'negative').length;
  console.log(`\n${rows.length - failed}/${rows.length} pages pass (${positives} positive, ${rows.length - positives} negative)`);
  return failed === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
