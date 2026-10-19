import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Names } from './engine/playback';
import { useMachineOptions, useMakerspaceTimeZone, useNow } from './preview';
import { resolvePublished, type PublishedOptions, type PublishedView } from './publishedView';
import { previewQuery, templatesQuery } from './queries';

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
