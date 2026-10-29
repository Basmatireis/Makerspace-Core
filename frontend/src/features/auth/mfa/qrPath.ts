/** Quiet zone around the symbol, in modules (the QR specification asks for four, two scans reliably on screens). */
export const QR_MARGIN = 2;

/** Converts a flat 0/1 module matrix into one SVG path with a unit square per dark module. */
export function qrModulesToPath(data: ArrayLike<number>, size: number, margin = QR_MARGIN): string {
  const segments: string[] = [];
  for (let index = 0; index < data.length; index += 1) {
    if (!data[index]) continue;
    const x = (index % size) + margin;
    const y = Math.floor(index / size) + margin;
    segments.push(`M${x} ${y}h1v1h-1z`);
  }
  return segments.join('');
}
