import { ApiError } from '../../api/http-client';
import { signagePaths } from './paths';

/** The address staff open on a screen to start the player: this app's origin plus the player path. */
export const playerAddress = () => `${window.location.origin}${signagePaths.player}`;

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

export function formatDuration(milliseconds: number): string {
  return formatLoop(Math.max(1, Math.round(milliseconds / 1000)));
}

export const formatDateTime = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export const pluralize = (count: number, singular: string, plural = `${singular}s`) => `${count} ${count === 1 ? singular : plural}`;

export const orientationLabel = (orientation: 'portrait' | 'landscape') => (orientation === 'portrait' ? 'Portrait' : 'Landscape');

export function errorMessage(error: unknown, fallback = 'The request failed. Try again.'): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

type ErrorBody = { code?: string; details?: { references?: unknown } };
const bodyOf = (error: unknown): ErrorBody | undefined => (error instanceof ApiError ? (error.data as ErrorBody | undefined) : undefined);

/** A write quoted an outdated `expectedVersion`: somebody else changed the entity. */
export const isStaleWrite = (error: unknown) => error instanceof ApiError && error.status === 409 && bodyOf(error)?.code === 'stale_write';

export type SignageReference = { kind: string; id: string; name: string };

/** The references that block a delete (409 `signage_in_use`), or null for any other error. */
export function inUseReferences(error: unknown): SignageReference[] | null {
  if (!(error instanceof ApiError) || error.status !== 409 || bodyOf(error)?.code !== 'signage_in_use') return null;
  const raw = bodyOf(error)?.details?.references;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): SignageReference[] => {
    const entry = item as Partial<SignageReference> | null;
    return entry && typeof entry.id === 'string' && typeof entry.name === 'string' ? [{ kind: String(entry.kind ?? ''), id: entry.id, name: entry.name }] : [];
  });
}

/** Where a reference of a blocked delete points to, if the admin UI has a page for it. */
export function referenceHref(reference: SignageReference): string | null {
  switch (reference.kind) {
    case 'scene': return `/signage/scenes/${encodeURIComponent(reference.id)}`;
    case 'playlist': return `/signage/playlists/${encodeURIComponent(reference.id)}`;
    case 'display_default':
    case 'display_rule': return `/signage/displays/${encodeURIComponent(reference.id)}`;
    case 'announcement': return '/signage/announcements';
    default: return null;
  }
}

export const referenceLabel = (reference: SignageReference) => ({
  scene: 'Scene', playlist: 'Playlist', display_default: 'Display (default playlist)', display_rule: 'Display (rule)', announcement: 'Announcement',
} as Record<string, string>)[reference.kind] ?? reference.kind;

/** "just now", "5 min ago", "2 h ago", "3 days ago". */
export function relativeTime(iso: string, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86_400)} days ago`;
}

/** "Mon 21 Oct, 14:30" in the viewer's zone, for announcement windows. */
export const formatMoment = (iso: string) => new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const PENDING_KIND: Record<string, string> = { display: 'Display settings', rule: 'Rule', scene: 'Scene', playlist: 'Playlist', asset: 'Media' };
const PENDING_CHANGE: Record<string, string> = { added: 'added', modified: 'edited', removed: 'removed' };
/** "Scene “Print live” edited". */
export const describePendingChange = (change: { kind: string; name: string; change: string }) => `${PENDING_KIND[change.kind] ?? change.kind}${change.name ? ` “${change.name}”` : ''} ${PENDING_CHANGE[change.change] ?? change.change}`;

export type DisplayResolution = { width: number; height: number };
/** Common panel sizes per orientation; the first is the default. */
export const RESOLUTIONS: Record<'portrait' | 'landscape', DisplayResolution[]> = {
  portrait: [{ width: 1080, height: 1920 }, { width: 2160, height: 3840 }, { width: 720, height: 1280 }],
  landscape: [{ width: 1920, height: 1080 }, { width: 3840, height: 2160 }, { width: 1280, height: 720 }],
};
export const resolutionLabel = (resolution: DisplayResolution) => `${resolution.width} × ${resolution.height}`;
/** The presets of an orientation, plus the current size when it is none of them. */
export function resolutionOptions(orientation: 'portrait' | 'landscape', current?: DisplayResolution): DisplayResolution[] {
  const presets = RESOLUTIONS[orientation];
  return current && !presets.some((item) => item.width === current.width && item.height === current.height) ? [current, ...presets] : presets;
}
