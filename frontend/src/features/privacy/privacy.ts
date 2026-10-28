import { getPrivacyOverview, getPrivacySettings, listPrivacyCategories } from '../../api/generated/privacy/privacy';

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
