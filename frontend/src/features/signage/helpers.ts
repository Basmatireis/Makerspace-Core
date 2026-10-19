import { ApiError } from '../../api/http-client';

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
    // Display and announcement pages arrive with phase 2b; until then they are listed without a link.
    default: return null;
  }
}

export const referenceLabel = (reference: SignageReference) => ({
  scene: 'Scene', playlist: 'Playlist', display_default: 'Display (default playlist)', display_rule: 'Display (rule)', announcement: 'Announcement',
} as Record<string, string>)[reference.kind] ?? reference.kind;
