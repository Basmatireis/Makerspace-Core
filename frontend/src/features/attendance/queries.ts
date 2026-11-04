import { keepPreviousData, queryOptions } from '@tanstack/react-query';
import { getAttendanceStatistics, listVisits } from '../../api/generated/attendance/attendance';
import { listPeople } from '../../api/generated/people/people';

export const attendanceKeys = {
  all: ['attendance'] as const,
  visits: ['attendance', 'visits'] as const,
  statistics: ['attendance', 'statistics'] as const,
  candidates: (search: string) => ['attendance', 'candidates', search] as const,
};

export function visitsOptions(enabled: boolean) {
  return queryOptions({
    queryKey: attendanceKeys.visits,
    queryFn: ({ signal }) => listVisits({ currentlyHere: true }, { signal }),
    refetchInterval: 5_000,
    enabled,
  });
}

export function statisticsOptions(enabled: boolean) {
  return queryOptions({
    queryKey: attendanceKeys.statistics,
    // The window ends at fetch time, so a refetch after a check-in counts the new visit.
    queryFn: ({ signal }) => {
      const now = new Date();
      const from = new Date(now);
      from.setDate(now.getDate() - 30);
      return getAttendanceStatistics({ from: from.toISOString(), to: now.toISOString() }, { signal });
    },
    enabled,
  });
}

export function candidatesOptions(search: string, enabled: boolean) {
  return queryOptions({
    queryKey: attendanceKeys.candidates(search),
    queryFn: ({ signal }) => listPeople({ search: search.trim() || undefined, pageSize: 25 }, { signal }),
    placeholderData: keepPreviousData,
    enabled,
  });
}
