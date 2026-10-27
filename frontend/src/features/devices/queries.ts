import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { listManagedDevices } from '../../api/generated/managed-devices/managed-devices';
import { keys } from './components/deviceShared';

/**
 * Every managed device. Tables search, filter and sort in the browser and the fleet is small, so the remaining pages
 * are fetched as soon as one arrives.
 */
export function useAllManagedDevices(enabled = true) {
  const query = useInfiniteQuery({
    queryKey: keys.devices,
    queryFn: ({ signal, pageParam }) => listManagedDevices({ limit: 50, cursor: pageParam }, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled,
  });
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  return { query, devices: query.data?.pages.flatMap((page) => page.items) };
}
