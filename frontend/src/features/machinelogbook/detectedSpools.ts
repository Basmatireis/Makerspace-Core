import type { DetectedSpoolTag, Material, MaterialType } from '../../api/generated/models';
import { colorDistance, COLOR_MISMATCH_THRESHOLD, reportedToMaterialHex } from './colors';

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

export type DetectedSuggestion = {
  /** An existing filament article of the reported type, variant and (nearly) colour. */
  article: Material | null;
  /** The filament type the tray type names, if one exists. */
  type: MaterialType | null;
  variant: string;
  /** The reported colour as #RRGGBB. */
  colorHex: string | null;
};

/**
 * What a detected tag most likely is: the material type whose code or name equals the reported tray type, the variant
 * from the sub-brand, and the active article of that type and variant whose colour is closest to the reported one
 * (within the colour-mismatch threshold). The printer's report is a hint only; staff confirm it when registering.
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
  if (!type) return { article: null, type, variant, colorHex };
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
  return { article: ranked[0]?.item ?? null, type, variant, colorHex };
}

/** Grams a reported remaining percentage stands for, given the package size of the article (1 kg by default). */
export const detectedGrams = (tag: Pick<DetectedSpoolTag, 'remainPercent'>, packageSize: number | null | undefined) =>
  tag.remainPercent == null ? null : Math.round(((packageSize || 1000) * tag.remainPercent) / 100);
