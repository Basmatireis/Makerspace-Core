import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { getDownloadSignageAssetUrl } from '../../api/generated/signage/signage';
import type { SignageAnnouncementTemplate } from '../../api/generated/models';
import { renderAnnouncement } from './engine/announcements';
import type { RenderAnnouncement, RenderData, RenderMachine } from './render/types';
import { machinesQuery, templatesQuery } from './queries';

// Sample data for the admin previews (editor canvas, thumbnails, playlist preview). Real live data only exists on the
// player; the editor lets people check fallbacks by picking a "Preview as" situation.

export type PreviewPresetId = 'idle' | 'first' | 'all' | 'camera' | 'stale' | 'announcement';
export const PREVIEW_PRESETS: { id: PreviewPresetId; label: string }[] = [
  { id: 'idle', label: 'Idle' },
  { id: 'first', label: 'One machine printing' },
  { id: 'all', label: 'All machines printing' },
  { id: 'camera', label: 'Camera unavailable' },
  { id: 'stale', label: 'Live data stale' },
  { id: 'announcement', label: 'Announcement active' },
];

export const assetContentUrl = (assetId: string) => getDownloadSignageAssetUrl(assetId);

export type MachineOption = { id: string; name: string };

/** Machines for pickers and previews. Without `machines.read` the list is empty and widgets show ids as "Machine". */
export function useMachineOptions(): { machines: MachineOption[]; known: boolean } {
  const canRead = hasPermission(useCurrentUser(), PermissionId.machinesread);
  const query = useQuery(machinesQuery(canRead));
  const machines = useMemo(() => (query.data?.items ?? []).map((machine) => ({ id: machine.id, name: machine.name })), [query.data]);
  return { machines, known: canRead && query.isSuccess };
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const pad = (value: number) => String(value).padStart(2, '0');
const localDate = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const localDateTime = (date: Date) => `${localDate(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;

type SampleField = { key: string; label: string; type: string; defaultValue: string; options: string[] };

/** Example values for the template editor preview: the default, else something typical for the field type. */
export function sampleValues(fields: readonly SampleField[], now: Date): Record<string, string> {
  const tomorrow = new Date(now.getTime() + 86_400_000);
  tomorrow.setHours(10, 0, 0, 0);
  const sample = (field: SampleField): string => {
    if (field.defaultValue !== '') return field.defaultValue;
    switch (field.type) {
      case 'time': return '14:30';
      case 'date': return localDate(tomorrow);
      case 'datetime': return localDateTime(tomorrow);
      case 'number': return '15';
      case 'choice': return field.options[0] ?? '';
      case 'machine': return '';
      default: return field.label || 'Sample text';
    }
  };
  return Object.fromEntries(fields.map((field) => [field.key, sample(field)]));
}

type TemplateLike = Pick<SignageAnnouncementTemplate, 'fields' | 'title' | 'body' | 'tone'>;

/** A template rendered with sample values, ending in two hours (display name and location are sample text too). */
export function renderSample(template: TemplateLike, machines: Record<string, string>, now: Date): ReturnType<typeof renderAnnouncement> {
  return renderAnnouncement(template, sampleValues(template.fields, now), { startsAt: now, endsAt: new Date(now.getTime() + 2 * 3_600_000) }, { now, timeZone: browserZone(), displayName: 'Entrance window', location: 'Ground floor', machines });
}

const sampleOpenDays = (now: number): RenderData['openDays'] => [1, 3, 5].map((days) => {
  const start = new Date(now + days * 86_400_000);
  start.setHours(14, 0, 0, 0);
  return { startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 3 * 3_600_000).toISOString(), status: 'scheduled' };
});
const sampleEvents = (now: number): RenderData['events'] => ['Soldering workshop', 'Laser cutter introduction', 'Repair café'].map((title, index) => {
  const start = new Date(now + (index + 2) * 86_400_000);
  start.setHours(18, 0, 0, 0);
  return { title, startsAt: start.toISOString(), location: null };
});

export type PreviewInput = {
  preset: PreviewPresetId;
  now: number;
  machines: MachineOption[];
  /** Machines the scene mentions; they appear even when the person cannot list machines. */
  referencedMachineIds?: readonly string[];
  templates: readonly SignageAnnouncementTemplate[];
  still?: boolean;
};

export function buildPreviewData({ preset, now, machines, referencedMachineIds = [], templates, still }: PreviewInput): RenderData {
  const ids = [...new Set([...machines.map((machine) => machine.id), ...referencedMachineIds])];
  const names = Object.fromEntries(machines.map((machine) => [machine.id, machine.name]));
  const printing = preset === 'all' ? ids : preset === 'idle' || preset === 'announcement' ? [] : ids.slice(0, 1);
  const states: RenderMachine[] = ids.map((id, index) => {
    const busy = printing.includes(id);
    return { machineId: id, name: names[id] ?? 'Machine', state: busy ? 'printing' : 'idle', progressPercent: busy ? 62 - index * 17 : null, remainingMinutes: busy ? 38 + index * 20 : null, stale: false };
  });
  const date = new Date(now);
  let announcements: RenderAnnouncement[] = [];
  if (preset === 'announcement') {
    announcements = templates.slice(0, 3).map((template, index) => ({ id: template.id, templateId: template.id, ...renderSample(template, names, date), startsAt: now - index }));
    if (announcements.length === 0) announcements = [{ id: 'sample', templateId: '', tone: 'warning', title: 'Closed today', body: 'We are back tomorrow.', startsAt: now }];
  }
  return {
    now,
    liveAvailable: preset !== 'stale',
    machines: states,
    unavailableCameras: new Set(preset === 'camera' ? ids.slice(0, 1) : []),
    announcements,
    openDays: sampleOpenDays(now),
    events: sampleEvents(now),
    assetUrl: assetContentUrl,
    still,
  };
}

/** Render data for previews, with machines and announcement templates from the API (when the person may read them). */
export function usePreviewData(preset: PreviewPresetId, options: { now: number; referencedMachineIds?: readonly string[]; still?: boolean }): RenderData {
  const { machines } = useMachineOptions();
  const templates = useQuery(templatesQuery()).data?.items;
  const { now, referencedMachineIds, still } = options;
  const referenced = referencedMachineIds?.join(',') ?? '';
  return useMemo(
    () => buildPreviewData({ preset, now, machines, referencedMachineIds: referenced ? referenced.split(',') : [], templates: templates ?? [], still }),
    [preset, now, machines, referenced, templates, still],
  );
}
