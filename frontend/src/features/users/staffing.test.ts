import { describe, expect, it } from 'vitest';
import type { SupervisorRow } from '../../api/generated/models';
import { filterRows } from './staffing';

const row = (overrides: Partial<SupervisorRow>): SupervisorRow => ({
  personId: 'p1',
  personVersion: 1,
  name: 'Ada Lovelace',
  kind: 'supervisor',
  hasProfileImage: true,
  laborordnungState: 'current',
  staffed: 1,
  booked: 0,
  staffedAsTrainee: 0,
  minimum: 2,
  status: 'missing',
  missing: 1,
  lastOpenDayAt: null,
  memberSince: '2026-01-01',
  ...overrides,
});

const ada = row({});
const grace = row({
  personId: 'p2',
  name: 'Grace Hopper',
  kind: 'trainee',
  laborordnungState: 'outdated',
  status: 'ready',
});
const names = (search: string) => filterRows([ada, grace], search, {}).map((item) => item.name);

describe('filterRows search', () => {
  it('matches the name', () => {
    expect(names('lovelace')).toEqual(['Ada Lovelace']);
  });

  it('matches the role, status and Lab Rules labels the table shows', () => {
    expect(names('trainee')).toEqual(['Grace Hopper']);
    expect(names('below minimum')).toEqual(['Ada Lovelace']);
    expect(names('ready for supervisor')).toEqual(['Grace Hopper']);
    expect(names('outdated')).toEqual(['Grace Hopper']);
  });

  it('finds nothing for an unrelated term', () => {
    expect(names('kiosk')).toEqual([]);
  });
});
