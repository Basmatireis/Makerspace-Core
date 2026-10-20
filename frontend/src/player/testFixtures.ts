import type { SignagePlayerLive, SignagePlayerManifest, SignagePlayerRule, SignagePlayerScene } from '../api/generated/models';
import type { PlayerApi } from './api';

// Builders for player tests.

export const scene = (id: string, patch: Partial<SignagePlayerScene> = {}): SignagePlayerScene => ({
  id, name: id, orientation: 'landscape', layoutId: 'full', backgroundColor: '#000000', backgroundAssetId: null, backgroundFit: 'cover', backgroundDim: 0, theme: 'dark', zones: { main: { type: 'text', text: id, size: 'm', align: 'start' } }, version: 1, ...patch,
} as SignagePlayerScene);

export const rule = (id: string, patch: Partial<SignagePlayerRule>): SignagePlayerRule => ({
  id, kind: 'live_data_unavailable', weekdays: [], timeFrom: null, timeTo: null, machineIds: [], machineMatch: null, announcementTemplateIds: [], targetKind: 'scene', targetId: 'scene-a', minSeconds: 0, multiMode: 'split', alternateSeconds: 10, ...patch,
} as SignagePlayerRule);

export const manifest = (revision: number, patch: Partial<SignagePlayerManifest> = {}): SignagePlayerManifest => ({
  revision,
  display: { orientation: 'landscape', resolution: { width: 1920, height: 1080 }, visibleFromOutside: false },
  rules: [],
  defaultPlaylistId: 'pl-default',
  scenes: [scene('scene-a'), scene('scene-b')],
  playlists: [{ id: 'pl-default', name: 'Default', version: 1, items: [{ sceneId: 'scene-a', seconds: 10, transition: 'cut' }] }],
  assets: [],
  layoutsVersion: 1,
  ...patch,
});

export const live = (patch: Partial<SignagePlayerLive> = {}): SignagePlayerLive => ({
  serverTime: new Date().toISOString(), revision: 1, machines: [], announcements: [], openDays: [], events: [], streams: [], ...patch,
});

export const asset = (id: string, kind: 'image' | 'video' = 'image') => ({ id, kind, name: id, contentType: kind === 'image' ? 'image/png' : 'video/mp4', sha256: 'a'.repeat(64), sizeBytes: 10, width: null, height: null, durationMs: null, url: `/api/v1/signage/player/assets/${id}/${'a'.repeat(64)}` }) as SignagePlayerManifest['assets'][number];

/** An API whose calls all resolve; tests override the ones they care about. */
export function fakeApi(patch: Partial<PlayerApi> = {}): PlayerApi {
  return {
    startPairing: async () => ({ code: 'ABC234', expiresAt: new Date(Date.now() + 900_000).toISOString() }),
    pollPairing: async () => ({ status: 'pending' }),
    manifest: async () => ({ unchanged: false, manifest: manifest(1) }),
    live: async () => live(),
    heartbeat: async () => undefined,
    ...patch,
  };
}
