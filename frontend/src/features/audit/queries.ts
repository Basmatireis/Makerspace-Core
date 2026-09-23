import type { AuditActorType, ListAuditEventsParams } from '../../api/generated/models';
import { listAuditEvents } from '../../api/generated/audit/audit';

export type ActivityFilters = {
  action?: string;
  actorType?: AuditActorType;
  actorSearch?: string;
  resourceType?: string;
};

export const activityKeys = {
  all: ['audit-events'] as const,
  list: (filters: ActivityFilters) => [...activityKeys.all, filters] as const,
};

export function activityQuery(filters: ActivityFilters) {
  return {
    queryKey: activityKeys.list(filters),
    queryFn: ({ signal, pageParam }: { signal: AbortSignal; pageParam: string | undefined }) => {
      const params: ListAuditEventsParams = {
        limit: 50,
        cursor: pageParam,
        action: filters.action,
        actorType: filters.actorType,
        actorSearch: filters.actorSearch,
        resourceType: filters.resourceType,
      };
      return listAuditEvents(params, { signal });
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page: Awaited<ReturnType<typeof listAuditEvents>>) => page.nextCursor ?? undefined,
  };
}
