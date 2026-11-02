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
