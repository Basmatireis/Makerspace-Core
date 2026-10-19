/**
 * A deterministic QR-like pattern for a URL: finder squares in three corners and pseudo-random modules.
 * NOT SCANNABLE. It stands in until the player phase adds a verified QR encoder; callers only use `qrModules`.
 */
export function qrModules(text: string, size = 25): boolean[][] {
  let seed = [...text].reduce((hash, char) => (hash * 33 + char.charCodeAt(0)) >>> 0, 5381) || 1;
  const next = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const grid = Array.from({ length: size }, () => Array.from({ length: size }, () => next() > 0.52));
  const finder = (top: number, left: number) => {
    for (let row = -1; row <= 7; row += 1) {
      for (let col = -1; col <= 7; col += 1) {
        const y = top + row;
        const x = left + col;
        if (y < 0 || x < 0 || y >= size || x >= size) continue;
        const edge = row === 0 || row === 6 || col === 0 || col === 6;
        const core = row >= 2 && row <= 4 && col >= 2 && col <= 4;
        grid[y][x] = row >= 0 && row <= 6 && col >= 0 && col <= 6 && (edge || core);
      }
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
  return grid;
}
