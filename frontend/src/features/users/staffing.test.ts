import { describe, expect, it } from 'vitest';
import type { SupervisorRow } from '../../api/generated/models';
import {
  activeFilterCount,
  filterDefs,
  filterRows,
  glanceCount,
  isPresetActive,
  GLANCE_PRESETS,
  sortRows,
  staffingCsv,
} from './staffing';

const row = (overrides: Partial<SupervisorRow>): SupervisorRow => ({
  personId: 'p1',
  personVersion: 1,
  name: 'Ada Lovelace',
  membership: 'supervisor',
  extraRoles: [],
  competencies: [],
  hasProfileImage: true,
  laborordnungState: 'current',
  staffed: 1,
  booked: 0,
  staffedAsTrainee: 0,
  minimum: 2,
  minimumSource: 'membership',
  minimumExceptionRole: null,
  excused: false,
  excusalReason: null,
  status: 'missing',
  missing: 1,
  lastOpenDayAt: null,
  nextAssignment: null,
  memberSince: '2026-01-01',
  ...overrides,
});

const ada = row({});
const grace = row({
  personId: 'p2',
  name: 'Grace Hopper',
  membership: 'trainee',
  extraRoles: ['Laser'],
  competencies: [{ id: 'c-laser', label: 'Laser cutting' }],
  laborordnungState: 'outdated',
  status: 'ready',
  nextAssignment: { openDayId: 'd1', startsAt: '2026-11-10T09:00:00Z', endsAt: '2026-11-10T13:00:00Z' },
});
const alan = row({
  personId: 'p3',
  name: 'Alan Turing',
  status: 'fulfilled',
  booked: 1,
  laborordnungState: 'not_required',
});
const rows = [ada, grace, alan];
const names = (list: SupervisorRow[]) => list.map((item) => item.name);

describe('filterRows', () => {
  it('searches name, role, extra role, status and lab rules label', () => {
    expect(names(filterRows(rows, 'lovelace', {}))).toEqual(['Ada Lovelace']);
    expect(names(filterRows(rows, 'laser', {}))).toEqual(['Grace Hopper']);
    expect(names(filterRows(rows, 'below minimum', {}))).toEqual(['Ada Lovelace']);
    expect(names(filterRows(rows, 'not confirmed', {}))).toEqual(['Grace Hopper']);
  });

  it('combines categories and ORs the options of one category', () => {
    expect(names(filterRows(rows, '', { membership: ['trainee'] }))).toEqual(['Grace Hopper']);
    expect(names(filterRows(rows, '', { status: ['missing', 'fulfilled'] }))).toEqual(['Ada Lovelace', 'Alan Turing']);
    expect(names(filterRows(rows, '', { extra: ['__none__'] }))).toEqual(['Ada Lovelace', 'Alan Turing']);
    expect(names(filterRows(rows, '', { signedUp: ['yes'] }))).toEqual(['Grace Hopper']);
    expect(names(filterRows(rows, '', { labRules: ['confirmed'], signedUp: ['no'] }))).toEqual(['Ada Lovelace']);
  });

  it('filters by training category and offers the categories people hold', () => {
    const training = filterDefs(rows).find((def) => def.key === 'training');
    expect(training?.options.map((option) => option.label)).toEqual(['Laser cutting', 'No training']);
    expect(names(filterRows(rows, '', { training: ['c-laser'] }))).toEqual(['Grace Hopper']);
    expect(names(filterRows(rows, '', { training: ['__none__'] }))).toEqual(['Ada Lovelace', 'Alan Turing']);
    expect(names(filterRows(rows, 'laser cutting', {}))).toEqual(['Grace Hopper']);
  });

  it('offers the extra roles people hold as filter options', () => {
    const extra = filterDefs(rows).find((def) => def.key === 'extra');
    expect(extra?.options.map((option) => option.label)).toEqual(['Laser', 'No extra role']);
    expect(activeFilterCount({ status: ['missing'], extra: ['Laser', '__none__'] })).toBe(3);
  });
});

describe('glance tiles', () => {
  it('count rows through their filter preset and are active only for exactly that preset', () => {
    expect(glanceCount(rows, 'below')).toBe(1);
    expect(glanceCount(rows, 'ready')).toBe(1);
    expect(glanceCount(rows, 'idle')).toBe(1);
    expect(glanceCount(rows, 'labRules')).toBe(1);
    expect(isPresetActive(GLANCE_PRESETS.idle, 'idle')).toBe(true);
    expect(isPresetActive({ status: ['missing'] }, 'idle')).toBe(false);
    expect(isPresetActive({ status: ['missing'] }, 'below')).toBe(true);
  });
});

describe('sortRows', () => {
  it('puts people who need action first by default', () => {
    expect(names(sortRows(rows, null))).toEqual(['Ada Lovelace', 'Grace Hopper', 'Alan Turing']);
  });

  it('sorts by name in both directions', () => {
    expect(names(sortRows(rows, { key: 'name', direction: 'asc' }))).toEqual([
      'Ada Lovelace',
      'Alan Turing',
      'Grace Hopper',
    ]);
    expect(names(sortRows(rows, { key: 'name', direction: 'desc' }))).toEqual([
      'Grace Hopper',
      'Alan Turing',
      'Ada Lovelace',
    ]);
  });

  it('keeps people with nothing coming up last whichever way the next open day sorts', () => {
    expect(sortRows(rows, { key: 'next', direction: 'asc' })[0].name).toBe('Grace Hopper');
    expect(sortRows(rows, { key: 'next', direction: 'desc' })[0].name).toBe('Grace Hopper');
  });

  it('sorts by distance to the minimum, furthest behind first', () => {
    expect(sortRows(rows, { key: 'progress', direction: 'asc' })[0].name).toBe('Ada Lovelace');
  });
});

describe('staffingCsv', () => {
  it('exports exactly the table columns of the given rows', () => {
    const lines = staffingCsv([grace]).replace('\uFEFF', '').trim().split('\r\n');
    expect(lines[0]).toBe('Name,System role,Extra roles,This semester,Status,Next open day,Lab rules');
    expect(lines[1]).toMatch(
      /^Grace Hopper,Trainee,Laser,1 of 2,Ready for supervisor,10\.11\.2026 \d\d:\d\d,Not confirmed$/,
    );
    expect(lines).toHaveLength(2);
  });

  it('quotes cells and defuses spreadsheet formulas', () => {
    const csv = staffingCsv([row({ name: '=HYPERLINK("x"), Eve' })]);
    expect(csv).toContain(`"'=HYPERLINK(""x""), Eve"`);
  });
});
