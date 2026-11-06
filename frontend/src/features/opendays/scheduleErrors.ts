import { ApiError } from '../../api/http-client';

/** A readable message for a failed schedule save. */
export function scheduleErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const details = error.data?.details;
    if (typeof details === 'object' && details !== null && 'reason' in details && typeof details.reason === 'string')
      return details.reason;
    if (error.status === 409) return 'The schedule changed since you opened it. Discard your changes and try again.';
  }
  return error instanceof Error ? error.message : 'Review the dates and times and try again.';
}
