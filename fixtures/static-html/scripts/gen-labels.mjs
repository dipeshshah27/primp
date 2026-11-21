#!/usr/bin/env node
// Generates labels.json: the ground truth for "which source position is this element".
//
//   node scripts/gen-labels.mjs           write labels.json
//   node scripts/gen-labels.mjs --check   exit 1 if labels.json is out of date (writes nothing)
//
// Every element in the site's .html files that carries data-label="..." becomes one entry:
//   { label, file, line, col, tag, kind, page }
// line and col are 1-based and point at the "<" of the opening tag (col counts UTF-16 code
// units). kind is always "static": the markup is served as written. page is the URL path
// that serves the file.
//
// No dependencies: the small tokenizer below reads start tags, and skips comments, the
// doctype, end tags and the contents of <script>, <style>, <textarea> and <title>. It is
// meant for the hand-written HTML in this fixture, not for arbitrary documents.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = 'labels.json';
const LABEL_ATTRIBUTE = 'data-label';
const KIND = 'static';
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'scripts']);
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title']);

const isSpace = (char) => char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';
const isNameStart = (char) => /[a-zA-Z]/.test(char);

function listHtmlFiles(dir = '') {
  const files = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const path = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) files.push(...listHtmlFiles(path));
    } else if (entry.name.endsWith('.html')) {
      files.push(path);
    }
  }
  return files.sort();
}

/** "/" for index.html, "/docs/" for docs/index.html, "/about.html" for about.html. */
function pageOf(file) {
  if (file === 'index.html') return '/';
  if (file.endsWith('/index.html')) return `/${file.slice(0, -'index.html'.length)}`;
  return `/${file}`;
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

/**
 * Reads the attributes of a start tag. `index` is just after the tag name.
 * Returns the attributes (first occurrence wins, as in browsers) and the index after ">".
 */
function readAttributes(code, index, fail) {
  const attributes = new Map();
  let i = index;
  for (;;) {
    while (i < code.length && (isSpace(code[i]) || code[i] === '/')) i++;
    if (i >= code.length) fail(index, 'start tag is never closed');
    if (code[i] === '>') return { attributes, end: i + 1 };

    const nameStart = i;
    while (i < code.length && !isSpace(code[i]) && code[i] !== '=' && code[i] !== '>' && code[i] !== '/') i++;
    const name = code.slice(nameStart, i).toLowerCase();
    if (name === '') fail(i, 'attribute without a name');

    while (i < code.length && isSpace(code[i])) i++;
    let value = '';
    if (code[i] === '=') {
      i++;
      while (i < code.length && isSpace(code[i])) i++;
      const quote = code[i];
      if (quote === '"' || quote === "'") {
        const close = code.indexOf(quote, i + 1);
        if (close === -1) fail(i, 'attribute value is never closed');
        value = code.slice(i + 1, close);
        i = close + 1;
      } else {
        const valueStart = i;
        while (i < code.length && !isSpace(code[i]) && code[i] !== '>') i++;
        value = code.slice(valueStart, i);
      }
    }
    if (!attributes.has(name)) attributes.set(name, { value, offset: nameStart });
  }
}

/** Every start tag in `code`: { name, offset, attributes }. */
function startTagsOf(code, fail) {
  const tags = [];
  let i = 0;
  while (i < code.length) {
    const open = code.indexOf('<', i);
    if (open === -1) break;

    if (code.startsWith('<!--', open)) {
      const close = code.indexOf('-->', open + 4);
      if (close === -1) fail(open, 'comment is never closed');
      i = close + 3;
    } else if (code[open + 1] === '!' || code[open + 1] === '?' || code[open + 1] === '/') {
      // doctype, processing instruction or end tag
      const close = code.indexOf('>', open);
      if (close === -1) fail(open, 'markup is never closed');
      i = close + 1;
    } else if (isNameStart(code[open + 1] ?? '')) {
      let nameEnd = open + 1;
      while (nameEnd < code.length && !isSpace(code[nameEnd]) && code[nameEnd] !== '>' && code[nameEnd] !== '/') nameEnd++;
      const name = code.slice(open + 1, nameEnd).toLowerCase();
      const { attributes, end } = readAttributes(code, nameEnd, fail);
      tags.push({ name, offset: open, attributes });
      i = end;

      if (RAW_TEXT_ELEMENTS.has(name)) {
        const closing = new RegExp(`</${name}[\\s>/]`, 'i');
        const match = closing.exec(code.slice(i));
        if (!match) fail(open, `<${name}> is never closed`);
        i += match.index;
      }
    } else {
      // a "<" in text
      i = open + 1;
    }
  }
  return tags;
}

function collectFile(file) {
  const code = readFileSync(join(root, file), 'utf8');
  const lineStarts = lineStartsOf(code);
  const fail = (offset, message) => {
    const { line, col } = positionAt(lineStarts, offset);
    throw new Error(`${file}:${line}:${col} ${message}`);
  };

  const found = [];
  for (const tag of startTagsOf(code, fail)) {
    const attribute = tag.attributes.get(LABEL_ATTRIBUTE);
    if (!attribute) continue;
    if (attribute.value === '') fail(attribute.offset, `${LABEL_ATTRIBUTE} must not be empty`);
    const { line, col } = positionAt(lineStarts, tag.offset);
    found.push({ label: attribute.value, file, line, col, tag: tag.name, kind: KIND, page: pageOf(file) });
  }

  // Guard against a label the tokenizer skipped (inside a comment or a script): the textual
  // count must agree.
  const textual = (code.match(new RegExp(`\\b${LABEL_ATTRIBUTE}\\s*=`, 'g')) ?? []).length;
  if (textual !== found.length) {
    throw new Error(`${file}: ${textual} textual "${LABEL_ATTRIBUTE}=" occurrences but ${found.length} labelled elements`);
  }
  return found;
}

function generate() {
  const labels = listHtmlFiles().flatMap(collectFile);
  // index.html first, then the other pages by name; within a file, document order.
  const order = (file) => (file === 'index.html' ? '' : file);
  labels.sort((a, b) => order(a.file).localeCompare(order(b.file)) || a.line - b.line || a.col - b.col);

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
      // a missing file is reported below
    }
    if (current !== text) {
      console.error(`${shown} is out of date; run "node scripts/gen-labels.mjs"`);
      process.exit(1);
    }
    console.log(`${shown} is up to date (${labels.length} labels)`);
  } else {
    writeFileSync(outputPath, text);
    const perFile = new Map();
    for (const entry of labels) perFile.set(entry.file, (perFile.get(entry.file) ?? 0) + 1);
    for (const [file, count] of perFile) console.log(`  ${String(count).padStart(3)}  ${file}`);
    console.log(`wrote ${shown} (${labels.length} labels)`);
  }
} catch (error) {
  console.error(`gen-labels: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
