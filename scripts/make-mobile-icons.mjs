/**
 * Generates apps/mobile's two install icons — icon-192.png and icon-512.png — without
 * adding an image library. A PWA install icon is a one-time, unmoving asset (a filled
 * circle on the app's own background colour); pulling in `sharp` or `canvas` to draw two
 * squares would be a native-module dependency, with its own ABI story
 * (`verify-electron-app`), for something Node's own `zlib` already has every piece of:
 * `deflateSync` for the IDAT stream, and a hand-rolled CRC32 (PNG's own checksum, not
 * exposed by any Node built-in) for each chunk trailer.
 *
 *     node scripts/make-mobile-icons.mjs
 *
 * Colours match the app exactly rather than approximating it: `#1f1f1f` is
 * `useGlobalStyles`' page background (packages/ui/src/theme.ts), and `#22E4FF` is
 * `FLUO.cyan` (packages/shared/src/theme's live/in-progress colour) — the only accent this
 * app already uses for "this is alive", which is what an app icon is.
 *
 * Both icons declare `purpose: "any maskable"` in the manifest (one file serves both
 * roles), which is why the mark sits inside a circle of radius 0.32×size rather than
 * filling the square: Android's maskable spec crops to different shapes (circle, squircle,
 * rounded square) and only guarantees the inner 80%-diameter safe zone survives every one
 * of them. 0.32 leaves a visible margin inside that 0.4 limit rather than running up to it.
 *
 * Self-verifying: after writing each file, this script re-reads it and asserts the PNG
 * signature and the width/height the IHDR chunk actually declares match what was asked
 * for, in the same PASS/FAIL style as verify-resume-migration.mjs. It fails loudly if,
 * say, the IHDR byte offsets above are wrong — prove that yourself by changing `12` to
 * `11` in `assertPng` below and re-running.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'apps', 'mobile', 'public', 'icons');

const BACKGROUND = [0x1f, 0x1f, 0x1f];
const MARK = [0x22, 0xe4, 0xff];
const SIZES = [192, 512];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/** One filled circle, `MARK` on `BACKGROUND`, no transparency — see the header. */
function renderPixels(size) {
  const center = size / 2;
  const radius = size * 0.32;
  // +1 byte per row for the filter type (0 = None), 3 bytes (RGB) per pixel.
  const raw = Buffer.alloc(size * (1 + size * 3));
  let offset = 0;
  for (let y = 0; y < size; y++) {
    raw[offset++] = 0;
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - center;
      const dy = y + 0.5 - center;
      const [r, g, b] = dx * dx + dy * dy <= radius * radius ? MARK : BACKGROUND;
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
    }
  }
  return raw;
}

function buildPng(size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolor RGB, no alpha
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace method: none

  const idat = deflateSync(renderPixels(size), { level: 9 });

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function assertPng(buffer, expectedSize) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('not a PNG: signature mismatch');
  }
  const chunkType = buffer.subarray(12, 16).toString('ascii');
  if (chunkType !== 'IHDR') {
    throw new Error(`expected the IHDR chunk first, got "${chunkType}"`);
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width !== expectedSize || height !== expectedSize) {
    throw new Error(`expected ${expectedSize}x${expectedSize}, got ${width}x${height}`);
  }
}

mkdirSync(outDir, { recursive: true });

let failures = 0;
for (const size of SIZES) {
  const outPath = join(outDir, `icon-${size}.png`);
  try {
    writeFileSync(outPath, buildPng(size));
    assertPng(readFileSync(outPath), size);
    console.log(`PASS  icon-${size}.png written and verified at ${size}x${size}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  icon-${size}.png — ${err.message}`);
  }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
