import type { OpenDayPeriod } from '../../../api/generated/models';

/**
 * The period people without `open_days.manage` land on: the one running today, else the next one that starts, else the
 * latest. Drafts are never offered (the API does not list them for those people, and this keeps the rule explicit).
 */
export function currentPeriod(periods: readonly OpenDayPeriod[], today: string): OpenDayPeriod | undefined {
  const visible = periods
    .filter((period) => period.status !== 'draft')
    .sort((a, b) => a.startsOn.localeCompare(b.startsOn));
  return (
    visible.find((period) => period.startsOn <= today && today <= period.endsOn) ??
    visible.find((period) => period.startsOn > today) ??
    visible[visible.length - 1]
  );
}
