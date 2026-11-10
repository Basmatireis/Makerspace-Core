import type { Draft } from '../sceneDraft';
import { sceneGridSize } from '../render/aspect';
import { arrange, type ArrangeAction } from './blockOps';

export type Change = (next: Draft, coalesceKey?: string) => void;

/** Runs an arrange tool on the selected blocks; tools that create copies change the selection to the new blocks. */
export function runArrange(
  draft: Draft,
  ids: readonly string[],
  action: ArrangeAction,
  options: { rel?: 'selection' | 'screen'; gap?: number },
  onChange: Change,
  onSelect: (ids: string[]) => void,
) {
  const result = arrange(draft.blocks, ids, action, { grid: sceneGridSize(draft.aspectRatio), ...options });
  if (result.blocks !== draft.blocks) onChange({ ...draft, blocks: result.blocks });
  if (result.selectIds.join() !== ids.join()) onSelect(result.selectIds);
}
