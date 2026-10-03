import { Add } from '@carbon/icons-react';
import { Button, Tooltip } from '@carbon/react';
import { forwardRef, type ReactNode } from 'react';
import type { CalendarEntry } from '../../api/generated/models';
import { formatDate, formatLongDate, formatMonthYear } from '../../app/dateTime';
import { CalendarContextMarker } from './CalendarContextMarker';

export type CalendarGridDay = {
  date: string;
  dayNumber: number;
  entries: CalendarEntry[];
  withinRange: boolean;
};

type GridProps = {
  startsOn: string;
  endsOn: string;
  entries?: CalendarEntry[];
  renderDay: (day: CalendarGridDay) => ReactNode;
  className?: string;
  ariaLabel?: string;
};

export function SemesterCalendarGrid({ startsOn, endsOn, entries = [], renderDay, className = '', ariaLabel = 'Semester calendar' }: GridProps) {
  const start = new Date(`${startsOn}T00:00:00Z`);
  const end = new Date(`${endsOn}T00:00:00Z`);
  const months: Date[] = [];
  for (let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1, 12)); cursor <= end; cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1, 12))) {
    months.push(cursor);
  }

  return (
    <div className={`semester-calendar${className ? ` ${className}` : ''}`} aria-label={ariaLabel}>
      {months.map((month) => {
        const count = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();
        const sundayOffset = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1)).getUTCDay();
        const weekCount = Math.ceil((sundayOffset + count) / 7);
        const trailingCount = weekCount * 7 - sundayOffset - count;
        return (
          <section className="calendar-month" key={month.toISOString()} aria-labelledby={`month-${month.getUTCFullYear()}-${month.getUTCMonth()}`}>
            <h3 id={`month-${month.getUTCFullYear()}-${month.getUTCMonth()}`}>{formatMonthYear(month)}</h3>
            <div className="calendar-weekdays" aria-hidden="true">{['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((day) => <span key={day}>{day}</span>)}</div>
            <div className="calendar-days" style={{ gridTemplateRows: `repeat(${weekCount}, minmax(5rem, auto))` }}>
              {Array.from({ length: sundayOffset }, (_, index) => <span className="calendar-cell calendar-cell--empty" key={`empty-${index}`} />)}
              {Array.from({ length: count }, (_, index) => {
                const date = dateKey(month.getUTCFullYear(), month.getUTCMonth(), index + 1);
                return renderDay({
                  date,
                  dayNumber: index + 1,
                  entries: entries.filter((entry) => entry.startsOn <= date && entry.endsOn >= date),
                  withinRange: date >= startsOn && date <= endsOn,
                });
              })}
              {Array.from({ length: trailingCount }, (_, index) => <span className="calendar-cell calendar-cell--trailing" aria-hidden="true" key={`trailing-${index}`} />)}
            </div>
          </section>
        );
      })}
    </div>
  );
}

type CellProps = {
  day: CalendarGridDay;
  children?: ReactNode;
  className?: string;
  onSelectDate?: () => void;
  tooltipDescription?: ReactNode;
};

export const CalendarDayCell = forwardRef<HTMLDivElement, CellProps>(function CalendarDayCell({ day, children, className = '', onSelectDate, tooltipDescription }, ref) {
  const fullDate = formatLongDate(day.date);
  const contextDescription = day.entries.map((entry) => `${entry.category === 'academicBreak' ? 'Academic break' : 'Public holiday'}: ${entry.name}`);
  const description = tooltipDescription ?? [fullDate, ...contextDescription].join('. ');

  return (
    <Tooltip
      as="div"
      ref={ref}
      description={description}
      align="bottom-start"
      enterDelayMs={300}
      className={`calendar-cell${day.withinRange ? '' : ' calendar-cell--outside-period'}${className ? ` ${className}` : ''}`}
    >
      <div className="calendar-cell__tooltip-target" aria-label={fullDate}>
        <div className="calendar-cell__header">
          {onSelectDate ? (
            <Button kind="ghost" size="sm" renderIcon={Add} className="calendar-cell__date-action" onClick={onSelectDate} aria-label={`Add Open Day on ${formatDate(day.date)}`}>
              {day.dayNumber}
            </Button>
          ) : <span className="calendar-cell__date">{day.dayNumber}</span>}
          {day.entries.length > 0 && (
            <div className="calendar-cell__context">
              {day.entries.map((entry) => (
                <CalendarContextMarker
                  entry={entry}
                  mode="icon"
                  key={`${entry.source}-${entry.id ?? entry.name}`}
                />
              ))}
            </div>
          )}
        </div>
        {day.entries.map((entry) => (
          <CalendarContextMarker
            entry={entry}
            mode="label"
            key={`label-${entry.source}-${entry.id ?? entry.name}`}
          />
        ))}
        {children}
      </div>
    </Tooltip>
  );
});

function dateKey(year: number, month: number, day: number) {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
