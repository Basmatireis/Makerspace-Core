import { MultiSelect } from '@carbon/react';
import { timeInTimeZone } from './dateTime';
import { openDayWeekdays, type OpenDayDateTimeFilter } from './openDayDateTimeFilter';

export function OpenDayDateTimeFilters({ idPrefix, items, timeZone, value, onChange }: {
  idPrefix: string;
  items: Array<{ startsAt: string }>;
  timeZone: string;
  value: OpenDayDateTimeFilter;
  onChange: (value: OpenDayDateTimeFilter) => void;
}) {
  const startTimes = [...new Set(items.map((item) => timeInTimeZone(item.startsAt, timeZone)))].sort();
  for (const selectedTime of value.startTimes) {
    if (!startTimes.includes(selectedTime)) startTimes.push(selectedTime);
  }
  startTimes.sort();

  return <div className="open-days-date-time-filters" role="group" aria-label="Filter by day and time">
    <MultiSelect
      className="open-days-weekday-filter"
      id={`${idPrefix}-weekday`}
      titleText="Filter by weekday"
      hideLabel
      size="md"
      label={value.weekdays.length === 0 ? 'All days' : `${value.weekdays.length} selected`}
      items={[...openDayWeekdays]}
      itemToString={(weekday) => weekday ?? ''}
      selectedItems={value.weekdays}
      onChange={({ selectedItems }) => onChange({ ...value, weekdays: selectedItems ?? [] })}
    />
    <MultiSelect
      id={`${idPrefix}-start-time`}
      titleText="Filter by start time"
      hideLabel
      size="md"
      label={value.startTimes.length === 0 ? 'All start times' : `${value.startTimes.length} selected`}
      items={startTimes}
      itemToString={(startTime) => startTime ?? ''}
      selectedItems={value.startTimes}
      onChange={({ selectedItems }) => onChange({ ...value, startTimes: selectedItems ?? [] })}
    />
  </div>;
}
