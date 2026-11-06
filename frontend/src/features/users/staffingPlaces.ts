import type { OpenDay, OpenDaySchedule, OpenDayRequirementKind, SupervisorRow } from '../../api/generated/models';

/** A place of an open-day timeslot that a person may be assigned to. */
export type Place = {
  openDayId: string;
  timeslotId: string;
  requirementId: string;
  startsAt: string;
  endsAt: string;
  kind: OpenDayRequirementKind;
  required: number;
  taken: number;
  /** The place names extra roles; whether the person holds one is checked by the server's eligibility search. */
  restricted: boolean;
};

/** An assignment of the person in a timeslot. */
export type PersonAssignment = {
  assignmentId: string;
  openDayId: string;
  timeslotId: string;
  startsAt: string;
  endsAt: string;
  kind: OpenDayRequirementKind;
};

const isLive = (day: OpenDay) => day.status === 'scheduled';

/** Whether the schedule lists who is assigned; without that permission the places only carry counts. */
export function assignmentsVisible(schedule: OpenDaySchedule): boolean {
  return schedule.items.every((day) =>
    day.timeslots.every((slot) =>
      slot.requirements.every((req) => req.assignedCount === 0 || req.assignments !== undefined),
    ),
  );
}

export function assignmentsOf(schedule: OpenDaySchedule, personId: string): PersonAssignment[] {
  const found: PersonAssignment[] = [];
  for (const day of schedule.items.filter(isLive)) {
    for (const slot of day.timeslots) {
      for (const req of slot.requirements) {
        for (const assignment of req.assignments ?? []) {
          if (assignment.personId !== personId) continue;
          found.push({
            assignmentId: assignment.id,
            openDayId: day.id,
            timeslotId: slot.id,
            startsAt: slot.startsAt,
            endsAt: slot.endsAt,
            kind: req.kind,
          });
        }
      }
    }
  }
  return found.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

/**
 * Free places in upcoming timeslots whose kind matches the person's membership and where they are not yet assigned.
 * Extra-role restrictions are resolved by the caller; the server enforces eligibility again on assignment.
 */
export function candidatePlaces(schedule: OpenDaySchedule, row: SupervisorRow, now: number): Place[] {
  const places: Place[] = [];
  for (const day of schedule.items.filter(isLive)) {
    for (const slot of day.timeslots) {
      if (new Date(slot.endsAt).getTime() <= now) continue;
      const already = slot.requirements.some((req) => req.assignments?.some((a) => a.personId === row.personId));
      if (already) continue;
      for (const req of slot.requirements) {
        if (req.kind !== row.membership || req.assignedCount >= req.requiredCount) continue;
        places.push({
          openDayId: day.id,
          timeslotId: slot.id,
          requirementId: req.id,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          kind: req.kind,
          required: req.requiredCount,
          taken: req.assignedCount,
          restricted: (req.eligibleRoleIds?.length ?? 0) > 0,
        });
      }
    }
  }
  return places.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

/** A period takes assignments while staffing and once published. */
export const periodTakesAssignments = (status: string | undefined) => status === 'staffing' || status === 'published';
