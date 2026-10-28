import { ApiError } from '../../api/http-client';
import type { PrivacyCategory } from '../../api/generated/models';
import {
  getPrivacyOverview,
  getPrivacySettings,
  getRetentionRun,
  listPrivacyCategories,
  listPrivacyHolds,
  listPrivacyPolicies,
  listRetentionRuns,
} from '../../api/generated/privacy/privacy';

export const privacyQueryKey = ['privacy'] as const;

export function privacyOverviewQueryOptions() {
  return {
    queryKey: [...privacyQueryKey, 'overview'] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) => getPrivacyOverview({ signal }),
  } as const;
}

export function privacyCategoriesQueryOptions() {
  return {
    queryKey: [...privacyQueryKey, 'categories'] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) => listPrivacyCategories({ signal }),
  } as const;
}

export function privacySettingsQueryOptions() {
  return {
    queryKey: [...privacyQueryKey, 'settings'] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) => getPrivacySettings({ signal }),
  } as const;
}

export function privacyPoliciesQueryOptions() {
  return {
    queryKey: [...privacyQueryKey, 'policies'] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) => listPrivacyPolicies({ signal }),
  } as const;
}

export function privacyHoldsQueryOptions() {
  return {
    queryKey: [...privacyQueryKey, 'holds'] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) => listPrivacyHolds({ signal }),
  } as const;
}

export function retentionRunsQueryOptions() {
  return {
    queryKey: [...privacyQueryKey, 'runs'] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) => listRetentionRuns({ signal }),
  } as const;
}

export function retentionRunQueryOptions(runId: string) {
  return {
    queryKey: [...privacyQueryKey, 'runs', runId] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) => getRetentionRun(runId, { signal }),
  } as const;
}

/** The API error code of a failed request, if the envelope carries one. */
export function errorCode(error: unknown): string | undefined {
  return error instanceof ApiError ? (error.data as { code?: string } | undefined)?.code : undefined;
}

const errorMessages: Record<string, string> = {
  policy_not_draft: 'Only draft policies can be edited. Create a new version instead.',
  policy_incomplete: 'Purpose, legal basis and reason are required before a policy can be approved.',
  policy_four_eyes: 'The person who approved a policy cannot activate it. Ask a second person to activate it.',
  policy_state_invalid: 'The policy is no longer in a state that allows this step. Reload and try again.',
  hold_not_open: 'This hold was already released.',
};

export function privacyErrorMessage(error: unknown): string {
  const code = errorCode(error);
  if (code && errorMessages[code]) return errorMessages[code];
  return error instanceof Error ? error.message : 'The request failed.';
}

export function categoryName(categories: readonly PrivacyCategory[] | undefined, id: string): string {
  return categories?.find((category) => category.id === id)?.name ?? id;
}
