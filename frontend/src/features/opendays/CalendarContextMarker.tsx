import { Calendar, Education } from '@carbon/icons-react';
import type { CalendarEntry } from '../../api/generated/models';

type Props = {
  entry: CalendarEntry;
  mode?: 'full' | 'icon' | 'label';
};

export function CalendarContextMarker({ entry, mode = 'full' }: Props) {
  const academicBreak = entry.category === 'academicBreak';
  const Icon = academicBreak ? Education : Calendar;
  const category = academicBreak ? 'Academic break' : 'Public holiday';
  const description = academicBreak
    ? `${category}: ${entry.name}, ${entry.startsOn} to ${entry.endsOn}`
    : `${category}: ${entry.name}`;
  const visibleLabel = mode === 'icon' ? '' : entry.name;

  return (
    <span
      className={`calendar-marker calendar-marker--${entry.category} calendar-marker--${mode}`}
      aria-label={mode === 'label' ? undefined : description}
      aria-hidden={mode === 'label' ? 'true' : undefined}
      title={description}
    >
      {mode !== 'label' && <Icon size={12} aria-hidden="true" />}
      {visibleLabel && <span aria-hidden="true">{visibleLabel}</span>}
    </span>
  );
}
