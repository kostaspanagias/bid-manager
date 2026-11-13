import { QueryClient } from '@tanstack/react-query';
import { isApiError } from '@/api/client';

/**
 * Defaults for a small internal tool: data is fresh for 30 s, refetches when the tab regains focus,
 * client errors (4xx) are never retried, server/network errors twice.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 10 * 60_000,
        refetchOnWindowFocus: true,
        retry: (failureCount, error) => {
          if (isApiError(error) && error.status >= 400 && error.status < 500) return false;
          return failureCount < 2;
        },
      },
      mutations: { retry: false },
    },
  });
}
