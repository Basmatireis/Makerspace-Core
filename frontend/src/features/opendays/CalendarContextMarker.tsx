import { Calendar, Education } from '@carbon/icons-react';
import type { CalendarEntry } from '../../api/generated/models';

type Props = {
  entry: CalendarEntry;
  showBreakLabel?: boolean;
};

export function CalendarContextMarker({ entry, showBreakLabel = true }: Props) {
  const academicBreak = entry.category === 'academicBreak';
  const Icon = academicBreak ? Education : Calendar;
  const category = academicBreak ? 'Academic break' : 'Public holiday';
  const description = academicBreak
    ? `${category}: ${entry.name}, ${entry.startsOn} to ${entry.endsOn}`
    : `${category}: ${entry.name}`;
  const visibleLabel = academicBreak && !showBreakLabel ? '' : entry.name;

  return (
    <span
      className={`calendar-marker calendar-marker--${entry.category}${academicBreak && !showBreakLabel ? ' calendar-marker--continuation' : ''}`}
      aria-label={description}
      title={description}
    >
      <Icon size={12} aria-hidden="true" />
      {visibleLabel && <span aria-hidden="true">{visibleLabel}</span>}
    </span>
  );
}
