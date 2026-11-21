#!/usr/bin/env node
// Regenerates the binary assets of the corpus. The outputs are checked in, so this only needs
// to run when an asset changes:
//
//   node fixtures/cls-corpus/scripts/make-assets.mjs
//
// PNGs are written with Node's zlib (no dependencies). The WebM clip needs ffmpeg on PATH; when
// ffmpeg is missing the clip is left as it is and the script says so.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMG_DIR = path.join(ROOT, 'assets', 'img');
const VIDEO_DIR = path.join(ROOT, 'assets', 'video');

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * Encodes an RGB PNG whose rows are all identical (a horizontal gradient with a few bars).
 * Row 0 is stored raw, every other row uses the "Up" filter and is all zeroes, so a
 * 1200x400 image is a few hundred bytes.
 */
function gradientPng(width, height, from, to) {
  const row = Buffer.alloc(width * 3);
  for (let x = 0; x < width; x++) {
    const t = x / (width - 1);
    const bar = Math.floor(x / (width / 12)) % 2 === 0 ? 1 : 0.9;
    for (let c = 0; c < 3; c++) row[x * 3 + c] = Math.round((from[c] + (to[c] - from[c]) * t) * bar);
  }
  const raw = Buffer.alloc((1 + row.length) * height);
  raw[0] = 0; // filter: None
  row.copy(raw, 1);
  for (let y = 1; y < height; y++) raw[y * (1 + row.length)] = 2; // filter: Up, deltas are zero
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const images = [
  ['hero-1200x400.png', 1200, 400, [37, 99, 235], [147, 51, 234]],
  ['card-600x400.png', 600, 400, [5, 150, 105], [13, 148, 136]],
  ['thumb-320x240.png', 320, 240, [234, 88, 12], [202, 138, 4]],
];

mkdirSync(IMG_DIR, { recursive: true });
for (const [name, width, height, from, to] of images) {
  const png = gradientPng(width, height, from, to);
  writeFileSync(path.join(IMG_DIR, name), png);
  console.log(`wrote assets/img/${name} (${png.length} bytes)`);
}

// A one-second 640x360 VP8 clip. Chromium (including Playwright's build) plays VP8 without
// proprietary codecs. -bitexact keeps the output free of encoder version strings.
mkdirSync(VIDEO_DIR, { recursive: true });
const clip = path.join(VIDEO_DIR, 'clip-640x360.webm');
const ffmpeg = spawnSync(
  'ffmpeg',
  [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=10:duration=1',
    '-c:v', 'libvpx', '-b:v', '120k', '-pix_fmt', 'yuv420p', '-an',
    '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact',
    clip,
  ],
  { stdio: 'inherit' },
);
if (ffmpeg.error || ffmpeg.status !== 0) {
  console.log('ffmpeg not available or failed: assets/video/clip-640x360.webm was not regenerated');
} else {
  console.log('wrote assets/video/clip-640x360.webm');
}
