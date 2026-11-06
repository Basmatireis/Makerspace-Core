import { describe, expect, it } from 'vitest';
import { openDay, requirement, slot, supervisorViewer, managerViewer } from '../testData';
import { dayState, missingSupervisors, placesForMe, slotState, stateTag, type StateContext } from './state';

const now = new Date('2026-11-03T08:00:00Z');
const ctx = (viewer = supervisorViewer): StateContext => ({ viewer, now, warningDays: 14 });
const sup = (id: string, required: number, assigned: number, flags = { eligible: true, canJoin: true }) =>
  requirement(id, 'supervisor', required, { assignedCount: assigned, ...flags });
const tr = (id: string, required: number, assigned: number, flags = { eligible: false, canJoin: false }) =>
  requirement(id, 'trainee', required, { assignedCount: assigned, ...flags });

describe('viewer state of an open day', () => {
  it('calls a day urgent when a supervisor place the viewer can take opens within the warning window', () => {
    const day = openDay('d1', [slot('s1', '2026-11-10', '17:00', '21:00', [sup('r1', 2, 1), tr('r2', 1, 0)])]);
    expect(slotState(day, day.timeslots[0], ctx())).toBe('urgent');
    expect(stateTag(day, null, ctx(), true)?.label).toBe('Supervisor needed');
    expect(stateTag(day, null, ctx())?.label).toBe('Supervisor needed · 1 place open');
  });

  it('is open (not urgent) beyond the warning window', () => {
    const day = openDay('d1', [slot('s1', '2026-12-20', '17:00', '21:00', [sup('r1', 2, 1), tr('r2', 1, 0)])]);
    expect(slotState(day, day.timeslots[0], ctx())).toBe('open');
    expect(stateTag(day, null, ctx(), true)?.label).toBe('Place for you');
  });

  it('is full for the viewer when every place they may take is taken, whatever is free for others', () => {
    const day = openDay('d1', [
      slot('s1', '2026-12-20', '17:00', '21:00', [sup('r1', 2, 2, { eligible: true, canJoin: false }), tr('r2', 3, 0)]),
    ]);
    expect(slotState(day, day.timeslots[0], ctx())).toBe('full');
    expect(stateTag(day, null, ctx())?.label).toBe('Full');
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
    expect(stateTag(day, null, ctx())?.label).toBe("You're in · Supervisor");
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
    expect(missingSupervisors({ ...day, status: 'cancelled' }, now)).toBe(0);
  });

  it('does not offer places on past timeslots', () => {
    const day = openDay('d1', [slot('s1', '2026-10-20', '17:00', '21:00', [sup('r1', 2, 1)])]);
    expect(slotState(day, day.timeslots[0], ctx())).toBe('past');
  });
});
