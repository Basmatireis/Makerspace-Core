import type { CalendarEntry } from '../../../api/generated/models';
import { formatDate } from '../../../app/dateTime';

export function SelectedCalendarContext({ date, entries }: { date: string; entries: CalendarEntry[] }) {
  const context = entries.filter((entry) => entry.startsOn <= date && entry.endsOn >= date);
  if (!context.length) return null;
  return (
    <div className="open-day-selected-context">
      <strong>{formatDate(date)}</strong>
      {context.map((entry) => (
        <p key={`${entry.source}-${entry.id ?? entry.name}`}>
          {entry.category === 'academicBreak' ? 'Academic break' : 'Public holiday'}: {entry.name}
        </p>
      ))}
    </div>
  );
}
