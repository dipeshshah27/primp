#!/usr/bin/env node
// Micro-experiments on the Layout Instability API in headless Chromium.
//
//   node fixtures/cls-corpus/scripts/probe.mjs            (run from the repo root)
//   node fixtures/cls-corpus/scripts/probe.mjs --only cap
//
// Every statement in the "How the Layout Instability API behaves" section of the README is
// backed by one probe here. A probe builds a tiny page, lets it paint, runs one mutation and
// prints the layout-shift entries it observed. Each probe also asserts the behaviour that the
// README documents, so a Chromium release that changes it makes this script exit 1.
//
// Exit code 0 when every probe observed the documented behaviour, 1 otherwise.

import { chromium } from '@playwright/test';
import { startServer } from '../server.mjs';

const VIEWPORT = { width: 1280, height: 800 };

const OBSERVER_SCRIPT = `(() => {
  const raw = [];
  const seen = [];
  const rect = (r) => ({ x: r.x, y: r.y, width: r.width, height: r.height });
  const describe = (node) => {
    if (!node) return null;
    if (node.nodeType === 3) return '#text(' + node.data.trim().slice(0, 16) + ')';
    return node.nodeName.toLowerCase() + (node.id ? '#' + node.id : '');
  };
  const record = (list) => {
    for (const entry of list) {
      raw.push(entry);
      seen.push({
        value: entry.value,
        startTime: entry.startTime,
        hadRecentInput: entry.hadRecentInput,
        sources: entry.sources.map((s) => ({ node: describe(s.node), nodeType: s.node ? s.node.nodeType : null, prev: rect(s.previousRect), cur: rect(s.currentRect) })),
      });
    }
  };
  const observer = new PerformanceObserver((list) => record(list.getEntries()));
  observer.observe({ type: 'layout-shift', buffered: true });
  window.__probe = {
    collect() { record(observer.takeRecords()); return seen; },
    // Reads entry.sources[].node again, now, instead of at delivery time.
    nodesNow() { return raw.map((entry) => entry.sources.map((s) => describe(s.node))); },
  };
})();`;

const page = (body, style = '') => `<!doctype html><html><head><meta charset="utf-8"><style>
  html { scrollbar-gutter: stable; } body { margin: 0; font: 16px/24px Arial, sans-serif; }
  .box { background: #93c5fd; } ${style}
</style></head><body>${body}</body></html>`;

const near = (a, b, tolerance = 0.0005) => Math.abs(a - b) <= tolerance;
const fmt = (r) => `[${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}]`;

/**
 * Each probe: html, an optional "act" (default: call window.go() once the page has painted),
 * and "check(entries, extra)" which returns a list of problems (empty = documented behaviour seen).
 */
const PROBES = [
  {
    name: 'cap: at most 5 sources per entry, the largest by area, largest first',
    html: page(
      `<div id="spacer" style="height:10px"></div>` +
        Array.from({ length: 12 }, (_, i) => `<div class="box" id="b${i + 1}" style="height:${10 + i * 5}px;margin-bottom:4px"></div>`).join(''),
    ),
    go: `document.getElementById('spacer').style.height = '110px'`,
    check(entries) {
      const problems = [];
      if (entries.length !== 1) return [`expected 1 entry, saw ${entries.length}`];
      const ids = entries[0].sources.map((s) => s.node);
      if (ids.length !== 5) problems.push(`expected 5 sources for 12 moved siblings, saw ${ids.length}`);
      const largest = ['div#b12', 'div#b11', 'div#b10', 'div#b9', 'div#b8'];
      if (ids.join() !== largest.join()) problems.push(`expected the five tallest boxes, largest first (${largest.join(' ')}), saw ${ids.join(' ')}`);
      return problems;
    },
  },
  {
    name: 'dedup: a moved wrapper hides its moved descendants',
    html: page(
      `<div id="spacer" style="height:10px"></div><div id="wrapper"><p id="c1">one</p><p id="c2">two</p><p id="c3">three</p></div>`,
      'p { margin: 0 0 8px; }',
    ),
    go: `document.getElementById('spacer').style.height = '110px'`,
    check(entries) {
      if (entries.length !== 1) return [`expected 1 entry, saw ${entries.length}`];
      const ids = entries[0].sources.map((s) => s.node);
      return ids.join() === 'div#wrapper' ? [] : [`expected only div#wrapper, saw ${ids.join(' ')}`];
    },
  },
  {
    name: 'dedup: moved siblings without a moved wrapper are listed one by one',
    html: page(`<div id="spacer" style="height:10px"></div><p id="c1">one</p><p id="c2">two</p><p id="c3">three</p>`, 'p { margin: 0 0 8px; }'),
    go: `document.getElementById('spacer').style.height = '110px'`,
    check(entries) {
      if (entries.length !== 1) return [`expected 1 entry, saw ${entries.length}`];
      const ids = entries[0].sources.map((s) => s.node).sort();
      return ids.join() === 'p#c1,p#c2,p#c3' ? [] : [`expected p#c1 p#c2 p#c3, saw ${ids.join(' ')}`];
    },
  },
  {
    name: 'value: impact fraction x distance fraction, rects clipped to the viewport',
    // A 1280x600 box at y=100 moves down 200px: it is cut off at the bottom of the 800px viewport.
    html: page(`<div id="spacer" style="height:100px"></div><div class="box" id="big" style="height:600px"></div>`),
    go: `document.getElementById('spacer').style.height = '300px'`,
    check(entries) {
      if (entries.length !== 1) return [`expected 1 entry, saw ${entries.length}`];
      const problems = [];
      const [source] = entries[0].sources;
      // union of [100..700] and [300..800 (clipped from 900)] = [100..800] -> 700/800 of the viewport
      const expected = (700 / 800) * (200 / 1280);
      if (!near(entries[0].value, expected)) problems.push(`value ${entries[0].value} != ${expected} (impact 0.875 x distance 200/1280)`);
      if (source.cur.y !== 300 || source.cur.height !== 500) problems.push(`currentRect should be clipped to [0,300 1280x500], saw ${fmt(source.cur)}`);
      return problems;
    },
  },
  {
    name: 'value: one distance for the whole entry, the largest move of any node in the frame',
    // A large box moves 40px down while a small box moves 400px to the right, in the same frame.
    html: page(
      `<div id="spacer" style="height:100px"></div><div class="box" id="big" style="height:300px"></div>` +
        `<div class="box" id="small" style="position:absolute;left:0;top:600px;width:100px;height:50px"></div>`,
    ),
    go: `document.getElementById('spacer').style.height = '140px'; document.getElementById('small').style.left = '400px'`,
    check(entries) {
      if (entries.length !== 1) return [`expected 1 entry, saw ${entries.length}`];
      // impact: big union [100..440] x 1280 plus small 2 x (100 x 50); distance: 400 of 1280, not 40.
      const impact = (1280 * 340 + 2 * 100 * 50) / (1280 * 800);
      const expected = impact * (400 / 1280);
      const ifSmallDistance = impact * (40 / 1280);
      return near(entries[0].value, expected) ? [] : [`value ${entries[0].value} != ${expected} (with the 40px distance it would be ${ifSmallDistance})`];
    },
  },
  {
    name: 'size change without a move of the start corner is not a shift',
    html: page(`<div class="box" id="grows" style="height:100px"></div>`),
    go: `document.getElementById('grows').style.height = '300px'`,
    check: (entries) => (entries.length === 0 ? [] : [`expected no entry, saw ${entries.length}`]),
  },
  {
    name: 'threshold: a move under 3 CSS px is ignored',
    html: page(`<div id="spacer" style="height:10px"></div><div class="box" id="v" style="height:200px"></div>`),
    go: `document.getElementById('spacer').style.height = '12px'`,
    check: (entries) => (entries.length === 0 ? [] : [`expected no entry for a 2px move, saw ${entries.length}`]),
  },
  {
    name: 'threshold: a move of 3 CSS px is reported',
    html: page(`<div id="spacer" style="height:10px"></div><div class="box" id="v" style="height:200px"></div>`),
    go: `document.getElementById('spacer').style.height = '13px'`,
    check: (entries) => (entries.length === 1 ? [] : [`expected 1 entry for a 3px move, saw ${entries.length}`]),
  },
  {
    name: 'transform on an ancestor: rects and value are in visual (post-transform) pixels',
    html: page(
      `<div id="scaled" style="transform:scale(0.5);transform-origin:0 0;width:1280px"><div id="spacer" style="height:100px"></div><div class="box" id="v" style="height:400px"></div></div>`,
    ),
    go: `document.getElementById('spacer').style.height = '300px'`,
    check(entries) {
      if (entries.length !== 1) return [`expected 1 entry, saw ${entries.length}`];
      const problems = [];
      const [source] = entries[0].sources;
      if (source.prev.y !== 50 || source.cur.y !== 150) problems.push(`expected y 50 -> 150 (half of 100 -> 300), saw ${source.prev.y} -> ${source.cur.y}`);
      if (source.cur.width !== 640 || source.cur.height !== 200) problems.push(`expected a 640x200 visual rect, saw ${fmt(source.cur)}`);
      // union [50..350] x 640 wide; distance 100 visual px
      const expected = ((640 * 300) / (1280 * 800)) * (100 / 1280);
      if (!near(entries[0].value, expected)) problems.push(`value ${entries[0].value} != ${expected}`);
      return problems;
    },
  },
  {
    name: 'changing only the transform of an element is not a shift',
    html: page(`<div class="box" id="v" style="height:200px"></div><p id="after">after</p>`),
    go: `document.getElementById('v').style.transform = 'translate(300px, 200px)'`,
    check: (entries) => (entries.length === 0 ? [] : [`expected no entry, saw ${entries.length}`]),
  },
  {
    name: 'changing top/left of a positioned element is a shift',
    html: page(`<div class="box" id="v" style="position:absolute;top:50px;left:50px;width:300px;height:200px"></div>`),
    go: `document.getElementById('v').style.top = '250px'`,
    check(entries) {
      if (entries.length !== 1) return [`expected 1 entry, saw ${entries.length}`];
      return entries[0].sources[0]?.node === 'div#v' ? [] : [`expected div#v as the source, saw ${entries[0].sources.map((s) => s.node).join(' ')}`];
    },
  },
  {
    name: 'text that moves without its own box is reported as a text node, with rects that hide the move',
    html: page(`<div id="row"><span id="grow" style="display:inline-block;width:0;height:10px"></span>loose text in the row</div>`),
    go: `document.getElementById('grow').style.width = '200px'`,
    check(entries) {
      if (entries.length !== 1) return [`expected 1 entry, saw ${entries.length}`];
      const [source] = entries[0].sources;
      if (!source || source.nodeType !== 3) return [`expected a text node (nodeType 3), saw ${JSON.stringify(entries[0].sources.map((s) => [s.node, s.nodeType]))}`];
      const problems = [];
      // The text is 142px wide and moves from x=0 to x=200, but the rects are the full line strip, twice.
      if (source.prev.x !== source.cur.x || source.prev.width !== 1280 || source.cur.width !== 1280) {
        problems.push(`expected identical full-width rects before and after, saw ${fmt(source.prev)} -> ${fmt(source.cur)}`);
      }
      // The value does use the real 200px move: (1280 x 17 strip) / viewport x 200 / 1280.
      const expected = ((1280 * source.cur.height) / (1280 * 800)) * (200 / 1280);
      if (!near(entries[0].value, expected, 0.0002)) problems.push(`value ${entries[0].value} != ${expected}`);
      return problems;
    },
  },
  {
    name: 'a source whose node is later removed reads back as null',
    html: page(`<div id="spacer" style="height:10px"></div><div class="box" id="v" style="height:200px"></div>`),
    async act(pw) {
      await pw.evaluate(() => { document.getElementById('spacer').style.height = '110px'; });
      await pw.waitForTimeout(300);
      await pw.evaluate(() => window.__probe.collect());
      await pw.evaluate(() => document.getElementById('v').remove());
      return { nodesNow: await pw.evaluate(() => window.__probe.nodesNow()) };
    },
    check(entries, extra) {
      if (entries.length !== 1) return [`expected 1 entry, saw ${entries.length}`];
      const problems = [];
      if (entries[0].sources[0]?.node !== 'div#v') problems.push(`at delivery time the node should be div#v, saw ${entries[0].sources[0]?.node}`);
      if (extra.nodesNow[0][0] !== null) problems.push(`after removal the node should be null, saw ${extra.nodesNow[0][0]}`);
      return problems;
    },
  },
  {
    name: 'one entry per animation frame: two unrelated mutations in one task are merged',
    html: page(
      `<div style="display:flex;gap:40px;align-items:flex-start"><div style="flex:1"><div id="s1" style="height:10px"></div><div class="box" id="left" style="height:200px"></div></div>` +
        `<div style="flex:1"><div id="s2" style="height:10px"></div><div class="box" id="right" style="height:300px"></div></div></div>`,
    ),
    go: `document.getElementById('s1').style.height = '110px'; document.getElementById('s2').style.height = '60px'`,
    check(entries) {
      if (entries.length !== 1) return [`expected 1 merged entry, saw ${entries.length}`];
      const ids = entries[0].sources.map((s) => s.node).sort();
      return ids.join() === 'div#left,div#right' ? [] : [`expected div#left and div#right in one entry, saw ${ids.join(' ')}`];
    },
  },
  {
    name: 'one entry per animation frame: the same two mutations in different frames give two entries',
    html: page(
      `<div style="display:flex;gap:40px;align-items:flex-start"><div style="flex:1"><div id="s1" style="height:10px"></div><div class="box" id="left" style="height:200px"></div></div>` +
        `<div style="flex:1"><div id="s2" style="height:10px"></div><div class="box" id="right" style="height:300px"></div></div></div>`,
    ),
    go: `document.getElementById('s1').style.height = '110px'; setTimeout(() => { document.getElementById('s2').style.height = '60px'; }, 150)`,
    check(entries) {
      if (entries.length !== 2) return [`expected 2 entries, saw ${entries.length}`];
      const ids = entries.map((entry) => entry.sources.map((s) => s.node).join());
      return ids.join('|') === 'div#left|div#right' ? [] : [`expected div#left then div#right, saw ${ids.join('|')}`];
    },
  },
  {
    name: 'hadRecentInput: a shift 300 ms after a click is flagged',
    html: page(`<button id="btn" style="height:40px">go</button><div id="spacer" style="height:10px"></div><div class="box" id="v" style="height:200px"></div>`),
    setup: `document.getElementById('btn').addEventListener('click', () => setTimeout(() => { document.getElementById('spacer').style.height = '110px'; }, 300))`,
    async act(pw) {
      await pw.click('#btn');
      await pw.waitForTimeout(800);
    },
    check: (entries) => (entries.length === 1 && entries[0].hadRecentInput === true ? [] : [`expected 1 entry with hadRecentInput=true, saw ${JSON.stringify(entries.map((e) => e.hadRecentInput))}`]),
  },
  {
    name: 'hadRecentInput: a shift 800 ms after a click is not flagged',
    html: page(`<button id="btn" style="height:40px">go</button><div id="spacer" style="height:10px"></div><div class="box" id="v" style="height:200px"></div>`),
    setup: `document.getElementById('btn').addEventListener('click', () => setTimeout(() => { document.getElementById('spacer').style.height = '110px'; }, 800))`,
    async act(pw) {
      await pw.click('#btn');
      await pw.waitForTimeout(1300);
    },
    check: (entries) => (entries.length === 1 && entries[0].hadRecentInput === false ? [] : [`expected 1 entry with hadRecentInput=false, saw ${JSON.stringify(entries.map((e) => e.hadRecentInput))}`]),
  },
  {
    name: 'hadRecentInput: mouse movement alone does not flag a shift',
    html: page(`<div id="spacer" style="height:10px"></div><div class="box" id="v" style="height:200px"></div>`),
    async act(pw) {
      await pw.mouse.move(200, 200);
      await pw.mouse.move(400, 300, { steps: 5 });
      await pw.evaluate(() => { document.getElementById('spacer').style.height = '110px'; });
      await pw.waitForTimeout(300);
    },
    check: (entries) => (entries.length === 1 && entries[0].hadRecentInput === false ? [] : [`expected 1 entry with hadRecentInput=false, saw ${JSON.stringify(entries.map((e) => e.hadRecentInput))}`]),
  },
  {
    name: 'subframe: a shift inside an iframe is reported only on the iframe timeline',
    html: page(`<p>parent</p><iframe id="frame" style="width:400px;height:300px;border:0" srcdoc='<body style="margin:0"><div id="spacer" style="height:10px"></div><div id="inner" style="height:100px;background:#93c5fd"></div></body>'></iframe>`),
    async act(pw) {
      const frame = pw.frames().find((f) => f !== pw.mainFrame());
      await frame.evaluate(() => { document.getElementById('spacer').style.height = '110px'; });
      await pw.waitForTimeout(300);
      return { frameEntries: await frame.evaluate(() => window.__probe.collect()) };
    },
    check(entries, extra) {
      const problems = [];
      if (entries.length !== 0) problems.push(`expected no entry in the parent, saw ${entries.length}`);
      if (extra.frameEntries.length !== 1) return [...problems, `expected 1 entry in the iframe, saw ${extra.frameEntries.length}`];
      // Relative to the iframe's own 400x300 viewport: union [10..210] of 300, distance 100 of max(400,300).
      const own = (200 / 300) * (100 / 400);
      if (!near(extra.frameEntries[0].value, own)) problems.push(`iframe entry value ${extra.frameEntries[0].value} != ${own} (computed against the iframe's own viewport)`);
      return problems;
    },
    describeExtra: (extra) => extra.frameEntries.map((e) => `iframe entry value=${e.value.toFixed(6)} sources=${e.sources.map((s) => s.node).join(' ')}`),
  },
  {
    name: 'visibility:hidden elements that move are not reported',
    html: page(`<div id="spacer" style="height:10px"></div><div class="box" id="v" style="height:200px;visibility:hidden"></div>`),
    go: `document.getElementById('spacer').style.height = '110px'`,
    check: (entries) => (entries.length === 0 ? [] : [`expected no entry, saw ${entries.length}`]),
  },
  {
    name: 'opacity:0 elements that move are not reported',
    html: page(`<div id="spacer" style="height:10px"></div><div class="box" id="v" style="height:200px;opacity:0"></div>`),
    go: `document.getElementById('spacer').style.height = '110px'`,
    check: (entries) => (entries.length === 0 ? [] : [`expected no entry, saw ${entries.length}`]),
  },
  {
    name: 'opacity:0.5 elements that move are reported',
    html: page(`<div id="spacer" style="height:10px"></div><div class="box" id="v" style="height:200px;opacity:0.5"></div>`),
    go: `document.getElementById('spacer').style.height = '110px'`,
    check: (entries) => (entries.length === 1 ? [] : [`expected 1 entry, saw ${entries.length}`]),
  },
  {
    name: 'scroll anchoring: content inserted above a scrolled viewport does not shift it',
    html: page(`<div id="top" style="height:1500px"></div><div class="box" id="v" style="height:400px"></div><div style="height:3000px"></div>`),
    async act(pw) {
      // #top ends above the viewport, so #v is the first visible element and becomes the anchor.
      await pw.evaluate(() => window.scrollTo(0, 1600));
      await pw.waitForTimeout(700); // well clear of the scroll itself
      const before = await pw.evaluate(() => document.getElementById('v').getBoundingClientRect().top);
      await pw.evaluate(() => {
        const late = document.createElement('div');
        late.style.height = '200px';
        document.body.insertBefore(late, document.body.firstChild);
      });
      await pw.waitForTimeout(300);
      const after = await pw.evaluate(() => document.getElementById('v').getBoundingClientRect().top);
      return { before, after, scrollY: await pw.evaluate(() => window.scrollY) };
    },
    check(entries, extra) {
      const problems = [];
      if (entries.length !== 0) problems.push(`expected no entry, saw ${entries.length}`);
      if (extra.before !== extra.after) problems.push(`the element should stay at the same viewport y, saw ${extra.before} -> ${extra.after}`);
      if (extra.scrollY !== 1800) problems.push(`scrollY should have been adjusted to 1800, saw ${extra.scrollY}`);
      return problems;
    },
    describeExtra: (extra) => [`viewport y ${extra.before} -> ${extra.after}, scrollY now ${extra.scrollY}`],
  },
  {
    name: 'no scroll anchoring at scroll position 0: the same insertion at the top of an unscrolled page shifts it',
    html: page(`<div id="top" style="height:100px"></div><div class="box" id="v" style="height:400px"></div><div style="height:3000px"></div>`),
    go: `const late = document.createElement('div'); late.style.height = '200px'; document.body.insertBefore(late, document.body.firstChild)`,
    check: (entries) => (entries.length === 1 ? [] : [`expected 1 entry, saw ${entries.length}`]),
  },
  {
    name: 'buffered: an observer created after the shift still receives it',
    html: page(`<div id="spacer" style="height:10px"></div><div class="box" id="v" style="height:200px"></div>`),
    async act(pw) {
      await pw.evaluate(() => { document.getElementById('spacer').style.height = '110px'; });
      await pw.waitForTimeout(300);
      const late = await pw.evaluate(
        () =>
          new Promise((resolve) => {
            const got = [];
            new PerformanceObserver((list) => got.push(...list.getEntries().map((e) => e.value))).observe({ type: 'layout-shift', buffered: true });
            setTimeout(() => resolve(got), 200);
          }),
      );
      return { late };
    },
    check: (entries, extra) => (entries.length === 1 && extra.late.length === 1 ? [] : [`expected the late observer to get 1 buffered entry, saw ${extra.late.length}`]),
    describeExtra: (extra) => [`late observer received ${extra.late.length} buffered entries`],
  },
];

async function runProbe(browser, baseUrl, probe) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  try {
    await context.addInitScript({ content: OBSERVER_SCRIPT });
    const pw = await context.newPage();
    // The probe page is served from the corpus origin so that it is an ordinary http document.
    await pw.route('**/__probe__', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: probe.html }));
    await pw.goto(`${baseUrl}/__probe__`, { waitUntil: 'load' });
    // Two frames and a pause: the page has painted before anything is changed.
    await pw.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await pw.waitForTimeout(150);
    if (probe.setup) await pw.evaluate(probe.setup);
    let extra = {};
    if (probe.act) {
      extra = (await probe.act(pw)) ?? {};
    } else {
      await pw.evaluate(probe.go);
      await pw.waitForTimeout(450);
    }
    const entries = await pw.evaluate(() => window.__probe.collect());
    return { entries, extra };
  } finally {
    await context.close();
  }
}

async function main() {
  const onlyIndex = process.argv.indexOf('--only');
  const only = onlyIndex === -1 ? null : process.argv[onlyIndex + 1];
  const probes = PROBES.filter((probe) => !only || probe.name.includes(only));
  if (probes.length === 0) throw new Error('no probe matches');

  const server = await startServer({ port: 0 });
  let browser;
  let failed = 0;
  const abort = () => {
    Promise.resolve(browser?.close())
      .catch(() => {})
      .then(() => server.close())
      .finally(() => process.exit(1));
  };
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    browser = await chromium.launch();
    console.log(`Layout Instability probes: Chromium ${browser.version()}, viewport ${VIEWPORT.width}x${VIEWPORT.height}\n`);
    for (const probe of probes) {
      const { entries, extra } = await runProbe(browser, server.url, probe);
      const problems = probe.check(entries, extra);
      if (problems.length > 0) failed++;
      console.log(`${problems.length === 0 ? 'AS DOCUMENTED' : 'DIFFERENT    '}  ${probe.name}`);
      for (const entry of entries) {
        console.log(`    entry value=${entry.value.toFixed(6)} hadRecentInput=${entry.hadRecentInput} sources=${entry.sources.length}`);
        for (const source of entry.sources) console.log(`      ${source.node ?? '(null node)'}  ${fmt(source.prev)} -> ${fmt(source.cur)}`);
      }
      if (entries.length === 0) console.log('    no entries');
      for (const line of probe.describeExtra?.(extra) ?? []) console.log(`    ${line}`);
      for (const problem of problems) console.log(`    ! ${problem}`);
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    await server.close();
  }
  console.log(`\n${probes.length - failed}/${probes.length} probes behave as documented`);
  return failed === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
