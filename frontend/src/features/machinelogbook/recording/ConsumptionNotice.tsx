import {
  Button,
  InlineLoading,
  InlineNotification,
  Tag,
  Toggletip,
  ToggletipButton,
  ToggletipContent,
} from '@carbon/react';
import { Calculator, Renew, WarningAltFilled } from '@carbon/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  requestMachineRunArtifactRefetch,
  requestMachineRunConsumptionRecompute,
} from '../../../api/generated/machine-runs/machine-runs';
import type {
  MachineRunCommand,
  MachineRunCommandKind,
  MachineRunConsumptionStatus,
  MachineRunRecording,
} from '../../../api/generated/models';
import { machineLogbookKeys } from '../queries';
import {
  commandErrorMessage,
  commandKindLabel,
  commandStateLabel,
  consumptionNotice,
  isCommandOpen,
  latestCommand,
} from './recordingText';
import './recording.scss';

const kinds: MachineRunCommandKind[] = ['refetch_artifact', 'recompute_consumption'];
const stateTag = { requested: 'gray', running: 'blue', succeeded: 'green', failed: 'red' } as const;

function CommandLine({ command }: { command: MachineRunCommand }) {
  return (
    <p className="mj-inline">
      <Tag size="sm" type={stateTag[command.state]}>
        {commandStateLabel(command)}
      </Tag>
      <span className="mj-secondary">{commandKindLabel(command.kind)}</span>
    </p>
  );
}

/**
 * Why a recorded run has missing, partial or pending consumption, with the two connector commands that can fix it.
 * The notification itself has no interactive children (Carbon throws on them); the buttons sit below it.
 */
export function ConsumptionNotice({
  runId,
  status,
  recording,
  canEdit,
  ended,
}: {
  runId: string;
  status: MachineRunConsumptionStatus | null | undefined;
  recording: MachineRunRecording | undefined;
  /** machine_jobs.edit: the backend decides; this only hides the buttons. */
  canEdit: boolean;
  ended: boolean;
}) {
  const client = useQueryClient();
  const request = useMutation({
    mutationFn: (kind: MachineRunCommandKind) =>
      kind === 'refetch_artifact'
        ? requestMachineRunArtifactRefetch(runId)
        : requestMachineRunConsumptionRecompute(runId),
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: machineLogbookKeys.recording(runId) }),
        client.invalidateQueries({ queryKey: machineLogbookKeys.run(runId) }),
      ]),
  });
  const notice = consumptionNotice(status);
  const commands = recording?.commands ?? [];
  const latest = kinds.flatMap((kind) => latestCommand(commands, kind) ?? []);
  if (!notice && latest.length === 0) return null;

  const open = commands.some(isCommandOpen);
  const canAct = canEdit && ended && status?.reason !== 'run_in_progress' && recording !== undefined;
  const missingFile = recording !== undefined && recording.artifact === null;

  return (
    <div className="mj-stack">
      {notice && (
        <InlineNotification
          kind={notice.kind}
          lowContrast
          hideCloseButton
          title={notice.title}
          subtitle={notice.detail ? `${notice.message} Detail: ${notice.detail}` : notice.message}
        />
      )}
      {canAct && (
        <div className="recording-actions">
          <Button
            kind="tertiary"
            size="sm"
            renderIcon={Renew}
            disabled={open || request.isPending}
            onClick={() => request.mutate('refetch_artifact')}
          >
            Fetch print file again
          </Button>
          <Button
            kind="tertiary"
            size="sm"
            renderIcon={Calculator}
            disabled={open || request.isPending || missingFile}
            onClick={() => request.mutate('recompute_consumption')}
          >
            Recalculate consumption
          </Button>
          {(open || request.isPending) && <InlineLoading description="Waiting for the connector" />}
        </div>
      )}
      {canAct && missingFile && (
        <p className="mj-secondary">Core has no print file for this run yet, so consumption cannot be recalculated.</p>
      )}
      {latest.map((command) => (
        <CommandLine key={command.id} command={command} />
      ))}
      {request.isError && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Request not sent"
          subtitle={commandErrorMessage(request.error)}
        />
      )}
    </div>
  );
}

/** A warning icon with the reason in a toggletip, for run lists; nothing when the consumption is recorded. */
export function ConsumptionHint({ status }: { status: MachineRunConsumptionStatus | null | undefined }) {
  const notice = consumptionNotice(status);
  if (!notice) return null;
  return (
    <span className="recording-hint">
      <Toggletip align="bottom-start">
        <ToggletipButton label={`${notice.title}: why?`}>
          <WarningAltFilled />
        </ToggletipButton>
        <ToggletipContent>
          <p>
            <strong>{notice.title}.</strong> {notice.message}
          </p>
          {notice.detail && <p className="mj-secondary">Detail: {notice.detail}</p>}
        </ToggletipContent>
      </Toggletip>
    </span>
  );
}
