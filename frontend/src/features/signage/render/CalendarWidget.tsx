import { Fragment, type CSSProperties } from 'react';
import type { SignageCalendarWidget } from '../../../api/generated/models';
import { buildCalendar, type CalendarCategory, type CalendarDay } from './calendarModel';
import { withOpacity } from './style';
import type { RenderData } from './types';

// Month grid or weeks view with toggleable categories. Everything is sized in --u so it stays legible on a wall display.

const WEEKDAY_HEADS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const CATEGORY_LABEL: Record<CalendarCategory, string> = {
  holiday: 'Holiday',
  break: 'Break',
  openDay: 'Open day',
  event: 'Event',
};
/** Entries shown per day before "+n"; a month cell is small, a week row has room. */
const MAX_ENTRIES = { month: 2, weeks: 4 } as const;

type Props = { widget: SignageCalendarWidget; data: RenderData };

function DayCell({ day, widget, limit }: { day: CalendarDay; widget: SignageCalendarWidget; limit: number }) {
  const shown = day.entries.slice(0, limit);
  const more = day.entries.length - shown.length;
  const style = day.breakDay ? { background: withOpacity(widget.colors.break, 22) } : undefined;
  return (
    <div
      className={`sg-cal__day${day.today ? ' sg-cal__day--today' : ''}${day.inMonth ? '' : ' sg-cal__day--outside'}${
        day.weekend ? ' sg-cal__day--weekend' : ''
      }`}
      style={style}
      data-date={day.key}
    >
      <span className="sg-cal__number">{day.day}</span>
      {shown.map((entry, index) => {
        const color = widget.colors[entry.category];
        const entryStyle = {
          borderInlineStartColor: color,
          background: withOpacity(color, 30),
        } satisfies CSSProperties;
        return (
          <span
            key={`${entry.category}-${index}`}
            className={`sg-cal__entry sg-cal__entry--${entry.category}${entry.cancelled ? ' sg-cal__entry--cancelled' : ''}`}
            style={entryStyle}
          >
            {entry.time !== '' && <span className="sg-cal__time">{entry.time}</span>} {entry.label}
          </span>
        );
      })}
      {more > 0 && <span className="sg-cal__more">+{more}</span>}
    </div>
  );
}

export function CalendarWidget({ widget, data }: Props) {
  const model = buildCalendar(widget, data.calendar, data.now, data.timeZone);
  const view = widget.view;
  const title = widget.title ?? '';
  const columns = widget.showWeekNumbers ? 'calc(var(--u) * 3) repeat(7, minmax(0, 1fr))' : 'repeat(7, minmax(0, 1fr))';
  const legend = (
    [
      ['holiday', widget.showHolidays],
      ['break', widget.showBreaks],
      ['openDay', widget.showOpenDays],
      ['event', widget.showEvents],
    ] as const
  ).filter(([, shown]) => shown);
  return (
    <div className={`sg-cal sg-cal--${view}`} role="group" aria-label={title || 'Calendar'}>
      {(title !== '' || model.monthLabel !== '') && (
        <div className="sg-cal__head">
          {title !== '' && <strong className="sg-cal__title">{title}</strong>}
          {model.monthLabel !== '' && <span className="sg-cal__month">{model.monthLabel}</span>}
        </div>
      )}
      <div
        className="sg-cal__grid"
        style={{ gridTemplateColumns: columns, gridTemplateRows: `auto repeat(${model.weeks.length}, minmax(0, 1fr))` }}
      >
        {widget.showWeekNumbers && <span className="sg-cal__weekday sg-cal__wk">Wk</span>}
        {WEEKDAY_HEADS.map((name) => (
          <span key={name} className="sg-cal__weekday">
            {name}
          </span>
        ))}
        {model.weeks.map((week) => (
          <Fragment key={week.days[0].key}>
            {widget.showWeekNumbers && (
              <span className="sg-cal__wk" aria-label={`Week ${week.isoWeek}`}>
                {week.isoWeek}
              </span>
            )}
            {week.days.map((day) => (
              <DayCell key={day.key} day={day} widget={widget} limit={MAX_ENTRIES[view]} />
            ))}
          </Fragment>
        ))}
      </div>
      {legend.length > 0 && (
        <ul className="sg-cal__legend" aria-label="Legend">
          {legend.map(([category]) => (
            <li key={category}>
              <span className="sg-cal__swatch" style={{ background: widget.colors[category] }} aria-hidden="true" />
              {CATEGORY_LABEL[category]}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
