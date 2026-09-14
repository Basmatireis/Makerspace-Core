import { Calendar, CheckmarkFilled, Education, InformationFilled, Misuse, UserAvatarFilledAlt, WarningFilled } from '@carbon/icons-react';
import type { CalendarEntry, OpenDay } from '../../api/generated/models';
import { timeRange, isFullyStaffed } from './format';
import { dateInTimeZone } from './dateTime';
import { hasOpenSupervisorPosition } from './openDayFilters';
import { CalendarContextMarker } from './CalendarContextMarker';

type Props = {
  startsOn: string;
  endsOn: string;
  days: OpenDay[];
  entries?: CalendarEntry[];
  timeZone: string;
  onOpenDay: (day: OpenDay) => void;
};

function dateKey(value: Date | string) {
  const date = typeof value === 'string' ? new Date(value) : value;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function SemesterCalendar({ startsOn, endsOn, days, entries = [], timeZone, onOpenDay }: Props) {
  const start = new Date(`${startsOn}T00:00:00`);
  const end = new Date(`${endsOn}T00:00:00`);
  const months: Date[] = [];
  for (let cursor = new Date(start.getFullYear(), start.getMonth(), 1); cursor <= end; cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)) {
    months.push(cursor);
  }
  const byDate = new Map<string, OpenDay[]>();
  for (const item of days) {
    const key = dateInTimeZone(item.startsAt, timeZone);
    byDate.set(key, [...(byDate.get(key) ?? []), item]);
  }

  return (
    <>
      <div className="calendar-legend" aria-label="Calendar status legend">
        <span><CheckmarkFilled size={14} aria-hidden="true" />Fully staffed</span>
        <span><WarningFilled size={14} aria-hidden="true" />Supervisor position open</span>
        <span><UserAvatarFilledAlt size={14} aria-hidden="true" />Your assignment</span>
        <span><Misuse size={14} aria-hidden="true" />Cancelled</span>
        <span><Calendar size={14} aria-hidden="true" />Public holiday</span>
        <span><Education size={14} aria-hidden="true" />Academic break</span>
      </div>
      <div className="semester-calendar" aria-label="Semester calendar">
        {months.map((month) => {
          const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
          const sundayOffset = new Date(month.getFullYear(), month.getMonth(), 1).getDay();
          return (
            <section className="calendar-month" key={month.toISOString()} aria-labelledby={`month-${month.getFullYear()}-${month.getMonth()}`}>
              <h3 id={`month-${month.getFullYear()}-${month.getMonth()}`}>{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h3>
              <div className="calendar-weekdays" aria-hidden="true">{['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((day) => <span key={day}>{day}</span>)}</div>
              <div className="calendar-days">
                {Array.from({ length: sundayOffset }, (_, index) => <span className="calendar-cell calendar-cell--empty" key={`empty-${index}`} />)}
                {Array.from({ length: count }, (_, index) => {
                  const date = new Date(month.getFullYear(), month.getMonth(), index + 1);
                  const key = dateKey(date);
                  const slots = byDate.get(key) ?? [];
                  const markers = entries.filter((entry) => entry.startsOn <= key && entry.endsOn >= key);
                  return (
                    <div className="calendar-cell" key={key} aria-label={date.toLocaleDateString(undefined, { dateStyle: 'full' })}>
                      <span className="calendar-cell__date">{index + 1}</span>
                      {markers.map((entry) => (
                        <CalendarContextMarker
                          entry={entry}
                          showBreakLabel={entry.startsOn === key || index === 0}
                          key={`${entry.source}-${entry.id ?? entry.name}`}
                        />
                      ))}
                      {slots.map((slot) => <CalendarSlot day={slot} timeZone={timeZone} onOpenDay={onOpenDay} key={slot.id} />)}
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}

function CalendarSlot({ day, timeZone, onOpenDay }: { day: OpenDay; timeZone: string; onOpenDay: (day: OpenDay) => void }) {
  const presentation = slotPresentation(day);
  const Icon = presentation.Icon;
  return (
    <button type="button" className={`calendar-slot calendar-slot--${presentation.kind}${day.myAssignment ? ' calendar-slot--mine' : ''}`} onClick={() => onOpenDay(day)}>
      <span className="calendar-slot__time">{timeRange(day, timeZone)}</span>
      <small className="calendar-slot__status"><Icon size={12} aria-hidden="true" />{presentation.label}</small>
      {day.myAssignment && <small className="calendar-slot__assignment"><UserAvatarFilledAlt size={12} aria-hidden="true" />Your assignment</small>}
    </button>
  );
}

function slotPresentation(day: OpenDay) {
  if (day.status === 'cancelled') return { kind: 'cancelled', label: 'Cancelled', Icon: Misuse };
  if (hasOpenSupervisorPosition(day)) return { kind: 'needs-supervisor', label: 'Supervisor position open', Icon: WarningFilled };
  if (isFullyStaffed(day)) return { kind: 'staffed', label: 'Fully staffed', Icon: CheckmarkFilled };
  return { kind: 'needs-trainee', label: 'Trainee position open', Icon: InformationFilled };
}
