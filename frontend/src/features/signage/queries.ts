import { queryOptions } from '@tanstack/react-query';
import { listMachines } from '../../api/generated/machines/machines';
import {
  getSignageAsset,
  getSignagePlaylist,
  getSignageScene,
  listSignageAnnouncementTemplates,
  listSignageAnnouncements,
  listSignageAssets,
  listSignagePlaylists,
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
};

export const scenesQuery = () => queryOptions({ queryKey: signageKeys.scenes(), queryFn: ({ signal }) => listSignageScenes({ signal }) });
export const sceneQuery = (id: string) => queryOptions({ queryKey: signageKeys.scene(id), queryFn: ({ signal }) => getSignageScene(id, { signal }) });
export const playlistsQuery = () => queryOptions({ queryKey: signageKeys.playlists(), queryFn: ({ signal }) => listSignagePlaylists({ signal }) });
export const playlistQuery = (id: string) => queryOptions({ queryKey: signageKeys.playlist(id), queryFn: ({ signal }) => getSignagePlaylist(id, { signal }) });
export const templatesQuery = () => queryOptions({ queryKey: signageKeys.templates(), queryFn: ({ signal }) => listSignageAnnouncementTemplates({ signal }) });
export const announcementsQuery = () => queryOptions({ queryKey: signageKeys.announcements(), queryFn: ({ signal }) => listSignageAnnouncements({ signal }) });
export const assetsQuery = () => queryOptions({ queryKey: signageKeys.assets(), queryFn: ({ signal }) => listSignageAssets(undefined, { signal }) });
export const assetQuery = (id: string) => queryOptions({ queryKey: signageKeys.asset(id), queryFn: ({ signal }) => getSignageAsset(id, { signal }) });

/** Machine names for widget pickers. Needs `machines.read`; callers enable it only for people who have it. */
export const machinesQuery = (enabled: boolean) => queryOptions({
  queryKey: signageKeys.machines(),
  queryFn: ({ signal }) => listMachines({ pageSize: 100 }, { signal }),
  enabled,
});
