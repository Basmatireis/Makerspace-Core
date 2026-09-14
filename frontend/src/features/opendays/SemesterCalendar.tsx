import type { CalendarEntry, OpenDay } from '../../api/generated/models';
import { timeRange, staffingLabel } from './format';
import { dateInTimeZone } from './dateTime';

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
    <div className="semester-calendar" aria-label="Semester calendar">
      {months.map((month) => {
        const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
        const mondayOffset = (new Date(month.getFullYear(), month.getMonth(), 1).getDay() + 6) % 7;
        return (
          <section className="calendar-month" key={month.toISOString()} aria-labelledby={`month-${month.getFullYear()}-${month.getMonth()}`}>
            <h3 id={`month-${month.getFullYear()}-${month.getMonth()}`}>{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h3>
            <div className="calendar-weekdays" aria-hidden="true">{['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((day) => <span key={day}>{day}</span>)}</div>
            <div className="calendar-days">
              {Array.from({ length: mondayOffset }, (_, index) => <span className="calendar-cell calendar-cell--empty" key={`empty-${index}`} />)}
              {Array.from({ length: count }, (_, index) => {
                const date = new Date(month.getFullYear(), month.getMonth(), index + 1);
                const key = dateKey(date);
                const slots = byDate.get(key) ?? [];
                const markers = entries.filter((entry) => entry.startsOn <= key && entry.endsOn >= key);
                return (
                  <div className="calendar-cell" key={key} aria-label={date.toLocaleDateString(undefined, { dateStyle: 'full' })}>
                    <span className="calendar-cell__date">{index + 1}</span>
                    {markers.map((entry) => <span className={`calendar-marker calendar-marker--${entry.source}`} key={`${entry.source}-${entry.id ?? entry.name}`}>{entry.name}</span>)}
                    {slots.map((slot) => <button type="button" className={`calendar-slot calendar-slot--${slot.status === 'cancelled' ? 'cancelled' : staffingLabel(slot).startsWith('Needs') ? 'needs' : 'staffed'}${slot.myAssignment ? ' calendar-slot--mine' : ''}`} key={slot.id} onClick={() => onOpenDay(slot)}><span>{timeRange(slot, timeZone)}</span><small>{slot.myAssignment ? 'Your assignment' : staffingLabel(slot)}</small></button>)}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
