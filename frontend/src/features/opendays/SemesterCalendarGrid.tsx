import { Add } from '@carbon/icons-react';
import { Button, Tooltip } from '@carbon/react';
import { forwardRef, type ReactNode } from 'react';
import type { CalendarEntry } from '../../api/generated/models';
import { CalendarContextMarker } from './CalendarContextMarker';

export type CalendarGridDay = {
  date: string;
  dayNumber: number;
  entries: CalendarEntry[];
  showBreakLabel: boolean;
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
  const start = new Date(`${startsOn}T00:00:00`);
  const end = new Date(`${endsOn}T00:00:00`);
  const months: Date[] = [];
  for (let cursor = new Date(start.getFullYear(), start.getMonth(), 1); cursor <= end; cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)) {
    months.push(cursor);
  }

  return (
    <div className={`semester-calendar${className ? ` ${className}` : ''}`} aria-label={ariaLabel}>
      {months.map((month) => {
        const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
        const sundayOffset = new Date(month.getFullYear(), month.getMonth(), 1).getDay();
        const weekCount = Math.ceil((sundayOffset + count) / 7);
        const trailingCount = weekCount * 7 - sundayOffset - count;
        return (
          <section className="calendar-month" key={month.toISOString()} aria-labelledby={`month-${month.getFullYear()}-${month.getMonth()}`}>
            <h3 id={`month-${month.getFullYear()}-${month.getMonth()}`}>{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h3>
            <div className="calendar-weekdays" aria-hidden="true">{['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((day) => <span key={day}>{day}</span>)}</div>
            <div className="calendar-days" style={{ gridTemplateRows: `repeat(${weekCount}, minmax(0, 1fr))` }}>
              {Array.from({ length: sundayOffset }, (_, index) => <span className="calendar-cell calendar-cell--empty" key={`empty-${index}`} />)}
              {Array.from({ length: count }, (_, index) => {
                const date = dateKey(month.getFullYear(), month.getMonth(), index + 1);
                return renderDay({
                  date,
                  dayNumber: index + 1,
                  entries: entries.filter((entry) => entry.startsOn <= date && entry.endsOn >= date),
                  showBreakLabel: entries.some((entry) => entry.category === 'academicBreak' && entry.startsOn === date) || index === 0,
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
  tooltipDescription?: string;
};

export const CalendarDayCell = forwardRef<HTMLDivElement, CellProps>(function CalendarDayCell({ day, children, className = '', onSelectDate, tooltipDescription }, ref) {
  const holidays = day.entries.filter((entry) => entry.category === 'publicHoliday');
  const fullDate = new Date(`${day.date}T00:00:00`).toLocaleDateString(undefined, { dateStyle: 'full' });
  const contextDescription = day.entries.map((entry) => `${entry.category === 'academicBreak' ? 'Academic break' : 'Public holiday'}: ${entry.name}`);
  const description = tooltipDescription ?? [fullDate, ...contextDescription].join('. ');

  return (
    <div ref={ref} className={`calendar-cell${day.withinRange ? '' : ' calendar-cell--outside-period'}${className ? ` ${className}` : ''}`} aria-label={fullDate}>
      <div className="calendar-cell__header">
        <Tooltip description={description} align="bottom-start" enterDelayMs={300}>
          <span className="calendar-cell__date-tooltip">
            {onSelectDate ? (
              <Button kind="ghost" size="sm" renderIcon={Add} className="calendar-cell__date-action" onClick={onSelectDate} aria-label={`Add Open Day on ${day.date}`}>
                {day.dayNumber}
              </Button>
            ) : <span className="calendar-cell__date">{day.dayNumber}</span>}
          </span>
        </Tooltip>
        {day.entries.length > 0 && (
          <div className="calendar-cell__context">
            {day.entries.map((entry) => (
              <CalendarContextMarker
                entry={entry}
                showBreakLabel={entry.category !== 'academicBreak' || day.showBreakLabel}
                mode={entry.category === 'publicHoliday' ? 'icon' : 'full'}
                key={`${entry.source}-${entry.id ?? entry.name}`}
              />
            ))}
          </div>
        )}
      </div>
      {holidays.map((entry) => (
        <CalendarContextMarker
          entry={entry}
          mode="label"
          key={`label-${entry.source}-${entry.id ?? entry.name}`}
        />
      ))}
      {children}
    </div>
  );
});

function dateKey(year: number, month: number, day: number) {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
