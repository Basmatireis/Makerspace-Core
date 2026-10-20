/** A material colour code as #RRGGBB with upper-case digits, the form the API accepts. */
export const COLOR_HEX_PATTERN = /^#[0-9A-F]{6}$/;

/** Largest RGB distance (0 to 441) at which two colours still count as the same. */
export const COLOR_MISMATCH_THRESHOLD = 80;

const channels = (hex: string): [number, number, number] | null => {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const value = parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};

/** Euclidean distance between two colour codes in RGB space; null when either is missing or malformed. */
export function colorDistance(a: string | null | undefined, b: string | null | undefined): number | null {
  const first = a ? channels(a) : null;
  const second = b ? channels(b) : null;
  if (!first || !second) return null;
  return Math.sqrt(first.reduce((sum, value, index) => sum + (value - second[index]) ** 2, 0));
}

/** True when the material colour and the colour the printer reports for the slot clearly differ. Skipped (false) when either is missing. */
export function colorsClearlyDiffer(
  materialHex: string | null | undefined,
  reportedHex: string | null | undefined,
): boolean {
  const distance = colorDistance(materialHex, reportedHex);
  return distance != null && distance > COLOR_MISMATCH_THRESHOLD;
}

/** The printer reports RRGGBB without "#"; materials store #RRGGBB. */
export const reportedToMaterialHex = (reported: string): string => `#${reported.replace(/^#/, '').toUpperCase()}`;
