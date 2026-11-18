import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiErrorCode } from '../../api/http-client';
import { workingGroupKeys } from './queries';

/** A mutation of the working-group pages: whatever the outcome (also a stale write), everything is read again. */
export function useWgMutation<Variables>(run: (variables: Variables) => Promise<unknown>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSettled: () => client.invalidateQueries({ queryKey: workingGroupKeys.all }),
  });
}

/** The inline message for a failed save: a stale write has its own wording. */
export function saveErrorText(error: unknown): string | null {
  if (!error) return null;
  return apiErrorCode(error) === 'stale_write'
    ? 'Someone else changed this just now. The latest version is shown; try again.'
    : 'Not saved. Check your connection and try again.';
}
