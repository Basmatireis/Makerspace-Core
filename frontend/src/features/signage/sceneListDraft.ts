import type { SignageSceneListItem } from '../../api/generated/models';

export const MAX_SCENE_LIST_ITEMS = 100;

/** A scene list item in the editor; `sceneId` is empty until a scene is chosen. */
export type SceneListDraftItem = Omit<SignageSceneListItem, 'sceneId'> & { sceneId: string };

export const newSceneListItem = (): SceneListDraftItem => ({ sceneId: '', seconds: 20, transition: 'fade' });

export const sceneListDraftOf = (items: readonly SignageSceneListItem[]): SceneListDraftItem[] =>
  items.map((item) => ({ ...item }));

/** The message for an invalid list, or null: at least one item, every item with a scene and 3 to 3600 seconds. */
export function sceneListError(items: readonly SceneListDraftItem[]): string | null {
  if (items.length === 0) return 'Add at least one scene';
  if (items.some((item) => item.sceneId === '')) return 'Choose a scene for every item';
  if (items.length > 1 && items.some((item) => !(item.seconds >= 3 && item.seconds <= 3600)))
    return 'Show every scene for 3 to 3600 seconds';
  return null;
}
