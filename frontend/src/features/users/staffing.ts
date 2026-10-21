import type { StaffingStatus, SupervisorRow } from '../../api/generated/models';
import type { FilterValues } from '../../app/BatchFilter';

export const STATUS_OPTIONS: Array<{ id: StaffingStatus; label: string }> = [
  { id: 'missing', label: 'Below minimum' },
  { id: 'ready', label: 'Ready for supervisor' },
  { id: 'fulfilled', label: 'Minimum reached' },
];

export const KIND_OPTIONS = [
  { id: 'supervisor', label: 'Supervisor' },
  { id: 'trainee', label: 'Trainee' },
];

export const LAB_RULES_OPTIONS = [
  { id: 'current', label: 'Current' },
  { id: 'outdated', label: 'Outdated' },
  { id: 'not_required', label: 'Not required' },
  { id: 'no_published_version', label: 'No published version' },
];

export const PHOTO_OPTIONS = [
  { id: 'complete', label: 'Complete' },
  { id: 'missing', label: 'Missing' },
];

export function labRulesLabel(state: string): string {
  return state.replaceAll('_', ' ').replace(/^./, (value) => value.toUpperCase());
}

/** Rows that need action first (below minimum, then ready for promotion), then by name. */
export function compareRows(a: SupervisorRow, b: SupervisorRow): number {
  const rank = (row: SupervisorRow) => STATUS_OPTIONS.findIndex((option) => option.id === row.status);
  return rank(a) - rank(b) || a.name.localeCompare(b.name);
}

export function filterRows(rows: SupervisorRow[], search: string, filters: FilterValues): SupervisorRow[] {
  const query = search.trim().toLocaleLowerCase();
  const matches = (key: string, value: string) => !filters[key]?.length || filters[key].includes(value);
  return rows
    .filter(
      (row) =>
        (!query || row.name.toLocaleLowerCase().includes(query)) &&
        matches('status', row.status) &&
        matches('kind', row.kind) &&
        matches('labRules', row.laborordnungState) &&
        matches('photo', row.hasProfileImage ? 'complete' : 'missing'),
    )
    .sort(compareRows);
}

/** A key-figure tile is active when exactly its one filter is set. */
export function isTileActive(filters: FilterValues, key: string, value: string): boolean {
  const keys = Object.keys(filters).filter((name) => filters[name].length > 0);
  return keys.length === 1 && keys[0] === key && filters[key].length === 1 && filters[key][0] === value;
}
