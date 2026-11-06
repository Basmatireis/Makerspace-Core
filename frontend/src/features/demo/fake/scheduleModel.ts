import type {
  OpenDay,
  OpenDaySeries,
  OpenDayStaffRequirement,
  OpenDayTimeslot,
  OpenDayTimeslotInput,
  SaveOpenDayScheduleRequest,
  ScheduleSeriesCreate,
  ScheduleSeriesUpdate,
} from '../../../api/generated/models';
import { zonedDateTimeToISO } from '../../../app/dateTime';
import { dateOf, datesOnWeekday } from '../../opendays/model/dates';
import { refreshPeriod } from './openDayModel';
import { fail, type DemoReply } from './router';
import { nextId, type DemoStore } from './store';

/**
 * The schedule save of the demo: the same atomic delta as the real endpoint (days, series and rejoins), applied to the
 * in-memory store. It checks versions and applies the series template like the server does, but not every validation
 * (overlaps and holidays are left to the page, which checks them before saving).
 */

type Template = Pick<
  OpenDaySeries,
  'timeslots' | 'supervisorPlaces' | 'traineePlaces' | 'supervisorRoleIds' | 'traineeRoleIds'
>;

const requirementOf = (
  store: DemoStore,
  timeslotId: string,
  kind: 'supervisor' | 'trainee',
  requiredCount: number,
  eligibleRoleIds: string[],
  previous?: OpenDayStaffRequirement,
): OpenDayStaffRequirement => ({
  id: previous?.id ?? nextId(store),
  timeslotId,
  kind,
  requiredCount,
  assignedCount: previous?.assignedCount ?? 0,
  eligible: false,
  canJoin: false,
  eligibleRoleIds,
  assignments: previous?.assignments ?? [],
});

function timeslotsOf(store: DemoStore, day: OpenDay | null, inputs: OpenDayTimeslotInput[]): OpenDayTimeslot[] {
  return [...inputs]
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
    .map((input, position) => {
      const previous = day?.timeslots.find((slot) => slot.id === input.id);
      const id = previous?.id ?? nextId(store);
      return {
        id,
        position,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        requirements: input.requirements.map((item) =>
          requirementOf(
            store,
            id,
            item.kind,
            item.requiredCount,
            item.eligibleRoleIds,
            previous?.requirements.find((existing) => existing.kind === item.kind),
          ),
        ),
        myAssignment: null,
      };
    });
}

function setTimeslots(day: OpenDay, timeslots: OpenDayTimeslot[]) {
  day.timeslots = timeslots;
  day.startsAt = timeslots[0].startsAt;
  day.endsAt = timeslots[timeslots.length - 1].endsAt;
  // Assignments carry the open day and timeslot they belong to.
  for (const slot of timeslots)
    for (const requirement of slot.requirements)
      requirement.assignments = (requirement.assignments ?? []).map((a) => ({
        ...a,
        openDayId: day.id,
        timeslotId: slot.id,
      }));
}

function newDay(store: DemoStore, periodId: string, inputs: OpenDayTimeslotInput[], note?: string | null): OpenDay {
  const day: OpenDay = {
    id: nextId(store),
    periodId,
    competencies: [],
    startsAt: '',
    endsAt: '',
    internalNote: note ?? null,
    status: 'scheduled',
    timeslots: [],
    seriesId: null,
    detachedFromSeriesId: null,
    version: 1,
    createdAt: store.now.toISOString(),
    updatedAt: store.now.toISOString(),
  };
  setTimeslots(day, timeslotsOf(store, day, inputs));
  return day;
}

/** The timeslot inputs a series template gives a date. */
function templateInputs(template: Template, date: string, previous?: OpenDay): OpenDayTimeslotInput[] {
  return template.timeslots.map((slot, index) => ({
    id: previous?.timeslots[index]?.id,
    startsAt: zonedDateTimeToISO(date, slot.startTime),
    endsAt: zonedDateTimeToISO(date, slot.endTime),
    requirements: [
      { kind: 'supervisor', requiredCount: template.supervisorPlaces, eligibleRoleIds: template.supervisorRoleIds },
      { kind: 'trainee', requiredCount: template.traineePlaces, eligibleRoleIds: template.traineeRoleIds },
    ],
  }));
}

const hasAssignments = (day: OpenDay) =>
  day.timeslots.some((slot) => slot.requirements.some((item) => item.assignedCount > 0));

function removeDay(store: DemoStore, day: OpenDay, draft: boolean) {
  if (draft) store.openDays = store.openDays.filter((item) => item.id !== day.id);
  else {
    day.status = 'cancelled';
    day.version += 1;
  }
}

function generate(store: DemoStore, series: OpenDaySeries, from: string, until: string) {
  for (const date of datesOnWeekday(series.weekday, from, until)) {
    const taken = store.openDays.some(
      (day) => day.seriesId === series.id && dateOf(day.startsAt) === date && day.status === 'scheduled',
    );
    if (taken) continue;
    const day = newDay(store, series.periodId, templateInputs(series, date));
    day.seriesId = series.id;
    store.openDays.push(day);
  }
}

function createSeries(store: DemoStore, periodId: string, body: ScheduleSeriesCreate) {
  const series: OpenDaySeries = {
    id: nextId(store),
    periodId,
    weekday: body.weekday,
    fromDate: body.fromDate,
    untilDate: body.untilDate,
    timeslots: body.timeslots,
    supervisorPlaces: body.supervisorPlaces,
    traineePlaces: body.traineePlaces,
    supervisorRoleIds: body.supervisorRoleIds,
    traineeRoleIds: body.traineeRoleIds,
    forcedDates: body.forcedDates,
    dayCount: 0,
    version: 1,
    createdAt: store.now.toISOString(),
    updatedAt: store.now.toISOString(),
  };
  store.series.push(series);
  generate(store, series, series.fromDate, series.untilDate);
}

function updateSeries(store: DemoStore, body: ScheduleSeriesUpdate, draft: boolean): DemoReply | null {
  const series = store.series.find((item) => item.id === body.id);
  if (!series) return fail(404, 'not_found', 'Series not found.');
  if (series.version !== body.expectedVersion) return fail(409, 'stale_write', 'The series changed meanwhile.');
  Object.assign(series, {
    untilDate: body.untilDate,
    timeslots: body.timeslots,
    supervisorPlaces: body.supervisorPlaces,
    traineePlaces: body.traineePlaces,
    supervisorRoleIds: body.supervisorRoleIds,
    traineeRoleIds: body.traineeRoleIds,
    forcedDates: body.forcedDates,
    version: series.version + 1,
  });
  const own = store.openDays.filter((day) => day.seriesId === series.id && day.status === 'scheduled');
  for (const day of own) {
    const date = dateOf(day.startsAt);
    if (date < body.applyFrom) continue;
    if (date > series.untilDate) removeDay(store, day, draft || !hasAssignments(day));
    else {
      setTimeslots(day, timeslotsOf(store, day, templateInputs(series, date, day)));
      day.version += 1;
    }
  }
  generate(store, series, body.applyFrom > series.fromDate ? body.applyFrom : series.fromDate, series.untilDate);
  return null;
}

export const seriesView = (store: DemoStore): OpenDaySeries[] =>
  store.series.map((series) => ({
    ...series,
    dayCount: store.openDays.filter((day) => day.seriesId === series.id && day.status === 'scheduled').length,
  }));

/** Applies the delta; answers with the failure, or null when it was saved. */
export function saveSchedule(store: DemoStore, periodId: string, body: SaveOpenDayScheduleRequest): DemoReply | null {
  if (periodId !== store.period.id) return fail(404, 'not_found', 'Period not found.');
  if (body.expectedPeriodVersion !== store.period.version)
    return fail(409, 'stale_write', 'The schedule changed meanwhile.');
  const draft = store.period.status === 'draft';
  const find = (id: string) => store.openDays.find((day) => day.id === id);
  for (const item of [...body.updates, ...body.removals]) {
    const day = find(item.id);
    if (!day) return fail(404, 'not_found', 'Open Day not found.');
    if (day.version !== item.expectedVersion) return fail(409, 'stale_write', 'An open day changed meanwhile.');
  }
  for (const removal of body.removals) {
    const day = find(removal.id);
    if (day) removeDay(store, day, draft);
  }
  for (const update of body.updates) {
    const day = find(update.id);
    if (!day) continue;
    const before = day.timeslots.map((slot) => `${slot.startsAt}${slot.endsAt}`).join();
    setTimeslots(day, timeslotsOf(store, day, update.timeslots));
    // A day edited on its own leaves its series.
    if (day.seriesId && before !== day.timeslots.map((slot) => `${slot.startsAt}${slot.endsAt}`).join()) {
      day.detachedFromSeriesId = day.seriesId;
      day.seriesId = null;
    }
    day.internalNote = update.internalNote ?? null;
    day.version += 1;
  }
  for (const create of body.creates)
    store.openDays.push(newDay(store, periodId, create.timeslots, create.internalNote));
  for (const create of body.seriesCreates ?? []) createSeries(store, periodId, create);
  for (const update of body.seriesUpdates ?? []) {
    const failure = updateSeries(store, update, draft);
    if (failure) return failure;
  }
  for (const rejoin of body.seriesRejoins ?? []) {
    const day = find(rejoin.openDayId);
    const series = store.series.find((item) => item.id === day?.detachedFromSeriesId);
    if (!day || !series) return fail(409, 'open_day_not_detached', 'This open day never left its series.');
    day.seriesId = series.id;
    day.detachedFromSeriesId = null;
    setTimeslots(day, timeslotsOf(store, day, templateInputs(series, dateOf(day.startsAt), day)));
    day.version += 1;
  }
  store.openDays.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  store.period.version += 1;
  refreshPeriod(store);
  return null;
}
