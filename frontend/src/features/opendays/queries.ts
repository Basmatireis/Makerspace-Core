import { getSupervisorDashboard } from '../../api/generated/supervisors/supervisors';
import {
  getOpenDayCalendarContext,
  listOpenDayAcademicBreaks,
  listOpenDayEligibilityRoles,
  listOpenDayEligiblePeople,
  listOpenDayPeriods,
  listOpenDays,
  listOpenDaySeries,
} from '../../api/generated/open-days/open-days';

export const openDayKeys = {
  all: ['open-days'] as const,
  periods: () => [...openDayKeys.all, 'periods'] as const,
  academicBreaks: () => [...openDayKeys.all, 'academic-breaks'] as const,
  schedule: (periodId: string) => [...openDayKeys.all, 'period', periodId] as const,
  series: (periodId: string) => [...openDayKeys.all, 'series', periodId] as const,
  calendarContext: (periodId: string) => [...openDayKeys.all, 'calendar-context', periodId] as const,
  eligibilityRoles: () => [...openDayKeys.all, 'eligibility-roles'] as const,
  eligiblePeople: (requirementId: string, search: string) =>
    [...openDayKeys.all, 'eligible-people', requirementId, search] as const,
  staffingRows: (periodId: string) => [...openDayKeys.all, 'staffing-rows', periodId] as const,
  requirements: () => [...openDayKeys.all, 'requirements'] as const,
};

export function academicBreaksQueryOptions() {
  return {
    queryKey: openDayKeys.academicBreaks(),
    queryFn: ({ signal }: { signal: AbortSignal }) => listOpenDayAcademicBreaks({ signal }),
  };
}

export function eligibilityRolesQueryOptions(enabled = true) {
  return {
    queryKey: openDayKeys.eligibilityRoles(),
    queryFn: ({ signal }: { signal: AbortSignal }) => listOpenDayEligibilityRoles({ signal }),
    enabled,
  };
}

export function periodsQueryOptions() {
  return {
    queryKey: openDayKeys.periods(),
    queryFn: ({ signal }: { signal: AbortSignal }) => listOpenDayPeriods({ signal }),
  };
}

export function scheduleQueryOptions(periodId: string) {
  return {
    queryKey: openDayKeys.schedule(periodId),
    queryFn: ({ signal }: { signal: AbortSignal }) => listOpenDays(periodId, { signal }),
  };
}

export function seriesQueryOptions(periodId: string) {
  return {
    queryKey: openDayKeys.series(periodId),
    queryFn: ({ signal }: { signal: AbortSignal }) => listOpenDaySeries(periodId, { signal }),
  };
}

export function calendarContextQueryOptions(periodId: string) {
  return {
    queryKey: openDayKeys.calendarContext(periodId),
    queryFn: ({ signal }: { signal: AbortSignal }) => getOpenDayCalendarContext(periodId, { signal }),
    enabled: Boolean(periodId),
  };
}

export function eligiblePeopleQueryOptions(requirementId: string, search: string) {
  return {
    queryKey: openDayKeys.eligiblePeople(requirementId, search),
    queryFn: ({ signal }: { signal: AbortSignal }) => listOpenDayEligiblePeople(requirementId, { search }, { signal }),
  };
}

/** The supervisor dashboard rows of a period: who is below their minimum. Needs `supervisor_dashboard.read`. */
export function staffingRowsQueryOptions(periodId: string) {
  return {
    queryKey: openDayKeys.staffingRows(periodId),
    queryFn: ({ signal }: { signal: AbortSignal }) => getSupervisorDashboard({ periodId }, { signal }),
  };
}
