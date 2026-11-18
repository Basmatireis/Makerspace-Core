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

export const TASK_CHANGED = 'This was changed by someone else.';

/** The message for a failed action: a state conflict (409 `working_group_task_state`) has its own wording. */
export function taskErrorText(error: unknown, fallback: string): string {
  return apiErrorCode(error) === 'working_group_task_state' ? TASK_CHANGED : fallback;
}

/** The inline message for a failed save: a stale write has its own wording. */
export function saveErrorText(error: unknown): string | null {
  if (!error) return null;
  if (apiErrorCode(error) === 'stale_write') {
    return 'Someone else changed this just now. The latest version is shown; try again.';
  }
  return taskErrorText(error, 'Not saved. Check your connection and try again.');
}
