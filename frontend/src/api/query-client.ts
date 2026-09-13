import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './http-client';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 0,
      gcTime: 5 * 60 * 1000,
      refetchOnWindowFocus: true,
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status < 500) {
          return false;
        }
        return failureCount < 1;
      },
    },
    mutations: {
      retry: false,
    },
  },
});

export function clearPrivateQueryData(): void {
  void queryClient.cancelQueries();
  queryClient.clear();
}
