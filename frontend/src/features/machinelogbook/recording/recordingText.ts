import type {
  MachineRunCommand,
  MachineRunCommandKind,
  MachineRunConsumptionReason,
  MachineRunConsumptionStatus,
  MachineRunPreview,
  MachineRunTimelapseStatus,
} from '../../../api/generated/models';
import { ApiError } from '../../../api/http-client';
import { formatQuantity } from '../shared/format';

/** One sentence per reason code the backend derives; the codes are a closed set of the API contract. */
const consumptionReasonText: Record<MachineRunConsumptionReason, string> = {
  artifact_not_found_on_printer:
    'The printer no longer had the print file, so Core could not read the planned filament weights.',
  artifact_retrieval_failed: 'The connector could not fetch the print file from the printer.',
  artifact_upload_failed: 'The connector fetched the print file but could not hand it over to Core.',
  artifact_rejected: 'Core rejected the print file because it is not a valid 3MF.',
  no_slicer_weights_in_artifact: 'The print file does not contain filament weights from the slicer.',
  gcode_estimate_unavailable: 'The weights could not be estimated from the G-code in the print file.',
  cancelled_before_first_layer: 'The print was cancelled before the first layer, so no filament was used.',
  outcome_unknown: 'The machine did not report how the print ended, so the consumption cannot be settled.',
  slot_without_spool_assignment: 'The filament slot used for this print has no spool assigned in Core.',
  no_spool_mapping: 'The reported filament could not be mapped to a spool of the inventory.',
  connector_offline_during_run: 'The connector was offline while the print ran and missed the consumption data.',
  inventory_not_booked: 'The consumption is known, but it has not been booked from the inventory yet.',
  consumption_pending: 'The machine has not sent the final consumption report yet.',
  run_in_progress: 'The run is still in progress. Consumption is recorded when it ends.',
  consumption_not_reported: 'The machine did not report any consumption for this run.',
};

const consumptionTitle: Record<MachineRunConsumptionStatus['state'], string> = {
  recorded: 'Material recorded',
  partial: 'Material only partly recorded',
  missing: 'Material not recorded',
  pending: 'Material pending',
};

/** Human-readable message for a reason code; unknown codes (newer backend) fall back to a generic line. */
export function consumptionReasonMessage(reason: string | null | undefined): string {
  if (!reason) return 'The reason is not known.';
  return (consumptionReasonText as Record<string, string>)[reason] ?? 'The reason is not known.';
}

/** Notice for a run whose consumption is not (fully) recorded; null when there is nothing to explain. */
export function consumptionNotice(status: MachineRunConsumptionStatus | null | undefined) {
  if (!status || status.state === 'recorded') return null;
  return {
    kind: status.state === 'pending' ? ('info' as const) : ('warning' as const),
    title: consumptionTitle[status.state],
    message: consumptionReasonMessage(status.reason),
    detail: status.detail,
  };
}

const commandKindText: Record<MachineRunCommandKind, string> = {
  refetch_artifact: 'Fetching the print file again',
  recompute_consumption: 'Recalculating consumption',
};

export const commandKindLabel = (kind: MachineRunCommandKind) => commandKindText[kind];

export const isCommandOpen = (command: MachineRunCommand) =>
  command.state === 'requested' || command.state === 'running';

/** The newest command of one kind, if any. */
export function latestCommand(commands: MachineRunCommand[], kind: MachineRunCommandKind) {
  return commands
    .filter((command) => command.kind === kind)
    .sort((a, b) => new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime())[0];
}

const commandStateText: Record<MachineRunCommand['state'], string> = {
  requested: 'Requested, waiting for the connector',
  running: 'Running',
  succeeded: 'Done',
  failed: 'Failed',
};

export function commandStateLabel(command: MachineRunCommand) {
  const base = commandStateText[command.state];
  return command.state === 'failed' && command.reasonCode ? `${base} (${command.reasonCode.replace(/_/g, ' ')})` : base;
}

const commandErrorText: Record<string, string> = {
  run_command_rate_limited:
    'Too many requests for this run. At most five commands are accepted per run and hour; try again later.',
  run_not_recorded: 'Only recorded runs can be fetched or recalculated.',
  run_running: 'The run is still running. Try again when it has ended.',
  run_connector_unavailable: 'The connector of this run is no longer assigned or active.',
  connector_commands_unavailable: 'The connector is too old to take commands. Update it first.',
  run_artifact_missing: 'Core has no print file for this run. Fetch the print file again first.',
};

/** Message for a failed command request, including the rate limit (429). */
export function commandErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const code = error.data?.code;
    if (code && commandErrorText[code]) return commandErrorText[code];
    if (error.status === 429) return commandErrorText.run_command_rate_limited;
  }
  return 'The request could not be sent. Reload the page and try again.';
}

/** Label of a preview in the viewer: "Plate 2", "Model" or "Preview". */
export function previewLabel(preview: Pick<MachineRunPreview, 'role' | 'plateNumber'>) {
  if (preview.role === 'plate') return preview.plateNumber != null ? `Plate ${preview.plateNumber}` : 'Plate';
  return preview.role === 'model' ? 'Model' : 'Preview';
}

const timelapseReasonText: Record<string, string> = {
  timelapse_not_recorded: 'The printer has no timelapse video for this print.',
  timelapse_ambiguous: 'Several videos on the printer could belong to this print, so none was taken.',
  timelapse_baseline_missing:
    'The connector did not know which videos existed before the print started, so it could not tell which one is new.',
  timelapse_too_large: 'The video is larger than the configured limit and was not stored.',
  timelapse_retrieval_failed: 'The connector could not fetch the video from the printer.',
  timelapse_upload_failed: 'The connector could not hand the video over to Core.',
  timelapse_disabled: 'Timelapse collection is switched off.',
  timelapse_unsupported_adapter: 'This kind of printer does not provide timelapses to Core.',
};

export type TimelapseMessage = { title: string; message: string };

/** What to say when a run has no playable timelapse; null while a video is available. */
export function timelapseMessage(status: MachineRunTimelapseStatus | null | undefined): TimelapseMessage | null {
  if (!status) return { title: 'No timelapse', message: 'No timelapse was recorded for this run.' };
  const reason = status.reason ? (timelapseReasonText[status.reason] ?? null) : null;
  switch (status.state) {
    case 'available':
      return null;
    case 'pending':
      return { title: 'Timelapse pending', message: 'The connector is still collecting the video from the printer.' };
    case 'not_found':
      return { title: 'No timelapse found', message: reason ?? timelapseReasonText.timelapse_not_recorded };
    case 'failed':
      return { title: 'Timelapse failed', message: reason ?? 'The timelapse could not be collected.' };
    case 'skipped':
      return {
        title: 'Timelapse skipped',
        message: reason ?? 'The timelapse was skipped.',
      };
    case 'expired':
      return { title: 'Timelapse expired', message: 'The video was removed after its retention period.' };
  }
}

export const formatFileSize = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${formatQuantity(bytes / (1024 * 1024), 1)} MB` : `${formatQuantity(bytes / 1024, 0)} kB`;
