import type {
  PrinterConnectorAssignment,
  PrinterConnectorEventKind,
  PrinterLiveStatus,
  PrinterLiveStatusState,
} from '../../../../api/generated/models';
import { ageSeconds } from '../../shared/connectorStatus';
import { connectorDiagnostic } from '../../shared/connectorHelpers';
import { formatRelative } from '../../shared/format';

export const STALE_AFTER_SECONDS = 300;

export const LIVE_REFRESH_MS = 5000;

export const eventLabels: Record<PrinterConnectorEventKind, string> = {
  identity: 'Identity',
  connectivity: 'Connection',
  operational_state: 'State change',
  progress: 'Progress',
  slot_observation: 'Slot observation',
  consumption_report: 'Material consumption',
  terminal_outcome: 'Print outcome',
  printer_error: 'Printer warning',
  filament_change: 'Filament change',
};

/** Why Core kept an event for review instead of applying it. */
const reviewReasons: Record<string, string> = {
  stale_assignment: 'The assignment had ended or the connector was disabled when the event arrived.',
  configuration_version_mismatch: 'The event was recorded under an older configuration of the assignment.',
  incomplete_run_history: 'The connector joined the print after it started, so the run history is incomplete.',
};

export const reviewReason = (reason: string | null) =>
  reason ? (reviewReasons[reason] ?? `Needs review (${reason})`) : null;

export const stateLabels = { recorded: 'Recorded', applied: 'Applied', review_required: 'Needs review' } as const;

export const runtimeLabels = {
  connecting: 'Connecting',
  connected: 'Connected',
  disconnected: 'Disconnected',
  degraded: 'Degraded',
  disabled: 'Disabled',
} as const;

export const runtimeTypes = {
  connecting: 'blue',
  connected: 'green',
  disconnected: 'red',
  degraded: 'purple',
  disabled: 'gray',
} as const;

export const runStateMeta: Record<
  PrinterLiveStatusState,
  { label: string; type: 'green' | 'blue' | 'purple' | 'gray' | 'cyan' | 'red' }
> = {
  idle: { label: 'Idle', type: 'gray' },
  preparing: { label: 'Preparing', type: 'blue' },
  printing: { label: 'Printing', type: 'green' },
  paused: { label: 'Paused', type: 'purple' },
  finished: { label: 'Finished', type: 'cyan' },
  failed: { label: 'Failed', type: 'red' },
  unknown: { label: 'Unknown', type: 'gray' },
};

export function relativeAge(iso: string) {
  const seconds = ageSeconds(iso);
  return seconds < 60 ? `${seconds} s ago` : formatRelative(iso);
}

export function durationText(seconds: number) {
  return seconds < 60
    ? `${seconds} s`
    : seconds < 3600
      ? `${Math.round(seconds / 60)} min`
      : `${Math.round(seconds / 3600)} h`;
}

export const remainingText = (minutes: number) =>
  minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;

export const temperature = (current: number | null, target: number | null) =>
  current == null ? '—' : target ? `${current} / ${target} °C` : `${current} °C`;

export type PrinterView = {
  assignment: PrinterConnectorAssignment;
  live: PrinterLiveStatus | null | undefined;
  stale: boolean;
  issue: string | null;
};

export function printerIssue(
  assignment: PrinterConnectorAssignment,
  live: PrinterLiveStatus | null | undefined,
  stale: boolean,
) {
  if (assignment.runtimeErrorCode) return connectorDiagnostic(assignment.runtimeErrorCode);
  const errors = live?.status.errors ?? [];
  if (errors.some((error) => error.sourceFamily === 'print')) return 'The printer reports a print error';
  if (errors.length > 0) return `${errors.length} printer warning${errors.length === 1 ? '' : 's'}`;
  return stale ? 'No recent status' : null;
}
