import type { AcademicBreak } from '../../../api/generated/models';
import { dayDiff } from './dates';

export type BreakFields = { name: string; startsOn: string; endsOn: string };

export const breakDays = (item: Pick<AcademicBreak, 'startsOn' | 'endsOn'>) => dayDiff(item.endsOn, item.startsOn) + 1;

export function breakError(values: BreakFields): string {
  if (!values.name.trim()) return 'Give the break a name.';
  if (!values.startsOn || !values.endsOn) return 'Choose start and end.';
  if (values.endsOn < values.startsOn) return 'The break must end after it starts.';
  return '';
}
