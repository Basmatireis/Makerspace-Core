import { keepPreviousData, queryOptions, useQueries, useQuery } from '@tanstack/react-query';
import type { NotificationRuleInput } from '../../api/generated/models';
import {
  dryRunNotificationRule,
  getNotificationCatalog,
  listNotificationActivity,
  getNotificationRule,
  listNotificationCategories,
  listNotificationRules,
} from '../../api/generated/notification-rules/notification-rules';
import { ApiError } from '../../api/http-client';
import { fullRoleCatalogOptions } from '../roles/queries';
import { personOptions } from '../users/queries';
import type { NameLookup } from './ruleText';

export const notificationCenterKeys = {
  all: ['notification-center'] as const,
  catalog: () => [...notificationCenterKeys.all, 'catalog'] as const,
  rules: () => [...notificationCenterKeys.all, 'rules'] as const,
  rule: (id: string) => [...notificationCenterKeys.all, 'rule', id] as const,
  categories: () => [...notificationCenterKeys.all, 'categories'] as const,
  activity: () => [...notificationCenterKeys.all, 'activity'] as const,
  dryRun: () => [...notificationCenterKeys.all, 'dry-run'] as const,
};

// The catalog only changes with a release.
export const catalogQuery = () =>
  queryOptions({
    queryKey: notificationCenterKeys.catalog(),
    queryFn: ({ signal }) => getNotificationCatalog({ signal }),
    staleTime: 5 * 60_000,
  });
export const rulesQuery = () =>
  queryOptions({
    queryKey: notificationCenterKeys.rules(),
    queryFn: ({ signal }) => listNotificationRules({ signal }),
  });
export const ruleQuery = (id: string) =>
  queryOptions({
    queryKey: notificationCenterKeys.rule(id),
    queryFn: ({ signal }) => getNotificationRule(id, { signal }),
  });
export const categoriesQuery = () =>
  queryOptions({
    queryKey: notificationCenterKeys.categories(),
    queryFn: ({ signal }) => listNotificationCategories({ signal }),
  });

/** One page of the activity log, optionally of a single rule. */
export const activityQuery = (params: { ruleId?: string; page: number; pageSize: number }) =>
  queryOptions({
    queryKey: [...notificationCenterKeys.activity(), params] as const,
    queryFn: ({ signal }) => listNotificationActivity(params, { signal }),
    placeholderData: keepPreviousData,
  });

/** The server's dry run of a draft: the key is the draft itself, so every edit asks again and an older answer stays in view meanwhile. */
export const dryRunQuery = (personal: boolean, rule: NotificationRuleInput) =>
  queryOptions({
    queryKey: [...notificationCenterKeys.dryRun(), personal, rule] as const,
    queryFn: ({ signal }) => dryRunNotificationRule({ personal, rule }, { signal }),
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 30_000,
  });

/** Role and person names for recipients that are stored by id. */
export function useNameLookup(personIds: readonly string[]): NameLookup {
  const roles = useQuery(fullRoleCatalogOptions);
  const people = useQueries({
    queries: personIds.map((id) => ({ ...personOptions(id), retry: false, staleTime: 5 * 60_000 })),
  });
  return {
    roles: Object.fromEntries((roles.data ?? []).map((role) => [role.id, role.name])),
    people: Object.fromEntries(
      personIds.flatMap((id, index) => {
        const person = people[index]?.data;
        return person ? [[id, `${person.firstName} ${person.lastName}`]] : [];
      }),
    ),
  };
}

export type SaveProblem = { title: string; message: string; stale: boolean; reason: string };

/** What a rejected save says: the validation reason of a 422, the reload hint of a 409, or the plain message. */
export function saveProblem(error: unknown, subject: string): SaveProblem {
  if (error instanceof ApiError) {
    const data = error.data as { code?: string; message?: string; details?: { reason?: unknown } } | undefined;
    if (data?.code === 'stale_write') {
      return {
        title: `${subject} changed`,
        message: `This ${subject.toLowerCase()} was changed in another session. Reload it before saving again.`,
        stale: true,
        reason: '',
      };
    }
    const reason = typeof data?.details?.reason === 'string' ? data.details.reason : '';
    if (data?.code === 'validation_failed' && reason) {
      return { title: `${subject} not saved`, message: reason, stale: false, reason };
    }
    return { title: `${subject} not saved`, message: error.message, stale: false, reason };
  }
  return { title: `${subject} not saved`, message: 'The request failed. Try again.', stale: false, reason: '' };
}
