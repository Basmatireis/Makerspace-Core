import { getOpenDay, getOpenDayCalendarContext, listOpenDayPeriods, listOpenDays } from '../../api/generated/open-days/open-days';

export const openDayKeys = {
  all: ['open-days'] as const,
  periods: () => [...openDayKeys.all, 'periods'] as const,
  schedule: (periodId: string) => [...openDayKeys.all, 'period', periodId] as const,
  calendarContext: (periodId: string) => [...openDayKeys.all, 'calendar-context', periodId] as const,
  day: (openDayId: string) => [...openDayKeys.all, 'day', openDayId] as const,
};

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

export function calendarContextQueryOptions(periodId: string) {
  return {
    queryKey: openDayKeys.calendarContext(periodId),
    queryFn: ({ signal }: { signal: AbortSignal }) => getOpenDayCalendarContext(periodId, { signal }),
    enabled: Boolean(periodId),
  };
}

export function openDayQueryOptions(openDayId: string) {
  return {
    queryKey: openDayKeys.day(openDayId),
    queryFn: ({ signal }: { signal: AbortSignal }) => getOpenDay(openDayId, { signal }),
  };
}
