import { queryOptions } from '@tanstack/react-query';
import {
  getSignageAsset,
  getSignageCalendar,
  getSignageDisplay,
  getSignageDisplayPreview,
  getSignagePlaylist,
  getSignageScene,
  listSignageAnnouncementTemplates,
  listSignageAnnouncements,
  listSignageAssets,
  listSignageDisplays,
  listSignageMachines,
  listSignagePlaylists,
  listSignageRules,
  listSignageScenes,
} from '../../api/generated/signage/signage';

export const signageKeys = {
  all: ['signage'] as const,
  scenes: () => [...signageKeys.all, 'scenes'] as const,
  scene: (id: string) => [...signageKeys.all, 'scene', id] as const,
  playlists: () => [...signageKeys.all, 'playlists'] as const,
  playlist: (id: string) => [...signageKeys.all, 'playlist', id] as const,
  templates: () => [...signageKeys.all, 'templates'] as const,
  announcements: () => [...signageKeys.all, 'announcements'] as const,
  assets: () => [...signageKeys.all, 'assets'] as const,
  asset: (id: string) => [...signageKeys.all, 'asset', id] as const,
  machines: () => [...signageKeys.all, 'machines'] as const,
  calendar: () => [...signageKeys.all, 'calendar'] as const,
  displays: () => [...signageKeys.all, 'displays'] as const,
  display: (id: string) => [...signageKeys.all, 'display', id] as const,
  rules: (id: string) => [...signageKeys.all, 'rules', id] as const,
  preview: (id: string) => [...signageKeys.all, 'preview', id] as const,
};

export const scenesQuery = () => queryOptions({ queryKey: signageKeys.scenes(), queryFn: ({ signal }) => listSignageScenes({ signal }) });
export const sceneQuery = (id: string) => queryOptions({ queryKey: signageKeys.scene(id), queryFn: ({ signal }) => getSignageScene(id, { signal }) });
export const playlistsQuery = () => queryOptions({ queryKey: signageKeys.playlists(), queryFn: ({ signal }) => listSignagePlaylists({ signal }) });
export const playlistQuery = (id: string) => queryOptions({ queryKey: signageKeys.playlist(id), queryFn: ({ signal }) => getSignagePlaylist(id, { signal }) });
export const templatesQuery = () => queryOptions({ queryKey: signageKeys.templates(), queryFn: ({ signal }) => listSignageAnnouncementTemplates({ signal }) });
export const announcementsQuery = () => queryOptions({ queryKey: signageKeys.announcements(), queryFn: ({ signal }) => listSignageAnnouncements({ signal }) });
export const assetsQuery = () => queryOptions({ queryKey: signageKeys.assets(), queryFn: ({ signal }) => listSignageAssets(undefined, { signal }) });
export const assetQuery = (id: string) => queryOptions({ queryKey: signageKeys.asset(id), queryFn: ({ signal }) => getSignageAsset(id, { signal }) });

/** Machines for widget pickers: id, name and kind only. Any signage permission is enough (no `machines.read` needed). */
export const machinesQuery = (enabled: boolean) => queryOptions({
  queryKey: signageKeys.machines(),
  queryFn: ({ signal }) => listSignageMachines({ signal }),
  enabled,
});

/** The upcoming public open days and events players show (the same lists as the live endpoint). Previews use them instead of samples. */
export const calendarQuery = (enabled: boolean) => queryOptions({
  queryKey: signageKeys.calendar(),
  queryFn: ({ signal }) => getSignageCalendar({ signal }),
  enabled,
  staleTime: 60_000,
});

// Heartbeats arrive every 30 s and live data every 10 s on the player, so the admin views poll at a similar pace.
export const displaysQuery = () => queryOptions({ queryKey: signageKeys.displays(), queryFn: ({ signal }) => listSignageDisplays({ signal }), refetchInterval: 30_000 });
export const displayQuery = (id: string) => queryOptions({ queryKey: signageKeys.display(id), queryFn: ({ signal }) => getSignageDisplay(id, { signal }), refetchInterval: 30_000 });
/** Ordered rules and the display version every rule write must quote. */
export const rulesQuery = (displayId: string, enabled = true) => queryOptions({ queryKey: signageKeys.rules(displayId), queryFn: ({ signal }) => listSignageRules(displayId, { signal }), enabled });
/** The display's latest publication plus the live data its player would poll. */
export const previewQuery = (displayId: string, enabled = true) => queryOptions({ queryKey: signageKeys.preview(displayId), queryFn: ({ signal }) => getSignageDisplayPreview(displayId, { signal }), refetchInterval: 10_000, enabled });
