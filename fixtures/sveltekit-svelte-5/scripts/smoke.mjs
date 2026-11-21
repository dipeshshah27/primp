#!/usr/bin/env node
// Starts the dev server on a free port, checks every page and the sign-in flow over plain
// HTTP, then stops the server. Exits 0 when every check passes, 1 otherwise.
//
//   node scripts/smoke.mjs
//
// Nothing here uses a browser: it checks what the server sends (status, markup, cookies,
// the Origin rule and that /streamed really arrives in two parts).

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = 'localhost';
const START_TIMEOUT_MS = 60_000;
const SESSION_COOKIE = 'primp_fixture_user';
const PAGES = ['/', '/about', '/streamed', '/server-only'];
const FORM_HEADERS = {
	accept: 'text/html,application/xhtml+xml',
	'content-type': 'application/x-www-form-urlencoded'
};

const labels = JSON.parse(readFileSync(join(root, 'labels.json'), 'utf8'));
const results = [];
const check = (name, ok, evidence) => {
	results.push({ name, ok });
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${evidence ? `  (${evidence})` : ''}`);
};

function freePort() {
	return new Promise((done, fail) => {
		const server = net.createServer();
		server.once('error', fail);
		server.listen(0, HOST, () => {
			const { port } = server.address();
			server.close(() => done(port));
		});
	});
}

/** One HTTP request. Resolves with status, headers, body and the arrival time of each chunk. */
function request(port, path, { method = 'GET', headers = {}, body } = {}) {
	return new Promise((done, fail) => {
		const started = performance.now();
		const req = http.request({ host: HOST, port, path, method, headers }, (res) => {
			const chunks = [];
			res.on('data', (chunk) => {
				chunks.push({ at: performance.now() - started, text: chunk.toString('utf8') });
			});
			res.on('end', () => {
				done({
					status: res.statusCode,
					headers: res.headers,
					chunks,
					body: chunks.map((chunk) => chunk.text).join('')
				});
			});
			res.on('error', fail);
		});
		req.on('error', fail);
		req.end(body);
	});
}

async function waitUntilReady(port, child) {
	const deadline = Date.now() + START_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`dev server exited with code ${child.exitCode}`);
		try {
			const response = await request(port, '/api/me');
			if (response.status === 200) return;
		} catch {
			// not listening yet
		}
		await new Promise((done) => setTimeout(done, 150));
	}
	throw new Error(`dev server did not answer within ${START_TIMEOUT_MS} ms`);
}

/** Expected number of DOM nodes per label on `page` in the given session state. */
function expectedLabels(page, state) {
	const expected = new Map();
	for (const entry of labels) {
		if (entry.page !== page && !entry.everyPage) continue;
		if (entry.when && entry.when !== state) continue;
		expected.set(entry.label, entry.instances ?? 1);
	}
	return expected;
}

function actualLabels(html) {
	const actual = new Map();
	for (const match of html.matchAll(/\sdata-label="([^"]+)"/g)) {
		actual.set(match[1], (actual.get(match[1]) ?? 0) + 1);
	}
	return actual;
}

function labelDifferences(expected, actual) {
	const differences = [];
	for (const [label, count] of expected) {
		if (actual.get(label) !== count) differences.push(`${label}: want ${count}, got ${actual.get(label) ?? 0}`);
	}
	for (const [label, count] of actual) {
		if (!expected.has(label)) differences.push(`${label}: not in labels.json for this page, got ${count}`);
	}
	return differences;
}

function checkLabels(page, state, html) {
	const expected = expectedLabels(page, state);
	const differences = labelDifferences(expected, actualLabels(html));
	const nodes = [...expected.values()].reduce((sum, count) => sum + count, 0);
	check(
		`${page} (${state}) renders exactly the labels in labels.json`,
		differences.length === 0,
		differences.length ? differences.join('; ') : `${expected.size} labels, ${nodes} nodes`
	);
}

async function run(port) {
	const origin = `http://${HOST}:${port}`;

	const generated = spawnSync(process.execPath, ['scripts/gen-labels.mjs', '--check'], { cwd: root, encoding: 'utf8' });
	check('labels.json is up to date', generated.status === 0, (generated.stdout || generated.stderr).trim());

	for (const page of PAGES) {
		const response = await request(port, page);
		const type = response.headers['content-type'] ?? '';
		check(`GET ${page} is 200 text/html`, response.status === 200 && type.startsWith('text/html'), `${response.status} ${type}`);
		checkLabels(page, 'signed-out', response.body);
	}

	const home = await request(port, '/');
	check('home page says "Signed out"', home.body.includes('>Signed out<'));
	check(
		'home page carries scoped component styles with an @media rule',
		/\.hero\.svelte-[a-z0-9]+\s*\{/.test(home.body) && /@media \(max-width: 640px\)\s*\{\s*\.hero\.svelte-/.test(home.body)
	);

	const serverOnly = await request(port, '/server-only');
	const scripts = (serverOnly.body.match(/<script/g) ?? []).length;
	check('/server-only (csr = false) ships no <script>', scripts === 0, `${scripts} script tags`);

	const missing = await request(port, '/no-such-page');
	check('unknown page is 404', missing.status === 404, String(missing.status));

	const me = await request(port, '/api/me');
	check('GET /api/me is {"user":null} before signing in', me.body === '{"user":null}', me.body);

	// The Origin rule for form posts.
	const noOrigin = await request(port, '/?/signin', { method: 'POST', headers: FORM_HEADERS, body: 'name=Ada' });
	check('POST without an Origin header is 403', noOrigin.status === 403 && !noOrigin.headers['set-cookie'], String(noOrigin.status));

	const wrongOrigin = await request(port, '/?/signin', {
		method: 'POST',
		headers: { ...FORM_HEADERS, origin: `http://${HOST}:1` },
		body: 'name=Ada'
	});
	check('POST with another port as Origin is 403', wrongOrigin.status === 403 && !wrongOrigin.headers['set-cookie'], String(wrongOrigin.status));

	const empty = await request(port, '/?/signin', { method: 'POST', headers: { ...FORM_HEADERS, origin }, body: 'name=' });
	check(
		'POST with an empty name is 400 and re-renders the form with an error',
		empty.status === 400 && empty.body.includes('Enter a name to sign in.') && !empty.headers['set-cookie'],
		String(empty.status)
	);

	// Signing in.
	const signin = await request(port, '/?/signin', { method: 'POST', headers: { ...FORM_HEADERS, origin }, body: 'name=Ada' });
	const setCookie = signin.headers['set-cookie']?.[0] ?? '';
	check(
		'POST with the matching Origin is 303 to / and sets the session cookie',
		signin.status === 303 && signin.headers.location === '/' && setCookie.startsWith(`${SESSION_COOKIE}=Ada;`),
		`${signin.status} location=${signin.headers.location} set-cookie=${setCookie}`
	);
	const cookie = setCookie.split(';', 1)[0];

	const meSignedIn = await request(port, '/api/me', { headers: { cookie } });
	check('GET /api/me with the cookie is {"user":"Ada"}', meSignedIn.body === '{"user":"Ada"}', meSignedIn.body);

	const homeSignedIn = await request(port, '/', { headers: { cookie } });
	check('home page with the cookie says "Signed in as Ada"', homeSignedIn.body.includes('>Signed in as Ada<'));
	checkLabels('/', 'signed-in', homeSignedIn.body);

	const signout = await request(port, '/?/signout', { method: 'POST', headers: { ...FORM_HEADERS, origin, cookie }, body: '' });
	const cleared = signout.headers['set-cookie']?.[0] ?? '';
	check(
		'sign-out is 303 and clears the cookie',
		signout.status === 303 && cleared.startsWith(`${SESSION_COOKIE}=;`) && /Max-Age=0/i.test(cleared),
		`${signout.status} set-cookie=${cleared}`
	);

	// Streaming: the shell must be readable well before the late value.
	const streamed = await request(port, '/streamed');
	const shell = streamed.chunks.find((chunk) => chunk.text.includes('data-label="streamed-shell"'));
	const value = streamed.chunks.find((chunk) => chunk.text.includes('streamed value arrived'));
	const gap = shell && value ? value.at - shell.at : NaN;
	check(
		'/streamed sends the shell first and the value at least 500 ms later in the same response',
		Boolean(shell && value) && gap >= 500 && !shell.text.includes('streamed value arrived'),
		shell && value
			? `shell at ${shell.at.toFixed(0)} ms, value at ${value.at.toFixed(0)} ms, ${streamed.chunks.length} chunks`
			: 'shell or value chunk not found'
	);
}

function stop(child) {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((done) => {
		const force = setTimeout(() => {
			try {
				process.kill(-child.pid, 'SIGKILL');
			} catch {
				// already gone
			}
		}, 3000);
		child.once('exit', () => {
			clearTimeout(force);
			done();
		});
		try {
			// The dev server is its own process group, so this also reaches anything it spawned.
			process.kill(-child.pid, 'SIGTERM');
		} catch {
			clearTimeout(force);
			done();
		}
	});
}

const port = await freePort();
const child = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'dev'], {
	cwd: root,
	env: { ...process.env, PORT: String(port) },
	detached: true,
	stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
child.stdout.on('data', (chunk) => (output += chunk));
child.stderr.on('data', (chunk) => (output += chunk));

for (const signal of ['SIGINT', 'SIGTERM']) {
	process.on(signal, () => {
		stop(child).then(() => process.exit(1));
	});
}

let crashed = null;
try {
	await waitUntilReady(port, child);
	console.log(`dev server ready on http://${HOST}:${port}`);
	await run(port);
} catch (error) {
	crashed = error;
} finally {
	await stop(child);
}

if (crashed) {
	console.error(`smoke: ${crashed instanceof Error ? crashed.message : String(crashed)}`);
	console.error(output.trim());
	process.exit(1);
}

const failed = results.filter((result) => !result.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) console.error(output.trim());
process.exit(failed.length ? 1 : 0);
