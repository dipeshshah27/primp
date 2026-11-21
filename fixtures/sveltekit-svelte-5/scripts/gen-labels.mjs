#!/usr/bin/env node
// Generates labels.json: the ground truth for "which source position rendered this element".
//
//   node scripts/gen-labels.mjs           write labels.json
//   node scripts/gen-labels.mjs --check   exit 1 if labels.json is out of date (writes nothing)
//
// Every element in src/**/*.svelte and src/app.html that carries data-label="..." becomes one
// entry:
//   { label, file, line, col, tag, kind, page, everyPage?, instances?, when? }
// line and col are 1-based and point at the "<" of the opening tag. col counts UTF-16 code
// units, so a tab is one column.
//
//   kind       "client"  rendered by a Svelte component that is server-rendered and then
//                        hydrated (the normal SvelteKit case)
//              "server"  rendered by a route that sets `csr = false`: HTML only, never hydrated
//              "static"  markup in src/app.html, outside every component
//   page       a URL path on which the element is rendered
//   everyPage  true when the element comes from the root layout or app.html, so it is on every
//              page (kind describes it on `page`; on a csr = false route it is not hydrated)
//   instances  present when the element is rendered more than once on `page`
//   when       present when the element is only rendered in one session state
//              ("signed-out" is the state of a fresh browser)
//
// Positions come from the Svelte compiler's own parser (svelte/compiler), not from a regular
// expression. Run "pnpm install --ignore-workspace" in the fixture first.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'svelte/compiler';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIR = 'src';
const ROUTES_DIR = 'src/routes';
const APP_TEMPLATE = 'src/app.html';
const OUTPUT = 'labels.json';
const LABEL_ATTRIBUTE = 'data-label';

const read = (file) => readFileSync(join(root, file), 'utf8');
const readJson = (file) => JSON.parse(read(file));

// Where each component is used. A component with labels that is missing here is an error.
//   page       the page that renders it
//   everyPage  it is rendered by the root layout
//   instances  how many times the page renders it (read from the data the page loops over)
//   when       the session state in which the page renders it
const COMPONENTS = {
	'src/lib/components/SiteHeader.svelte': { page: '/', everyPage: true },
	'src/lib/components/SiteFooter.svelte': { page: '/', everyPage: true },
	'src/lib/components/Hero.svelte': { page: '/' },
	'src/lib/components/Panel.svelte': { page: '/' },
	'src/lib/components/FeatureCard.svelte': {
		page: '/',
		instances: readJson('src/lib/data/features.json').length
	},
	'src/lib/components/SignInForm.svelte': { page: '/', when: 'signed-out' },
	'src/lib/components/AccountCard.svelte': { page: '/', when: 'signed-in' }
};

// How often the body of `{#each <expression> ...}` is rendered, keyed "file#expression".
// A label inside an each block that is not listed here is an error.
const EACH_COUNTS = {
	'src/routes/about/+page.svelte#principles': readJson('src/lib/data/principles.json').length
};

// Blocks whose content is not always in the DOM. Labels are not allowed inside them, because
// labels.json describes the page as it is after a plain load.
const CONDITIONAL_BLOCKS = new Map([
	['IfBlock', '{#if}'],
	['AwaitBlock', '{#await}'],
	['KeyBlock', '{#key}'],
	['SnippetBlock', '{#snippet}'],
	['SvelteBoundary', '<svelte:boundary>']
]);

function listSourceFiles(dir) {
	const files = [];
	for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
		const path = `${dir}/${entry.name}`;
		if (entry.isDirectory()) files.push(...listSourceFiles(path));
		else if (entry.name.endsWith('.svelte') || path === APP_TEMPLATE) files.push(path);
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

/** "/about" for "src/routes/about/+page.svelte"; route groups "(name)" do not appear in URLs. */
function routeOf(file) {
	const segments = dirname(file)
		.slice(ROUTES_DIR.length)
		.split('/')
		.filter((segment) => segment && !/^\(.*\)$/.test(segment));
	return `/${segments.join('/')}`;
}

/** True when the route directory of `file` opts out of client-side rendering. */
function isServerOnlyRoute(file) {
	const directory = dirname(file);
	return ['+page.ts', '+page.js', '+page.server.ts', '+page.server.js'].some((name) => {
		const path = `${directory}/${name}`;
		return existsSync(join(root, path)) && /^export\s+const\s+csr\s*=\s*false\b/m.test(read(path));
	});
}

/** The facts that are the same for every label in one file. */
function fileFacts(file) {
	if (file === APP_TEMPLATE) return { kind: 'static', page: '/', everyPage: true };
	if (file.startsWith(`${ROUTES_DIR}/`)) {
		const name = file.slice(file.lastIndexOf('/') + 1);
		if (name === '+layout.svelte') {
			if (dirname(file) !== ROUTES_DIR) {
				throw new Error(`${file}: only the root layout is supported by this script`);
			}
			return { kind: 'client', page: '/', everyPage: true };
		}
		if (name === '+page.svelte') {
			return { kind: isServerOnlyRoute(file) ? 'server' : 'client', page: routeOf(file) };
		}
		throw new Error(`${file}: labels are only supported in +page.svelte and +layout.svelte`);
	}
	const usage = COMPONENTS[file];
	return usage ? { kind: 'client', ...usage } : null;
}

const isNode = (value) =>
	value !== null && typeof value === 'object' && typeof value.type === 'string';

function collectFile(file) {
	const code = read(file);
	const lineStarts = lineStartsOf(code);
	const found = [];
	const fail = (offset, message) => {
		const { line, col } = positionAt(lineStarts, offset);
		throw new Error(`${file}:${line}:${col} ${message}`);
	};

	/**
	 * @param {any} node
	 * @param {{ conditional: string | null, each: string[] }} context
	 */
	const visit = (node, context) => {
		const labelAttribute = Array.isArray(node.attributes)
			? node.attributes.find((attr) => attr.type === 'Attribute' && attr.name === LABEL_ATTRIBUTE)
			: undefined;

		if (labelAttribute) {
			const value = labelAttribute.value;
			const isLiteral = Array.isArray(value) && value.length === 1 && value[0].type === 'Text';
			if (!isLiteral || value[0].data === '') {
				fail(labelAttribute.start, `${LABEL_ATTRIBUTE} must be a non-empty string literal`);
			}
			const label = value[0].data;
			if (node.type !== 'RegularElement') {
				fail(node.start, `${LABEL_ATTRIBUTE} is only allowed on plain HTML elements`);
			}
			if (!code.startsWith(`<${node.name}`, node.start)) {
				fail(node.start, `parser offset does not point at "<${node.name}"`);
			}
			if (context.conditional) {
				fail(node.start, `"${label}" is inside ${context.conditional}; labels must always render`);
			}

			const facts = fileFacts(file);
			if (!facts) fail(node.start, `"${label}": add "${file}" to COMPONENTS`);

			let instances = facts.instances ?? 1;
			for (const expression of context.each) {
				const count = EACH_COUNTS[`${file}#${expression}`];
				if (count === undefined) {
					fail(node.start, `"${label}" is inside {#each ${expression}}; add "${file}#${expression}" to EACH_COUNTS`);
				}
				instances *= count;
			}

			const { line, col } = positionAt(lineStarts, node.start);
			const entry = { label, file, line, col, tag: node.name, kind: facts.kind, page: facts.page };
			if (facts.everyPage) entry.everyPage = true;
			if (instances !== 1) entry.instances = instances;
			if (facts.when) entry.when = facts.when;
			found.push(entry);
		}

		let childContext = context;
		const conditional = CONDITIONAL_BLOCKS.get(node.type);
		if (conditional && !context.conditional) childContext = { ...context, conditional };
		if (node.type === 'EachBlock') {
			const expression = code.slice(node.expression.start, node.expression.end);
			childContext = { ...childContext, each: [...childContext.each, expression] };
		}

		for (const [key, child] of Object.entries(node)) {
			if (key === 'metadata' || key === 'parent') continue;
			if (Array.isArray(child)) {
				for (const item of child) if (isNode(item)) visit(item, childContext);
			} else if (isNode(child)) {
				visit(child, childContext);
			}
		}
	};

	const ast = parse(code, { modern: true, filename: file });
	visit(ast.fragment, { conditional: null, each: [] });

	// Guard against anything the walk did not see as a plain attribute (spread props, a label
	// built at runtime, a label in a comment): the textual count must agree.
	const textual = (code.match(new RegExp(`\\b${LABEL_ATTRIBUTE}\\s*=`, 'g')) ?? []).length;
	if (textual !== found.length) {
		throw new Error(`${file}: ${textual} textual "${LABEL_ATTRIBUTE}=" occurrences but ${found.length} labelled elements`);
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

const serialise = (labels) =>
	`[\n${labels.map((entry) => `  ${JSON.stringify(entry)}`).join(',\n')}\n]\n`;

function report(labels) {
	const perFile = new Map();
	for (const entry of labels) perFile.set(entry.file, (perFile.get(entry.file) ?? 0) + 1);
	for (const [file, count] of perFile) console.log(`  ${String(count).padStart(3)}  ${file}`);

	const pages = [...new Set(labels.map((entry) => entry.page))].sort();
	for (const page of pages) {
		const onPage = labels.filter(
			(entry) => (entry.page === page || entry.everyPage) && (entry.when ?? 'signed-out') === 'signed-out'
		);
		const nodes = onPage.reduce((sum, entry) => sum + (entry.instances ?? 1), 0);
		console.log(`page ${page} (signed out): ${onPage.length} labels, ${nodes} labelled DOM nodes`);
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
			// a missing file is reported below
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
