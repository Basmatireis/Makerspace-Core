import { activeAnnouncementsFor, renderAnnouncement, resolvePlayback } from './engine';
import { CLOSED_TEMPLATE_ID, sampleClosedAnnouncement } from './mockData';
import type { Announcement, AnnouncementField, AnnouncementTemplate, Display, RenderedAnnouncement, MachineSim, MediaItem, PlaybackResult, Playlist, Scene, Sim, Target, Widget } from './types';

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

export const sceneMediaIds = (scene: Scene): string[] => [...(scene.backgroundImage ? [scene.backgroundImage.mediaId] : []), ...Object.values(scene.zones).flatMap(widgetMediaIds)];

export const loopSeconds = (playlist: Playlist) => playlist.items.reduce((sum, item) => sum + item.seconds, 0);

/** The playback a display runs: always its last publication, never the drafts. Announcements are live data, not part of a publication. */
export function playbackOf(display: Display, sim: Sim, now: number, announcements: Announcement[]): PlaybackResult {
  const date = new Date(now);
  return resolvePlayback({ defaultPlaylistId: display.published.defaultPlaylistId }, display.published.rules, sim, date, activeAnnouncementsFor(display.id, announcements, date));
}

/** Renders one announcement for a display (`{display}` and `{location}` depend on it). */
export function renderFor(announcement: Announcement, template: AnnouncementTemplate, display: Pick<Display, 'name' | 'location'>, now: Date): RenderedAnnouncement {
  const timing = { startsAt: new Date(announcement.startsAt), endsAt: announcement.endsAt ? new Date(announcement.endsAt) : null };
  return { ...renderAnnouncement(template, announcement.values, timing, { now, displayName: display.name, location: display.location }), id: announcement.id, templateId: announcement.templateId, startsAt: timing.startsAt.getTime() };
}

/** What the Announcement widget of a display's scenes gets: the active announcements, rendered, newest first. */
export function renderedFor(display: Pick<Display, 'id' | 'name' | 'location'>, announcements: Announcement[], templates: AnnouncementTemplate[], now: Date): RenderedAnnouncement[] {
  return activeAnnouncementsFor(display.id, announcements, now).flatMap((item) => {
    const template = templates.find((entry) => entry.id === item.templateId);
    return template ? [renderFor(item, template, display, now)] : [];
  }).sort((a, b) => b.startsAt - a.startsAt);
}

/** The sample "Closed" announcement, rendered for thumbnails and the editor's "Announcement active" preview. Empty when the template was removed. */
export function sampleRendered(templates: AnnouncementTemplate[], now: Date, display: Pick<Display, 'name' | 'location'> = { name: 'Entrance window', location: 'Ground floor' }): RenderedAnnouncement[] {
  const template = templates.find((item) => item.id === CLOSED_TEMPLATE_ID);
  return template ? [renderFor(sampleClosedAnnouncement(now.getTime()), template, display, now)] : [];
}

export function targetName(target: Target, scenes: Scene[], playlists: Playlist[]): string {
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

// Announcement form values ----------------------------------------------------------------------------------------------------------
const pad = (value: number) => String(value).padStart(2, '0');
export const toDateValue = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
export const toDateTimeValue = (date: Date) => `${toDateValue(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;

/** The values a template's fields start with: their defaults. */
export const defaultValues = (fields: AnnouncementField[]): Record<string, string> => Object.fromEntries(fields.map((field) => [field.key, field.defaultValue]));

/** Example values for the template editor preview: the default, else something typical for the field type. */
export function sampleValues(fields: AnnouncementField[], now: Date): Record<string, string> {
  const tomorrow = new Date(now.getTime() + 86_400_000);
  tomorrow.setHours(10, 0, 0, 0);
  const sample = (field: AnnouncementField): string => {
    if (field.defaultValue !== '') return field.defaultValue;
    switch (field.type) {
      case 'time': return '14:30';
      case 'date': return toDateValue(tomorrow);
      case 'datetime': return toDateTimeValue(tomorrow);
      case 'number': return '15';
      case 'choice': return field.options[0] ?? '';
      case 'machine': return 'h2d';
      default: return field.label || 'Sample text';
    }
  };
  return Object.fromEntries(fields.map((field) => [field.key, sample(field)]));
}
