import type { OpenDayPeriod } from '../../../api/generated/models';
import { addCalendarDays } from '../../../app/dateTime';

/**
 * Suggested values for a new period: it starts on the first of the month after the latest period ended (about a month
 * later) and runs for four months; the latest period's series are offered as the start.
 */
export function newPeriodDefaults(periods: readonly OpenDayPeriod[], today: string) {
  const latest = [...periods].sort((a, b) => b.endsOn.localeCompare(a.endsOn))[0];
  const anchor = addCalendarDays(latest?.endsOn ?? today, latest ? 30 : 0);
  const [year, month] = anchor.split('-').map(Number);
  const startsOn = `${year}-${String(month).padStart(2, '0')}-01`;
  const end = new Date(Date.UTC(year, month - 1 + 4, 0));
  return {
    name: '',
    startsOn,
    endsOn: end.toISOString().slice(0, 10),
    signUpDeadline: '',
    copySeriesFromPeriodId: latest?.id ?? '',
  };
}

export type PeriodFields = {
  name: string;
  startsOn: string;
  endsOn: string;
  signUpDeadline: string;
  copySeriesFromPeriodId: string;
};

export function periodError(values: PeriodFields): string {
  if (!values.name.trim()) return 'Give the period a name.';
  if (!values.startsOn || !values.endsOn) return 'Choose start and end.';
  if (values.endsOn < values.startsOn) return 'The period must end after it starts.';
  if (values.signUpDeadline && (values.signUpDeadline < values.startsOn || values.signUpDeadline > values.endsOn))
    return 'The sign-up deadline must lie within the period.';
  return '';
}
