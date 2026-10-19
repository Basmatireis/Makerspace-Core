import { resolvePlayback } from './engine';
import type { Display, MachineSim, MediaItem, PlaybackResult, Playlist, Scene, Sim, Target, Widget } from './types';

export const uid = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;

export function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} kB`;
}

export function formatLoop(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86_400)} d ago`;
}

export const formatDateTime = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
export const formatClock = (date: Date) => date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

export const orientationLabel = (display: Pick<Display, 'orientation' | 'resolution'>) =>
  `${display.orientation === 'portrait' ? 'Portrait' : 'Landscape'} ${display.resolution.w} × ${display.resolution.h}`;

export const pluralize = (count: number, singular: string, plural = `${singular}s`) => `${count} ${count === 1 ? singular : plural}`;

export function widgetMediaIds(widget: Widget): string[] {
  switch (widget.type) {
    case 'image': case 'video': return widget.mediaId ? [widget.mediaId] : [];
    case 'slideshow': return widget.mediaIds;
    case 'camera': return widget.fallbackMediaId ? [widget.fallbackMediaId] : [];
    default: return [];
  }
}

export const sceneMediaIds = (scene: Scene): string[] => Object.values(scene.zones).flatMap(widgetMediaIds);

export const loopSeconds = (playlist: Playlist) => playlist.items.reduce((sum, item) => sum + item.seconds, 0);

/** The playback a display runs: always its last publication, never the drafts. */
export function playbackOf(display: Display, sim: Sim, now: number): PlaybackResult {
  return resolvePlayback({ defaultPlaylistId: display.published.defaultPlaylistId, announcement: display.announcement }, display.published.rules, sim, new Date(now));
}

export function targetName(target: Target, scenes: Scene[], playlists: Playlist[]): string {
  if (target.type === 'scene' && target.id === '') return 'Scene Announcement text';
  if (target.type === 'scene') return `Scene ${scenes.find((item) => item.id === target.id)?.name ?? 'removed'}`;
  return `Playlist ${playlists.find((item) => item.id === target.id)?.name ?? 'removed'}`;
}

/** Scenes referenced by a display's draft: its rules and default playlist, directly or through playlists. */
export function displaySceneIds(display: Display, playlists: Playlist[]): Set<string> {
  const ids = new Set<string>();
  const addPlaylist = (id: string) => playlists.find((item) => item.id === id)?.items.forEach((item) => ids.add(item.sceneId));
  addPlaylist(display.defaultPlaylistId);
  for (const rule of display.rules) { if (rule.target.type === 'scene') ids.add(rule.target.id); else addPlaylist(rule.target.id); }
  return ids;
}

export const displayUsesPlaylist = (display: Display, playlistId: string) =>
  display.defaultPlaylistId === playlistId || display.rules.some((rule) => rule.target.type === 'playlist' && rule.target.id === playlistId);

export function sceneUsage(sceneId: string, playlists: Playlist[], displays: Display[]) {
  return {
    playlists: playlists.filter((playlist) => playlist.items.some((item) => item.sceneId === sceneId)).length,
    rules: displays.reduce((sum, display) => sum + display.rules.filter((rule) => rule.target.type === 'scene' && rule.target.id === sceneId).length, 0),
  };
}

export const scenesUsingMedia = (media: MediaItem, scenes: Scene[]) => scenes.filter((scene) => sceneMediaIds(scene).includes(media.id));

/** Scenes of any display's last publication that still use the media; deleting it would break a running display. */
export function publishedScenesUsingMedia(mediaId: string, displays: Display[]): Scene[] {
  const found = new Map<string, Scene>();
  for (const display of displays) for (const scene of display.published.scenes) if (sceneMediaIds(scene).includes(mediaId)) found.set(scene.id, scene);
  return [...found.values()];
}

export function cameraState(sim: MachineSim, coreReachable: boolean): { label: string; type: 'green' | 'gray' | 'red' } {
  if (!coreReachable || sim === 'camera_unavailable') return { label: 'Unavailable', type: 'red' };
  return sim === 'printing' ? { label: 'Live', type: 'green' } : { label: 'Idle', type: 'gray' };
}
