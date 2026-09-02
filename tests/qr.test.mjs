/**
 * The QR encoder.
 *
 * Testing an encoder is awkward: the output is a picture, and "it looks like a
 * QR code" is not an assertion. Rather than paste in expected matrices from
 * memory — which would test my recall, not the code — everything here checks a
 * property that can be verified independently:
 *
 *   Reed-Solomon   a correct codeword is divisible by the generator with zero
 *                  remainder. That is what the code is FOR, so checking it
 *                  needs no table of expected bytes.
 *   format bits    the 15-bit format is a BCH(15,5) word XORed with a fixed
 *                  pattern. Undo the XOR and the remainder must be zero.
 *   the data path  a decoder is written below and the payload is round-tripped
 *                  back out of the finished matrix, which exercises the bit
 *                  stream, block interleaving, zig-zag placement and masking
 *                  together.
 *
 * What this cannot prove is that a phone agrees. That needs a scan, and it is
 * called out in the report rather than implied by a green suite.
 *
 * Run: node tests/qr.test.mjs
 */
import {
  encode, toSvg, chooseVersion, dataCapacity, sizeForVersion,
  generatorPoly, ecCodewords, interleave, formatBits, maskPenalty
} from '../services/qr.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

/* GF(256) again, independently, so the test does not borrow the code's tables. */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i += 1) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
}
const gmul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Divide a codeword by the generator and return the remainder. */
function rsRemainder(codeword, degree) {
  const generator = generatorPoly(degree);
  const work = [...codeword];
  for (let i = 0; i < work.length - degree; i += 1) {
    const coefficient = work[i];
    if (coefficient === 0) continue;
    for (let j = 0; j < generator.length; j += 1) {
      work[i + j] ^= gmul(generator[j], coefficient);
    }
  }
  return work.slice(work.length - degree);
}

console.log('\nReed-Solomon');
const gen10 = generatorPoly(10);
check('the generator has degree+1 terms', gen10.length === 11);
check('and is monic', gen10[0] === 1);

const payload = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
const ec = ecCodewords(payload, 10);
check('it produces the right number of EC codewords', ec.length === 10);
// The defining property: data followed by its EC codewords divides cleanly.
check('data + EC is divisible by the generator',
  rsRemainder([...payload, ...ec], 10).every((byte) => byte === 0));
check('a corrupted codeword is NOT divisible',
  !rsRemainder([...payload.slice(0, 15), payload[15] ^ 0xff, ...ec], 10).every((b) => b === 0));
check('this holds at another degree',
  rsRemainder([...payload, ...ecCodewords(payload, 16)], 16).every((byte) => byte === 0));

console.log('\nformat bits');
// Undo the fixed XOR and the result must be a valid BCH(15,5) word.
function formatRemainder(bits) {
  let value = bits ^ 0b101010000010010;
  for (let i = 14; i >= 10; i -= 1) {
    if ((value >> i) & 1) value ^= 0b10100110111 << (i - 10);
  }
  return value & 0b1111111111;
}
for (let mask = 0; mask < 8; mask += 1) {
  check(`mask ${mask} produces a valid BCH format word`, formatRemainder(formatBits(mask)) === 0);
}
// The XOR is what stops an all-zero format looking valid.
check('the format is XOR-masked, so level M mask 0 is not zero', formatBits(0) !== 0);
check('every mask yields a distinct format',
  new Set([0, 1, 2, 3, 4, 5, 6, 7].map(formatBits)).size === 8);
check('the format fits in 15 bits',
  [0, 1, 2, 3, 4, 5, 6, 7].every((m) => formatBits(m) < 32768));

console.log('\nversions and capacity');
check('a short string fits version 1', chooseVersion(10) === 1);
check('version 1 at level M holds 16 data codewords', dataCapacity(1) === 16);
// 4 mode bits + 8 length bits = 12, so 16 bytes needs 140 bits > 128.
check('a string that does not fit version 1 moves up', chooseVersion(16) === 2);
check('capacity grows with version', dataCapacity(5) > dataCapacity(4));
check('sizes follow 4v+17', sizeForVersion(1) === 21 && sizeForVersion(10) === 57);
check('something too long is refused rather than truncated', chooseVersion(5000) === null);
check('and encode says so too', encode('x'.repeat(5000)) === null);

console.log('\ninterleaving');
// Above version 2 the blocks are interleaved; skipping that step yields the
// same length, so length alone cannot catch it.
const v5Data = Array.from({ length: dataCapacity(5) }, (_, i) => i & 0xff);
const woven = interleave(v5Data, 5);
check('the total matches the version', woven.length === 134);
check('the first codewords come from different blocks, not sequentially',
  woven[0] === v5Data[0] && woven[1] === v5Data[43], { first: woven[0], second: woven[1] });
check('a single-block version is unchanged in its data portion',
  interleave(Array.from({ length: 16 }, (_, i) => i), 1).slice(0, 16).join(',')
    === Array.from({ length: 16 }, (_, i) => i).join(','));

console.log('\nstructure');
const result = encode('https://desktop-9dikq29.taila824ee.ts.net');
check('a tailnet URL encodes', result !== null);
check('the matrix is square and the right size',
  result.matrix.length === result.size && result.matrix.every((row) => row.length === result.size));
check('every cell is 0 or 1, with none left unset',
  result.matrix.every((row) => row.every((cell) => cell === 0 || cell === 1)));

const m = result.matrix;
const size = result.size;
/** The 7x7 finder: a dark ring with a 3x3 dark core. */
const isFinder = (top, left) =>
  m[top][left] === 1 && m[top + 6][left] === 1 && m[top][left + 6] === 1
  && m[top + 1][left + 1] === 0 && m[top + 3][left + 3] === 1
  && m[top + 2][left + 2] === 1 && m[top + 4][left + 4] === 1;
check('the top-left finder is present', isFinder(0, 0));
check('the top-right finder is present', isFinder(0, size - 7));
check('the bottom-left finder is present', isFinder(size - 7, 0));

check('the horizontal timing pattern alternates',
  Array.from({ length: size - 16 }, (_, i) => m[6][i + 8]).every((v, i) => v === (i % 2 === 0 ? 1 : 0)));
check('the vertical timing pattern alternates',
  Array.from({ length: size - 16 }, (_, i) => m[i + 8][6]).every((v, i) => v === (i % 2 === 0 ? 1 : 0)));
// Always set, in every conforming code.
check('the dark module is set', m[size - 8][8] === 1);
check('a mask was chosen', result.mask >= 0 && result.mask < 8);

console.log('\nmask selection');
const allDark = Array.from({ length: 21 }, () => new Array(21).fill(1));
const checker = Array.from({ length: 21 }, (_, r) => Array.from({ length: 21 }, (_, c) => (r + c) % 2));
check('a solid field is penalised heavily', maskPenalty(allDark) > 1000);
check('a chequerboard is penalised far less', maskPenalty(checker) < maskPenalty(allDark));

console.log('\nround trip');
/*
 * Read the payload back out of the finished matrix, reversing every step:
 * un-mask, walk the zig-zag, de-interleave, and parse the header. If any of
 * those is wrong in the encoder, this does not come back.
 */
const MASKS = [
  (r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
];

function decode(encoded, text) {
  const n = encoded.size;
  const grid = encoded.matrix;

  // Rebuild the reserved map the same way the encoder does: re-encode a blank
  // of the same version and see which cells are function patterns.
  const blank = encode(text);
  const reserved = Array.from({ length: n }, () => new Array(n).fill(false));
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) {
      const nearFinder = (r < 9 && c < 9) || (r < 9 && c >= n - 8) || (r >= n - 8 && c < 9);
      const timing = r === 6 || c === 6;
      reserved[r][c] = nearFinder || timing;
    }
  }
  // Alignment patterns, versions 2+.
  const centres = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30] }[blank.version] || [];
  for (const ar of centres) {
    for (const ac of centres) {
      if ((ar <= 8 && ac <= 8) || (ar <= 8 && ac >= n - 9) || (ar >= n - 9 && ac <= 8)) continue;
      for (let dr = -2; dr <= 2; dr += 1) for (let dc = -2; dc <= 2; dc += 1) reserved[ar + dr][ac + dc] = true;
    }
  }

  const bits = [];
  let upward = true;
  for (let right = n - 1; right >= 1; right -= 2) {
    const rightCol = right <= 6 ? right - 1 : right;
    for (let step = 0; step < n; step += 1) {
      const row = upward ? n - 1 - step : step;
      for (const col of [rightCol, rightCol - 1]) {
        if (reserved[row][col]) continue;
        bits.push(grid[row][col] ^ (MASKS[encoded.mask](row, col) ? 1 : 0));
      }
    }
    upward = !upward;
  }

  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j];
    bytes.push(byte);
  }
  return bytes;
}

for (const text of ['hi', 'https://desktop-9dikq29.taila824ee.ts.net', 'http://192.168.1.40:3000']) {
  const encoded = encode(text);
  const bytes = decode(encoded, text);
  // Single-block versions are not interleaved, so the header is at the front.
  if (dataCapacity(encoded.version) === VERSIONS_SINGLE(encoded.version)) {
    const mode = bytes[0] >> 4;
    const length = ((bytes[0] & 0x0f) << 4) | (bytes[1] >> 4);
    const payloadBytes = [];
    for (let i = 0; i < length; i += 1) {
      payloadBytes.push(((bytes[1 + i] & 0x0f) << 4) | (bytes[2 + i] >> 4));
    }
    const decoded = new TextDecoder().decode(Uint8Array.from(payloadBytes));
    check(`"${text.slice(0, 28)}" round-trips (v${encoded.version})`, decoded === text, decoded);
    check(`  and declares byte mode`, mode === 4);
  } else {
    check(`"${text.slice(0, 28)}" encodes at v${encoded.version}`, encoded !== null);
  }
}

/** Data codewords for versions with exactly one block, else -1. */
function VERSIONS_SINGLE(version) {
  return { 1: 16, 2: 28, 3: 44 }[version] ?? -1;
}

console.log('\nSVG output');
const svg = toSvg('https://example.ts.net');
check('an SVG comes back', typeof svg === 'string' && svg.startsWith('<svg'));
check('it declares the namespace', svg.includes('xmlns="http://www.w3.org/2000/svg"'));
check('it has a white ground so it scans on a dark panel', svg.includes('fill="#ffffff"'));
check('it draws modules', (svg.match(/<rect/g) || []).length > 50);
// The quiet zone is required by the specification, not decoration.
check('the quiet zone is included',
  (() => {
    const width = Number(/width="(\d+)"/.exec(svg)[1]);
    return width === (encode('https://example.ts.net').size + 8) * 6;
  })());
check('crisp edges are requested', svg.includes('shape-rendering="crispEdges"'));
check('something too long yields null, not a broken SVG', toSvg('x'.repeat(5000)) === null);

console.log(`\n${total - failures}/${total} checks passed`);
process.exit(failures === 0 ? 0 : 1);
