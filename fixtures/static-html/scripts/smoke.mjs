#!/usr/bin/env node
// Starts server.mjs on a free port, checks pages, content types, gzip and conditional
// requests over plain HTTP, then stops the server. Exits 0 when every check passes, 1 otherwise.
//
//   node scripts/smoke.mjs

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = 'localhost';
const START_TIMEOUT_MS = 10_000;

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

/** One HTTP request; the body is returned as raw bytes (never decoded automatically). */
function request(port, path, { method = 'GET', headers = {} } = {}) {
  return new Promise((done, fail) => {
    const req = http.request({ host: HOST, port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', fail);
    });
    req.on('error', fail);
    req.end();
  });
}

async function waitUntilReady(port, child) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited with code ${child.exitCode}`);
    try {
      await request(port, '/');
      return;
    } catch {
      // not listening yet
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`server did not answer within ${START_TIMEOUT_MS} ms`);
}

function labelDifferences(page, html) {
  const expected = new Set(labels.filter((entry) => entry.page === page).map((entry) => entry.label));
  const actual = [...html.matchAll(/\sdata-label="([^"]+)"/g)].map((match) => match[1]);
  const differences = [];
  for (const label of expected) {
    const count = actual.filter((name) => name === label).length;
    if (count !== 1) differences.push(`${label}: want 1, got ${count}`);
  }
  for (const label of new Set(actual)) {
    if (!expected.has(label)) differences.push(`${label}: not in labels.json for ${page}`);
  }
  return { differences, count: expected.size };
}

async function run(port) {
  const generated = spawnSync(process.execPath, ['scripts/gen-labels.mjs', '--check'], { cwd: root, encoding: 'utf8' });
  check('labels.json is up to date', generated.status === 0, (generated.stdout || generated.stderr).trim());

  // Pages and their labels.
  for (const [page, file] of [['/', 'index.html'], ['/about.html', 'about.html']]) {
    const response = await request(port, page);
    const onDisk = readFileSync(join(root, file));
    check(
      `GET ${page} is 200 text/html and byte-identical to ${file}`,
      response.status === 200 && response.headers['content-type'] === 'text/html; charset=utf-8' && response.body.equals(onDisk),
      `${response.status} ${response.headers['content-type']} ${response.body.length} B`
    );
    const { differences, count } = labelDifferences(page, response.body.toString('utf8'));
    check(`${page} carries exactly the labels in labels.json`, differences.length === 0, differences.length ? differences.join('; ') : `${count} labels`);
  }

  // Content types.
  const types = [
    ['/css/site.css', 'text/css; charset=utf-8'],
    ['/js/site.js', 'text/javascript; charset=utf-8'],
    ['/img/mark.svg', 'image/svg+xml'],
    ['/labels.json', 'application/json; charset=utf-8'],
  ];
  for (const [path, type] of types) {
    const response = await request(port, path);
    check(`GET ${path} is 200 ${type}`, response.status === 200 && response.headers['content-type'] === type, `${response.status} ${response.headers['content-type']}`);
  }

  const css = (await request(port, '/css/site.css')).body.toString('utf8');
  check('site.css has an @media rule and a :hover rule', /@media \(max-width: 640px\)/.test(css) && /\.card:hover\s*\{/.test(css));

  // Encoding.
  const identity = await request(port, '/');
  check(
    'without Accept-Encoding the response is not compressed and has Content-Length',
    identity.headers['content-encoding'] === undefined && Number(identity.headers['content-length']) === identity.body.length,
    `content-length=${identity.headers['content-length']}`
  );

  const gzipped = await request(port, '/', { headers: { 'accept-encoding': 'gzip, deflate, br' } });
  let decoded = null;
  try {
    decoded = zlib.gunzipSync(gzipped.body);
  } catch {
    // reported by the check below
  }
  check(
    'with Accept-Encoding: gzip the response is gzip, chunked, and decodes to the same bytes',
    gzipped.headers['content-encoding'] === 'gzip' &&
      gzipped.headers['transfer-encoding'] === 'chunked' &&
      gzipped.headers['content-length'] === undefined &&
      gzipped.headers.vary === 'Accept-Encoding' &&
      decoded !== null &&
      decoded.equals(identity.body),
    `${gzipped.body.length} B on the wire, ${decoded?.length ?? 'undecodable'} B decoded`
  );

  const refused = await request(port, '/', { headers: { 'accept-encoding': 'gzip;q=0, identity' } });
  check('Accept-Encoding: gzip;q=0 is honoured', refused.headers['content-encoding'] === undefined && refused.body.equals(identity.body));

  // Validators and 304.
  const etag = identity.headers.etag;
  const lastModified = identity.headers['last-modified'];
  check(
    'responses carry ETag, Last-Modified and Cache-Control: no-cache',
    /^W\/"[0-9a-f]+-[0-9a-f]+"$/.test(etag ?? '') && Number.isFinite(Date.parse(lastModified ?? '')) && identity.headers['cache-control'] === 'no-cache',
    `etag=${etag} last-modified=${lastModified}`
  );
  check('the gzip response has the same ETag', gzipped.headers.etag === etag);

  const byEtag = await request(port, '/', { headers: { 'if-none-match': etag } });
  check('If-None-Match with the current ETag is 304 with an empty body', byEtag.status === 304 && byEtag.body.length === 0 && byEtag.headers.etag === etag, String(byEtag.status));

  const byDate = await request(port, '/', { headers: { 'if-modified-since': lastModified } });
  check('If-Modified-Since with the Last-Modified date is 304', byDate.status === 304 && byDate.body.length === 0, String(byDate.status));

  const staleEtag = await request(port, '/', { headers: { 'if-none-match': 'W/"0-0"', 'if-modified-since': lastModified } });
  check('a stale ETag is 200 even when If-Modified-Since would match', staleEtag.status === 200 && staleEtag.body.equals(identity.body), String(staleEtag.status));

  const oldDate = await request(port, '/', { headers: { 'if-modified-since': 'Thu, 01 Jan 2015 00:00:00 GMT' } });
  check('an old If-Modified-Since date is 200', oldDate.status === 200, String(oldDate.status));

  // Other methods and paths.
  const head = await request(port, '/about.html', { method: 'HEAD' });
  check(
    'HEAD has the headers of GET and no body',
    head.status === 200 && head.body.length === 0 && Number(head.headers['content-length']) === readFileSync(join(root, 'about.html')).length,
    `content-length=${head.headers['content-length']}`
  );

  const post = await request(port, '/', { method: 'POST' });
  check('POST is 405 with Allow: GET, HEAD', post.status === 405 && post.headers.allow === 'GET, HEAD', String(post.status));

  const missing = await request(port, '/no-such-page.html');
  check('an unknown path is a 404 HTML page', missing.status === 404 && missing.headers['content-type'] === 'text/html; charset=utf-8', String(missing.status));

  const traversal = await request(port, '/..%2f..%2f..%2fetc%2fhosts');
  const hidden = await request(port, '/.gitignore');
  check('paths outside the site and dotfiles are 404', traversal.status === 404 && hidden.status === 404, `${traversal.status} ${hidden.status}`);
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
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      clearTimeout(force);
      done();
    }
  });
}

const port = await freePort();
const child = spawn(process.execPath, [join(root, 'server.mjs')], {
  cwd: root,
  env: { ...process.env, PORT: String(port), HOST },
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
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
  check(`server announces the requested port ${port}`, output.includes(`http://${HOST}:${port}`), output.trim());
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
process.exit(failed.length ? 1 : 0);
