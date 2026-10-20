// A small QR Code encoder (ISO/IEC 18004): byte mode, error correction level M, versions 1-10 (up to 213 bytes of UTF-8).
// Pure TypeScript without dependencies, so the player bundle stays tiny. qr.test.ts checks it against known vectors.

type BlockPlan = { ecPerBlock: number; groups: readonly (readonly [count: number, dataWords: number])[] };

// Level M block structure per version (index = version - 1).
const BLOCKS: readonly BlockPlan[] = [
  { ecPerBlock: 10, groups: [[1, 16]] },
  { ecPerBlock: 16, groups: [[1, 28]] },
  { ecPerBlock: 26, groups: [[1, 44]] },
  { ecPerBlock: 18, groups: [[2, 32]] },
  { ecPerBlock: 24, groups: [[2, 43]] },
  { ecPerBlock: 16, groups: [[4, 27]] },
  { ecPerBlock: 18, groups: [[4, 31]] },
  { ecPerBlock: 22, groups: [[2, 38], [2, 39]] },
  { ecPerBlock: 22, groups: [[3, 36], [2, 37]] },
  { ecPerBlock: 26, groups: [[4, 43], [1, 44]] },
];
const ALIGNMENT: readonly (readonly number[])[] = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

export const QR_MAX_BYTES = 213;

const dataWordsOf = (plan: BlockPlan) => plan.groups.reduce((sum, [count, words]) => sum + count * words, 0);

// GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, value = 1; i < 255; i += 1) {
  EXP[i] = value;
  LOG[value] = i;
  value <<= 1;
  if (value & 0x100) value ^= 0x11d;
}
for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
const multiply = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function reedSolomon(data: readonly number[], degree: number): number[] {
  let generator = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array<number>(generator.length + 1).fill(0);
    generator.forEach((coefficient, index) => {
      next[index] ^= coefficient;
      next[index + 1] ^= multiply(coefficient, EXP[i]);
    });
    generator = next;
  }
  const remainder = new Array<number>(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder.shift()!;
    remainder.push(0);
    for (let i = 0; i < degree; i += 1) remainder[i] ^= multiply(generator[i + 1], factor);
  }
  return remainder;
}

/** Data codewords (mode, length, payload, terminator, padding) for the version. */
function dataCodewords(bytes: Uint8Array, version: number): number[] {
  const bits: number[] = [];
  const push = (value: number, length: number) => { for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  bytes.forEach((byte) => push(byte, 8));
  const capacity = dataWordsOf(BLOCKS[version - 1]) * 8;
  push(0, Math.min(4, capacity - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const words: number[] = [];
  for (let i = 0; i < bits.length; i += 8) words.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xec; words.length < capacity / 8; pad ^= 0xec ^ 0x11) words.push(pad);
  return words;
}

/** Splits into blocks, appends error correction and interleaves. */
function interleave(words: readonly number[], version: number): number[] {
  const plan = BLOCKS[version - 1];
  const blocks: number[][] = [];
  let offset = 0;
  for (const [count, size] of plan.groups) {
    for (let i = 0; i < count; i += 1) { blocks.push(words.slice(offset, offset + size)); offset += size; }
  }
  const corrections = blocks.map((block) => reedSolomon(block, plan.ecPerBlock));
  const result: number[] = [];
  const longest = Math.max(...blocks.map((block) => block.length));
  for (let i = 0; i < longest; i += 1) blocks.forEach((block) => { if (i < block.length) result.push(block[i]); });
  for (let i = 0; i < plan.ecPerBlock; i += 1) corrections.forEach((block) => result.push(block[i]));
  return result;
}

type Matrix = { size: number; modules: boolean[][]; reserved: boolean[][] };

function baseMatrix(version: number): Matrix {
  const size = 17 + 4 * version;
  const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    modules[y][x] = dark;
    reserved[y][x] = true;
  };
  for (let i = 0; i < size; i += 1) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy += 1) for (let dx = -4; dx <= 4; dx += 1) { const distance = Math.max(Math.abs(dx), Math.abs(dy)); set(cx + dx, cy + dy, distance !== 2 && distance !== 4); }
  }
  const centers = ALIGNMENT[version - 1];
  centers.forEach((cx, i) => centers.forEach((cy, j) => {
    const onFinder = (i === 0 && j === 0) || (i === 0 && j === centers.length - 1) || (i === centers.length - 1 && j === 0);
    if (onFinder) return;
    for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));
  // Reserve the format areas (written per mask).
  for (let i = 0; i < 9; i += 1) { reserved[8][i] = true; reserved[i][8] = true; }
  for (let i = 0; i < 8; i += 1) { reserved[8][size - 1 - i] = true; reserved[size - 1 - i][8] = true; }
  if (version >= 7) {
    let remainder = version;
    for (let i = 0; i < 12; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
    const bits = (version << 12) | remainder;
    for (let i = 0; i < 18; i += 1) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }
  return { size, modules, reserved };
}

const MASKS: readonly ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** 15 format bits for error correction level M (bits 00) and the mask. */
function formatBits(mask: number): number {
  let remainder = mask;
  for (let i = 0; i < 10; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  return ((mask << 10) | remainder) ^ 0x5412;
}

function withMask(base: Matrix, codewords: readonly number[], mask: number): boolean[][] {
  const { size } = base;
  const modules = base.modules.map((row) => [...row]);
  let index = 0;
  const total = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;
        if (base.reserved[y][x] || index >= total) continue;
        modules[y][x] = ((codewords[index >>> 3] >>> (7 - (index & 7))) & 1) !== 0;
        index += 1;
      }
    }
  }
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) if (!base.reserved[y][x] && MASKS[mask](x, y)) modules[y][x] = !modules[y][x];
  const bits = formatBits(mask);
  const bit = (i: number) => ((bits >>> i) & 1) !== 0;
  for (let i = 0; i <= 5; i += 1) modules[i][8] = bit(i);
  modules[7][8] = bit(6);
  modules[8][8] = bit(7);
  modules[8][7] = bit(8);
  for (let i = 9; i < 15; i += 1) modules[8][14 - i] = bit(i);
  for (let i = 0; i < 8; i += 1) modules[8][size - 1 - i] = bit(i);
  for (let i = 8; i < 15; i += 1) modules[size - 15 + i][8] = bit(i);
  modules[size - 8][8] = true; // the always-dark module
  return modules;
}

function penalty(modules: boolean[][]): number {
  const size = modules.length;
  let score = 0;
  const line = (get: (i: number) => boolean) => {
    let run = 1;
    for (let i = 1; i < size; i += 1) {
      if (get(i) === get(i - 1)) { run += 1; if (run === 5) score += 3; else if (run > 5) score += 1; } else run = 1;
    }
    // Finder-like 1:1:3:1:1 with four light modules on one side.
    for (let i = 0; i + 11 <= size; i += 1) {
      let slice = '';
      for (let k = 0; k < 11; k += 1) slice += get(i + k) ? '1' : '0';
      if (slice === '10111010000' || slice === '00001011101') score += 40;
    }
  };
  for (let a = 0; a < size; a += 1) { line((i) => modules[a][i]); line((i) => modules[i][a]); }
  for (let y = 0; y + 1 < size; y += 1) for (let x = 0; x + 1 < size; x += 1) {
    const color = modules[y][x];
    if (color === modules[y][x + 1] && color === modules[y + 1][x] && color === modules[y + 1][x + 1]) score += 3;
  }
  const dark = modules.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/** Smallest version (1-10) that holds this many bytes, or null when they do not fit at level M. */
export function qrVersionFor(byteLength: number): number | null {
  for (let version = 1; version <= BLOCKS.length; version += 1) {
    if (byteLength <= dataWordsOf(BLOCKS[version - 1]) - 1 - (version < 10 ? 1 : 2)) return version;
  }
  return null;
}

/** The QR modules (true = dark, no quiet zone) for the text, or null when it is longer than 213 UTF-8 bytes. */
export function qrModules(text: string): boolean[][] | null {
  const bytes = new TextEncoder().encode(text);
  const version = qrVersionFor(bytes.length);
  if (version === null) return null;
  const codewords = interleave(dataCodewords(bytes, version), version);
  const base = baseMatrix(version);
  let best: boolean[][] | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = withMask(base, codewords, mask);
    const score = penalty(candidate);
    if (score < bestScore) { best = candidate; bestScore = score; }
  }
  return best;
}
