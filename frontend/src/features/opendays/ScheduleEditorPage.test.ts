import { describe, expect, it } from 'vitest';
import { scheduleEditorReducer, type EditorState, type WorkingSlot } from './scheduleState';
import { dateInTimeZone, timeInTimeZone, zonedDateTimeToISO } from './dateTime';

const requirements = [
  { kind: 'supervisor' as const, requiredCount: 0, eligibleRoleIds: [] },
  { kind: 'trainee' as const, requiredCount: 0, eligibleRoleIds: [] },
];

function slot(id: string, date = '2026-10-07'): WorkingSlot {
  return {
    id,
    startsAt: new Date(`${date}T16:00:00Z`).toISOString(),
    endsAt: new Date(`${date}T19:00:00Z`).toISOString(),
    requirements,
  };
}

describe('schedule editor working copy', () => {
  it('supports one-step undo after add, move, and remove changes', () => {
    const initial: EditorState = { slots: [slot('one')], previous: null, dirty: false };
    const added = scheduleEditorReducer(initial, { type: 'add', slot: slot('two') });
    expect(added.slots).toHaveLength(2);
    expect(scheduleEditorReducer(added, { type: 'undo' })).toMatchObject({ slots: initial.slots, dirty: false });

    const moved = scheduleEditorReducer(initial, { type: 'move', id: 'one', date: '2026-10-14', timeZone: 'Europe/Vienna' });
    expect(moved.slots[0].startsAt.startsWith('2026-10-14')).toBe(true);
    expect(scheduleEditorReducer(moved, { type: 'undo' }).slots).toEqual(initial.slots);

    const removed = scheduleEditorReducer(initial, { type: 'remove', id: 'one' });
    expect(removed.slots).toHaveLength(0);
    expect(scheduleEditorReducer(removed, { type: 'undo' }).slots).toEqual(initial.slots);
  });

  it('interprets schedule wall times in the makerspace timezone', () => {
    const instant = zonedDateTimeToISO('2026-10-07', '16:00', 'Europe/Vienna');
    expect(instant).toBe('2026-10-07T14:00:00.000Z');
    expect(dateInTimeZone(instant, 'Europe/Vienna')).toBe('2026-10-07');
    expect(timeInTimeZone(instant, 'Europe/Vienna')).toBe('16:00');
  });
});
