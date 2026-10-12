#!/usr/bin/env node
/**
 * Renders `apps/web/public/icons/icon-*.png` from `apps/client/build/icon.png` — the same
 * icon the desktop app ships, so a user who has both installed sees one glyph, not two. Run
 * via `pnpm --filter @tm/web icons`; the output is committed (a PWA manifest needs real files
 * on disk, not a build step every deploy would have to remember to run).
 *
 * No `sharp`/`jimp`/etc: the source is a plain 8-bit RGBA, non-interlaced PNG — the simplest
 * case the format has — so decoding, resizing and re-encoding it is a few dozen lines against
 * Node's own `zlib`, versus a native dependency pnpm would need a build-script approval for
 * (`pnpm-workspace.yaml`'s `allowBuilds`) just to scale one square image.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

const repoRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const SOURCE_ICON = join(repoRoot, 'apps', 'client', 'build', 'icon.png');
const OUT_DIR = join(repoRoot, 'apps', 'web', 'public', 'icons');

/** The manifest's installability minimum (192, 512) plus the favicon `index.html` links. */
const SIZES = [48, 192, 512];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Decodes an 8-bit RGBA, non-interlaced PNG into raw pixels. Deliberately narrow — it throws
 * on anything else — rather than a general decoder this script has no other use for.
 */
function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`${SOURCE_ICON} is not a PNG file`);
  }

  let offset = 8;
  let ihdr = null;
  const idatChunks = [];
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') ihdr = data;
    else if (type === 'IDAT') idatChunks.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (!ihdr) throw new Error(`${SOURCE_ICON} has no IHDR chunk`);

  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr.readUInt8(8);
  const colorType = ihdr.readUInt8(9);
  const interlace = ihdr.readUInt8(12);
  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
    throw new Error(
      `${SOURCE_ICON} must be 8-bit RGBA, non-interlaced (got bitDepth=${bitDepth}, ` +
        `colorType=${colorType}, interlace=${interlace}) — this script only decodes that form`,
    );
  }

  const raw = inflateSync(Buffer.concat(idatChunks));
  const stride = width * 4;
  const pixels = Buffer.alloc(height * stride);
  let rawOffset = 0;
  for (let y = 0; y < height; y++) {
    const filterType = raw[rawOffset];
    rawOffset += 1;
    const rowStart = y * stride;
    const prevRowStart = rowStart - stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[rawOffset + x];
      const a = x >= 4 ? pixels[rowStart + x - 4] : 0;
      const b = y > 0 ? pixels[prevRowStart + x] : 0;
      const c = y > 0 && x >= 4 ? pixels[prevRowStart + x - 4] : 0;
      let reconstructed;
      switch (filterType) {
        case 0:
          reconstructed = value;
          break;
        case 1:
          reconstructed = value + a;
          break;
        case 2:
          reconstructed = value + b;
          break;
        case 3:
          reconstructed = value + ((a + b) >> 1);
          break;
        case 4:
          reconstructed = value + paeth(a, b, c);
          break;
        default:
          throw new Error(`unsupported PNG filter type ${filterType}`);
      }
      pixels[rowStart + x] = reconstructed & 0xff;
    }
    rawOffset += stride;
  }
  return { width, height, pixels };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Bilinear resample — the icon is a flat vector-style mark, not a photo, so this is plenty. */
function resize(src, dstW, dstH) {
  const { width: srcW, height: srcH, pixels } = src;
  const dst = Buffer.alloc(dstW * dstH * 4);
  const xRatio = srcW / dstW;
  const yRatio = srcH / dstH;
  for (let dy = 0; dy < dstH; dy++) {
    const sy = (dy + 0.5) * yRatio - 0.5;
    const sy0 = Math.min(srcH - 1, Math.max(0, Math.floor(sy)));
    const sy1 = Math.min(srcH - 1, sy0 + 1);
    const fy = Math.min(1, Math.max(0, sy - sy0));
    for (let dx = 0; dx < dstW; dx++) {
      const sx = (dx + 0.5) * xRatio - 0.5;
      const sx0 = Math.min(srcW - 1, Math.max(0, Math.floor(sx)));
      const sx1 = Math.min(srcW - 1, sx0 + 1);
      const fx = Math.min(1, Math.max(0, sx - sx0));
      for (let channel = 0; channel < 4; channel++) {
        const p00 = pixels[(sy0 * srcW + sx0) * 4 + channel];
        const p10 = pixels[(sy0 * srcW + sx1) * 4 + channel];
        const p01 = pixels[(sy1 * srcW + sx0) * 4 + channel];
        const p11 = pixels[(sy1 * srcW + sx1) * 4 + channel];
        const top = p00 + (p10 - p00) * fx;
        const bottom = p01 + (p11 - p01) * fx;
        dst[(dy * dstW + dx) * 4 + channel] = Math.round(top + (bottom - top) * fy);
      }
    }
  }
  return { width: dstW, height: dstH, pixels: dst };
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePng({ width, height, pixels }) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None) for every scanline
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(6, 9); // color type: RGBA
  ihdr.writeUInt8(0, 10); // compression
  ihdr.writeUInt8(0, 11); // filter
  ihdr.writeUInt8(0, 12); // interlace
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function main() {
  const source = decodePng(readFileSync(SOURCE_ICON));
  mkdirSync(OUT_DIR, { recursive: true });
  for (const size of SIZES) {
    const sized = size === source.width && size === source.height ? source : resize(source, size, size);
    const outPath = join(OUT_DIR, `icon-${size}.png`);
    writeFileSync(outPath, encodePng(sized));
    console.log(`wrote ${outPath} (${size}x${size})`);
  }
}

main();
