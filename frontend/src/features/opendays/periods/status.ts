import type { OpenDayPeriod } from '../../../api/generated/models';
import { dayMonth, dayMonthYear } from '../model/dates';

export const STATUS_TAG = {
  draft: { label: 'Draft', type: 'warm-gray' },
  staffing: { label: 'Staffing', type: 'blue' },
  published: { label: 'Published', type: 'green' },
  archived: { label: 'Archived', type: 'gray' },
} as const;

export const periodRange = (period: Pick<OpenDayPeriod, 'startsOn' | 'endsOn'>) =>
  `${dayMonth(period.startsOn)}${period.startsOn.slice(0, 4) === period.endsOn.slice(0, 4) ? '' : ` ${period.startsOn.slice(0, 4)}`} – ${dayMonthYear(period.endsOn)}`;
