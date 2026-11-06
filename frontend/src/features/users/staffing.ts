import type { StaffingStatus, SupervisorRow } from '../../api/generated/models';
import { formatDate, formatTime } from '../../app/dateTime';

/** The people table's filter categories; each maps to a list of chosen option ids. */
export type FilterKey = 'membership' | 'status' | 'extra' | 'signedUp' | 'labRules';
export type StaffingFilterValues = Partial<Record<FilterKey, string[]>>;

export type FilterOption = { id: string; label: string };
export type FilterDef = { key: FilterKey; label: string; options: FilterOption[] };

/** Most urgent first: the default order of the table. */
export const STATUS_OPTIONS: Array<{ id: StaffingStatus; label: string }> = [
  { id: 'missing', label: 'Below minimum' },
  { id: 'ready', label: 'Ready for supervisor' },
  { id: 'fulfilled', label: 'Minimum reached' },
  { id: 'excused', label: 'Excused' },
  { id: 'no_minimum', label: 'No minimum' },
];

export const MEMBERSHIP_OPTIONS: FilterOption[] = [
  { id: 'supervisor', label: 'Supervisor' },
  { id: 'trainee', label: 'Trainee' },
];

export const NO_EXTRA_ROLE = '__none__';

const SIGNED_UP_OPTIONS: FilterOption[] = [
  { id: 'yes', label: 'Signed up for an upcoming open day' },
  { id: 'no', label: 'Nothing coming up' },
];

const LAB_RULES_OPTIONS: FilterOption[] = [
  { id: 'confirmed', label: 'Confirmed' },
  { id: 'not_confirmed', label: 'Not confirmed' },
  { id: 'not_required', label: 'Not required' },
];

/** Groups the four Lab Rules states of the API into what a supervisor cares about. */
export function labRulesGroup(row: SupervisorRow): 'confirmed' | 'not_confirmed' | 'not_required' {
  if (row.laborordnungState === 'current') return 'confirmed';
  if (row.laborordnungState === 'outdated') return 'not_confirmed';
  return 'not_required';
}

export function labRulesLabel(row: SupervisorRow): string {
  return LAB_RULES_OPTIONS.find((option) => option.id === labRulesGroup(row))?.label ?? '';
}

export const membershipLabel = (membership: string) =>
  MEMBERSHIP_OPTIONS.find((option) => option.id === membership)?.label ?? membership;

export const statusLabel = (status: StaffingStatus) =>
  STATUS_OPTIONS.find((option) => option.id === status)?.label ?? status;

/** The filter definitions for the loaded rows; the extra-role options are the roles people actually hold. */
export function filterDefs(rows: SupervisorRow[]): FilterDef[] {
  const extraRoles = [...new Set(rows.flatMap((row) => row.extraRoles))].sort((a, b) => a.localeCompare(b));
  return [
    { key: 'membership', label: 'System role', options: MEMBERSHIP_OPTIONS },
    { key: 'status', label: 'Status', options: STATUS_OPTIONS },
    {
      key: 'extra',
      label: 'Extra role',
      options: [
        ...extraRoles.map((role) => ({ id: role, label: role })),
        { id: NO_EXTRA_ROLE, label: 'No extra role' },
      ],
    },
    { key: 'signedUp', label: 'Signed up', options: SIGNED_UP_OPTIONS },
    { key: 'labRules', label: 'Lab rules', options: LAB_RULES_OPTIONS },
  ];
}

export function activeFilterCount(filters: StaffingFilterValues): number {
  return Object.values(filters).reduce((total, values) => total + (values?.length ?? 0), 0);
}

/** The text the search matches: what the table shows for the person. */
export function rowSearchText(row: SupervisorRow): string {
  return [row.name, membershipLabel(row.membership), ...row.extraRoles, statusLabel(row.status), labRulesLabel(row)]
    .join(' ')
    .toLocaleLowerCase();
}

export function filterRows(rows: SupervisorRow[], search: string, filters: StaffingFilterValues): SupervisorRow[] {
  const query = search.trim().toLocaleLowerCase();
  const chosen = (key: FilterKey, test: (value: string) => boolean) => {
    const values = filters[key];
    return !values?.length || values.some(test);
  };
  return rows.filter(
    (row) =>
      (!query || rowSearchText(row).includes(query)) &&
      chosen('membership', (value) => row.membership === value) &&
      chosen('status', (value) => row.status === value) &&
      chosen('extra', (value) =>
        value === NO_EXTRA_ROLE ? row.extraRoles.length === 0 : row.extraRoles.includes(value),
      ) &&
      chosen('signedUp', (value) => (value === 'yes') === (row.nextAssignment !== null)) &&
      chosen('labRules', (value) => labRulesGroup(row) === value),
  );
}

export type SortKey = 'name' | 'membership' | 'progress' | 'status' | 'next' | 'labRules';
export type SortState = { key: SortKey; direction: 'asc' | 'desc' } | null;

const statusRank = (row: SupervisorRow) => STATUS_OPTIONS.findIndex((option) => option.id === row.status);
const nextTime = (row: SupervisorRow) => (row.nextAssignment ? new Date(row.nextAssignment.startsAt).getTime() : null);
const LAB_RULES_RANK = { not_confirmed: 0, not_required: 1, confirmed: 2 } as const;

const compareName = (a: SupervisorRow, b: SupervisorRow) => a.name.localeCompare(b.name);

const COMPARATORS: Record<SortKey, (a: SupervisorRow, b: SupervisorRow) => number> = {
  name: compareName,
  membership: (a, b) => a.membership.localeCompare(b.membership),
  // Distance to the minimum: the furthest behind sort first when ascending.
  progress: (a, b) => a.staffed + a.booked - a.minimum - (b.staffed + b.booked - b.minimum),
  status: (a, b) => statusRank(a) - statusRank(b),
  next: () => 0,
  labRules: (a, b) => LAB_RULES_RANK[labRulesGroup(a)] - LAB_RULES_RANK[labRulesGroup(b)],
};

/** Sorts a copy. Without a chosen column the people who need action come first, then by name. */
export function sortRows(rows: SupervisorRow[], sort: SortState): SupervisorRow[] {
  const copy = [...rows];
  if (!sort) return copy.sort((a, b) => statusRank(a) - statusRank(b) || compareName(a, b));
  const direction = sort.direction === 'asc' ? 1 : -1;
  return copy.sort((a, b) => {
    if (sort.key === 'next') {
      // People with nothing coming up always sort last, whatever the direction.
      const left = nextTime(a);
      const right = nextTime(b);
      if (left === null || right === null)
        return (left === null ? 1 : 0) - (right === null ? 1 : 0) || compareName(a, b);
      return (left - right) * direction || compareName(a, b);
    }
    return COMPARATORS[sort.key](a, b) * direction || compareName(a, b);
  });
}

/** A glance tile is a one-click filter preset. */
export type GlanceTileId = 'below' | 'ready' | 'idle' | 'labRules';

export const GLANCE_PRESETS: Record<GlanceTileId, StaffingFilterValues> = {
  below: { status: ['missing'] },
  ready: { status: ['ready'] },
  idle: { status: ['missing'], signedUp: ['no'] },
  labRules: { labRules: ['not_confirmed'] },
};

export function glanceCount(rows: SupervisorRow[], id: GlanceTileId): number {
  return filterRows(rows, '', GLANCE_PRESETS[id]).length;
}

/** A tile is active when the applied filters are exactly its preset. */
export function isPresetActive(filters: StaffingFilterValues, id: GlanceTileId): boolean {
  const preset = GLANCE_PRESETS[id];
  const keys = (Object.keys(filters) as FilterKey[]).filter((key) => filters[key]?.length);
  const presetKeys = Object.keys(preset) as FilterKey[];
  return (
    keys.length === presetKeys.length &&
    presetKeys.every((key) => {
      const applied = filters[key] ?? [];
      const wanted = preset[key] ?? [];
      return applied.length === wanted.length && wanted.every((value) => applied.includes(value));
    })
  );
}

export function nextOpenDayText(row: SupervisorRow): string {
  return row.nextAssignment
    ? `${formatDate(row.nextAssignment.startsAt)} ${formatTime(row.nextAssignment.startsAt)}`
    : '';
}

export function semesterText(row: SupervisorRow): string {
  return `${row.staffed + row.booked} of ${row.minimum}`;
}

/** Where a person's minimum comes from, in words. */
export function minimumSourceText(row: SupervisorRow): string {
  if (row.minimumSource === 'excused') return 'Excused';
  if (row.minimumSource === 'exception') return `Exception for ${row.minimumExceptionRole ?? 'an extra role'}`;
  return `${membershipLabel(row.membership)} minimum`;
}

const CSV_COLUMNS: Array<{ header: string; value: (row: SupervisorRow) => string }> = [
  { header: 'Name', value: (row) => row.name },
  { header: 'System role', value: (row) => membershipLabel(row.membership) },
  { header: 'Extra roles', value: (row) => row.extraRoles.join('; ') },
  { header: 'This semester', value: semesterText },
  { header: 'Status', value: (row) => statusLabel(row.status) },
  { header: 'Next open day', value: nextOpenDayText },
  { header: 'Lab rules', value: labRulesLabel },
];

/** Spreadsheet programs run cells that start with these characters as formulas. */
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** The rows as CSV with exactly the columns the table shows; a byte order mark keeps umlauts intact in Excel. */
export function staffingCsv(rows: SupervisorRow[]): string {
  const lines = [CSV_COLUMNS.map((column) => csvCell(column.header)).join(',')];
  for (const row of rows) lines.push(CSV_COLUMNS.map((column) => csvCell(column.value(row))).join(','));
  return `${'\uFEFF'}${lines.join('\r\n')}\r\n`;
}
