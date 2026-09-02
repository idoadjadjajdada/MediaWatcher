/**
 * Generate the PWA icons.
 *
 * Kept as a script rather than committing only its output, so the icons can be
 * regenerated if the mark changes, and so nobody has to wonder where a binary
 * in the repo came from.
 *
 * Written by hand rather than with a library: a PNG is a zlib stream plus four
 * chunks, and adding an image dependency to a media server to draw a rounded
 * square with a triangle on it would be the wrong trade.
 *
 * The design matches the inline favicon in index.html - a purple-to-pink
 * gradient with a play triangle - so the installed icon and the tab icon are
 * recognisably the same thing.
 *
 * Run: node tools/make-icons.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

/* CRC-32, table built once. Every PNG chunk carries one. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** RGBA pixel buffer to a PNG file. */
function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;    // bit depth
  header[9] = 6;    // colour type: RGBA
  // 10-12 stay zero: deflate, adaptive filtering, no interlace.

  // Each scanline is prefixed with its filter type; 0 means none, which costs
  // some size and keeps this readable.
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/**
 * Draw the mark at a given size.
 *
 * `padding` is what separates a maskable icon from a normal one: Android may
 * crop an installed icon to a circle, so the maskable variant keeps the mark
 * inside the safe zone and lets the gradient bleed to the edges.
 */
function drawIcon(size, { padding = 0, radius = size * 0.22 } = {}) {
  const rgba = Buffer.alloc(size * size * 4);

  const inner = size - padding * 2;
  const triW = inner * 0.30;
  const triH = inner * 0.36;
  const triX = padding + inner * 0.40;
  const triY = padding + (inner - triH) / 2;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;

      // Rounded-square mask. Only the corners need the distance check.
      let inside = true;
      const cx = Math.min(x, size - 1 - x);
      const cy = Math.min(y, size - 1 - y);
      if (cx < radius && cy < radius) {
        const dx = radius - cx;
        const dy = radius - cy;
        inside = Math.hypot(dx, dy) <= radius;
      }
      if (!inside) continue;

      // Diagonal gradient, purple to pink, matching the favicon.
      const t = (x / size + y / size) / 2;
      const r = Math.round(168 + (236 - 168) * t);
      const g = Math.round(85 + (72 - 85) * t);
      const b = Math.round(247 + (153 - 247) * t);

      // The triangle: a point is inside when it is left of the hypotenuse and
      // within the vertical span that narrows towards the tip.
      const ty = y - triY;
      const tx = x - triX;
      const half = triH / 2;
      const inTriangle = tx >= 0 && tx <= triW
        && Math.abs(ty - half) <= half * (1 - tx / triW);

      rgba[i] = inTriangle ? 255 : r;
      rgba[i + 1] = inTriangle ? 255 : g;
      rgba[i + 2] = inTriangle ? 255 : b;
      rgba[i + 3] = 255;
    }
  }

  return encodePng(size, size, rgba);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const ICONS = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  // Maskable: the mark sits inside the safe zone and the square is not rounded,
  // because the launcher applies its own shape.
  ['icon-192-maskable.png', 192, { padding: 192 * 0.14, radius: 0 }],
  ['icon-512-maskable.png', 512, { padding: 512 * 0.14, radius: 0 }],
  // iOS ignores the manifest's icons and uses apple-touch-icon, which is also
  // composited on an opaque background - so it gets the rounded, unpadded one.
  ['apple-touch-icon.png', 180, {}]
];

for (const [name, size, options] of ICONS) {
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, drawIcon(size, options));
  console.log(`${name}  ${size}x${size}  ${fs.statSync(file).size} bytes`);
}
