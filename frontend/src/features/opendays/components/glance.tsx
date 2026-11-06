import type { ReactNode } from 'react';
import type { OpenDay, PersonalDashboardStaffing, SupervisorRow } from '../../../api/generated/models';
import {
  clockOf,
  dateOf,
  dayMonth,
  mondayOf,
  plural,
  relativeDay,
  shortDate,
  timeRange,
  weekdayShort,
} from '../model/dates';
import {
  free,
  isShortStaffed,
  myRequirement,
  placesForMe,
  slotEnded,
  startsSoon,
  supervisorsOf,
  type StateContext,
} from '../model/state';

type Tone = 'good' | 'warn' | 'bad';

export type GlanceTile = {
  id: string;
  label: string;
  value: ReactNode;
  unit?: string;
  helper?: ReactNode;
  tone?: Tone;
  /** Selecting this tile switches to a section tab. */
  section?: string;
};

function meter(value: number, max: number, label: string) {
  return (
    <span className="od-meter" role="img" aria-label={label}>
      {Array.from({ length: Math.max(max, value) }, (_, index) => (
        <i key={index} className={index < value ? 'is-on' : undefined} />
      ))}
    </span>
  );
}

export type GlanceInput = {
  days: OpenDay[];
  ctx: StateContext;
  staffing: PersonalDashboardStaffing | null;
  /** Dashboard rows of the period; only for people who may read the supervisor dashboard. */
  rows: SupervisorRow[] | null;
};

/** The tiles above the schedule, per viewer. Exported for tests. */
export function glanceTiles({ days, ctx, staffing, rows }: GlanceInput): GlanceTile[] {
  const { viewer, now } = ctx;
  const today = dateOf(now);
  const upcoming = days.filter((day) => day.status !== 'cancelled' && new Date(day.endsAt) > now);
  if (!viewer.canSignUp && !viewer.canManage) {
    const next = upcoming[0];
    const week = upcoming.filter((day) => mondayOf(dateOf(day.startsAt)) === mondayOf(today));
    return [
      {
        id: 'next',
        label: 'Next open day',
        value: next ? shortDate(dateOf(next.startsAt)) : '—',
        helper: next ? `${timeRange(next.startsAt, next.endsAt)} · no sign-up needed` : undefined,
      },
      {
        id: 'week',
        label: 'This week',
        value: plural(week.length, 'open day'),
        helper:
          week.map((day) => `${weekdayShort(dateOf(day.startsAt))} ${clockOf(day.startsAt)}`).join(' · ') || 'None',
      },
    ];
  }
  const tiles: GlanceTile[] = [];
  if (staffing) {
    const done = staffing.staffed + staffing.booked;
    const missing = staffing.missing;
    const by = staffing.semester?.signUpBy ? ` by ${dayMonth(staffing.semester.signUpBy)}` : '';
    tiles.push({
      id: 'semester',
      label: 'Your semester',
      value: done,
      unit: `of ${staffing.minimum}`,
      tone: staffing.status === 'missing' ? 'warn' : 'good',
      helper: (
        <>
          {meter(done, staffing.minimum, `${done} of ${staffing.minimum}`)}
          <span>
            {staffing.status === 'excused'
              ? 'Excused this semester'
              : missing
                ? `Sign up for ${missing} more${by}`
                : staffing.minimum
                  ? 'Minimum reached'
                  : 'No minimum'}
          </span>
        </>
      ),
    });
    if (staffing.kind === 'trainee')
      tiles.push({
        id: 'trainee',
        label: 'Trainee progress',
        value: staffing.staffedAsTrainee,
        unit: `of ${staffing.traineeThreshold} staffed`,
        helper: (
          <>
            {meter(
              staffing.staffedAsTrainee,
              staffing.traineeThreshold,
              `${staffing.staffedAsTrainee} of ${staffing.traineeThreshold}`,
            )}
            <span>The Leitung makes you a supervisor afterwards</span>
          </>
        ),
      });
  }
  const mine = upcoming
    .flatMap((day) => day.timeslots.filter((slot) => slot.myAssignment && !slotEnded(slot, now)))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0];
  const kind = mine ? myRequirement(mine)?.kind : undefined;
  tiles.push({
    id: 'next-duty',
    label: 'Your next duty',
    value: mine ? shortDate(dateOf(mine.startsAt)) : 'None planned',
    helper: mine
      ? `${timeRange(mine.startsAt, mine.endsAt)}${kind ? ` as ${kind}` : ''}${relativeDay(dateOf(mine.startsAt), today) ? ` · ${relativeDay(dateOf(mine.startsAt), today)}` : ''}`
      : 'Pick a day with a free place',
    section: mine ? undefined : 'forme',
  });
  if (viewer.canManage) {
    const short = upcoming.filter((day) => isShortStaffed(day, now));
    const urgent = short.filter((day) =>
      day.timeslots.some((slot) => startsSoon(slot, ctx) && free(supervisorsOf(slot)) > 0),
    );
    const slots = upcoming.flatMap((day) => day.timeslots.filter((slot) => !slotEnded(slot, now)));
    const places = slots.reduce((sum, slot) => sum + (supervisorsOf(slot)?.requiredCount ?? 0), 0);
    const filled = slots.reduce(
      (sum, slot) => sum + Math.min(supervisorsOf(slot)?.requiredCount ?? 0, supervisorsOf(slot)?.assignedCount ?? 0),
      0,
    );
    const below = rows?.filter((row) => row.status === 'missing').length;
    tiles.push({
      id: 'short',
      label: 'Short-staffed',
      value: short.length,
      unit: short.length === 1 ? 'open day' : 'open days',
      tone: urgent.length ? 'bad' : undefined,
      helper: `${urgent.length} within ${ctx.warningDays} days · trainee places never count`,
      section: 'short',
    });
    tiles.push({
      id: 'filled',
      label: 'Supervisor places filled',
      value: Math.round((filled / Math.max(1, places)) * 100),
      unit: '%',
      helper: `${filled} of ${places} upcoming${below === undefined ? '' : ` · ${plural(below, 'person', 'people')} below minimum`}`,
    });
  } else {
    const forMe = upcoming.filter((day) => placesForMe(day) > 0);
    const urgent = forMe.filter((day) =>
      day.timeslots.some(
        (slot) => startsSoon(slot, ctx) && slot.requirements.some((item) => item.kind === 'supervisor' && item.canJoin),
      ),
    );
    tiles.push({
      id: 'for-me',
      label: 'Places for you',
      value: forMe.length,
      unit: forMe.length === 1 ? 'open day' : 'open days',
      tone: urgent.length ? 'bad' : undefined,
      helper: urgent.length
        ? `${urgent.length} need a supervisor within ${ctx.warningDays} days`
        : viewer.kind === 'trainee'
          ? 'Trainee places only'
          : 'Nothing urgent',
      section: 'forme',
    });
  }
  return tiles;
}
