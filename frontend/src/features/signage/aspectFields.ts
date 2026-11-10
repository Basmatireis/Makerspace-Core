import type { SignageAspectRatio } from '../../api/generated/models';
import { ASPECT_PRESETS, aspectLabel, parseAspectRatio, sameRatio } from './helpers';

/** The two form fields behind an aspect ratio: the preset `Select` and the custom `W:H` text. */
export type AspectFields = { aspectPreset: string; aspectCustom: string };

export const CUSTOM = 'custom';

/** Form values for a ratio: its preset, or Custom with the ratio filled in when it is none of them. */
export function aspectFieldsOf(ratio: SignageAspectRatio): AspectFields {
  const preset = ASPECT_PRESETS.find((item) => sameRatio(item.ratio, ratio));
  return preset
    ? { aspectPreset: aspectLabel(preset.ratio), aspectCustom: '' }
    : { aspectPreset: CUSTOM, aspectCustom: aspectLabel(ratio) };
}

/** The ratio the form values stand for; falls back to the first preset when a custom input is invalid. */
export function aspectOfFields(values: AspectFields): SignageAspectRatio {
  if (values.aspectPreset === CUSTOM) return parseAspectRatio(values.aspectCustom) ?? ASPECT_PRESETS[0].ratio;
  return (
    ASPECT_PRESETS.find((item) => aspectLabel(item.ratio) === values.aspectPreset)?.ratio ?? ASPECT_PRESETS[0].ratio
  );
}

/** "Landscape", "Portrait" or "Square": the name of the shape a ratio describes. */
export const shapeName = (ratio: SignageAspectRatio) =>
  ratio.width === ratio.height ? 'Square' : ratio.width > ratio.height ? 'Landscape' : 'Portrait';

export const RATIO_PART_ERROR = 'Enter two whole numbers between 1 and 999, for example 16 and 9.';
export const RATIO_RANGE_ERROR = 'Use a shape between 1:5 and 5:1.';

/** Why two typed ratio parts are not a usable screen shape, or null. Parts are 1–999 integers within 1:5 to 5:1. */
export function ratioPartsError(width: string, height: string): string | null {
  const w = Number(width);
  const h = Number(height);
  const whole = (value: string, n: number) => value.trim() !== '' && Number.isInteger(n) && n >= 1 && n <= 999;
  if (!whole(width, w) || !whole(height, h)) return RATIO_PART_ERROR;
  return w / h > 5 || h / w > 5 ? RATIO_RANGE_ERROR : null;
}

/** The two typed parts of a ratio. Kept as text so a half-typed number is not lost; `ratioPartsError` judges them. */
export type RatioParts = { width: string; height: string };

export const ratioPartsOf = (ratio: SignageAspectRatio): RatioParts => ({
  width: String(ratio.width),
  height: String(ratio.height),
});

/** The shape for valid parts; callers check `ratioPartsError` first. */
export const ratioOfParts = (parts: RatioParts): SignageAspectRatio => ({
  width: Number(parts.width),
  height: Number(parts.height),
});
