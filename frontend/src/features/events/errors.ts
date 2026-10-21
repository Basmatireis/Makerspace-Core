import { ApiError } from '../../api/http-client';

// Sentences for the API's stable error codes, so a rejected change says what to do instead of a generic failure.
const MESSAGES: Record<string, string> = {
  stale_write: 'This event changed in another session. Reload it before saving again.',
  event_read_only: 'This event is completed or cancelled. Only tasks and files can still be changed.',
  invalid_event_transition: 'The event is not in a state that allows this change. Reload it and try again.',
  signup_not_open: 'Signup for this place is not open.',
  signup_closed: 'Signup for this place has closed.',
  already_assigned: 'You already have a place in this shift.',
  person_not_eligible: 'You do not have the role this position needs.',
  requirement_full: 'This position was just filled by someone else.',
  assignment_conflict: 'This overlaps with another shift you have.',
  shift_ended: 'This shift has already ended, so the place can no longer be given up.',
  requirement_has_assignments:
    'A position that has had helpers cannot be removed. Reduce its places or cancel the shift.',
  requirement_below_assignments: 'A position cannot have fewer places than helpers already assigned to it.',
  event_not_deletable: 'Only a draft event can be deleted.',
  event_has_assignment_history: 'This draft has assignment history and cannot be deleted. Cancel it instead.',
};

export function errorCode(error: unknown): string | undefined {
  return error instanceof ApiError ? error.data?.code : undefined;
}

export function eventMutationMessage(error: unknown): string {
  const code = errorCode(error);
  if (code && MESSAGES[code]) return MESSAGES[code];
  if (error instanceof Error && error.message) return error.message;
  return 'The request was rejected. Review the values and try again.';
}

/** Staff placing a helper may override an overlap; the dialogs offer it only after the server reported one. */
export const isConflict = (error: unknown) => errorCode(error) === 'assignment_conflict';
