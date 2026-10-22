import type { SignageCustomLayout, SignageScene } from '../../api/generated/models';
import { resolveLayout } from './layouts';
import { HEX_COLOR, widgetError } from './widgets';

export type Draft = Pick<
  SignageScene,
  | 'name'
  | 'layoutId'
  | 'customLayoutId'
  | 'backgroundColor'
  | 'backgroundAssetId'
  | 'backgroundFit'
  | 'backgroundDim'
  | 'theme'
  | 'zones'
>;
export const toDraft = (scene: SignageScene): Draft => ({
  name: scene.name,
  layoutId: scene.layoutId,
  customLayoutId: scene.customLayoutId,
  backgroundColor: scene.backgroundColor,
  backgroundAssetId: scene.backgroundAssetId,
  backgroundFit: scene.backgroundFit,
  backgroundDim: scene.backgroundDim,
  theme: scene.theme,
  zones: scene.zones,
});

/** What certainly would be rejected is not sent; the person sees why instead of a failed save. */
export function draftError(draft: Draft, customLayouts: readonly SignageCustomLayout[] = []): string | null {
  if (draft.name.trim() === '') return 'Give the scene a name.';
  if (draft.name.length > 100) return 'The name is limited to 100 characters.';
  if (!HEX_COLOR.test(draft.backgroundColor)) return 'Enter the background colour as #rrggbb.';
  for (const zone of resolveLayout(draft.layoutId, draft.customLayoutId, customLayouts).zones) {
    const message = widgetError(draft.zones[zone.id] ?? { type: 'empty' });
    if (message) return `Zone ${zone.label}: ${message}`;
  }
  return null;
}
