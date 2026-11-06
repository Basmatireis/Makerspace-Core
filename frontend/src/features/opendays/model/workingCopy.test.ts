import { describe, expect, it } from 'vitest';
import type { OpenDaySeries } from '../../../api/generated/models';
import { openDay, requirement, slot } from '../testData';
import { buildDelta } from './delta';
import { deriveSchedule } from './derive';
import {
  editCount,
  editorReducer,
  initialEditorState,
  noEdits,
  valuesOfDay,
  type DayValues,
  type Edits,
} from './workingCopy';

const now = new Date('2026-11-03T08:00:00Z');
const reqs = () => [requirement('sup', 'supervisor', 2, { assignedCount: 1 }), requirement('tr', 'trainee', 1)];
const seriesDay = (id: string, date: string) =>
  openDay(id, [slot(`${id}-s`, date, '17:00', '21:00', reqs())], { seriesId: 'ser1', version: 4 });
const saved: OpenDaySeries = {
  id: 'ser1',
  periodId: 'period-1',
  weekday: 2,
  fromDate: '2026-11-10',
  untilDate: '2026-11-24',
  timeslots: [{ startTime: '17:00', endTime: '21:00' }],
  supervisorPlaces: 2,
  traineePlaces: 1,
  supervisorRoleIds: [],
  traineeRoleIds: [],
  forcedDates: [],
  dayCount: 3,
  version: 7,
  createdAt: '',
  updatedAt: '',
};
const days = [seriesDay('d1', '2026-11-10'), seriesDay('d2', '2026-11-17'), seriesDay('d3', '2026-11-24')];
const input = (edits: Edits) => ({
  days,
  series: [saved],
  edits,
  entries: [],
  periodId: 'period-1',
  draft: false,
  now,
});
const delta = (edits: Edits) => buildDelta({ days, series: [saved], edits, periodVersion: 3 });
const reduce = (...actions: Parameters<typeof editorReducer>[1][]) => actions.reduce(editorReducer, initialEditorState);

describe('working copy', () => {
  it('starts empty and sends an empty delta', () => {
    expect(editCount(noEdits)).toBe(0);
    expect(delta(noEdits)).toMatchObject({
      expectedPeriodVersion: 3,
      creates: [],
      updates: [],
      removals: [],
      seriesCreates: [],
      seriesUpdates: [],
      seriesRejoins: [],
    });
  });

  it('takes a series day out of its series when its times change, and sends one update', () => {
    const values: DayValues = { ...valuesOfDay(days[1]), slots: [{ id: 'd2-s', start: '15:00', end: '19:00' }] };
    const state = reduce({ type: 'editDay', id: 'd2', values });
    const derived = deriveSchedule(input(state.edits));
    const day = derived.days.find((item) => item.id === 'd2');
    expect(day?.seriesId).toBeNull();
    expect(day?.detachedFromSeriesId).toBe('ser1');
    expect(derived.changes.get('d2')).toBe('edited');
    const body = delta(state.edits);
    expect(body.updates).toHaveLength(1);
    expect(body.updates[0]).toMatchObject({ id: 'd2', expectedVersion: 4 });
    expect(body.updates[0].timeslots[0]).toMatchObject({ id: 'd2-s' });
  });

  it('keeps a series day in its series when only the note changes', () => {
    const state = reduce({ type: 'editDay', id: 'd2', values: { ...valuesOfDay(days[1]), note: 'Bring clamps' } });
    expect(deriveSchedule(input(state.edits)).days.find((d) => d.id === 'd2')?.seriesId).toBe('ser1');
  });

  it('creates single days and drops them again without a trace', () => {
    const values: DayValues = {
      date: '2026-12-01',
      slots: [{ start: '12:00', end: '15:00' }],
      supervisorPlaces: 1,
      traineePlaces: 0,
      supervisorRoleIds: [],
      traineeRoleIds: [],
      note: '',
    };
    const added = reduce({ type: 'addDay', key: 'new-1', values });
    expect(delta(added.edits).creates).toHaveLength(1);
    expect(delta(added.edits).creates[0].timeslots[0].requirements[0]).toMatchObject({
      kind: 'supervisor',
      requiredCount: 1,
    });
    const removed = editorReducer(added, { type: 'remove', ids: ['new-1'] });
    expect(editCount(removed.edits)).toBe(0);
  });

  it('cancels saved days in a staffing period and deletes them in a draft', () => {
    const state = reduce({ type: 'remove', ids: ['d1'] });
    expect(delta(state.edits).removals).toEqual([{ id: 'd1', expectedVersion: 4 }]);
    expect(deriveSchedule(input(state.edits)).days.find((d) => d.id === 'd1')?.status).toBe('cancelled');
    expect(deriveSchedule({ ...input(state.edits), draft: true }).days.some((d) => d.id === 'd1')).toBe(false);
  });

  it('sends a series update instead of day updates and shrinks the series', () => {
    const state = reduce({
      type: 'editSeries',
      id: 'ser1',
      values: {
        weekday: 2,
        fromDate: '2026-11-10',
        untilDate: '2026-11-17',
        applyFrom: '2026-11-10',
        slots: [{ start: '16:00', end: '20:00' }],
        supervisorPlaces: 3,
        traineePlaces: 1,
        supervisorRoleIds: [],
        traineeRoleIds: [],
        forcedDates: [],
      },
    });
    const derived = deriveSchedule(input(state.edits));
    expect(derived.days.find((d) => d.id === 'd1')?.timeslots[0].requirements[0].requiredCount).toBe(3);
    expect(derived.days.find((d) => d.id === 'd3')?.status).toBe('cancelled');
    const body = delta(state.edits);
    expect(body.updates).toEqual([]);
    expect(body.seriesUpdates).toHaveLength(1);
    expect(body.seriesUpdates?.[0]).toMatchObject({
      id: 'ser1',
      expectedVersion: 7,
      applyFrom: '2026-11-10',
      untilDate: '2026-11-17',
    });
    // ScheduleSeriesUpdate allows no other fields (additionalProperties: false).
    expect(Object.keys(body.seriesUpdates?.[0] ?? {}).sort()).toEqual([
      'applyFrom',
      'expectedVersion',
      'forcedDates',
      'id',
      'supervisorPlaces',
      'supervisorRoleIds',
      'timeslots',
      'traineePlaces',
      'traineeRoleIds',
      'untilDate',
    ]);
  });

  it('extends a series with new days that skip holidays unless forced', () => {
    const values = {
      weekday: 2,
      fromDate: '2026-11-10',
      untilDate: '2026-12-08',
      applyFrom: '2026-11-10',
      slots: [{ start: '17:00', end: '21:00' }],
      supervisorPlaces: 2,
      traineePlaces: 1,
      supervisorRoleIds: [],
      traineeRoleIds: [],
      forcedDates: [] as string[],
    };
    const entries = [
      {
        name: 'Mariä Empfängnis',
        startsOn: '2026-12-08',
        endsOn: '2026-12-08',
        category: 'publicHoliday' as const,
        source: 'computed' as never,
      },
    ];
    const edits = reduce({ type: 'editSeries', id: 'ser1', values }).edits;
    const dates = (forced: string[]) =>
      deriveSchedule({ ...input({ ...edits, seriesEdits: { ser1: { ...values, forcedDates: forced } } }), entries })
        .days.filter((d) => d.id.startsWith('gen-'))
        .map((d) => d.id.slice(-10));
    expect(dates([])).toEqual(['2026-12-01']);
    expect(dates(['2026-12-08'])).toEqual(['2026-12-01', '2026-12-08']);
  });

  it('creates a series with generated days and sends only the series', () => {
    const values = {
      weekday: 4,
      fromDate: '2026-11-05',
      untilDate: '2026-11-19',
      applyFrom: '2026-11-05',
      slots: [{ start: '16:00', end: '20:00' }],
      supervisorPlaces: 2,
      traineePlaces: 2,
      supervisorRoleIds: ['role1'],
      traineeRoleIds: [],
      forcedDates: [],
    };
    const state = reduce({ type: 'addSeries', key: 'series-1', values });
    expect(deriveSchedule(input(state.edits)).days.filter((d) => d.seriesId === 'series-1')).toHaveLength(3);
    const body = delta(state.edits);
    expect(body.creates).toEqual([]);
    expect(body.seriesCreates?.[0]).toMatchObject({
      weekday: 4,
      supervisorRoleIds: ['role1'],
      timeslots: [{ startTime: '16:00', endTime: '20:00' }],
    });
  });

  it('skips series dates that overlap an existing open day', () => {
    const values = {
      weekday: 2,
      fromDate: '2026-11-10',
      untilDate: '2026-11-10',
      applyFrom: '2026-11-10',
      slots: [{ start: '20:00', end: '22:00' }],
      supervisorPlaces: 1,
      traineePlaces: 0,
      supervisorRoleIds: [],
      traineeRoleIds: [],
      forcedDates: [],
    };
    const state = reduce({ type: 'addSeries', key: 'series-1', values });
    expect(deriveSchedule(input(state.edits)).days.some((d) => d.id.startsWith('gen-'))).toBe(false);
  });

  it('follows the series again with a rejoin', () => {
    const detached = openDay('dx', [slot('dx-s', '2026-11-17', '15:00', '19:00', reqs())], {
      detachedFromSeriesId: 'ser1',
      version: 9,
    });
    const edits = reduce({ type: 'rejoin', id: 'dx' }).edits;
    const derived = deriveSchedule({ ...input(edits), days: [detached] });
    expect(derived.days[0].seriesId).toBe('ser1');
    expect(buildDelta({ days: [detached], series: [saved], edits, periodVersion: 3 }).seriesRejoins).toEqual([
      { openDayId: 'dx', expectedVersion: 9 },
    ]);
  });

  it('undoes the last change', () => {
    const state = reduce({ type: 'remove', ids: ['d1'] }, { type: 'remove', ids: ['d2'] }, { type: 'undo' });
    expect(state.edits.removed).toEqual(['d1']);
  });
});
