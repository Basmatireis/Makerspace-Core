import { listEventShifts, updateEventShift } from '../../api/generated/events/events';
import type { EventPositionInput, EventRequirement } from '../../api/generated/models';

export const positionInput = (requirement: EventRequirement): EventPositionInput => ({
  id: requirement.id,
  name: requirement.name,
  description: requirement.description ?? null,
  requiredCount: requirement.requiredCount,
  eligibilityMode: requirement.eligibilityMode,
  eligibleRoleIds: requirement.eligibleRoleIds,
});

// Positions are saved together with their shift. The current shift is read first so the complete position list and
// the shift version travel together.
export async function saveShiftPositions(
  eventId: string,
  shiftId: string,
  change: (positions: EventPositionInput[]) => EventPositionInput[],
) {
  const shift = (await listEventShifts(eventId)).items.find((item) => item.id === shiftId);
  if (!shift) throw new Error('The shift no longer exists.');
  return updateEventShift(eventId, shiftId, {
    sessionId: shift.sessionId ?? null,
    name: shift.name,
    description: shift.description ?? null,
    startsAt: shift.startsAt,
    endsAt: shift.endsAt,
    signupOpensAt: shift.signupOpensAt ?? null,
    signupClosesAt: shift.signupClosesAt ?? null,
    isPublic: shift.isPublic,
    status: shift.status,
    requirements: change(shift.requirements.map(positionInput)),
    expectedVersion: shift.version,
  });
}
