import type { DetectedSpoolTag, Material, MaterialType } from '../../api/generated/models';
import { bambuColorName } from './bambuColors';
import { colorDistance, COLOR_MISMATCH_THRESHOLD, COLOR_SAME_THRESHOLD, reportedToMaterialHex } from './colors';

/** Where a printer reports the tag: machine, unit and slot (or the raw tray when the tray maps to no slot). */
export const detectedSlotText = (tag: DetectedSpoolTag) =>
  [tag.machineName, tag.slotName ? tag.inputUnitName : tag.unitLabel, tag.slotName ?? `Tray ${tag.trayExternalId}`]
    .filter(Boolean)
    .join(' · ');

/** "PLA Basic" from tray type "PLA" and sub-brand "PLA Basic": the sub-brand without the type is the variant. */
export const detectedVariant = (tag: Pick<DetectedSpoolTag, 'materialType' | 'subBrand'>) => {
  const sub = tag.subBrand?.trim() ?? '';
  const type = tag.materialType?.trim() ?? '';
  if (!type) return sub;
  return sub.toLowerCase().startsWith(type.toLowerCase()) ? sub.slice(type.length).trim() : sub;
};

/** How the suggested article's colour relates to the reported one: the same to the eye, or merely similar. */
export type DetectedColorMatch = 'same' | 'similar';

export type DetectedSuggestion = {
  /** An existing filament article of the reported type, variant and (nearly) colour. */
  article: Material | null;
  /** Null without an article. */
  match: DetectedColorMatch | null;
  /** The filament type the tray type names, if one exists. */
  type: MaterialType | null;
  variant: string;
  /** The reported colour as #RRGGBB. */
  colorHex: string | null;
  /** The official name of the reported colour (from the product code, else from an article with exactly that colour). */
  colorName: string | null;
};

/** Label of a colour match for a tag next to the suggested article. */
export const matchLabel: Record<DetectedColorMatch, string> = { same: 'Match', similar: 'Similar colour' };

/**
 * The official name of the colour a tag reports: Bambu's catalogue by product code, else the name of an active
 * filament article whose colour code equals the reported one. Null when neither is known.
 */
export function detectedColorName(
  tag: Pick<DetectedSpoolTag, 'productCode' | 'colorHex'>,
  materials: readonly Material[],
): string | null {
  const official = bambuColorName(tag.productCode);
  if (official) return official;
  const hex = tag.colorHex ? reportedToMaterialHex(tag.colorHex) : null;
  if (!hex) return null;
  const same = materials.find(
    (item) => item.active && item.kind === 'filament' && item.colorName && item.colorHex?.toUpperCase() === hex,
  );
  return same?.colorName ?? null;
}

/**
 * What a detected tag most likely is: the material type whose code or name equals the reported tray type, the variant
 * from the sub-brand, and the active article of that type and variant whose colour is closest to the reported one
 * (within the colour-mismatch threshold; a `match` of `same` when it is also within the same-colour threshold). The
 * printer's report is a hint only; staff confirm it when registering.
 */
export function suggestArticle(
  tag: DetectedSpoolTag,
  materials: readonly Material[],
  types: readonly MaterialType[],
): DetectedSuggestion {
  const reported = tag.materialType?.trim().toLowerCase() ?? '';
  const type =
    types.find(
      (item) =>
        item.kind === 'filament' &&
        item.active &&
        (item.code.toLowerCase() === reported || item.name.toLowerCase() === reported),
    ) ?? null;
  const variant = detectedVariant(tag);
  const colorHex = tag.colorHex ? reportedToMaterialHex(tag.colorHex) : null;
  const colorName = detectedColorName(tag, materials);
  if (!type) return { article: null, match: null, type, variant, colorHex, colorName };
  const ranked = materials
    .filter(
      (item) =>
        item.active &&
        item.kind === 'filament' &&
        item.materialTypeId === type.id &&
        (item.variant ?? '').trim().toLowerCase() === variant.toLowerCase(),
    )
    .map((item) => ({ item, distance: colorDistance(item.colorHex, colorHex) }))
    .filter(
      (entry): entry is { item: Material; distance: number } =>
        entry.distance != null && entry.distance <= COLOR_MISMATCH_THRESHOLD,
    )
    .sort((a, b) => a.distance - b.distance);
  const best = ranked[0];
  const match: DetectedColorMatch | null = best ? (best.distance <= COLOR_SAME_THRESHOLD ? 'same' : 'similar') : null;
  return { article: best?.item ?? null, match, type, variant, colorHex, colorName };
}

/** Grams a reported remaining percentage stands for, given the package size of the article (1 kg by default). */
export const detectedGrams = (tag: Pick<DetectedSpoolTag, 'remainPercent'>, packageSize: number | null | undefined) =>
  tag.remainPercent == null ? null : Math.round(((packageSize || 1000) * tag.remainPercent) / 100);
