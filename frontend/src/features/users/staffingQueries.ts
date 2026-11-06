import { queryOptions } from '@tanstack/react-query';
import { listOpenDayPeriods, listOpenDays } from '../../api/generated/open-days/open-days';
import { getStaffingRules, getSupervisorDashboard } from '../../api/generated/supervisors/supervisors';

export const staffingKeys = {
  dashboards: ['supervisor-dashboard'] as const,
  dashboard: (periodId: string | undefined) => ['supervisor-dashboard', periodId ?? 'current'] as const,
  rules: ['staffing-rules'] as const,
  // Same keys as the Open Days feature, so a change there refreshes these lists and the other way round.
  periods: ['open-days', 'periods'] as const,
  schedule: (periodId: string) => ['open-days', 'period', periodId] as const,
};

/** The people table of a semester. Without a period the server picks the current semester. */
export const staffingDashboardOptions = (periodId: string | undefined) =>
  queryOptions({
    queryKey: staffingKeys.dashboard(periodId),
    queryFn: ({ signal }) => getSupervisorDashboard(periodId ? { periodId } : undefined, { signal }),
  });

export const staffingRulesOptions = () =>
  queryOptions({
    queryKey: staffingKeys.rules,
    queryFn: ({ signal }) => getStaffingRules({ signal }),
  });

export const staffingPeriodsOptions = (enabled: boolean) =>
  queryOptions({
    queryKey: staffingKeys.periods,
    queryFn: ({ signal }) => listOpenDayPeriods({ signal }),
    enabled,
  });

export const staffingScheduleOptions = (periodId: string | undefined, enabled: boolean) =>
  queryOptions({
    queryKey: staffingKeys.schedule(periodId ?? ''),
    queryFn: ({ signal }) => listOpenDays(periodId ?? '', { signal }),
    enabled: enabled && Boolean(periodId),
  });
