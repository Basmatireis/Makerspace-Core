import { CheckmarkFilled, InformationFilled, Misuse, UserAvatarFilledAlt, WarningFilled } from '@carbon/icons-react';
import type { CalendarEntry, OpenDay } from '../../api/generated/models';
import { timeRange, isFullyStaffed } from './format';
import { dateInTimeZone } from './dateTime';
import { hasOpenSupervisorPosition } from './openDayFilters';
import { CalendarEvent } from './CalendarEvent';
import { CalendarLegend } from './CalendarLegend';
import { CalendarDayCell, SemesterCalendarGrid } from './SemesterCalendarGrid';

type Props = {
  startsOn: string;
  endsOn: string;
  days: OpenDay[];
  entries?: CalendarEntry[];
  timeZone: string;
  onOpenDay: (day: OpenDay) => void;
};

export function SemesterCalendar({ startsOn, endsOn, days, entries = [], timeZone, onOpenDay }: Props) {
  const byDate = new Map<string, OpenDay[]>();
  for (const item of days) {
    const key = dateInTimeZone(item.startsAt, timeZone);
    byDate.set(key, [...(byDate.get(key) ?? []), item]);
  }

  return (
    <>
      <CalendarLegend />
      <SemesterCalendarGrid startsOn={startsOn} endsOn={endsOn} entries={entries} renderDay={(day) => (
        <CalendarDayCell day={day} key={day.date}>
          {(byDate.get(day.date) ?? []).map((slot) => <CalendarSlot day={slot} timeZone={timeZone} onOpenDay={onOpenDay} key={slot.id} />)}
        </CalendarDayCell>
      )} />
    </>
  );
}

function CalendarSlot({ day, timeZone, onOpenDay }: { day: OpenDay; timeZone: string; onOpenDay: (day: OpenDay) => void }) {
  const presentation = slotPresentation(day);
  const Icon = presentation.Icon;
  return <CalendarEvent kind={presentation.kind} timeLabel={timeRange(day, timeZone)} statusLabel={presentation.label} statusIcon={Icon} assignmentLabel={day.myAssignment ? 'Your assignment' : undefined} assignmentIcon={UserAvatarFilledAlt} onActivate={() => onOpenDay(day)} />;
}

function slotPresentation(day: OpenDay) {
  if (day.status === 'cancelled') return { kind: 'cancelled' as const, label: 'Cancelled', Icon: Misuse };
  if (hasOpenSupervisorPosition(day)) return { kind: 'needs-supervisor' as const, label: 'Supervisor position open', Icon: WarningFilled };
  if (isFullyStaffed(day)) return { kind: 'staffed' as const, label: 'Fully staffed', Icon: CheckmarkFilled };
  return { kind: 'needs-trainee' as const, label: 'Trainee position open', Icon: InformationFilled };
}
