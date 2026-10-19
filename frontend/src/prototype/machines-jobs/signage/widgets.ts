import type { MediaItem, Sim, Widget, WidgetType } from './types';

export const WIDGET_LABELS: Record<WidgetType, string> = {
  empty: 'Empty', image: 'Image', video: 'Video', slideshow: 'Slideshow', text: 'Text', qr: 'QR code', clock: 'Clock', camera: 'Camera', status: 'Machine status', open_days: 'Open days', events: 'Events', announcement: 'Announcement',
};
export const WIDGET_TYPES = Object.keys(WIDGET_LABELS) as WidgetType[];

export function defaultWidget(type: WidgetType, media: MediaItem[]): Widget {
  const firstImage = media.find((item) => item.kind === 'image')?.id ?? null;
  const firstVideo = media.find((item) => item.kind === 'video')?.id ?? null;
  switch (type) {
    case 'empty': return { type };
    case 'image': return { type, mediaId: firstImage, fit: 'cover' };
    case 'video': return { type, mediaId: firstVideo, fit: 'cover' };
    case 'slideshow': return { type, mediaIds: media.filter((item) => item.kind === 'image').slice(0, 2).map((item) => item.id), seconds: 8 };
    case 'text': return { type, text: 'Your text', size: 'm', align: 'start' };
    case 'qr': return { type, url: 'https://makerspace.example', caption: 'Scan for details' };
    case 'clock': return { type, mode: 'time' };
    case 'camera': return { type, source: 'auto', machineId: 'h2d', multi: 'split', showProgress: true, showRemaining: true, fallback: 'text', fallbackMediaId: null };
    case 'status': return { type, machineIds: ['h2d', 'x1c'], showProgress: true, showRemaining: true };
    case 'open_days': return { type, count: 3 };
    case 'events': return { type, count: 3 };
    case 'announcement': return { type, templateIds: [], style: 'banner', size: 'm', whenNone: 'empty', fallbackText: '', whenMany: 'rotate', rotateSeconds: 10 };
  }
}

/** "Preview as" choices in the scene editor. `announcement` shows the sample "Closed" announcement. */
export const PREVIEW_PRESETS: { id: string; label: string; sim: Sim; announcement?: boolean }[] = [
  { id: 'idle', label: 'Idle', sim: { h2d: 'idle', x1c: 'idle', coreReachable: true } },
  { id: 'h2d', label: 'H2D printing', sim: { h2d: 'printing', x1c: 'idle', coreReachable: true } },
  { id: 'both', label: 'Both printing', sim: { h2d: 'printing', x1c: 'printing', coreReachable: true } },
  { id: 'camera', label: 'Camera unavailable', sim: { h2d: 'camera_unavailable', x1c: 'idle', coreReachable: true } },
  { id: 'stale', label: 'Live data stale', sim: { h2d: 'printing', x1c: 'idle', coreReachable: false } },
  { id: 'announcement', label: 'Announcement active', sim: { h2d: 'idle', x1c: 'idle', coreReachable: true }, announcement: true },
];
