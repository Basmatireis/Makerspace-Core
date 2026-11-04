import { queryOptions, type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listMyGuideProgress, resetMyGuideProgress, updateMyGuideProgress } from '../../api/generated/guides/guides';
import type { GuideProgressStatus } from '../../api/generated/models';

export const guideProgressKey = ['guides', 'progress'] as const;

export const guideProgressOptions = () =>
  queryOptions({
    queryKey: guideProgressKey,
    queryFn: ({ signal }) => listMyGuideProgress({ signal }),
  });

export function useGuideProgress(enabled = true) {
  return useQuery({ ...guideProgressOptions(), enabled });
}

export function useUpdateGuideProgress() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ guideId, status }: { guideId: string; status: GuideProgressStatus }) =>
      updateMyGuideProgress(guideId, { status }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: guideProgressKey }),
  });
}

export function useResetGuideProgress() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => resetMyGuideProgress(),
    onSettled: () => queryClient.invalidateQueries({ queryKey: guideProgressKey }),
  });
}

/** Records a result without a component around it: a tour can finish after the hook that started it has unmounted. */
export async function recordGuideProgress(
  queryClient: QueryClient,
  guideId: string,
  status: GuideProgressStatus,
): Promise<void> {
  try {
    await updateMyGuideProgress(guideId, { status });
  } finally {
    await queryClient.invalidateQueries({ queryKey: guideProgressKey });
  }
}
