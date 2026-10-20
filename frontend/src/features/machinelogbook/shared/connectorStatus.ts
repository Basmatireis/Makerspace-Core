import type { PrinterConnector } from '../../../api/generated/models';

export type ConnectorStatus = {
  label: 'Connected' | 'Disconnected' | 'Degraded' | 'Disabled' | 'Never connected' | 'Pending' | 'Revoked';
  type: 'green' | 'red' | 'warm-gray' | 'purple' | 'blue';
};

/** A heartbeat older than this reads as disconnected. */
export const HEARTBEAT_STALE_MS = 90_000;

export function connectorStatus(connector: PrinterConnector, now = Date.now()): ConnectorStatus {
  if (connector.lifecycle === 'revoked') return { label: 'Revoked', type: 'red' };
  if (connector.lifecycle === 'disabled') return { label: 'Disabled', type: 'warm-gray' };
  if (connector.lifecycle === 'pending') return { label: 'Pending', type: 'blue' };
  if (!connector.lastHeartbeatAt) return { label: 'Never connected', type: 'warm-gray' };
  if (now - new Date(connector.lastHeartbeatAt).getTime() > HEARTBEAT_STALE_MS)
    return { label: 'Disconnected', type: 'red' };
  return connector.healthState === 'degraded'
    ? { label: 'Degraded', type: 'purple' }
    : { label: 'Connected', type: 'green' };
}

/** "5 s ago" style age that stays precise below one minute (status snapshots and heartbeats move quickly). */
export function ageSeconds(iso: string, now = Date.now()) {
  return Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
}
