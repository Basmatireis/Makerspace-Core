import { ApiError } from '../../api/http-client';

export function eventMutationMessage(error: unknown): string {
  if (error instanceof ApiError && error.data?.code === 'stale_write') {
    return 'This event changed in another session. Reload it before saving again.';
  }
  if (error instanceof Error && error.message) return error.message;
  return 'The request was rejected. Review the values and try again.';
}
