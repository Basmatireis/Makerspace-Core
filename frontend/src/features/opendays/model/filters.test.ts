import { describe, expect, it } from 'vitest';
import { openDay, requirement, slot, supervisorViewer } from '../testData';
import { activeFilterCount, dayMatchesSearch, dayPasses, filterDefs } from './filters';
import { inSection, sectionDefs } from './sections';

const now = new Date('2026-11-03T08:00:00Z');
const evening = openDay('evening', [
  slot('a', '2026-11-10', '17:00', '21:00', [requirement('r1', 'supervisor', 2, { assignedCount: 2, eligible: true })]),
]);
const noon = openDay(
  'noon',
  [
    slot('b', '2026-11-12', '12:00', '15:00', [requirement('r2', 'supervisor', 1, { eligible: true, canJoin: true })]),
    slot('c', '2026-11-12', '15:00', '18:00', [requirement('r3', 'supervisor', 1, { eligible: true, canJoin: true })]),
  ],
  { seriesId: 's1' },
);
const past = openDay('past', [slot('d', '2026-10-20', '17:00', '21:00', [requirement('r4', 'supervisor', 1)])]);

describe('filters and sections', () => {
  it('filters by weekday, time of day, staffing, timeslots and series', () => {
    expect(dayPasses(evening, { weekday: ['2'] }, now)).toBe(true);
    expect(dayPasses(evening, { weekday: ['3'] }, now)).toBe(false);
    expect(dayPasses(noon, { time: ['afternoon'] }, now)).toBe(true);
    expect(dayPasses(evening, { time: ['morning'] }, now)).toBe(false);
    expect(dayPasses(noon, { staffing: ['short'] }, now)).toBe(true);
    expect(dayPasses(evening, { staffing: ['short'] }, now)).toBe(false);
    expect(dayPasses(noon, { slots: ['several'] }, now)).toBe(true);
    expect(dayPasses(noon, { series: ['series'] }, now)).toBe(true);
    expect(dayPasses(evening, { series: ['single'] }, now)).toBe(true);
  });

  it('counts chosen options for the red badge', () => {
    expect(activeFilterCount({ weekday: ['1', '2'], time: ['evening'], slots: [] })).toBe(3);
  });

  it('offers the series filter only to the Leitung', () => {
    const keys = (canManage: boolean) =>
      filterDefs([evening], { ...supervisorViewer, canManage }).map((def) => def.key);
    expect(keys(false)).not.toContain('series');
    expect(keys(true)).toContain('series');
  });

  it('searches by date text and time', () => {
    expect(dayMatchesSearch(evening, 'tue 17:00')).toBe(true);
    expect(dayMatchesSearch(evening, 'friday')).toBe(false);
  });

  it('puts days in sections and shows short-staffed only to the Leitung', () => {
    const days = [evening, noon, past];
    expect(inSection(past, 'past', now)).toBe(true);
    expect(inSection(past, 'upcoming', now)).toBe(false);
    expect(inSection(noon, 'short', now)).toBe(true);
    expect(inSection(noon, 'forme', now)).toBe(true);
    expect(sectionDefs(days, supervisorViewer, now).map((s) => s.id)).toEqual(['upcoming', 'forme', 'mine', 'past']);
    expect(sectionDefs(days, { ...supervisorViewer, canManage: true }, now).map((s) => s.id)).toContain('short');
  });
});
