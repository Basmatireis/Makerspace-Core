import { listOpenDayPeriods, listOpenDays, getOpenDay } from '../../api/generated/open-days/open-days';

export const openDayKeys = {
  all: ['open-days'] as const,
  periods: () => [...openDayKeys.all, 'periods'] as const,
  schedule: (periodId: string) => [...openDayKeys.all, 'period', periodId] as const,
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

export function openDayQueryOptions(openDayId: string) {
  return {
    queryKey: openDayKeys.day(openDayId),
    queryFn: ({ signal }: { signal: AbortSignal }) => getOpenDay(openDayId, { signal }),
  };
}
