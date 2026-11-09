import { describe, expect, it } from 'vitest';
import { openDay, requirement, slot, supervisorViewer, managerViewer } from '../testData';
import { dayState, missingSupervisors, placesForMe, slotState, stateTag, type StateContext } from './state';

const now = new Date('2026-11-03T08:00:00Z');
const ctx = (viewer = supervisorViewer): StateContext => ({ viewer, now });
const sup = (id: string, required: number, assigned: number, flags = { eligible: true, canJoin: true }) =>
  requirement(id, 'supervisor', required, { assignedCount: assigned, ...flags });
const tr = (id: string, required: number, assigned: number, flags = { eligible: false, canJoin: false }) =>
  requirement(id, 'trainee', required, { assignedCount: assigned, ...flags });

describe('viewer state of an open day', () => {
  it('is open (red) when the viewer can take a place, however soon the day is', () => {
    for (const date of ['2026-11-10', '2026-12-20']) {
      const day = openDay('d1', [slot('s1', date, '17:00', '21:00', [sup('r1', 2, 1), tr('r2', 1, 0)])]);
      expect(slotState(day, day.timeslots[0], ctx())).toBe('open');
      expect(stateTag(day, null, ctx(), true)).toEqual({ label: 'Place for you', color: 'red' });
    }
  });

  it('is full for the viewer when every place they may take is taken, whatever is free for others', () => {
    const day = openDay('d1', [
      slot('s1', '2026-12-20', '17:00', '21:00', [sup('r1', 2, 2, { eligible: true, canJoin: false }), tr('r2', 3, 0)]),
    ]);
    expect(slotState(day, day.timeslots[0], ctx())).toBe('full');
    expect(stateTag(day, null, ctx())).toEqual({ label: 'Full', color: 'green' });
    expect(placesForMe(day)).toBe(0);
  });

  it('shows other roles only when nothing is eligible', () => {
    const day = openDay('d1', [
      slot('s1', '2026-12-20', '17:00', '21:00', [
        sup('r1', 2, 0, { eligible: false, canJoin: false }),
        tr('r2', 1, 0),
      ]),
    ]);
    expect(slotState(day, day.timeslots[0], ctx())).toBe('other');
    expect(stateTag(day, null, ctx())?.label).toBe('Other roles only');
  });

  it('shows the viewer as in, with the kind of place', () => {
    const day = openDay('d1', [slot('s1', '2026-12-20', '17:00', '21:00', [sup('r1', 2, 1), tr('r2', 1, 0)], true)]);
    expect(dayState(day, ctx())).toBe('mine');
    expect(stateTag(day, null, ctx())).toEqual({ label: "You're in · Supervisor", color: 'blue' });
    expect(dayState(day, ctx(managerViewer))).toBe('mine');
  });

  it('lists the timeslots the viewer is in on a multi-timeslot day', () => {
    const day = openDay('d1', [
      slot('s1', '2026-12-20', '09:00', '12:00', [sup('r1', 1, 1)], true),
      slot('s2', '2026-12-20', '12:00', '15:00', [sup('r3', 1, 0)]),
    ]);
    expect(stateTag(day, null, ctx())?.label).toBe("You're in · 09–12");
  });

  it('counts missing supervisors for the Leitung and ignores trainees and cancelled days', () => {
    const day = openDay('d1', [slot('s1', '2026-12-20', '17:00', '21:00', [sup('r1', 3, 1), tr('r2', 2, 0)])]);
    expect(missingSupervisors(day, now)).toBe(2);
    expect(stateTag(day, null, ctx(managerViewer))?.label).toBe('2 supervisors missing');
    expect(stateTag(day, null, ctx(managerViewer))?.color).toBe('red');
    expect(missingSupervisors({ ...day, status: 'cancelled' }, now)).toBe(0);
    expect(stateTag({ ...day, status: 'cancelled' }, null, ctx(managerViewer))?.color).toBe('gray');
  });

  it('shows the Leitung a day as staffed (green) once the supervisor places are full, whatever trainees are missing', () => {
    const day = openDay('d1', [
      slot('s1', '2026-12-20', '17:00', '21:00', [sup('r1', 2, 2, { eligible: true, canJoin: false }), tr('r2', 2, 0)]),
    ]);
    expect(dayState(day, ctx(managerViewer))).toBe('ok');
    expect(stateTag(day, null, ctx(managerViewer))).toEqual({ label: 'Staffed', color: 'green' });
  });

  it('does not offer places on past timeslots', () => {
    const day = openDay('d1', [slot('s1', '2026-10-20', '17:00', '21:00', [sup('r1', 2, 1)])]);
    expect(slotState(day, day.timeslots[0], ctx())).toBe('past');
  });
});
