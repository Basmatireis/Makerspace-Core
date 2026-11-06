import type { OpenDay, OpenDayAssignment, OpenDayStaffRequirement, OpenDayTimeslot } from '../../api/generated/models';

// Until the pages show timeslots, they treat an open day as one range: the places of all its timeslots, the caller's
// earliest assignment, and the first timeslot for editing.

export function dayRequirements(day: Pick<OpenDay, 'timeslots'>): OpenDayStaffRequirement[] {
  return day.timeslots.flatMap((slot) => slot.requirements);
}

export function myAssignment(day: Pick<OpenDay, 'timeslots'>): OpenDayAssignment | null {
  return day.timeslots.find((slot) => slot.myAssignment)?.myAssignment ?? null;
}

export function firstTimeslot(day: Pick<OpenDay, 'timeslots'>): OpenDayTimeslot | undefined {
  return day.timeslots[0];
}
