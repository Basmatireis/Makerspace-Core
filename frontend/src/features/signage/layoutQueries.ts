import { queryOptions } from '@tanstack/react-query';
import { getSignageCustomLayout, listSignageCustomLayouts } from '../../api/generated/signage/signage';
import { signageKeys } from './queries';

// Custom layouts live under the signage key prefix, so every signage invalidation (deletes, publishes) refreshes them too.
export const customLayoutKeys = {
  all: [...signageKeys.all, 'custom-layouts'] as const,
  one: (id: string) => [...signageKeys.all, 'custom-layout', id] as const,
};

export const customLayoutsQuery = () =>
  queryOptions({
    queryKey: customLayoutKeys.all,
    queryFn: ({ signal }) => listSignageCustomLayouts({ signal }),
  });

export const customLayoutQuery = (id: string) =>
  queryOptions({
    queryKey: customLayoutKeys.one(id),
    queryFn: ({ signal }) => getSignageCustomLayout(id, { signal }),
  });
