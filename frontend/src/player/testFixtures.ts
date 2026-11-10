import type {
  SignageBlock,
  SignagePlayerLive,
  SignagePlayerManifest,
  SignagePlayerRule,
  SignagePlayerScene,
} from '../api/generated/models';
import type { PlayerApi } from './api';

// Builders for player tests.

/** A full-screen 16:9 text block with the default text style. */
export const textBlock = (id: string, text: string, patch: Partial<SignageBlock> = {}): SignageBlock => ({
  id,
  name: id,
  x: 0,
  y: 0,
  w: 1920,
  h: 1080,
  hidden: false,
  locked: false,
  widget: { type: 'text', text, fit: false },
  style: {
    backgroundColor: null,
    backgroundOpacity: 100,
    backgroundAssetId: null,
    backgroundDim: 0,
    textColor: null,
    borderWidth: 0,
    borderStyle: 'solid',
    borderColor: null,
    radius: 0,
    shadow: 'none',
    fontFamily: 'inherit',
    fontAssetId: null,
    fontWeight: '600',
    lineHeight: 115,
    letterSpacing: 0,
    uppercase: false,
    textSize: 50,
    padding: 22,
    align: 'start',
    verticalAlign: 'center',
    opacity: 100,
  },
  ...patch,
});

export const scene = (id: string, patch: Partial<SignagePlayerScene> = {}): SignagePlayerScene =>
  ({
    id,
    name: id,
    aspectRatio: { width: 16, height: 9 },
    backgroundColor: '#000000',
    backgroundAssetId: null,
    backgroundFit: 'cover',
    backgroundDim: 0,
    fontFamily: 'sans',
    fontAssetId: null,
    theme: 'dark',
    blocks: [textBlock('main', id)],
    version: 1,
    ...patch,
  }) as SignagePlayerScene;

/** A scene list with one scene. */
export const only = (sceneId: string) => [{ sceneId, seconds: 10, transition: 'cut' as const }];

export const rule = (id: string, patch: Partial<SignagePlayerRule>): SignagePlayerRule =>
  ({
    id,
    kind: 'live_data_unavailable',
    weekdays: [],
    timeFrom: null,
    timeTo: null,
    machineIds: [],
    machineMatch: null,
    announcementTemplateIds: [],
    scenes: only('scene-a'),
    minSeconds: 0,
    multiMode: 'split',
    alternateSeconds: 10,
    ...patch,
  }) as SignagePlayerRule;

export const manifest = (revision: number, patch: Partial<SignagePlayerManifest> = {}): SignagePlayerManifest => ({
  revision,
  display: { aspectRatio: { width: 16, height: 9 }, visibleFromOutside: false },
  rules: [],
  manifestVersion: 4,
  defaultScenes: only('scene-a'),
  scenes: [scene('scene-a'), scene('scene-b')],
  assets: [],
  ...patch,
});

export const live = (patch: Partial<SignagePlayerLive> = {}): SignagePlayerLive => ({
  serverTime: new Date().toISOString(),
  revision: 1,
  machines: [],
  announcements: [],
  openDays: [],
  events: [],
  calendar: null,
  timelapses: null,
  streams: [],
  ...patch,
});

/** Distinct ids get distinct hashes (the cache is keyed by hash). */
const shaOf = (id: string) =>
  Array.from(id, (char) => char.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('')
    .padEnd(64, '0')
    .slice(0, 64);

export const asset = (id: string, kind: 'image' | 'video' = 'image', sizeBytes = 10) =>
  ({
    id,
    kind,
    name: id,
    contentType: kind === 'image' ? 'image/png' : 'video/mp4',
    sha256: shaOf(id),
    sizeBytes,
    width: null,
    height: null,
    durationMs: null,
    url: `/api/v1/signage/player/assets/${id}/${shaOf(id)}`,
  }) as SignagePlayerManifest['assets'][number];

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
