import { CheckmarkFilled, InformationFilled, Misuse, UserAvatarFilledAlt, WarningFilled } from '@carbon/icons-react';
import type { CalendarEntry, OpenDay } from '../../api/generated/models';
import { timeRange, isFullyStaffed, registeredPeopleCount } from './format';
import { dateInTimeZone } from './dateTime';
import { hasOpenSupervisorPosition } from './openDayFilters';
import { CalendarEvent } from './CalendarEvent';
import { CalendarLegend } from './CalendarLegend';
import { CalendarDayCell, SemesterCalendarGrid } from './SemesterCalendarGrid';

const maxTooltipNames = 3;

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
        <CalendarDayCell day={day} tooltipDescription={dateTooltipContent(day.date, byDate.get(day.date) ?? [], day.entries, timeZone)} key={day.date}>
          {(byDate.get(day.date) ?? []).map((slot) => <CalendarSlot day={slot} timeZone={timeZone} onOpenDay={onOpenDay} key={slot.id} />)}
        </CalendarDayCell>
      )} />
    </>
  );
}

function CalendarSlot({ day, timeZone, onOpenDay }: { day: OpenDay; timeZone: string; onOpenDay: (day: OpenDay) => void }) {
  const presentation = slotPresentation(day);
  const Icon = presentation.Icon;
  return <CalendarEvent kind={presentation.kind} timeLabel={timeRange(day, timeZone)} statusLabel={presentation.label} statusIcon={Icon} assignmentLabel={day.myAssignment ? 'Your assignment' : undefined} assignmentIcon={UserAvatarFilledAlt} registeredCount={registeredPeopleCount(day)} onActivate={() => onOpenDay(day)} />;
}

function slotPresentation(day: OpenDay) {
  if (day.status === 'cancelled') return { kind: 'cancelled' as const, label: 'Cancelled', Icon: Misuse };
  if (hasOpenSupervisorPosition(day)) return { kind: 'needs-supervisor' as const, label: 'Supervisor position open', Icon: WarningFilled };
  if (isFullyStaffed(day)) return { kind: 'staffed' as const, label: 'Fully staffed', Icon: CheckmarkFilled };
  return { kind: 'needs-trainee' as const, label: 'Trainee position open', Icon: InformationFilled };
}

function dateTooltipContent(date: string, days: OpenDay[], entries: CalendarEntry[], timeZone: string) {
  const fullDate = new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { dateStyle: 'full' });
  return (
    <div className="calendar-cell__tooltip-content">
      <strong>{fullDate}</strong>
      {entries.map((entry) => <span key={`${entry.source}-${entry.id ?? entry.name}`}>{entry.name}</span>)}
      {days.map((day) => <div className="calendar-cell__tooltip-slot" key={day.id}>
        <strong>{timeRange(day, timeZone)}</strong>
        <span>{slotPresentation(day).label}</span>
        {day.requirements.map((requirement) => {
          const role = requirement.kind === 'supervisor' ? 'Supervisors' : 'Trainees';
          const vacancies = Math.max(0, requirement.requiredCount - requirement.assignedCount);
          const vacancyLabel = `${vacancies} ${vacancies === 1 ? 'position' : 'positions'} open`;
          const visibleAssignments = requirement.assignments?.slice(0, maxTooltipNames);
          const overflowCount = Math.max(0, (requirement.assignments?.length ?? 0) - maxTooltipNames);
          return <div className="calendar-cell__tooltip-requirement" key={requirement.id}>
            <span className="calendar-cell__tooltip-requirement-header"><strong>{role}</strong><span>{vacancyLabel}</span></span>
            {requirement.assignments === undefined
              ? <span>{requirement.assignedCount} registered</span>
              : requirement.assignments.length === 0
                ? <span>Nobody registered</span>
                : <ul>
                    {visibleAssignments?.map((assignment) => <li key={assignment.id}>{assignment.displayName}{assignment.isCurrentUser ? ' (you)' : ''}</li>)}
                    {overflowCount > 0 && <li className="calendar-cell__tooltip-overflow">+{overflowCount} others</li>}
                  </ul>}
          </div>;
        })}
      </div>)}
    </div>
  );
}
