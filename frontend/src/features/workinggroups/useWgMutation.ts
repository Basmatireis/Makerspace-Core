import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiErrorCode } from '../../api/http-client';
import { workingGroupKeys } from './queries';

/** A mutation of the working-group pages: whatever the outcome (also a stale write), everything is read again. */
export function useWgMutation<Variables>(run: (variables: Variables) => Promise<unknown>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSettled: () => client.invalidateQueries({ queryKey: workingGroupKeys.all }),
  });
}

export const SIGNATURE_REQUIRED = 'Add a signature before the request goes to the WiRef.';

export const TASK_CHANGED = 'This was changed by someone else.';

const ERROR_TEXT: Record<string, string> = {
  working_group_task_state: TASK_CHANGED,
  working_group_purchase_state: 'This purchase was changed by someone else.',
  stale_write: 'Someone else changed this just now. The latest version is shown; try again.',
  purchase_needs_project: 'This purchase reaches the project limit and needs a project.',
  receipt_needs_project: 'This amount needs a project. Ask management.',
  budget_period_closed: 'The budget period is closed.',
  budget_period_missing: 'There is no open budget period today.',
  project_request_required: 'Choose a project request.',
  project_request_unknown: 'This project request does not exist any more.',
  purchase_not_orderable: 'Only approved purchases of a collective order can be ordered.',
  purchases_mixed_periods: 'Choose purchases of one period only.',
  working_group_has_finances: 'The group has purchases or budget shares and cannot be deleted.',
  project_checklist_open: 'The checklist is not complete yet.',
  signature_required: SIGNATURE_REQUIRED,
  signature_invalid: 'The signature could not be read. Draw or upload it again.',
  project_state: 'This project was changed by someone else.',
  project_has_purchases: 'This item has purchases and cannot be removed.',
  project_offers_missing: 'Choose an offer for every item that needs offers.',
  wiref_not_needed: 'This project does not need the WiRef.',
  working_group_project_request_exists: 'This project number exists already.',
};

/** The message for a failed action: known error codes (state conflicts, finance rules) have their own wording. */
export function taskErrorText(error: unknown, fallback: string): string {
  const code = apiErrorCode(error);
  return (code && ERROR_TEXT[code]) || fallback;
}

/** The inline message for a failed save: a stale write has its own wording. */
export function saveErrorText(error: unknown): string | null {
  if (!error) return null;
  if (apiErrorCode(error) === 'stale_write') {
    return 'Someone else changed this just now. The latest version is shown; try again.';
  }
  return taskErrorText(error, 'Not saved. Check your connection and try again.');
}

export const NOT_A_MEMBER = 'Only members of this working group can do this. Ask its lead to add you.';

/** The message for a failed create that only members of the group may do: a refusal (403 or 404) is no input mistake. */
export function createErrorText(error: unknown, fallback: string): string {
  const code = apiErrorCode(error);
  if (code && ERROR_TEXT[code]) return ERROR_TEXT[code];
  if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return NOT_A_MEMBER;
  return fallback;
}
