import type {
  CalendarEntry,
  OpenDay,
  OpenDaySeries,
  OpenDayStaffRequirement,
  OpenDayTimeslot,
} from '../../../api/generated/models';
import { zonedDateTimeToISO } from '../../../app/dateTime';
import { clockOf, dateOf } from './dates';
import { planSeries, type OccupiedRanges } from './seriesPlan';
import { overallRange, type SlotValue } from './timeslots';
import {
  scheduleChanged,
  valuesOfDay,
  valuesOfSeries,
  type DayValues,
  type Edits,
  type SeriesValues,
} from './workingCopy';

/** How a displayed day differs from the saved schedule. */
export type ChangeKind = 'new' | 'edited' | 'series' | 'cancelled';

export type SeriesView = Omit<SeriesValues, 'applyFrom'> & {
  /** A saved series id, or the key of a series that exists only in the working copy. */
  id: string;
  pending: boolean;
  dayCount: number;
  version: number | null;
  changed: boolean;
};

export type DerivedSchedule = {
  days: OpenDay[];
  /** By displayed day id. */
  changes: Map<string, ChangeKind>;
  series: SeriesView[];
};

export type DeriveInput = {
  days: OpenDay[];
  series: OpenDaySeries[];
  edits: Edits;
  entries: CalendarEntry[];
  periodId: string;
  /** Removing an open day in a draft period deletes it; later periods cancel it. */
  draft: boolean;
  now: Date;
};

/** An unambiguous instant for a local date and clock time; an impossible local time falls back to UTC for display. */
export function instantOf(date: string, time: string): string {
  try {
    return zonedDateTimeToISO(date, time);
  } catch {
    return `${date}T${time}:00.000Z`;
  }
}

function buildTimeslots(base: OpenDay | undefined, id: string, values: DayValues): OpenDayTimeslot[] {
  return [...values.slots]
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((slot, position) => {
      const existing = slot.id ? base?.timeslots.find((item) => item.id === slot.id) : undefined;
      const slotId = existing?.id ?? `${id}-s${position}`;
      const requirement = (
        kind: 'supervisor' | 'trainee',
        places: number,
        roles: string[],
      ): OpenDayStaffRequirement => {
        const before = existing?.requirements.find((item) => item.kind === kind);
        return {
          id: before?.id ?? `${slotId}-${kind}`,
          timeslotId: slotId,
          kind,
          requiredCount: places,
          assignedCount: before?.assignedCount ?? 0,
          eligible: before?.eligible ?? false,
          canJoin: before?.canJoin ?? false,
          eligibleRoleIds: roles,
          ...(before?.assignments ? { assignments: before.assignments } : {}),
        };
      };
      return {
        id: slotId,
        position,
        startsAt: instantOf(values.date, slot.start),
        endsAt: instantOf(values.date, slot.end),
        requirements: [
          requirement('supervisor', values.supervisorPlaces, values.supervisorRoleIds),
          requirement('trainee', values.traineePlaces, values.traineeRoleIds),
        ],
        myAssignment: existing?.myAssignment ?? null,
      };
    });
}

function displayDay(
  base: OpenDay | undefined,
  id: string,
  values: DayValues,
  periodId: string,
  links: { seriesId: string | null; detachedFromSeriesId: string | null },
): OpenDay {
  const timeslots = buildTimeslots(base, id, values);
  const startsAt = timeslots[0]?.startsAt ?? instantOf(values.date, '00:00');
  return {
    id,
    periodId,
    competencies: base?.competencies ?? [],
    startsAt,
    endsAt: timeslots[timeslots.length - 1]?.endsAt ?? startsAt,
    internalNote: values.note || null,
    status: base?.status ?? 'scheduled',
    timeslots,
    ...links,
    version: base?.version ?? 0,
    createdAt: base?.createdAt ?? startsAt,
    updatedAt: base?.updatedAt ?? startsAt,
  };
}

function templateValues(series: SeriesValues, date: string, base?: OpenDay): DayValues {
  const slots: SlotValue[] = series.slots.map((slot, index) => ({
    id: base?.timeslots[index]?.id,
    start: slot.start,
    end: slot.end,
  }));
  return {
    date,
    slots,
    supervisorPlaces: series.supervisorPlaces,
    traineePlaces: series.traineePlaces,
    supervisorRoleIds: series.supervisorRoleIds,
    traineeRoleIds: series.traineeRoleIds,
    note: base?.internalNote ?? '',
  };
}

/** Overlay the working copy's edits on the saved schedule, as the schedule would look after saving. */
export function deriveSchedule(input: DeriveInput): DerivedSchedule {
  const { edits, entries, now, periodId } = input;
  const days: OpenDay[] = [];
  const changes = new Map<string, ChangeKind>();
  const savedSeries = new Map(input.series.map((item) => [item.id, item]));
  const removed = new Set(edits.removed);
  const rejoins = new Set(edits.rejoins);
  const seriesValues = (id: string): SeriesValues | undefined => {
    const saved = savedSeries.get(id);
    return edits.seriesEdits[id] ?? (saved ? valuesOfSeries(saved, '') : undefined);
  };
  const cancel = (day: OpenDay) => {
    if (input.draft) return;
    days.push({ ...day, status: 'cancelled' });
    changes.set(day.id, 'cancelled');
  };

  for (const day of input.days) {
    if (removed.has(day.id)) {
      cancel(day);
      continue;
    }
    const date = dateOf(day.startsAt);
    const own = edits.dayEdits[day.id];
    const detached = Boolean(own && scheduleChanged(valuesOfDay(day), own));
    const series = !detached && day.seriesId ? edits.seriesEdits[day.seriesId] : undefined;
    if (series && day.status === 'scheduled' && new Date(day.startsAt) > now && date >= series.applyFrom) {
      if (date > series.untilDate) {
        cancel(day);
        continue;
      }
      days.push(
        displayDay(day, day.id, templateValues(series, date, day), periodId, {
          seriesId: day.seriesId,
          detachedFromSeriesId: day.detachedFromSeriesId,
        }),
      );
      changes.set(day.id, 'series');
      continue;
    }
    const rejoinTemplate =
      rejoins.has(day.id) && day.detachedFromSeriesId ? seriesValues(day.detachedFromSeriesId) : null;
    if (rejoinTemplate && day.detachedFromSeriesId) {
      days.push(
        displayDay(day, day.id, templateValues(rejoinTemplate, date, day), periodId, {
          seriesId: day.detachedFromSeriesId,
          detachedFromSeriesId: null,
        }),
      );
      changes.set(day.id, 'series');
      continue;
    }
    if (own) {
      days.push(
        displayDay(day, day.id, own, periodId, {
          seriesId: detached ? null : day.seriesId,
          detachedFromSeriesId: detached ? (day.seriesId ?? day.detachedFromSeriesId) : day.detachedFromSeriesId,
        }),
      );
      changes.set(day.id, 'edited');
      continue;
    }
    days.push(day);
  }

  const taken = new Map<string, [number, number][]>();
  const occupy = (day: OpenDay) => {
    if (day.status === 'cancelled') return;
    const date = dateOf(day.startsAt);
    const range = overallRange([{ start: clockOf(day.startsAt), end: clockOf(day.endsAt) }]);
    taken.set(date, [...(taken.get(date) ?? []), range]);
  };
  days.forEach(occupy);
  const occupied: OccupiedRanges = (date) => taken.get(date) ?? [];
  const generate = (seriesId: string, values: SeriesValues, plan: { make: string[] }) => {
    for (const date of plan.make) {
      const day = displayDay(undefined, `gen-${seriesId}-${date}`, templateValues(values, date), periodId, {
        seriesId,
        detachedFromSeriesId: null,
      });
      days.push(day);
      changes.set(day.id, 'new');
      occupy(day);
    }
  };

  for (const [id, values] of Object.entries(edits.seriesEdits)) {
    const saved = savedSeries.get(id);
    if (!saved) continue;
    const plan = planSeries({
      weekday: saved.weekday,
      from: saved.fromDate,
      until: values.untilDate,
      slots: values.slots,
      forced: values.forcedDates,
      entries,
      occupied,
      only: (date) =>
        date > saved.untilDate || (values.forcedDates.includes(date) && !saved.forcedDates.includes(date)),
    });
    generate(id, values, plan);
  }
  for (const created of edits.seriesCreates) {
    const plan = planSeries({
      weekday: created.values.weekday,
      from: created.values.fromDate,
      until: created.values.untilDate,
      slots: created.values.slots,
      forced: created.values.forcedDates,
      entries,
      occupied,
    });
    generate(created.key, created.values, plan);
  }
  for (const created of edits.creates) {
    const day = displayDay(undefined, created.key, created.values, periodId, {
      seriesId: null,
      detachedFromSeriesId: null,
    });
    days.push(day);
    changes.set(day.id, 'new');
  }
  days.sort((a, b) => a.startsAt.localeCompare(b.startsAt));

  const countFor = (id: string) => days.filter((day) => day.seriesId === id && day.status === 'scheduled').length;
  const series: SeriesView[] = [
    ...input.series.map((item): SeriesView => {
      const { applyFrom, ...values } = edits.seriesEdits[item.id] ?? valuesOfSeries(item, '');
      void applyFrom;
      return {
        ...values,
        id: item.id,
        pending: false,
        dayCount: countFor(item.id),
        version: item.version,
        changed: item.id in edits.seriesEdits,
      };
    }),
    ...edits.seriesCreates.map(({ key, values }): SeriesView => {
      const { applyFrom, ...rest } = values;
      void applyFrom;
      return { ...rest, id: key, pending: true, dayCount: countFor(key), version: null, changed: true };
    }),
  ];
  return { days, changes, series };
}
