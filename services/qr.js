/**
 * A QR encoder, byte mode, versions 1-10.
 *
 * Written rather than depended on because the only thing this needs to encode
 * is one short URL — the tailnet address, so a phone can be pointed at the
 * launcher and open the app without anyone typing
 * `https://desktop-9dikq29.taila824ee.ts.net` by hand.
 *
 * Scope is deliberately narrow. Byte mode only (a URL is not numeric and not
 * alphanumeric once it has a colon and slashes in it), versions 1-10 (enough
 * for ~200 characters at level M), and error correction level M, which is the
 * usual choice for something displayed on a screen rather than printed on a
 * box that might get scuffed.
 *
 * The parts that are easy to get subtly wrong, and are therefore tested
 * directly: the Reed-Solomon generator polynomial, block interleaving above
 * version 2, the eight mask patterns and the penalty rules that choose between
 * them, and the format bits — which carry their own BCH code and are XORed
 * with a fixed pattern so that an all-zero format never looks valid.
 */

/* --------------------------------------------------------------------------
 * Galois field GF(256), primitive polynomial 0x11d
 * ----------------------------------------------------------------------- */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
})();

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** The generator polynomial for `degree` error-correction codewords. */
export function generatorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= mul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** Reed-Solomon remainder: the EC codewords for one block. */
export function ecCodewords(data, degree) {
  const generator = generatorPoly(degree);
  const remainder = new Array(degree).fill(0);

  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.shift();
    remainder.push(0);
    for (let i = 0; i < degree; i += 1) {
      remainder[i] ^= mul(generator[i + 1], factor);
    }
  }
  return remainder;
}

/* --------------------------------------------------------------------------
 * Version tables, level M
 *
 * Per version: total codewords, EC codewords per block, and the block layout
 * as [count, dataCodewords] groups. Straight from the specification's tables;
 * the arithmetic that consumes them is checked in the tests.
 * ----------------------------------------------------------------------- */

const VERSIONS_M = {
  1: { total: 26, ecPerBlock: 10, groups: [[1, 16]] },
  2: { total: 44, ecPerBlock: 16, groups: [[1, 28]] },
  3: { total: 70, ecPerBlock: 26, groups: [[1, 44]] },
  4: { total: 100, ecPerBlock: 18, groups: [[2, 32]] },
  5: { total: 134, ecPerBlock: 24, groups: [[2, 43]] },
  6: { total: 172, ecPerBlock: 16, groups: [[4, 27]] },
  7: { total: 196, ecPerBlock: 18, groups: [[4, 31]] },
  8: { total: 242, ecPerBlock: 22, groups: [[2, 38], [2, 39]] },
  9: { total: 292, ecPerBlock: 22, groups: [[3, 36], [2, 37]] },
  10: { total: 346, ecPerBlock: 26, groups: [[4, 43], [1, 44]] }
};

/** Where the alignment patterns go, per version. */
const ALIGNMENT = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
};

export const sizeForVersion = (version) => version * 4 + 17;

/** Total data codewords a version holds at level M. */
export function dataCapacity(version) {
  const spec = VERSIONS_M[version];
  if (!spec) return 0;
  return spec.groups.reduce((sum, [count, size]) => sum + count * size, 0);
}

/**
 * The smallest version that fits `byteLength` in byte mode.
 *
 * The header is four bits of mode plus a length field — eight bits below
 * version 10, sixteen from version 10 up — so the threshold is not a simple
 * subtraction and is worth computing rather than approximating.
 */
export function chooseVersion(byteLength) {
  for (let version = 1; version <= 10; version += 1) {
    const lengthBits = version < 10 ? 8 : 16;
    const needed = 4 + lengthBits + byteLength * 8;
    if (needed <= dataCapacity(version) * 8) return version;
  }
  return null;
}

/* --------------------------------------------------------------------------
 * Bit stream
 * ----------------------------------------------------------------------- */

function toBitStream(bytes, version) {
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
  };

  push(0b0100, 4);                                  // byte mode
  push(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) push(byte, 8);

  const capacityBits = dataCapacity(version) * 8;
  // Terminator, up to four bits, then pad to a byte boundary.
  for (let i = 0; i < 4 && bits.length < capacityBits; i += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  // The two alternating pad bytes are specified; anything else would decode
  // but marks the encoder as non-conforming.
  const pads = [0xec, 0x11];
  let padIndex = 0;
  while (bits.length < capacityBits) {
    push(pads[padIndex % 2], 8);
    padIndex += 1;
  }

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }
  return codewords;
}

/**
 * Split into blocks, compute EC for each, and interleave.
 *
 * Interleaving is the step that silently produces an unscannable code if it is
 * skipped: for a single-block version the output happens to be identical, so
 * a version-1 code works and a version-4 one does not.
 */
export function interleave(codewords, version) {
  const spec = VERSIONS_M[version];
  const blocks = [];

  let offset = 0;
  for (const [count, size] of spec.groups) {
    for (let i = 0; i < count; i += 1) {
      const data = codewords.slice(offset, offset + size);
      offset += size;
      blocks.push({ data, ec: ecCodewords(data, spec.ecPerBlock) });
    }
  }

  const out = [];
  const longest = Math.max(...blocks.map((block) => block.data.length));
  for (let i = 0; i < longest; i += 1) {
    for (const block of blocks) if (i < block.data.length) out.push(block.data[i]);
  }
  for (let i = 0; i < spec.ecPerBlock; i += 1) {
    for (const block of blocks) out.push(block.ec[i]);
  }
  return out;
}

/* --------------------------------------------------------------------------
 * Matrix
 * ----------------------------------------------------------------------- */

const newMatrix = (size) => Array.from({ length: size }, () => new Array(size).fill(null));

function placeFinder(matrix, row, col) {
  for (let r = -1; r <= 7; r += 1) {
    for (let c = -1; c <= 7; c += 1) {
      const rr = row + r;
      const cc = col + c;
      if (rr < 0 || cc < 0 || rr >= matrix.length || cc >= matrix.length) continue;
      const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6))
        || (c >= 0 && c <= 6 && (r === 0 || r === 6));
      const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      matrix[rr][cc] = inRing || inCore ? 1 : 0;
    }
  }
}

function placeFunctionPatterns(matrix, version) {
  const size = matrix.length;

  placeFinder(matrix, 0, 0);
  placeFinder(matrix, 0, size - 7);
  placeFinder(matrix, size - 7, 0);

  // Timing patterns, alternating from the fixed offset of 6.
  for (let i = 8; i < size - 8; i += 1) {
    const bit = i % 2 === 0 ? 1 : 0;
    matrix[6][i] = bit;
    matrix[i][6] = bit;
  }

  for (const row of ALIGNMENT[version]) {
    for (const col of ALIGNMENT[version]) {
      // Alignment patterns never overlap a finder.
      if ((row <= 8 && col <= 8) || (row <= 8 && col >= size - 9) || (row >= size - 9 && col <= 8)) continue;
      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) {
          matrix[row + r][col + c] = Math.max(Math.abs(r), Math.abs(c)) !== 1 ? 1 : 0;
        }
      }
    }
  }

  // The dark module: always set, always here.
  matrix[size - 8][8] = 1;
}

/** Which cells are reserved for format and version information. */
function reserveFormat(matrix) {
  const size = matrix.length;
  for (let i = 0; i < 9; i += 1) {
    if (matrix[8][i] === null) matrix[8][i] = 0;
    if (matrix[i][8] === null) matrix[i][8] = 0;
  }
  for (let i = 0; i < 8; i += 1) {
    if (matrix[8][size - 1 - i] === null) matrix[8][size - 1 - i] = 0;
    if (matrix[size - 1 - i][8] === null) matrix[size - 1 - i][8] = 0;
  }
}

/** Zig-zag placement of the data bits, skipping the timing column. */
function placeData(matrix, codewords, reserved) {
  const size = matrix.length;
  const bits = [];
  for (const byte of codewords) {
    for (let i = 7; i >= 0; i -= 1) bits.push((byte >> i) & 1);
  }

  let bit = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    // Column 6 is the vertical timing pattern and is not part of the path.
    const rightCol = right <= 6 ? right - 1 : right;
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (const col of [rightCol, rightCol - 1]) {
        if (reserved[row][col]) continue;
        matrix[row][col] = bit < bits.length ? bits[bit] : 0;
        bit += 1;
      }
    }
    upward = !upward;
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
];

/**
 * The four penalty rules, summed.
 *
 * These exist to stop a mask producing something that looks like a finder
 * pattern or a large blank field, either of which confuses a scanner.
 */
export function maskPenalty(matrix) {
  const size = matrix.length;
  let penalty = 0;

  // Rule 1: runs of five or more of the same colour.
  for (let i = 0; i < size; i += 1) {
    for (const line of [matrix[i], matrix.map((row) => row[i])]) {
      let run = 1;
      for (let j = 1; j < size; j += 1) {
        if (line[j] === line[j - 1]) {
          run += 1;
          if (run === 5) penalty += 3;
          else if (run > 5) penalty += 1;
        } else run = 1;
      }
    }
  }

  // Rule 2: 2x2 blocks of one colour.
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const v = matrix[r][c];
      if (v === matrix[r][c + 1] && v === matrix[r + 1][c] && v === matrix[r + 1][c + 1]) penalty += 3;
    }
  }

  // Rule 3: the finder-like 1:1:3:1:1 sequence with four light modules beside it.
  const pattern = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const reversed = [...pattern].reverse();
  const matches = (line, at, seq) => seq.every((value, k) => line[at + k] === value);
  for (let i = 0; i < size; i += 1) {
    for (const line of [matrix[i], matrix.map((row) => row[i])]) {
      for (let j = 0; j + 11 <= size; j += 1) {
        if (matches(line, j, pattern) || matches(line, j, reversed)) penalty += 40;
      }
    }
  }

  // Rule 4: how far the proportion of dark modules is from half.
  let dark = 0;
  for (const row of matrix) for (const cell of row) if (cell) dark += 1;
  const percent = (dark * 100) / (size * size);
  penalty += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return penalty;
}

/**
 * Format information: EC level and mask, BCH-protected and XOR-masked.
 *
 * The XOR is what stops an all-zero format from reading as valid, so omitting
 * it produces a code that a scanner rejects outright rather than misreads.
 */
export function formatBits(maskIndex) {
  const LEVEL_M = 0b00;
  let value = (LEVEL_M << 3) | maskIndex;

  let bch = value << 10;
  for (let i = 14; i >= 10; i -= 1) {
    if ((bch >> i) & 1) bch ^= 0b10100110111 << (i - 10);
  }
  return ((value << 10) | bch) ^ 0b101010000010010;
}

function applyFormat(matrix, maskIndex) {
  const size = matrix.length;
  const bits = formatBits(maskIndex);
  const at = (i) => (bits >> i) & 1;

  for (let i = 0; i <= 5; i += 1) matrix[8][i] = at(i);
  matrix[8][7] = at(6);
  matrix[8][8] = at(7);
  matrix[7][8] = at(8);
  for (let i = 9; i <= 14; i += 1) matrix[14 - i][8] = at(i);

  /*
   * Bits 0-6 fill the vertical strip above the bottom-left finder, and 7-14
   * the horizontal strip beside the top-right one. Seven and eight, not eight
   * and seven: the eighth cell of the vertical strip is the dark module, and
   * running the loop one further overwrites it — which a scanner reads as a
   * malformed code even though everything else is correct.
   */
  for (let i = 0; i <= 6; i += 1) matrix[size - 1 - i][8] = at(i);
  for (let i = 7; i <= 14; i += 1) matrix[8][size - 15 + i] = at(i);
}

/**
 * Encode `text` as a matrix of 0/1.
 *
 * Returns null when the text is too long for version 10 at level M, rather
 * than silently truncating — a QR that encodes half a URL is worse than none.
 */
export function encode(text) {
  const bytes = Array.from(new TextEncoder().encode(String(text ?? '')));
  const version = chooseVersion(bytes.length);
  if (!version) return null;

  const size = sizeForVersion(version);
  const base = newMatrix(size);
  placeFunctionPatterns(base, version);
  reserveFormat(base);

  // Everything placed so far is a function pattern, so this snapshot is
  // exactly the set of cells the data must not overwrite.
  const reserved = base.map((row) => row.map((cell) => cell !== null));

  const codewords = interleave(toBitStream(bytes, version), version);
  const matrix = base.map((row) => [...row]);
  placeData(matrix, codewords, reserved);

  let best = null;
  for (let maskIndex = 0; maskIndex < 8; maskIndex += 1) {
    const candidate = matrix.map((row, r) => row.map((cell, c) => (
      reserved[r][c] ? cell : cell ^ (MASKS[maskIndex](r, c) ? 1 : 0)
    )));
    applyFormat(candidate, maskIndex);
    const penalty = maskPenalty(candidate);
    if (!best || penalty < best.penalty) best = { matrix: candidate, penalty, maskIndex };
  }

  return { matrix: best.matrix, version, size, mask: best.maskIndex };
}

/**
 * The same thing as an SVG.
 *
 * A quiet zone of four modules is part of the specification, not padding:
 * without it a scanner cannot find the edges against a busy background.
 */
export function toSvg(text, { moduleSize = 6, quiet = 4, dark = '#000000', light = '#ffffff' } = {}) {
  const result = encode(text);
  if (!result) return null;

  const total = (result.size + quiet * 2) * moduleSize;
  const rects = [];
  for (let r = 0; r < result.size; r += 1) {
    for (let c = 0; c < result.size; c += 1) {
      if (!result.matrix[r][c]) continue;
      const x = (c + quiet) * moduleSize;
      const y = (r + quiet) * moduleSize;
      rects.push(`<rect x="${x}" y="${y}" width="${moduleSize}" height="${moduleSize}"/>`);
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${total}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">`
    + `<rect width="${total}" height="${total}" fill="${light}"/>`
    + `<g fill="${dark}">${rects.join('')}</g></svg>`;
}

export default {
  encode, toSvg, chooseVersion, dataCapacity, sizeForVersion,
  generatorPoly, ecCodewords, interleave, maskPenalty, formatBits
};
