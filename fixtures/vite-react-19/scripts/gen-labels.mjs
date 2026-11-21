#!/usr/bin/env node
// Generates labels.json: the ground truth for "which source position rendered this element".
//
//   node scripts/gen-labels.mjs           write labels.json
//   node scripts/gen-labels.mjs --check   exit 1 if labels.json is out of date (writes nothing)
//
// Every JSX element in src/ that carries data-label="..." becomes one entry:
//   { label, file, line, col, tag, kind, page, instances? }
// line and col are 1-based and point at the "<" of the opening tag (col counts UTF-16 code
// units, like editors and source maps do). "instances" is present only when the element is
// rendered more than once; see REPEATS below.
//
// The sources are parsed with the parser that ships inside Vite (oxc, via parseAst), so the
// positions come from a real JSX/TypeScript AST and not from a regular expression. Run
// "pnpm install --ignore-workspace" in the fixture first.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIR = 'src';
const OUTPUT = 'labels.json';
const LABEL_ATTRIBUTE = 'data-label';

const readJson = (file) => JSON.parse(readFileSync(join(root, file), 'utf8'));

// Everything in this fixture is rendered in the browser by React (no SSR, no static markup).
const KIND = 'client';

// The page a labelled element is rendered on. App.tsx switches on location.pathname.
const pageOf = (file) => (file === 'src/pages/Big.tsx' ? '/big' : '/');

// How often a labelled element is rendered. Counts are read from the same data files the
// components import, so they follow the data.
//   component: every label in the file is repeated, because the component itself is rendered
//              once per item by another file.
//   map:       labels inside the callback of `<expr>.map(...)` in that file, keyed "file#expr".
// A label inside a .map() callback that is not listed here is an error, so a new loop cannot
// silently produce a wrong "instances" value.
const REPEATS = {
  component: {
    'src/components/Card.tsx': readJson('src/data/cards.json').length,
  },
  map: {
    'src/components/PricingTable.tsx#plans': readJson('src/data/plans.json').length,
    'src/pages/Big.tsx#rows': readJson('src/data/big.json').rows,
  },
};

function listSourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) files.push(...listSourceFiles(path));
    else if (/\.[jt]sx$/.test(entry.name)) files.push(path);
  }
  return files.sort();
}

function lineStartsOf(code) {
  const starts = [0];
  for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function positionAt(lineStarts, offset) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (lineStarts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low + 1, col: offset - lineStarts[low] + 1 };
}

const isNode = (value) => value !== null && typeof value === 'object' && typeof value.type === 'string';

/** The `x` of `x.map(callback)` if `node` is such a call, else null. */
function mappedExpression(node, code) {
  if (node.type !== 'CallExpression') return null;
  const callee = node.callee;
  if (callee?.type !== 'MemberExpression' || callee.computed) return null;
  if (callee.property?.name !== 'map') return null;
  return code.slice(callee.object.start, callee.object.end);
}

function collectFile(file) {
  const code = readFileSync(join(root, file), 'utf8');
  const lineStarts = lineStartsOf(code);
  const found = [];
  const fail = (offset, message) => {
    const { line, col } = positionAt(lineStarts, offset);
    throw new Error(`${file}:${line}:${col} ${message}`);
  };

  const visit = (node, maps) => {
    let innerMaps = maps;
    const mapped = mappedExpression(node, code);

    if (node.type === 'JSXElement') {
      const opening = node.openingElement;
      const attribute = opening.attributes.find(
        (attr) => attr.type === 'JSXAttribute' && attr.name.type === 'JSXIdentifier' && attr.name.name === LABEL_ATTRIBUTE,
      );
      if (attribute) {
        const value = attribute.value;
        if (value?.type !== 'Literal' || typeof value.value !== 'string' || value.value === '') {
          fail(attribute.start, `${LABEL_ATTRIBUTE} must be a non-empty string literal`);
        }
        const name = opening.name;
        if (name.type !== 'JSXIdentifier' || !/^[a-z]/.test(name.name)) {
          fail(opening.start, `${LABEL_ATTRIBUTE} is only allowed on host elements (lower-case tags)`);
        }
        if (!code.startsWith(`<${name.name}`, opening.start)) {
          fail(opening.start, `parser offset does not point at "<${name.name}" (non-ASCII text before it?)`);
        }

        let instances = REPEATS.component[file] ?? 1;
        for (const expression of maps) {
          const count = REPEATS.map[`${file}#${expression}`];
          if (count === undefined) {
            fail(opening.start, `"${value.value}" is inside ${expression}.map(...); add "${file}#${expression}" to REPEATS.map`);
          }
          instances *= count;
        }

        const { line, col } = positionAt(lineStarts, opening.start);
        const entry = { label: value.value, file, line, col, tag: name.name, kind: KIND, page: pageOf(file) };
        if (instances !== 1) entry.instances = instances;
        found.push(entry);
      }
    }

    for (const [key, child] of Object.entries(node)) {
      // Only the callback of x.map(callback) is "inside the loop"; x itself is not.
      const childMaps = mapped !== null && key === 'arguments' ? [...maps, mapped] : innerMaps;
      if (Array.isArray(child)) {
        for (const item of child) if (isNode(item)) visit(item, childMaps);
      } else if (isNode(child)) {
        visit(child, childMaps);
      }
    }
  };

  visit(parseAst(code, { lang: file.endsWith('.tsx') ? 'tsx' : 'jsx' }, file), []);

  // Guard against anything the AST walk did not see as a plain attribute (spread props,
  // commented-out markup, a label built at runtime): the textual count must agree.
  const textual = (code.match(new RegExp(`\\b${LABEL_ATTRIBUTE}\\s*=`, 'g')) ?? []).length;
  if (textual !== found.length) {
    throw new Error(`${file}: ${textual} textual "${LABEL_ATTRIBUTE}=" occurrences but ${found.length} labelled JSX elements`);
  }
  return found;
}

function generate() {
  const labels = listSourceFiles(SOURCE_DIR).flatMap(collectFile);
  labels.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col);

  const seen = new Map();
  for (const entry of labels) {
    const previous = seen.get(entry.label);
    if (previous) {
      throw new Error(`duplicate label "${entry.label}": ${previous.file}:${previous.line} and ${entry.file}:${entry.line}`);
    }
    seen.set(entry.label, entry);
  }
  return labels;
}

const serialise = (labels) => `[\n${labels.map((entry) => `  ${JSON.stringify(entry)}`).join(',\n')}\n]\n`;

function report(labels) {
  const perFile = new Map();
  const perPage = new Map();
  for (const entry of labels) {
    perFile.set(entry.file, (perFile.get(entry.file) ?? 0) + 1);
    const page = perPage.get(entry.page) ?? { labels: 0, nodes: 0 };
    page.labels += 1;
    page.nodes += entry.instances ?? 1;
    perPage.set(entry.page, page);
  }
  for (const [file, count] of perFile) console.log(`  ${String(count).padStart(3)}  ${file}`);
  for (const [page, { labels: count, nodes }] of perPage) {
    console.log(`page ${page}: ${count} labels, ${nodes} labelled DOM nodes`);
  }
}

try {
  const labels = generate();
  const text = serialise(labels);
  const outputPath = join(root, OUTPUT);
  const shown = relative(process.cwd(), outputPath).split(sep).join('/') || OUTPUT;

  if (process.argv.includes('--check')) {
    let current = null;
    try {
      current = readFileSync(outputPath, 'utf8');
    } catch {
      // missing file is reported below
    }
    if (current !== text) {
      console.error(`${shown} is out of date; run "node scripts/gen-labels.mjs"`);
      process.exit(1);
    }
    console.log(`${shown} is up to date (${labels.length} labels)`);
  } else {
    writeFileSync(outputPath, text);
    report(labels);
    console.log(`wrote ${shown} (${labels.length} labels)`);
  }
} catch (error) {
  console.error(`gen-labels: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
