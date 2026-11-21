#!/usr/bin/env node
// cls-heldout-2 static server. Dependency-free (Node built-ins only).
// Adapted from fixtures/cls-corpus/server.mjs; the routes behave the same way.
//
//   PORT=0 node server.mjs        -> listens on a free port, prints the URL
//   PORT=4310 node server.mjs     -> listens on 4310
//
// Routes
//   /<path>                 static file under this directory (directories serve index.html)
//   /delay/<ms>/<path>      the same static file, but the response starts <ms> milliseconds
//                           after the request arrived. This is how the held-out set makes layout
//                           shifts deterministic: the page's first paint always happens before
//                           the late resource, and the late resource always arrives at the
//                           same offset.
//
// Every response is sent with "Cache-Control: no-store" so each load is a cold load.

import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MAX_DELAY_MS = 30_000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webm': 'video/webm',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

/** Splits "/delay/800/assets/x.png" into { delayMs: 800, pathname: "/assets/x.png" }. */
export function parseDelay(pathname) {
  const match = /^\/delay\/(\d{1,6})(\/.*)$/.exec(pathname);
  if (!match) return { delayMs: 0, pathname };
  return { delayMs: Math.min(Number(match[1]), MAX_DELAY_MS), pathname: match[2] };
}

/** Maps a URL pathname to a file inside ROOT, or null when it escapes ROOT. */
function resolveFile(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const file = path.join(ROOT, path.normalize(decoded));
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return null;
  return file;
}

function sendText(res, status, text, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(text);
}

async function sendFile(req, res, pathname) {
  let file = resolveFile(pathname);
  if (!file) return sendText(res, 403, 'forbidden');

  let info;
  try {
    info = await stat(file);
    if (info.isDirectory()) {
      if (!pathname.endsWith('/')) {
        // Relative URLs inside a page only work when the directory URL ends with a slash.
        const original = new URL(req.url, 'http://heldout.invalid');
        res.writeHead(302, { Location: original.pathname + '/' + original.search, 'Cache-Control': 'no-store' });
        return res.end();
      }
      file = path.join(file, 'index.html');
      info = await stat(file);
    }
  } catch {
    return sendText(res, 404, 'not found');
  }

  const headers = {
    'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'bytes',
  };

  // Media elements ask for byte ranges; answer them so <video> behaves as it does in production.
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  let start = 0;
  let end = info.size - 1;
  let status = 200;
  if (range && (range[1] !== '' || range[2] !== '') && info.size > 0) {
    if (range[1] === '') {
      start = Math.max(0, info.size - Number(range[2]));
    } else {
      start = Number(range[1]);
      if (range[2] !== '') end = Math.min(Number(range[2]), info.size - 1);
    }
    if (start > end || start >= info.size) {
      return sendText(res, 416, 'range not satisfiable', { 'Content-Range': `bytes */${info.size}` });
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
  }
  headers['Content-Length'] = info.size === 0 ? 0 : end - start + 1;

  res.writeHead(status, headers);
  if (req.method === 'HEAD' || info.size === 0) return res.end();
  const stream = createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/**
 * Starts the held-out server.
 * @param {{ port?: number, host?: string }} [options] port 0 (the default) picks a free port.
 * @returns {Promise<{ server: http.Server, port: number, url: string, close: () => Promise<void> }>}
 */
export async function startServer({ port = 0, host = '127.0.0.1' } = {}) {
  const timers = new Set();

  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'method not allowed');
    const url = new URL(req.url ?? '/', 'http://heldout.invalid');
    const { delayMs, pathname } = parseDelay(url.pathname);
    const respond = () => {
      if (res.destroyed) return;
      sendFile(req, res, pathname).catch(() => {
        if (!res.headersSent) sendText(res, 500, 'internal error');
        else res.destroy();
      });
    };
    if (delayMs === 0) return respond();
    const timer = setTimeout(() => {
      timers.delete(timer);
      respond();
    }, delayMs);
    timers.add(timer);
    res.on('close', () => {
      clearTimeout(timer);
      timers.delete(timer);
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;

  const close = () =>
    new Promise((resolve) => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      server.close(() => resolve());
      server.closeAllConnections();
    });

  return { server, port: actualPort, url: `http://${host}:${actualPort}`, close };
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = process.env.PORT === undefined || process.env.PORT === '' ? 0 : Number(process.env.PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`cls-heldout-2: invalid PORT "${process.env.PORT}"`);
    process.exit(1);
  }
  const running = await startServer({ port, host: process.env.HOST || '127.0.0.1' });
  console.log(`cls-heldout-2 listening on ${running.url}/`);
  const shutdown = () => {
    running.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
