import { emptyZones } from './templates';
import { DEFAULT_ANNOUNCEMENT_SCENE } from './engine';
import type { Display, LocalService, MediaItem, Playlist, Rule, Scene, Snapshot, Widget } from './types';

// Mock data: everything is generated in code (inline SVG data URIs), no network and no files.

const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const uri = (svg: string) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;

/** A poster: diagonal gradient, large title lines and a soft shape. */
export function poster(lines: string[], sub: string, from: string, to: string, w: number, h: number, accent = '#ffffff') {
  const size = Math.round(Math.min(w, h) * 0.13);
  const startY = h * 0.38;
  const text = lines.map((line, index) => `<text x="${w * 0.08}" y="${startY + index * size * 1.15}" font-family="IBM Plex Sans, Arial, sans-serif" font-weight="700" font-size="${size}" fill="${accent}">${esc(line)}</text>`).join('');
  return uri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/><circle cx="${w * 0.82}" cy="${h * 0.16}" r="${Math.min(w, h) * 0.28}" fill="#ffffff" fill-opacity="0.12"/><circle cx="${w * 0.9}" cy="${h * 0.9}" r="${Math.min(w, h) * 0.2}" fill="#000000" fill-opacity="0.12"/>${text}<text x="${w * 0.08}" y="${startY + lines.length * size * 1.15 + size * 0.4}" font-family="IBM Plex Sans, Arial, sans-serif" font-size="${size * 0.42}" fill="${accent}" fill-opacity="0.85">${esc(sub)}</text></svg>`);
}

/** Mock camera frame: a dark workshop, a build plate and a half-finished print in the machine's colour. */
export function cameraFrame(color: string, layers: number) {
  const height = 30 + layers * 4;
  return uri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 360" width="560" height="360"><defs><linearGradient id="w" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b2f36"/><stop offset="1" stop-color="#14161a"/></linearGradient></defs><rect width="560" height="360" fill="url(#w)"/><rect x="40" y="30" width="480" height="8" fill="#474c55"/><rect x="40" y="30" width="8" height="300" fill="#474c55"/><rect x="512" y="30" width="8" height="300" fill="#474c55"/><polygon points="280,215 470,265 280,315 90,265" fill="#3a3f47" stroke="#6f7782" stroke-width="2"/><polygon points="280,262 ${280 + 62},${262 - 14} ${280 + 62},${262 - 14 - height} 280,${262 - height} ${280 - 62},${262 - 14 - height} ${280 - 62},${262 - 14}" fill="${color}"/><polygon points="280,${262 - height} ${280 + 62},${262 - 14 - height} 280,${262 - 28 - height} ${280 - 62},${262 - 14 - height}" fill="#ffffff" fill-opacity="0.28"/><rect x="262" y="${70 + layers}" width="36" height="22" rx="3" fill="#8d96a3"/><rect x="277" y="${92 + layers}" width="6" height="${Math.max(10, 120 - height)}" fill="#c6c6c6"/></svg>`);
}

const day = 86_400_000;
const hour = 3_600_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

// Media ---------------------------------------------------------------------------------------------------------------------------
const mediaRow = (id: string, name: string, kind: 'image' | 'video', width: number, height: number, sizeMb: number, format: string, src: string, ageDays: number, by = 'Mira Kovac'): MediaItem => ({
  id, name, kind, width, height, sizeBytes: Math.round(sizeMb * 1_048_576), format, checksum: `sha256:${Math.abs([...id].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) | 0, 7)).toString(16).padStart(8, '0')}${(id.length * 2654435761 % 4294967295).toString(16).padStart(8, '0')}`,
  uploadedBy: by, uploadedAt: iso(-ageDays * day), src, status: 'ready',
});

export const mediaSeed: MediaItem[] = [
  mediaRow('media-open-days', 'open-days-poster.png', 'image', 1080, 1920, 2.1, 'PNG', poster(['Open', 'days'], 'Sat 24 Oct · 10:00–16:00', '#6929c4', '#1192e8', 1080, 1920), 12),
  mediaRow('media-workshops', 'workshops-autumn.jpg', 'image', 1080, 1920, 1.6, 'JPEG', poster(['Learn', 'to make'], 'Workshops this autumn', '#005d5d', '#9ef0f0', 1080, 1920, '#161616'), 9),
  mediaRow('media-3dprint', '3d-printing-service.webp', 'image', 1080, 1920, 0.9, 'WebP', poster(['3D printing', 'for you'], 'Upload your model, pick it up', '#a2191f', '#ff832b', 1080, 1920), 20),
  mediaRow('media-welcome', 'welcome-landscape.png', 'image', 1920, 1080, 1.8, 'PNG', poster(['Welcome to', 'Makerspace Graz'], 'Please sign in at the desk', '#0f62fe', '#001d6c', 1920, 1080), 30),
  mediaRow('media-safety', 'safety-rules.png', 'image', 1920, 1080, 1.2, 'PNG', poster(['Safety first'], 'Eye protection · Closed shoes · Ask if unsure', '#161616', '#525252', 1920, 1080, '#f1c21b'), 45),
  mediaRow('media-laser', 'laser-cutter-intro.jpg', 'image', 1920, 1080, 2.4, 'JPEG', poster(['Laser', 'cutting'], 'Book a slot at the desk', '#8a3800', '#f1c21b', 1920, 1080, '#161616'), 6),
  mediaRow('media-closed', 'closed-background.png', 'image', 1080, 1920, 0.4, 'PNG', poster(['Closed'], 'We are back tomorrow', '#750e13', '#da1e28', 1080, 1920), 100),
  mediaRow('media-sponsors', 'sponsors-wall.png', 'image', 1920, 1080, 3.2, 'PNG', poster(['Thank you'], 'Our supporters and partners', '#198038', '#24a148', 1920, 1080), 3, 'Jonas Weber'),
  { ...mediaRow('media-timelapse', 'print-timelapse.mp4', 'video', 1920, 1080, 84.5, 'MP4 · H.264', poster(['Print', 'timelapse'], 'Video · 0:42', '#262626', '#6929c4', 1920, 1080), 15), checksum: 'sha256:9c1e07b24d5a6f10' },
  { ...mediaRow('media-intro', 'makerspace-intro.mp4', 'video', 1080, 1920, 120.3, 'MP4 · H.264', poster(['Meet the', 'makerspace'], 'Video · 1:05', '#001141', '#4589ff', 1080, 1920), 22), checksum: 'sha256:41ab39c0e7d8b215' },
];

export const GB_USED_BASE = 2.4 * 1024 * 1024 * 1024;
export const STORAGE_LIMIT_BYTES = 20 * 1024 * 1024 * 1024;

export const FEED_COLORS = { h2d: '#ff832b', x1c: '#4589ff' } as const;
export const cameraFrames = { h2d: [cameraFrame(FEED_COLORS.h2d, 22), cameraFrame(FEED_COLORS.h2d, 26)], x1c: [cameraFrame(FEED_COLORS.x1c, 10), cameraFrame(FEED_COLORS.x1c, 14)] };

/** What the status and camera widgets show for a printing machine. Never customer names or prices. */
export const machineLive = {
  h2d: { name: 'Bambu H2D', progress: 63, endsAt: '14:20', remaining: '48 min', file: 'Bracket v3' },
  x1c: { name: 'Bambu X1C', progress: 28, endsAt: '16:05', remaining: '2 h 12 min', file: 'Enclosure lid' },
} as const;

export const openDaysSeed = [
  { date: 'Sat 24 Oct', time: '10:00–16:00' }, { date: 'Sat 7 Nov', time: '10:00–16:00' }, { date: 'Sat 21 Nov', time: '10:00–14:00' },
  { date: 'Sat 5 Dec', time: '10:00–16:00' }, { date: 'Sat 19 Dec', time: '10:00–14:00' },
];
export const eventsSeed = [
  { title: 'Laser cutting basics', when: 'Tue 27 Oct · 18:00' }, { title: 'Soldering evening', when: 'Thu 29 Oct · 18:30' }, { title: 'Repair café', when: 'Sat 31 Oct · 14:00' },
  { title: '3D printing intro', when: 'Tue 3 Nov · 18:00' }, { title: 'Wood workshop', when: 'Thu 5 Nov · 17:30' },
];

// Scenes --------------------------------------------------------------------------------------------------------------------------
const fullImage = (mediaId: string): Record<string, Widget> => ({ main: { type: 'image', mediaId, fit: 'cover' } });
const scene = (partial: Pick<Scene, 'id' | 'name' | 'orientation' | 'templateId'> & Partial<Scene>): Scene => ({ background: '#161616', theme: 'dark', ...partial, zones: { ...emptyZones(partial.templateId), ...partial.zones } });

export const scenesSeed: Scene[] = [
  scene({ id: 'scene-ad-open-days', name: 'Ad – Open days', orientation: 'portrait', templateId: 'full', zones: fullImage('media-open-days') }),
  scene({ id: 'scene-ad-workshops', name: 'Ad – Workshops', orientation: 'portrait', templateId: 'full', zones: fullImage('media-workshops') }),
  scene({ id: 'scene-ad-3dprint', name: 'Ad – 3D printing service', orientation: 'portrait', templateId: 'full', zones: fullImage('media-3dprint') }),
  scene({
    id: 'scene-print-live', name: 'Print live', orientation: 'portrait', templateId: 'stack4', background: '#0b0f19',
    zones: {
      header: { type: 'text', text: 'Live from our printers', size: 'l', align: 'center' },
      main: { type: 'camera', source: 'auto', machineId: 'h2d', multi: 'split', showProgress: true, showRemaining: true, fallback: 'image', fallbackMediaId: 'media-3dprint' },
      info: { type: 'status', machineIds: ['h2d', 'x1c'], showProgress: true, showRemaining: true },
      footer: { type: 'qr', url: 'https://makerspace.example/print', caption: 'Order your print online' },
    },
  }),
  scene({
    id: 'scene-overview', name: 'Workshop overview', orientation: 'landscape', templateId: 'grid2x2', background: '#262626',
    zones: {
      tl: { type: 'status', machineIds: ['h2d', 'x1c'], showProgress: true, showRemaining: true }, tr: { type: 'open_days', count: 3 },
      bl: { type: 'events', count: 3 }, br: { type: 'clock', mode: 'datetime' },
    },
  }),
  scene({
    id: 'scene-morning', name: 'Morning briefing', orientation: 'landscape', templateId: 'banner_main', background: '#001d6c',
    zones: {
      banner: { type: 'text', text: 'Good morning – today in the workshop', size: 'l', align: 'start' },
      main: { type: 'slideshow', mediaIds: ['media-safety', 'media-laser', 'media-sponsors'], seconds: 8 },
    },
  }),
  scene({ id: 'scene-ad-welcome', name: 'Ad – Welcome', orientation: 'landscape', templateId: 'full', zones: fullImage('media-welcome') }),
  scene({
    id: DEFAULT_ANNOUNCEMENT_SCENE, name: 'Closed today', orientation: 'portrait', templateId: 'full', background: '#a2191f', announcement: true,
    zones: { main: { type: 'text', text: 'Closed today\nWe are back tomorrow at 10:00', size: 'xl', align: 'center' } },
  }),
  scene({
    id: 'scene-back-soon', name: 'Back in a moment', orientation: 'landscape', templateId: 'full', background: '#0f62fe', announcement: true,
    zones: { main: { type: 'text', text: 'Back in a moment\nPlease ask at the desk', size: 'xl', align: 'center' } },
  }),
];

// Playlists -----------------------------------------------------------------------------------------------------------------------
export const playlistsSeed: Playlist[] = [
  {
    id: 'pl-ads', name: 'Ads',
    items: [
      { id: 'pli-1', sceneId: 'scene-ad-open-days', seconds: 20, transition: 'fade' },
      { id: 'pli-2', sceneId: 'scene-ad-workshops', seconds: 30, transition: 'fade' },
      { id: 'pli-3', sceneId: 'scene-ad-3dprint', seconds: 30, transition: 'cut' },
    ],
  },
  {
    id: 'pl-workshop', name: 'Workshop info',
    items: [
      { id: 'pli-4', sceneId: 'scene-overview', seconds: 40, transition: 'fade' },
      { id: 'pli-5', sceneId: 'scene-ad-welcome', seconds: 20, transition: 'fade' },
    ],
  },
];

// Displays ------------------------------------------------------------------------------------------------------------------------
const snapshot = (rules: Rule[], defaultPlaylistId: string): Snapshot => ({ rules: structuredClone(rules), defaultPlaylistId, scenes: structuredClone(scenesSeed), playlists: structuredClone(playlistsSeed) });

const rulesEntrance: Rule[] = [{ id: 'rule-ent-1', enabled: true, condition: { kind: 'machines', machines: ['h2d', 'x1c'], mode: 'any' }, target: { type: 'scene', id: 'scene-print-live' }, minSeconds: 20, multiMode: 'split', alternateSeconds: 10 }];
const rulesWorkshop: Rule[] = [{ id: 'rule-ws-1', enabled: true, condition: { kind: 'time', days: [1, 2, 3, 4, 5], from: '08:00', to: '10:00' }, target: { type: 'scene', id: 'scene-morning' }, minSeconds: 20, multiMode: 'split', alternateSeconds: 10 }];
const rulesLaser: Rule[] = [{ id: 'rule-laser-1', enabled: true, condition: { kind: 'time', days: [1, 2, 3, 4, 5], from: '08:00', to: '10:00' }, target: { type: 'scene', id: 'scene-morning' }, minSeconds: 20, multiMode: 'split', alternateSeconds: 10 }];

const baseDisplay = { revoked: false, announcement: null, errors: [] as Display['errors'], syncPercent: 100 };

export const displaysSeed: Display[] = [
  {
    ...baseDisplay, id: 'display-entrance', name: 'Entrance window', location: 'Ground floor, facing the street', orientation: 'portrait', resolution: { w: 1080, h: 1920 }, outside: true,
    status: 'online', lastSeenAt: iso(-20_000), playerVersion: '0.9.3', cacheGb: 1.2, cacheLimitGb: 8, rules: structuredClone(rulesEntrance), defaultPlaylistId: 'pl-ads',
    pending: [], revision: 14, publishedAt: iso(-3 * day), published: snapshot(rulesEntrance, 'pl-ads'),
    errors: [{ at: iso(-26 * hour), message: 'Video “print-timelapse.mp4” skipped: decoder reset' }],
  },
  {
    ...baseDisplay, id: 'display-workshop', name: 'Workshop info', location: 'Workshop hall, next to the tool wall', orientation: 'landscape', resolution: { w: 1920, h: 1080 }, outside: false,
    status: 'online', lastSeenAt: iso(-45_000), playerVersion: '0.9.3', cacheGb: 0.6, cacheLimitGb: 8, rules: structuredClone(rulesWorkshop), defaultPlaylistId: 'pl-workshop',
    pending: [], revision: 9, publishedAt: iso(-8 * day), published: snapshot(rulesWorkshop, 'pl-workshop'),
  },
  {
    ...baseDisplay, id: 'display-laser', name: 'Laser room', location: 'Laser room, upper floor', orientation: 'landscape', resolution: { w: 1920, h: 1080 }, outside: false,
    status: 'offline', lastSeenAt: iso(-2 * hour), playerVersion: '0.9.1', cacheGb: 0.4, cacheLimitGb: 4, rules: structuredClone(rulesLaser), defaultPlaylistId: 'pl-workshop',
    pending: ['Scene “Workshop overview” edited', 'Rule added'], revision: 5, publishedAt: iso(-20 * day), published: snapshot(rulesLaser, 'pl-workshop'),
    errors: [{ at: iso(-2 * hour), message: 'Heartbeat missed: network unreachable' }, { at: iso(-5 * day), message: 'Player updated from 0.9.0 to 0.9.1' }],
  },
];

// Local services ------------------------------------------------------------------------------------------------------------------
export const servicesSeed: LocalService[] = [
  { id: 'svc-connector', kind: 'printer_connector', name: 'Printer connector', state: 'online', version: '1.4.2', detail: '2 printers connected', rotatesInDays: 61 },
  { id: 'svc-gateway', kind: 'streaming_gateway', name: 'Streaming gateway', state: 'online', version: '0.3.0', detail: '2 cameras', rotatesInDays: 34 },
];

export const camerasSeed = [
  { machine: 'h2d' as const, name: 'Bambu H2D', gateway: 'Streaming gateway', format: '1680 × 1080 · H.264 · 30 fps' },
  { machine: 'x1c' as const, name: 'Bambu X1C', gateway: 'Streaming gateway', format: '1280 × 720 · H.264 · 30 fps' },
];

export const PAIRING_CODE = 'K7F2QX';
export const RESOLUTIONS = {
  portrait: [{ w: 1080, h: 1920 }, { w: 2160, h: 3840 }, { w: 720, h: 1280 }],
  landscape: [{ w: 1920, h: 1080 }, { w: 3840, h: 2160 }, { w: 1280, h: 720 }],
};
