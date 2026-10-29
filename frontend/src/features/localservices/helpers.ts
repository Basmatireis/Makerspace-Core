import { formatDateTime } from '../../app/dateTime';

export const dateOrDash = (value: string | null | undefined) => (value ? formatDateTime(value) : '—');

export const errorText = (error: unknown, fallback = 'The request failed. Try again.') =>
  error instanceof Error && error.message ? error.message : fallback;

const releasePattern = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

/** Whether version is a release such as 0.8.3 (development builds report "dev"). */
export const isRelease = (version: string | null | undefined): version is string =>
  Boolean(version && releasePattern.test(version));

/** Whether candidate is a newer release than current. The server enforces the same rule. */
export function isNewerRelease(candidate: string | null | undefined, current: string | null | undefined): boolean {
  if (!isRelease(candidate) || !isRelease(current)) return false;
  const a = candidate.split('.').map(Number);
  const b = current.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }
  return false;
}
