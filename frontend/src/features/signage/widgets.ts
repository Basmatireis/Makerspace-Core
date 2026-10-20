import type { SignageWidget, SignageZones } from '../../api/generated/models';

export type WidgetType = SignageWidget['type'];

export const WIDGET_LABELS: Record<WidgetType, string> = {
  empty: 'Empty', image: 'Image', video: 'Video', slideshow: 'Slideshow', text: 'Text', qr: 'QR code', clock: 'Clock', camera: 'Camera',
  status: 'Machine status', open_days: 'Open days', events: 'Events', announcement: 'Announcement',
};
export const WIDGET_TYPES = Object.keys(WIDGET_LABELS) as WidgetType[];

export function defaultWidget(type: WidgetType): SignageWidget {
  switch (type) {
    case 'empty': return { type };
    case 'image': case 'video': return { type, mediaId: null, fit: 'cover' };
    case 'slideshow': return { type, mediaIds: [], seconds: 8 };
    case 'text': return { type, text: 'Your text', size: 'm', align: 'start' };
    case 'qr': return { type, url: 'https://', caption: 'Scan for details' };
    case 'clock': return { type, mode: 'time' };
    case 'camera': return { type, source: 'auto', machineId: null, multi: 'split', showProgress: true, showRemaining: true, fallback: 'text', fallbackMediaId: null, machineIds: [] };
    case 'status': return { type, machineIds: [], showProgress: true, showRemaining: true };
    case 'open_days': case 'events': return { type, count: 3 };
    case 'announcement': return { type, templateIds: [], style: 'banner', size: 'm', whenNone: 'empty', fallbackText: '', whenMany: 'rotate', rotateSeconds: 10 };
  }
}

/** Asset ids a widget points at. */
export function widgetAssetIds(widget: SignageWidget): string[] {
  switch (widget.type) {
    case 'image': case 'video': return widget.mediaId ? [widget.mediaId] : [];
    case 'slideshow': return widget.mediaIds;
    case 'camera': return widget.fallback === 'image' && widget.fallbackMediaId ? [widget.fallbackMediaId] : [];
    default: return [];
  }
}

export const sceneAssetIds = (scene: { backgroundAssetId: string | null; zones: SignageZones }): string[] => [
  ...(scene.backgroundAssetId ? [scene.backgroundAssetId] : []),
  ...Object.values(scene.zones).flatMap(widgetAssetIds),
];

/** Machines a scene's widgets point at, so previews can show them even without access to the machine list. */
export const sceneMachineIds = (zones: SignageZones): string[] => [...new Set(Object.values(zones).flatMap((widget) => {
  if (widget.type === 'camera') return [...(widget.machineId ? [widget.machineId] : []), ...(widget.machineIds ?? [])];
  return widget.type === 'status' ? widget.machineIds : [];
}))];

export const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Mirrors the backend widget validation (zones.go) so autosave does not send what is certain to be rejected. */
export function widgetError(widget: SignageWidget): string | null {
  switch (widget.type) {
    case 'text': return widget.text.length > 1000 ? 'Text is limited to 1000 characters.' : null;
    case 'qr':
      if (widget.url.length > 500) return 'The URL is limited to 500 characters.';
      if (widget.caption.length > 200) return 'The caption is limited to 200 characters.';
      try {
        const url = new URL(widget.url);
        return url.protocol === 'https:' && url.hostname !== '' && url.username === '' && url.password === '' ? null : 'Enter an https:// URL without credentials.';
      } catch {
        return 'Enter an https:// URL without credentials.';
      }
    case 'camera':
      if (widget.source === 'machine' && !widget.machineId) return 'Choose a machine.';
      return (widget.machineIds?.length ?? 0) > 20 ? 'A camera widget lists at most 20 machines.' : null;
    case 'slideshow': return widget.seconds < 3 || widget.seconds > 3600 ? 'Seconds per slide must be between 3 and 3600.' : widget.mediaIds.length > 50 ? 'A slideshow holds at most 50 images.' : null;
    case 'open_days': case 'events': return widget.count < 1 || widget.count > 10 ? 'Choose between 1 and 10.' : null;
    case 'announcement':
      if (widget.rotateSeconds < 3 || widget.rotateSeconds > 300) return 'Rotate every 3 to 300 seconds.';
      return widget.fallbackText.length > 500 ? 'The fallback text is limited to 500 characters.' : null;
    default: return null;
  }
}
