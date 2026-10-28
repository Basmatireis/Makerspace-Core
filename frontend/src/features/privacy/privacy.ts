import { ApiError } from '../../api/http-client';
import type { PrivacyCategory } from '../../api/generated/models';
import {
  getPrivacyOverview,
  getPrivacySettings,
  getRetentionRun,
  getSubjectRequest,
  listPrivacyCategories,
  listPrivacyHolds,
  listPrivacyPolicies,
  listProcessingActivities,
  listRetentionRuns,
  listSubjectRequests,
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

export function subjectRequestsQueryOptions() {
  return {
    queryKey: [...privacyQueryKey, 'requests'] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) => listSubjectRequests({ signal }),
  } as const;
}

export function subjectRequestQueryOptions(requestId: string) {
  return {
    queryKey: [...privacyQueryKey, 'requests', requestId] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) => getSubjectRequest(requestId, { signal }),
  } as const;
}

export function processingActivitiesQueryOptions() {
  return {
    queryKey: [...privacyQueryKey, 'activities'] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) => listProcessingActivities({ signal }),
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
  request_state_invalid: 'The request is no longer in a state that allows this step. Reload and try again.',
  request_four_eyes:
    'The person who verified the identity cannot approve the request. Ask a second person to approve it.',
  request_subject_missing: 'The person of this request no longer exists.',
  erasure_on_hold: 'The person has an open hold. Release the hold before erasing their data.',
  person_deletion_blocked: 'The person cannot be deleted yet. See the blockers in the assessment.',
  stale_write: 'The record changed in the meantime and was reloaded. Review it and try again.',
};

export function privacyErrorMessage(error: unknown): string {
  const code = errorCode(error);
  if (code && errorMessages[code]) return errorMessages[code];
  return error instanceof Error ? error.message : 'The request failed.';
}

export function categoryName(categories: readonly PrivacyCategory[] | undefined, id: string): string {
  return categories?.find((category) => category.id === id)?.name ?? id;
}
