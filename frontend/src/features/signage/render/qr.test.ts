import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { QR_MAX_BYTES, qrModules, qrVersionFor } from './qr';

const rows = (text: string) => qrModules(text)!.map((row) => row.map((dark) => (dark ? '1' : '0')).join(''));
const digest = (text: string) => createHash('sha256').update(rows(text).join('\n')).digest('hex');

// Vectors: the matrices below were decoded successfully with a platform QR detector (CoreImage) and, apart from the
// single-byte case, equal the platform generator's output module for module (level M, auto version).
const VECTORS: [label: string, text: string, size: number, sha256: string][] = [
  ['version 2', 'https://makerspace.example/events', 29, 'd0b066dd53ecdf040be7c33fa754766e2871d8e3ce89dd67646bf1e894f79335'],
  ['version 4', 'https://core.htu-makerspace.example/signage/sign-up?ref=abc123&lang=de', 37, '3627808c7c2df74f09e5c2387daf9dec95df33da3f289f7cdb7f706a6b217731'],
  ['version 3, repeated byte', 'x'.repeat(40), 29, 'e2254b71096d55259e245c2eaa6f3338bd8c1c93ed793fa56da96a3e35265d6c'],
  ['version 7 (version information), UTF-8', 'ä€ü '.repeat(15), 45, '7a3a8a1515b4ce187bddf54cec4e9dc168c9edbb36659029e7662236c28f0707'],
  ['version 6, 100 bytes', 'y'.repeat(100), 41, '7e493e4d3583ecb3270cb6ce4738fd79254611f21bb5b6d9bbcc7ba6db94a36a'],
  ['version 9, uneven blocks', 'z'.repeat(150), 49, 'dc814b4d229659681b73f09dd97364d6dd9a168aca3bb15f1ae4b799216321a5'],
  ['version 10, full capacity', 'q'.repeat(213), 57, '86d0337bea63245bc07d41bda87bf2cb1c154204778b82edd9dfe5e06f363b14'],
  ['version 1, full capacity', 'w'.repeat(14), 21, 'bb2c7aa272f1102c250d559923b81325894d06e06d0df8b4cd964cab3b7bccdc'],
  ['version 2, first byte over version 1', 'e'.repeat(15), 25, 'c8b6eb516eb83b3cadb3de805313319b0698b173ca34136eddc9579f9dcaa97a'],
];

const URL_V2 = [
  '11111110111110011111101111111', '10000010100110110110001000001', '10111010001001110011001011101', '10111010100110001100001011101',
  '10111010001011000111001011101', '10000010000110100001001000001', '11111110101010101010101111111', '00000000110011100100100000000',
  '10110111010001101110101001011', '00010100110100011111101110001', '11001011110110110110000000110', '11011101111101110001100100001',
  '11110110010000000100000001100', '00010100111001000101011000111', '01010011011100100011001110111', '01101100000111000001101000010',
  '01010111110100001001110111010', '00111001110001010100010101110', '10001110111100010100110110100', '00000001101110001110000100100',
  '01011111010101000111111111100', '00000000111001101010100011111', '11111110101001000111101011010', '10000010101000010010100011011',
  '10111010001010100100111110110', '10111010111110111111010111001', '10111010101100000111000100101', '10000010010100011010110111010',
  '11111110101101000011110010010',
];

describe('qrModules', () => {
  it.each(VECTORS)('%s matches the reference vector', (_label, text, size, sha256) => {
    expect(qrModules(text)).toHaveLength(size);
    expect(digest(text)).toBe(sha256);
  });

  it('reproduces a complete reference matrix', () => {
    expect(rows('https://makerspace.example/events')).toEqual(URL_V2);
  });

  it('picks the smallest version that fits and refuses longer input', () => {
    expect([0, 14, 15, 26, 27, 42, 43, 62, 63, 84, 85, 106, 107, 122, 123, 152, 153, 180, 181, 213].map(qrVersionFor)).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10]);
    expect(QR_MAX_BYTES).toBe(213);
    expect(qrVersionFor(214)).toBeNull();
    expect(qrModules('a'.repeat(214))).toBeNull();
    expect(qrModules('ä'.repeat(107))).toBeNull(); // 214 bytes
  });

  it('draws the fixed patterns', () => {
    const matrix = qrModules('https://makerspace.example/events')!;
    const size = matrix.length;
    const finder = (top: number, left: number) => [0, 6].every((i) => [0, 6].every((j) => matrix[top + i][left + j])) && !matrix[top + 1][left + 1] && matrix[top + 3][left + 3];
    expect(finder(0, 0) && finder(0, size - 7) && finder(size - 7, 0)).toBe(true);
    for (let i = 8; i < size - 8; i += 1) { expect(matrix[6][i]).toBe(i % 2 === 0); expect(matrix[i][6]).toBe(i % 2 === 0); }
    expect(matrix[size - 8][8]).toBe(true); // always-dark module
    expect(matrix[size - 9][size - 9]).toBe(true); // version 2 alignment pattern centre at 18
  });

  it('writes a valid format word (BCH checked, level M)', () => {
    const matrix = qrModules('https://makerspace.example/events')!;
    let bits = 0;
    for (let i = 0; i <= 5; i += 1) bits |= Number(matrix[i][8]) << i;
    bits |= Number(matrix[7][8]) << 6; bits |= Number(matrix[8][8]) << 7; bits |= Number(matrix[8][7]) << 8;
    for (let i = 9; i < 15; i += 1) bits |= Number(matrix[8][14 - i]) << i;
    const word = bits ^ 0x5412;
    expect(word >>> 13).toBe(0); // error correction level M is 00
    let remainder = word;
    for (let i = 14; i >= 10; i -= 1) if ((remainder >>> i) & 1) remainder ^= 0x537 << (i - 10);
    expect(remainder).toBe(0);
  });

  it('is deterministic and distinguishes inputs', () => {
    expect(digest('https://a.example')).toBe(digest('https://a.example'));
    expect(digest('https://a.example')).not.toBe(digest('https://b.example'));
  });
});
