import type { OpenDay } from '../../../api/generated/models';
import { dateOf } from './dates';
import { findOverlap } from './overlap';
import { slotsError } from './timeslots';
import { valuesOfDay, type DayValues } from './workingCopy';

/** Fields left undefined stay as they are on every selected day. */
export type BulkPatch = {
  start?: string;
  end?: string;
  supervisorPlaces?: number;
  traineePlaces?: number;
  supervisorRoleIds?: string[];
  traineeRoleIds?: string[];
};

/**
 * New values for each selected day. A new start or end only applies to days with one timeslot; days whose new times are
 * invalid or overlap another open day are skipped and counted.
 */
export function applyBulk(
  selected: readonly OpenDay[],
  patch: BulkPatch,
  allDays: readonly OpenDay[],
): { changes: Record<string, DayValues>; skipped: number } {
  const changes: Record<string, DayValues> = {};
  let skipped = 0;
  for (const day of selected) {
    const values = valuesOfDay(day);
    const next: DayValues = {
      ...values,
      supervisorPlaces: patch.supervisorPlaces ?? values.supervisorPlaces,
      traineePlaces: patch.traineePlaces ?? values.traineePlaces,
      supervisorRoleIds: patch.supervisorRoleIds ?? values.supervisorRoleIds,
      traineeRoleIds: patch.traineeRoleIds ?? values.traineeRoleIds,
    };
    if ((patch.start || patch.end) && values.slots.length === 1) {
      next.slots = [
        { ...values.slots[0], start: patch.start || values.slots[0].start, end: patch.end || values.slots[0].end },
      ];
      if (slotsError(next.slots) || findOverlap(allDays, dateOf(day.startsAt), next.slots, day.id)) {
        skipped += 1;
        continue;
      }
    }
    changes[day.id] = next;
  }
  return { changes, skipped };
}
