#!/usr/bin/env node
// static-html fixture server. Node built-ins only, no build step, no live reload.
//
//   node server.mjs               listens on http://localhost:4173
//   PORT=5005 node server.mjs     listens on 5005
//   PORT=0 node server.mjs        listens on a free port and prints the URL
//   HOST=127.0.0.1 ...            overrides the bind address (default: localhost)
//
// What it does, so that a proxy in front of it has something to handle:
//   - GET and HEAD for the files in this directory; a directory serves its index.html
//   - a Content-Type per file extension
//   - gzip when the request's Accept-Encoding allows it (text formats only). A gzip response
//     is streamed with chunked transfer encoding and has no Content-Length; an identity
//     response has a Content-Length
//   - a weak ETag and Last-Modified on every file, and 304 for If-None-Match or
//     If-Modified-Since. "Cache-Control: no-cache" makes browsers revalidate on every load,
//     so an edited file is picked up by the next request

import http from 'node:http';
import { createReadStream, realpathSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 4173;
const DEFAULT_HOST = 'localhost';

/** Content type and whether the format is worth compressing. */
const TYPES = {
  '.html': { type: 'text/html; charset=utf-8', compress: true },
  '.css': { type: 'text/css; charset=utf-8', compress: true },
  '.js': { type: 'text/javascript; charset=utf-8', compress: true },
  '.mjs': { type: 'text/javascript; charset=utf-8', compress: true },
  '.json': { type: 'application/json; charset=utf-8', compress: true },
  '.svg': { type: 'image/svg+xml', compress: true },
  '.txt': { type: 'text/plain; charset=utf-8', compress: true },
  '.md': { type: 'text/markdown; charset=utf-8', compress: true },
  '.png': { type: 'image/png', compress: false },
  '.jpg': { type: 'image/jpeg', compress: false },
  '.webp': { type: 'image/webp', compress: false },
  '.ico': { type: 'image/x-icon', compress: false },
  '.woff2': { type: 'font/woff2', compress: false },
};
const FALLBACK_TYPE = { type: 'application/octet-stream', compress: false };

const NOT_FOUND_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Not found</title>
  </head>
  <body>
    <h1>Not found</h1>
    <p><a href="/">Front page</a></p>
  </body>
</html>
`;

/** Maps a URL pathname to a file path inside `root`, or null when it must not be served. */
export function resolveFile(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const file = path.join(root, path.normalize(decoded));
  if (file !== root && !file.startsWith(root + path.sep)) return null;
  // Dotfiles and installed packages are not part of the site.
  const segments = path.relative(root, file).split(path.sep);
  if (segments.some((segment) => segment.startsWith('.') || segment === 'node_modules')) return null;
  return file;
}

/** True when an Accept-Encoding header value allows a gzip response. */
export function acceptsGzip(header) {
  if (typeof header !== 'string') return false;
  let wildcard = null;
  for (const part of header.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    const quality = params.map((param) => /^\s*q=([0-9.]+)\s*$/.exec(param)).find(Boolean);
    const allowed = quality ? Number(quality[1]) > 0 : true;
    const coding = name.trim();
    if (coding === 'gzip' || coding === 'x-gzip') return allowed;
    if (coding === '*') wildcard = allowed;
  }
  return wildcard === true;
}

/** Weak validator from size and modification time: W/"<size>-<mtime ms>", both in hex. */
export function etagOf(stats) {
  return `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
}

const opaqueTag = (etag) => etag.trim().replace(/^W\//, '');

/** True when the request's validators say the client's copy is still current. */
export function isNotModified(headers, etag, mtimeMs) {
  const ifNoneMatch = headers['if-none-match'];
  if (ifNoneMatch !== undefined) {
    // If-None-Match takes precedence over If-Modified-Since (RFC 9110, section 13.2.2).
    if (ifNoneMatch.trim() === '*') return true;
    return ifNoneMatch.split(',').some((candidate) => opaqueTag(candidate) === opaqueTag(etag));
  }
  const ifModifiedSince = headers['if-modified-since'];
  if (ifModifiedSince !== undefined) {
    const since = Date.parse(ifModifiedSince);
    // HTTP dates have one-second resolution.
    return Number.isFinite(since) && Math.floor(mtimeMs / 1000) * 1000 <= since;
  }
  return false;
}

async function statFile(file) {
  try {
    const stats = await stat(file);
    if (stats.isDirectory()) {
      const index = path.join(file, 'index.html');
      const indexStats = await stat(index);
      return indexStats.isFile() ? { file: index, stats: indexStats } : null;
    }
    return stats.isFile() ? { file, stats } : null;
  } catch {
    return null;
  }
}

function sendText(req, res, status, type, body, extraHeaders = {}) {
  const buffer = Buffer.from(body);
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': buffer.length,
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(req.method === 'HEAD' ? undefined : buffer);
}

async function handle(root, req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(req, res, 405, 'text/plain; charset=utf-8', 'Method not allowed\n', { Allow: 'GET, HEAD' });
    return;
  }

  let pathname;
  try {
    pathname = new URL(req.url ?? '/', 'http://fixture.invalid').pathname;
  } catch {
    sendText(req, res, 400, 'text/plain; charset=utf-8', 'Bad request\n');
    return;
  }

  const requested = resolveFile(root, pathname);
  const found = requested ? await statFile(requested) : null;
  if (!found) {
    sendText(req, res, 404, 'text/html; charset=utf-8', NOT_FOUND_PAGE);
    return;
  }

  const { file, stats } = found;
  const { type, compress } = TYPES[path.extname(file).toLowerCase()] ?? FALLBACK_TYPE;
  const etag = etagOf(stats);
  const headers = {
    ETag: etag,
    'Last-Modified': new Date(stats.mtimeMs).toUTCString(),
    'Cache-Control': 'no-cache',
  };
  // The body depends on Accept-Encoding only for the formats that get compressed.
  if (compress) headers.Vary = 'Accept-Encoding';

  if (isNotModified(req.headers, etag, stats.mtimeMs)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  headers['Content-Type'] = type;
  const gzip = compress && acceptsGzip(req.headers['accept-encoding']);
  if (gzip) headers['Content-Encoding'] = 'gzip';
  else headers['Content-Length'] = stats.size;
  res.writeHead(200, headers);

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const source = createReadStream(file);
  const onDone = (error) => {
    // Headers are already sent, so a read error can only end the connection.
    if (error) res.destroy();
  };
  if (gzip) pipeline(source, zlib.createGzip(), res, onDone);
  else pipeline(source, res, onDone);
}

/** An http.Server that serves the files under `root` (default: this directory). */
export function createStaticServer({ root = ROOT } = {}) {
  return http.createServer((req, res) => {
    handle(root, req, res).catch(() => {
      if (res.headersSent) res.destroy();
      else sendText(req, res, 500, 'text/plain; charset=utf-8', 'Internal error\n');
    });
  });
}

function parsePort(value) {
  if (value === undefined || value === '') return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be an integer from 0 to 65535, got "${value}"`);
  }
  return port;
}

// realpath, because Node resolves symlinks for import.meta.url but not for argv (on macOS a
// copy under /tmp or /var is reached through a symlink).
function isMainModule() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

const isMain = isMainModule();

if (isMain) {
  const host = process.env.HOST || DEFAULT_HOST;
  let port;
  try {
    port = parsePort(process.env.PORT);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  const server = createStaticServer();
  server.on('error', (error) => {
    console.error(`static-html: ${error.message}`);
    process.exit(1);
  });
  server.listen(port, host, () => {
    console.log(`static-html fixture listening on http://${host}:${server.address().port}`);
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
      server.closeAllConnections();
    });
  }
}
