import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import type { Names } from './engine/playback';
import { useMachineOptions, useMakerspaceTimeZone, useNow } from './preview';
import { resolvePublished, type PublishedOptions, type PublishedView } from './publishedView';
import type { CameraOutsideField } from './displayMutations';
import { displaysQuery, playlistsQuery, previewQuery, rulesQuery, templatesQuery } from './queries';

/** Machine and template names for describing rules; unknown ids read as removed. */
export function useRuleNames(): Names {
  const { machines } = useMachineOptions();
  const templates = useQuery(templatesQuery()).data?.items;
  return useMemo(() => ({
    machine: (id) => machines.find((item) => item.id === id)?.name ?? 'a machine',
    template: (id) => templates?.find((item) => item.id === id)?.name ?? 'a removed template',
  }), [machines, templates]);
}

/**
 * The display's latest publication run through the shared engine with its current live data. Polls like a player.
 * `options` must be stable (memoised) when given.
 */
export function usePublishedView(displayId: string, options: Pick<PublishedOptions, 'extra' | 'omitAnnouncementId'> = {}, enabled = true) {
  const preview = useQuery(previewQuery(displayId, enabled));
  const timeZone = useMakerspaceTimeZone();
  const names = useRuleNames();
  const now = useNow(1000);
  const { extra, omitAnnouncementId } = options;
  const view: PublishedView | null = useMemo(
    () => (preview.data ? resolvePublished(preview.data, { now, timeZone, names, extra, omitAnnouncementId }) : null),
    [preview.data, now, timeZone, names, extra, omitAnnouncementId],
  );
  return { preview, view, now };
}

/**
 * Names of the outside-visible displays that play the scene (default playlist or a rule) but do not allow live cameras:
 * a camera widget in the scene shows its fallback there.
 */
export function useCameraBlockedDisplays(sceneId: string): string[] {
  const displays = useQuery(displaysQuery()).data?.items;
  const playlists = useQuery(playlistsQuery()).data?.items;
  const blocked = useMemo(() => (displays ?? []).filter((display) => display.visibleFromOutside && display.status !== 'revoked' && !(display as CameraOutsideField).allowCameraOutside), [displays]);
  const rules = useQueries({ queries: blocked.map((display) => rulesQuery(display.id)) });
  const plays = (playlistId: string) => playlists?.find((item) => item.id === playlistId)?.items.some((item) => item.sceneId === sceneId) ?? false;
  return blocked.filter((display, index) => plays(display.defaultPlaylistId)
    || (rules[index]?.data?.items ?? []).some((rule) => (rule.targetKind === 'scene' ? rule.targetId === sceneId : plays(rule.targetId)))).map((display) => display.name);
}
