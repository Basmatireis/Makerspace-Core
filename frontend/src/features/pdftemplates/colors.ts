/** Colour maths of the picker: hex ↔ HSV (hue 0–360, saturation and value 0–1). */

export type Hsv = [h: number, s: number, v: number];

const HEX = /^#?([0-9a-f]{6})$/i;

export const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** `#rrggbb` (lower case) from text with or without `#`, or null when it is not a six-digit hex colour. */
export function normalizeHex(text: string): string | null {
  const m = HEX.exec(text.trim());
  return m ? `#${m[1].toLowerCase()}` : null;
}

export function hexToHsv(hex: string): Hsv {
  const m = HEX.exec(hex ?? '');
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  const r = (n >> 16) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, max ? d / max : 0, max];
}

export function hsvToHex(h: number, s: number, v: number): string {
  const channel = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return `#${[channel(5), channel(3), channel(1)]
    .map((x) =>
      Math.round(x * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}
