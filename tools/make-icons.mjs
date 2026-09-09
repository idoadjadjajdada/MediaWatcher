/**
 * Generate the icons and the favicon from the project mark.
 *
 * Kept as a script rather than committing only its output, so the icons can be
 * regenerated if the mark changes, and so nobody has to wonder where a binary
 * in the repo came from. The mark itself is `public/icons/logo.png`, committed
 * beside the icons it produces — replace that file, run this, and every size
 * the app declares follows.
 *
 * The PNG writer is still by hand: a PNG is a zlib stream plus four chunks, and
 * adding an image library to a media server for that would be the wrong trade.
 * The *resampling* is ffmpeg's, which is a different job and one this project
 * already depends on for every thumbnail it draws — writing a JPEG-quality
 * downscaler by hand would be the wrong trade in the other direction.
 *
 * This also rewrites the inline favicon in index.html and login.html. It has to:
 * the login page is served before the gate, so a favicon it had to *fetch* from
 * /icons would answer 401 to anyone not signed in, and the tab would fall back
 * to a blank sheet on the one page every new device sees first. Inlining it
 * keeps that request from existing, and rewriting both files here keeps them
 * from drifting from the mark.
 *
 * Run: node tools/make-icons.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'public', 'icons');
const SOURCE = path.join(OUT_DIR, 'logo.png');
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

/** Pages carrying an inline favicon, both of which this script keeps current. */
const PAGES = [path.join(ROOT, 'public', 'index.html'), path.join(ROOT, 'public', 'login.html')];

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
 * Decode part of the mark to raw pixels at a given size.
 *
 * `crop` is applied before the scale so the filter sees only the region that
 * survives, which is what keeps a heavy downscale from averaging in margins
 * that were never going to be drawn.
 */
function decode(width, height, crop = null) {
  const filters = [];
  if (crop) filters.push(`crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`);
  filters.push(`scale=${width}:${height}:flags=lanczos`);

  const result = spawnSync(FFMPEG, [
    '-v', 'error',
    '-i', SOURCE,
    '-vf', filters.join(','),
    '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'
  ], { maxBuffer: 1 << 28 });

  if (result.error) {
    throw new Error(`could not run ${FFMPEG}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed: ${String(result.stderr).trim() || `exit ${result.status}`}`);
  }
  if (result.stdout.length !== width * height * 4) {
    throw new Error(`expected ${width * height * 4} bytes from ffmpeg, got ${result.stdout.length}`);
  }
  return result.stdout;
}

/**
 * The mark's field colour and the box the drawing actually occupies.
 *
 * Measured rather than written down, so replacing logo.png reframes everything
 * on its own. The field is taken from a corner: a mark is never drawn into the
 * very corner of its own canvas, and everything that differs from it is the
 * mark. Alpha counts too, for a source that arrives cut out rather than on a
 * background of its own.
 */
function measure(sourceWidth, sourceHeight) {
  // Big enough that a thin outline is several pixels wide, small enough to scan
  // in no time at all.
  const probe = 512;
  const pixels = decode(probe, probe);
  const field = [pixels[0], pixels[1], pixels[2]];

  /*
   * A mark that arrives already cut out is found by its alpha, and only by its
   * alpha. Colour cannot help here: this one is black around the skull and
   * black inside it, so "not the corner colour" would lose the outline, the
   * sockets and the mouth. A transparent corner is the tell.
   */
  const cutOutSource = pixels[3] < 8;

  const differs = cutOutSource
    ? (i) => pixels[i + 3] >= 8
    : (i) => Math.max(
      Math.abs(pixels[i] - field[0]),
      Math.abs(pixels[i + 1] - field[1]),
      Math.abs(pixels[i + 2] - field[2])
    ) > 24;

  let minX = probe;
  let minY = probe;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < probe; y += 1) {
    for (let x = 0; x < probe; x += 1) {
      if (!differs((y * probe + x) * 4)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < 0) throw new Error('the mark appears to be a single flat colour');

  // Back to source pixels, rounded outward so nothing at the edge is shaved.
  const scaleX = sourceWidth / probe;
  const scaleY = sourceHeight / probe;
  return {
    field,
    cutOutSource,
    box: {
      x: Math.floor(minX * scaleX),
      y: Math.floor(minY * scaleY),
      w: Math.min(sourceWidth, Math.ceil((maxX + 1) * scaleX)) - Math.floor(minX * scaleX),
      h: Math.min(sourceHeight, Math.ceil((maxY + 1) * scaleY)) - Math.floor(minY * scaleY)
    }
  };
}

/**
 * Draw the mark on a square of nothing at all, at a given size.
 *
 * `fill` is how tall the drawing stands as a fraction of the icon, and it is
 * the only number that separates the variants. A launcher may crop an installed
 * icon to a circle, so the maskable ones stand shorter to keep every corner of
 * the mark inside that circle; the ordinary ones stand tall because nothing is
 * going to cut them.
 */
function drawPixels(size, { field, box }, fill) {
  const drawnHeight = Math.max(1, Math.round(size * fill));
  const drawnWidth = Math.max(1, Math.round(drawnHeight * (box.w / box.h)));
  const mark = decode(drawnWidth, drawnHeight, box);

  /*
   * Transparent, deliberately.
   *
   * These used to be drawn onto the mark's own field colour, on the reasoning
   * that a launcher composites an icon onto whatever it likes and a
   * transparent one picks up a white sheet. That trade is the wrong way round
   * for a mark that is a cut-out shape rather than a picture in a box: the
   * field arrives as a pale rectangle behind the skull on every dark surface
   * the icon lands on. So the square stays empty and each platform puts
   * whatever it wants behind it.
   */
  const rgba = Buffer.alloc(size * size * 4);

  const left = Math.round((size - drawnWidth) / 2);
  const top = Math.round((size - drawnHeight) / 2);

  for (let y = 0; y < drawnHeight; y += 1) {
    const canvasY = top + y;
    if (canvasY < 0 || canvasY >= size) continue;

    for (let x = 0; x < drawnWidth; x += 1) {
      const canvasX = left + x;
      if (canvasX < 0 || canvasX >= size) continue;

      const from = (y * drawnWidth + x) * 4;
      const to = (canvasY * size + canvasX) * 4;

      // Copied, alpha and all: there is nothing underneath to blend with, and
      // a soft edge has to stay soft or it will show its own outline.
      rgba[to] = mark[from];
      rgba[to + 1] = mark[from + 1];
      rgba[to + 2] = mark[from + 2];
      rgba[to + 3] = mark[from + 3];
    }
  }

  return rgba;
}

const drawIcon = (size, mark, fill) => encodePng(size, size, drawPixels(size, mark, fill));

/** How tall the mark stands in each kind of icon. */
const FULL = 0.82;
/*
 * A maskable icon may be cropped to a circle of 80% of its width, and the
 * corners of a tall mark are the first thing that circle takes. 0.6 keeps the
 * whole of this one inside it with room to spare.
 */
const SAFE = 0.6;
/** Tab-sized, where every pixel of the mark is worth having. */
const TAB = 0.88;

/** What Windows asks for: the title bar, the task bar, and the tray. */
const ICO_SIZES = [16, 32, 48];

if (!fs.existsSync(SOURCE)) {
  console.error(`no mark at ${path.relative(ROOT, SOURCE)}`);
  process.exit(1);
}

const size = spawnSync(FFMPEG.replace(/ffmpeg(\.exe)?$/i, (m) => m.replace('ffmpeg', 'ffprobe')), [
  '-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'stream=width,height',
  '-of', 'csv=p=0:s=x', SOURCE
], { encoding: 'utf8' });

const [sourceWidth, sourceHeight] = size.status === 0
  ? String(size.stdout).trim().split('x').map(Number)
  // ffprobe sits beside ffmpeg in every distribution, but it is not worth
  // failing over: the measurement below only needs the source's proportions to
  // map a probe back onto it, and a square guess is right for any icon source.
  : [1024, 1024];

const mark = measure(sourceWidth, sourceHeight);
console.log(`mark: ${mark.box.w}x${mark.box.h} at ${mark.box.x},${mark.box.y} `
  + `on rgb(${mark.field.join(', ')})`);

fs.mkdirSync(OUT_DIR, { recursive: true });

const ICONS = [
  ['icon-192.png', 192, FULL],
  ['icon-512.png', 512, FULL],
  ['icon-192-maskable.png', 192, SAFE],
  ['icon-512-maskable.png', 512, SAFE],
  // iOS ignores the manifest's icons and uses apple-touch-icon, which it rounds
  // and composites itself - so it gets the full-size framing.
  ['apple-touch-icon.png', 180, FULL],
  // Not declared anywhere: this one is inlined into the pages below.
  ['favicon.png', 64, TAB]
];

for (const [name, pixels, fill] of ICONS) {
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, drawIcon(pixels, mark, fill));
  console.log(`${name}  ${pixels}x${pixels}  ${fs.statSync(file).size} bytes`);
}

/* --------------------------------------------------------------------------
 * The mark on its own
 *
 * Every icon here is transparent now, so this is the same picture as the rest,
 * cropped to the mark and left at whatever height the pages want. It stays a
 * separate file because the pages ask for a tall mark rather than a square
 * one.
 *
 * A source that arrives with a background still has to have it taken off, and
 * that is done by flooding in from the edges rather than by keying the colour
 * out, because the two are not the same picture. A skull is black *around* its
 * outline and black *inside* it - the sockets, the eye patch, the open mouth -
 * and keying every black pixel would punch the face out along with the
 * background. Only what the border can reach is background.
 * ----------------------------------------------------------------------- */

function cutOut(height, { field, box, cutOutSource }, sourceHeight) {
  /*
   * Nothing to cut: the source arrived without a background, so scaling the
   * box is the whole job. Flooding it would be actively wrong — the flood
   * keys on colour, and the transparent ground here is black, the same black
   * as the outline it would eat its way into.
   */
  if (cutOutSource) {
    const width = Math.max(1, Math.round(height * (box.w / box.h)));
    return { png: encodePng(width, height, decode(width, height, box)), width, height };
  }

  // Worked at full frame, not cropped: the flood needs a border it can be sure
  // is background, and the tight box around the mark has the mark on its edge.
  const frame = Math.max(64, Math.round(height * (sourceHeight / box.h)));
  const pixels = decode(frame, frame);

  const isField = (i) => Math.max(
    Math.abs(pixels[i] - field[0]),
    Math.abs(pixels[i + 1] - field[1]),
    Math.abs(pixels[i + 2] - field[2])
  ) <= 40;

  // Iterative rather than recursive: a background this size is hundreds of
  // thousands of pixels and every one of them would be a stack frame.
  const outside = new Uint8Array(frame * frame);
  const stack = [];
  for (let x = 0; x < frame; x += 1) {
    stack.push(x, (frame - 1) * frame + x);
  }
  for (let y = 0; y < frame; y += 1) {
    stack.push(y * frame, y * frame + frame - 1);
  }

  while (stack.length) {
    const at = stack.pop();
    if (outside[at] || !isField(at * 4)) continue;
    outside[at] = 1;

    const x = at % frame;
    const y = (at - x) / frame;
    if (x > 0) stack.push(at - 1);
    if (x < frame - 1) stack.push(at + 1);
    if (y > 0) stack.push(at - frame);
    if (y < frame - 1) stack.push(at + frame);
  }

  // Crop to the mark itself, in this frame's coordinates.
  const scale = frame / sourceHeight;
  const left = Math.round(box.x * scale);
  const top = Math.round(box.y * scale);
  const width = Math.max(1, Math.round(box.w * scale));
  const tall = Math.max(1, Math.round(box.h * scale));

  const rgba = Buffer.alloc(width * tall * 4);
  for (let y = 0; y < tall; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const from = ((top + y) * frame + (left + x));
      const to = (y * width + x) * 4;
      if (from < 0 || from >= frame * frame) continue;
      rgba[to] = pixels[from * 4];
      rgba[to + 1] = pixels[from * 4 + 1];
      rgba[to + 2] = pixels[from * 4 + 2];
      rgba[to + 3] = outside[from] ? 0 : 255;
    }
  }

  return { png: encodePng(width, tall, rgba), width, height: tall };
}

const cut = cutOut(512, mark, sourceHeight);
fs.writeFileSync(path.join(OUT_DIR, 'mark.png'), cut.png);
console.log(`mark.png  ${cut.width}x${cut.height}  `
  + `${fs.statSync(path.join(OUT_DIR, 'mark.png')).size} bytes  (no background)`);

/* --------------------------------------------------------------------------
 * The Windows icon
 *
 * The launcher and the desktop window are WinForms, and WinForms takes an .ico
 * through GDI+, which is older than the PNG-inside-ICO convention every web
 * tool emits now. So this writes the classic thing: a bitmap per size, bottom
 * up, in BGRA, each one followed by the 1-bit mask that predates the alpha
 * channel and is still required to be there. Every byte of the mask is zero -
 * the icon is opaque, and the alpha channel is what actually gets used.
 * ----------------------------------------------------------------------- */

/** One BITMAPINFOHEADER image, as an .ico entry expects to find it. */
function icoImage(size, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);          // header size
  header.writeInt32LE(size, 4);         // width
  header.writeInt32LE(size * 2, 8);     // height: the image and its mask
  header.writeUInt16LE(1, 12);          // planes
  header.writeUInt16LE(32, 14);         // bits per pixel

  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    // Bottom-up: row 0 of the file is the last row of the picture.
    const from = (size - 1 - y) * size * 4;
    for (let x = 0; x < size; x += 1) {
      const source = from + x * 4;
      const target = (y * size + x) * 4;
      pixels[target] = rgba[source + 2];      // B
      pixels[target + 1] = rgba[source + 1];  // G
      pixels[target + 2] = rgba[source];      // R
      pixels[target + 3] = rgba[source + 3];  // A
    }
  }

  /*
   * The mask, which is not decoration.
   *
   * It predates the alpha channel and Windows still consults it in places —
   * small tray and title-bar renderings among them. It used to be left at all
   * zeros because the icon was opaque; now that it is not, a zeroed mask would
   * draw the transparent ground as a solid rectangle exactly where the icon is
   * smallest. One bit per pixel, set where the pixel is see-through, rows
   * bottom-up and padded to four bytes like everything else in here.
   */
  const stride = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y += 1) {
    const from = (size - 1 - y) * size * 4;
    for (let x = 0; x < size; x += 1) {
      if (rgba[from + x * 4 + 3] >= 128) continue;
      mask[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return Buffer.concat([header, pixels, mask]);
}

function writeIco(file, sizes) {
  const images = sizes.map((size) => icoImage(size, drawPixels(size, mark, FULL)));

  const directory = Buffer.alloc(6 + images.length * 16);
  directory.writeUInt16LE(0, 0);                 // reserved
  directory.writeUInt16LE(1, 2);                 // type: icon
  directory.writeUInt16LE(images.length, 4);

  let offset = directory.length;
  images.forEach((image, index) => {
    const entry = 6 + index * 16;
    directory[entry] = sizes[index] >= 256 ? 0 : sizes[index];
    directory[entry + 1] = sizes[index] >= 256 ? 0 : sizes[index];
    directory[entry + 2] = 0;                    // palette size
    directory[entry + 3] = 0;                    // reserved
    directory.writeUInt16LE(1, entry + 4);       // planes
    directory.writeUInt16LE(32, entry + 6);      // bits per pixel
    directory.writeUInt32LE(image.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += image.length;
  });

  fs.writeFileSync(file, Buffer.concat([directory, ...images]));
  return fs.statSync(file).size;
}

const icoFile = path.join(OUT_DIR, 'app.ico');
console.log(`app.ico  ${ICO_SIZES.join('/')}  ${writeIco(icoFile, ICO_SIZES)} bytes`);

/* --------------------------------------------------------------------------
 * The inline favicon
 * ----------------------------------------------------------------------- */

const favicon = fs.readFileSync(path.join(OUT_DIR, 'favicon.png'));
const href = `data:image/png;base64,${favicon.toString('base64')}`;

const LINK = /<link rel="icon" href="[^"]*">/;

for (const page of PAGES) {
  const html = fs.readFileSync(page, 'utf8');
  const name = path.relative(ROOT, page);

  // Tested rather than inferred from whether the text changed: running this
  // twice leaves the second run with nothing to do, and "already correct" must
  // not report itself as "the link is missing".
  if (!LINK.test(html)) {
    console.warn(`! no favicon link found in ${name}`);
    continue;
  }

  const replaced = html.replace(LINK, `<link rel="icon" href="${href}">`);
  if (replaced === html) {
    console.log(`${name}  favicon already current`);
    continue;
  }

  fs.writeFileSync(page, replaced);
  console.log(`${name}  favicon inlined (${href.length} chars)`);
}
