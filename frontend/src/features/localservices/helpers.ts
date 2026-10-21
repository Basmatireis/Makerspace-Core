import type { StreamingGateway } from '../../api/generated/models';
import { ApiError } from '../../api/http-client';
import { formatDateTime } from '../../app/dateTime';

/** The status view treats heartbeats older than this as missing (docs/signage.md, heartbeat). */
const ONLINE_MS = 90_000;

export type TagType = 'green' | 'red' | 'gray' | 'blue' | 'magenta';

export function gatewayStatus(gateway: StreamingGateway, now: number): { label: string; type: TagType } {
  if (gateway.lifecycle === 'revoked') return { label: 'Revoked', type: 'gray' };
  if (gateway.lifecycle === 'disabled') return { label: 'Disabled', type: 'gray' };
  if (gateway.lifecycle === 'pending') return { label: 'Awaiting enrollment', type: 'blue' };
  if (!gateway.lastHeartbeatAt || now - Date.parse(gateway.lastHeartbeatAt) > ONLINE_MS)
    return { label: 'Offline', type: 'red' };
  return gateway.healthState === 'degraded'
    ? { label: 'Degraded', type: 'magenta' }
    : { label: 'Online', type: 'green' };
}

export const dateOrDash = (value: string | null | undefined) => (value ? formatDateTime(value) : '—');

export const errorText = (error: unknown, fallback = 'The request failed. Try again.') =>
  error instanceof Error && error.message ? error.message : fallback;

const codeOf = (error: unknown) =>
  error instanceof ApiError ? (error.data as { code?: string } | undefined)?.code : undefined;
export const isStale = (error: unknown) =>
  error instanceof ApiError && error.status === 409 && codeOf(error) === 'stale_write';

/** Explains why a camera could not be assigned, from the API's validation and conflict errors. */
export function cameraAssignError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 422)
      return `${error.message} Only printers with an active Bambu H2D or X1 Carbon assignment can stream. Assign the printer to a connector under Printer connectors first.`;
    if (error.status === 409 && codeOf(error) === 'streaming_camera_exists')
      return 'This machine already has a camera on a streaming gateway. Remove that camera first.';
    if (error.status === 409 && codeOf(error) === 'streaming_gateway_revoked')
      return 'This gateway is revoked and cannot receive cameras.';
  }
  return errorText(error);
}

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
