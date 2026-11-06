import type {
  OpenDay,
  OpenDaySeries,
  OpenDayTimeslotInput,
  SaveOpenDayScheduleRequest,
  ScheduleSeriesCreate,
} from '../../../api/generated/models';
import { zonedDateTimeToISO } from '../../../app/dateTime';
import { valuesOfDay, scheduleChanged, type DayValues, type Edits, type SeriesValues } from './workingCopy';

export function timeslotInputs(values: DayValues): OpenDayTimeslotInput[] {
  return [...values.slots]
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((slot) => ({
      ...(slot.id ? { id: slot.id } : {}),
      startsAt: zonedDateTimeToISO(values.date, slot.start),
      endsAt: zonedDateTimeToISO(values.date, slot.end),
      requirements: [
        { kind: 'supervisor', requiredCount: values.supervisorPlaces, eligibleRoleIds: values.supervisorRoleIds },
        { kind: 'trainee', requiredCount: values.traineePlaces, eligibleRoleIds: values.traineeRoleIds },
      ],
    }));
}

function seriesBody(values: SeriesValues): ScheduleSeriesCreate {
  return {
    weekday: values.weekday,
    fromDate: values.fromDate,
    untilDate: values.untilDate,
    timeslots: values.slots.map((slot) => ({ startTime: slot.start, endTime: slot.end })),
    supervisorPlaces: values.supervisorPlaces,
    traineePlaces: values.traineePlaces,
    supervisorRoleIds: values.supervisorRoleIds,
    traineeRoleIds: values.traineeRoleIds,
    forcedDates: values.forcedDates,
  };
}

/**
 * The one atomic delta the schedule endpoint takes. Days a series change already covers are not sent on their own:
 * the server applies the series template to them.
 * @throws Error with a readable message when a local time does not exist (daylight saving) or is ambiguous.
 */
export function buildDelta(input: {
  days: OpenDay[];
  series: OpenDaySeries[];
  edits: Edits;
  periodVersion: number;
}): SaveOpenDayScheduleRequest {
  const { edits } = input;
  const dayById = new Map(input.days.map((day) => [day.id, day]));
  const seriesById = new Map(input.series.map((item) => [item.id, item]));
  const removed = new Set(edits.removed);

  const updates = Object.entries(edits.dayEdits).flatMap(([id, values]) => {
    const day = dayById.get(id);
    if (!day || removed.has(id)) return [];
    const before = valuesOfDay(day);
    const detached = scheduleChanged(before, values);
    if (!detached && day.seriesId && edits.seriesEdits[day.seriesId]) return [];
    if (!detached && before.note === values.note) return [];
    return [
      {
        id,
        internalNote: values.note || null,
        timeslots: timeslotInputs(values),
        expectedVersion: day.version,
      },
    ];
  });

  return {
    expectedPeriodVersion: input.periodVersion,
    creates: edits.creates.map(({ values }) => ({
      internalNote: values.note || null,
      timeslots: timeslotInputs(values),
    })),
    updates,
    removals: edits.removed.flatMap((id) => {
      const day = dayById.get(id);
      return day ? [{ id, expectedVersion: day.version }] : [];
    }),
    seriesCreates: edits.seriesCreates.map(({ values }) => seriesBody(values)),
    seriesUpdates: Object.entries(edits.seriesEdits).flatMap(([id, values]) => {
      const saved = seriesById.get(id);
      if (!saved) return [];
      // An update keeps the series' weekday and start, so the contract has no fields for them.
      const template = seriesBody(values);
      return [
        {
          id,
          expectedVersion: saved.version,
          applyFrom: values.applyFrom,
          untilDate: template.untilDate,
          timeslots: template.timeslots,
          supervisorPlaces: template.supervisorPlaces,
          traineePlaces: template.traineePlaces,
          supervisorRoleIds: template.supervisorRoleIds,
          traineeRoleIds: template.traineeRoleIds,
          forcedDates: template.forcedDates,
        },
      ];
    }),
    seriesRejoins: edits.rejoins.flatMap((id) => {
      const day = dayById.get(id);
      return day && !removed.has(id) ? [{ openDayId: id, expectedVersion: day.version }] : [];
    }),
  };
}
