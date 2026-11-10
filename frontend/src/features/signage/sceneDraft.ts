import type { SignageScene, UpdateSignageSceneRequest } from '../../api/generated/models';
import { blocksError, HEX_COLOR } from './widgets';

/** The editable part of a scene: everything the editor changes and autosaves. */
export type Draft = Pick<
  SignageScene,
  | 'name'
  | 'aspectRatio'
  | 'backgroundColor'
  | 'backgroundAssetId'
  | 'backgroundFit'
  | 'backgroundDim'
  | 'theme'
  | 'fontFamily'
  | 'fontAssetId'
  | 'blocks'
>;

export const toDraft = (scene: SignageScene): Draft => ({
  name: scene.name,
  aspectRatio: scene.aspectRatio,
  backgroundColor: scene.backgroundColor,
  backgroundAssetId: scene.backgroundAssetId,
  backgroundFit: scene.backgroundFit,
  backgroundDim: scene.backgroundDim,
  theme: scene.theme,
  fontFamily: scene.fontFamily,
  fontAssetId: scene.fontAssetId,
  blocks: scene.blocks,
});

export const draftRequest = (draft: Draft, expectedVersion: number): UpdateSignageSceneRequest => ({
  expectedVersion,
  ...draft,
  backgroundAssetId: draft.backgroundAssetId ?? null,
});

/** What certainly would be rejected is not sent; the person sees why instead of a failed save. */
export function draftError(draft: Draft): string | null {
  if (draft.name.trim() === '') return 'Give the screen a name.';
  if (draft.name.length > 100) return 'The name is limited to 100 characters.';
  if (!HEX_COLOR.test(draft.backgroundColor)) return 'Enter the background colour as #rrggbb.';
  if (draft.fontFamily === 'custom' && !draft.fontAssetId) return 'Choose an uploaded font.';
  return blocksError(draft.blocks);
}
