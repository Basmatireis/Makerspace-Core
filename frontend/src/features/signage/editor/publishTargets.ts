import { useQueries, useQuery } from '@tanstack/react-query';
import type { SignageAspectRatio, SignageSceneListItem } from '../../../api/generated/models';
import { pluralize } from '../helpers';
import { displaysQuery, groupsQuery, ownerRulesQuery } from '../queries';

/** A display (not in a group) or a display group whose default scenes or rules include the screen. */
export type PublishTarget = {
  kind: 'display' | 'group';
  id: string;
  name: string;
  detail: string;
  aspectRatio: SignageAspectRatio;
  /** Displays a publication reaches. */
  displayCount: number;
};

const plays = (items: readonly SignageSceneListItem[], sceneId: string) =>
  items.some((item) => item.sceneId === sceneId);

/**
 * Where the screen is shown, as the owners of rules see it: displays of a group follow the group's default scenes and
 * rules, so the group is the target; revoked displays are left out. `loading` is true until every list is known.
 */
export function usePublishTargets(sceneId: string): { targets: PublishTarget[]; loading: boolean } {
  const displays = useQuery(displaysQuery());
  const groups = useQuery(groupsQuery());
  const standalone = (displays.data?.items ?? []).filter(
    (display) => display.groupId === null && display.status !== 'revoked',
  );
  const groupItems = groups.data?.items ?? [];
  const displayRules = useQueries({
    queries: standalone.map((display) => ownerRulesQuery({ kind: 'display', id: display.id })),
  });
  const groupRules = useQueries({
    queries: groupItems.map((group) => ownerRulesQuery({ kind: 'group', id: group.id })),
  });
  const shows = (defaults: readonly SignageSceneListItem[], rules: { scenes: SignageSceneListItem[] }[] | undefined) =>
    plays(defaults, sceneId) || (rules ?? []).some((rule) => plays(rule.scenes, sceneId));
  const targets: PublishTarget[] = [
    ...standalone
      .filter((display, index) => shows(display.defaultScenes, displayRules[index]?.data?.items))
      .map((display) => ({
        kind: 'display' as const,
        id: display.id,
        name: display.name,
        detail: display.location,
        aspectRatio: display.aspectRatio,
        displayCount: 1,
      })),
    ...groupItems
      .filter((group, index) => shows(group.defaultScenes, groupRules[index]?.data?.items))
      .map((group) => ({
        kind: 'group' as const,
        id: group.id,
        name: group.name,
        detail: `Group of ${pluralize(group.displayIds.length, 'display')}`,
        aspectRatio: group.aspectRatio,
        displayCount: group.displayIds.length,
      })),
  ];
  const loading =
    displays.isPending || groups.isPending || [...displayRules, ...groupRules].some((query) => query.isPending);
  return { targets, loading };
}
