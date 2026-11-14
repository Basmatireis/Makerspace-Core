// TypeScript copy of backend/internal/signage/contrast.go for the admin forms. Go is authoritative; both run the shared
// vectors in api/testdata/signage-announcement-contrast.json. Pure TS: no Carbon, no src/app imports.
import type { SignageTone } from '../../api/generated/models';

const TEXT_LIGHT = '#ffffff';
const TEXT_DARK = '#161616';
/** WCAG 2 contrast ratio for normal text. */
const MIN_CONTRAST = 4.5;
const HEX = /^#[0-9a-fA-F]{6}$/;

/** The announcement background of each tone (render.css), shown as the swatch while no own colour is set. */
export const TONE_COLORS: Record<SignageTone, string> = {
  info: '#0043ce',
  warning: '#f1c21b',
  critical: '#da1e28',
  neutral: '#393939',
};

const linear = (value: number) => {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
};
const luminance = (color: string) =>
  0.2126 * linear(parseInt(color.slice(1, 3), 16)) +
  0.7152 * linear(parseInt(color.slice(3, 5), 16)) +
  0.0722 * linear(parseInt(color.slice(5, 7), 16));
const contrast = (a: string, b: string) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
};

/**
 * The text colour for an announcement background: #ffffff or #161616, whichever contrasts more (white on a tie).
 * Null when neither reaches 4.5:1 (the backend then refuses the colour) or the colour is not `#rrggbb`.
 */
export function announcementTextColor(color: string): string | null {
  if (!HEX.test(color)) return null;
  const lower = color.toLowerCase();
  const light = contrast(lower, TEXT_LIGHT);
  const dark = contrast(lower, TEXT_DARK);
  const [best, ratio] = dark > light ? [TEXT_DARK, dark] : [TEXT_LIGHT, light];
  return ratio >= MIN_CONTRAST ? best : null;
}

/** What a rendered announcement needs of its look: colour, derived text colour (null without colour) and image URL. */
export type AnnouncementLook = { color: string | null; textColor: string | null; imageUrl: string | null };

/** The look of a chosen colour and image URL; an unreadable colour gives no text colour. */
export const lookOf = (color: string | null, imageUrl: string | null): AnnouncementLook => ({
  color,
  textColor: color ? announcementTextColor(color) : null,
  imageUrl,
});
