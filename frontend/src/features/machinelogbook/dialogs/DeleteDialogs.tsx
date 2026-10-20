import { useState, type ReactNode } from 'react';
import {
  Button,
  Checkbox,
  InlineNotification,
  Link as CarbonLink,
  Modal,
  RadioButton,
  RadioButtonGroup,
  Stack,
} from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { deleteMachineJob } from '../../../api/generated/machine-jobs/machine-jobs';
import { deleteMachineRun } from '../../../api/generated/machine-runs/machine-runs';
import type { MachineJob, MachineJobUsage, MachineRun } from '../../../api/generated/models';
import { ApiError } from '../../../api/http-client';
import { jobOrderQuery, saveError } from './jobFormHelpers';
import { machineLogbookKeys, runQuery } from '../queries';
import { formatQuantity } from '../shared/format';
import { machineLogbookPaths } from '../shared/paths';
import { activeRuns, isRunLive } from '../shared/status';
import { useNotify } from '../shared/toasts';
import { useCan } from '../shared/useCan';
import { useNow } from '../shared/useNow';

type Can = ReturnType<typeof useCan>;

/** UX gate only: manual runs may be deleted by job editors or deleters, connector-recorded runs only by deleters. */
const canDeleteRun = (can: Can, run: Pick<MachineRun, 'source'>) =>
  can('machine_jobs.delete') || (run.source === 'manual' && can('machine_jobs.edit'));

const errorCode = (error: unknown) => (error instanceof ApiError ? error.data?.code : undefined);

/** Usages whose material left stock (own material, positive quantity); customer material never touched the ledger. */
const bookedUsages = (usages: MachineJobUsage[]) =>
  usages.filter((usage) => usage.ownership !== 'external' && Number(usage.quantity) > 0);

/** "183 g back to SP-0001, 20 g back to stock" */
function reversalSummary(usages: MachineJobUsage[]) {
  const totals = new Map<string, { quantity: number; unit: string; target: string }>();
  for (const usage of bookedUsages(usages)) {
    const target = usage.spoolDisplayId ?? 'stock';
    const key = `${target}|${usage.unit}`;
    const entry = totals.get(key) ?? { quantity: 0, unit: usage.unit, target };
    entry.quantity += Number(usage.quantity);
    totals.set(key, entry);
  }
  return [...totals.values()]
    .map(
      (entry) =>
        `${formatQuantity(entry.quantity)} ${entry.unit} back to ${entry.target === 'stock' ? 'stock' : entry.target}`,
    )
    .join(', ');
}

type Choice = 'reverse' | 'keep' | '';

type ShellProps = {
  heading: string;
  confirmLabel: string;
  usages: MachineJobUsage[];
  pending: boolean;
  error?: string;
  /** Other reasons the delete must not be confirmed. */
  blocked?: boolean;
  onClose: () => void;
  onConfirm: (reverseConsumption: boolean) => void;
  children: ReactNode;
};

/** Danger dialog with the explicit material choice. Mount it only while open so the choice starts empty every time. */
function DeleteShell({
  heading,
  confirmLabel,
  usages,
  pending,
  error,
  blocked = false,
  onClose,
  onConfirm,
  children,
}: ShellProps) {
  const [choice, setChoice] = useState<Choice>('');
  const asksChoice = bookedUsages(usages).length > 0;
  const ready = !blocked && (!asksChoice || choice !== '');
  return (
    <Modal
      open
      danger
      alert
      modalHeading={heading}
      primaryButtonText={pending ? `${confirmLabel}…` : confirmLabel}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={!ready || pending}
      preventCloseOnClickOutside
      selectorPrimaryFocus=".cds--btn--secondary"
      shouldSubmitOnEnter={false}
      onRequestClose={() => {
        if (!pending) onClose();
      }}
      onSecondarySubmit={() => {
        if (!pending) onClose();
      }}
      onRequestSubmit={() => {
        if (ready && !pending) onConfirm(choice === 'reverse');
      }}
    >
      <Stack gap={5}>
        {children}
        {asksChoice && (
          <RadioButtonGroup
            legendText="Material consumption"
            name="delete-consumption"
            orientation="vertical"
            onChange={(value) => setChoice(value as Choice)}
          >
            <RadioButton
              id="delete-consumption-reverse"
              value="reverse"
              labelText={`Reverse consumption (${reversalSummary(usages)})`}
            />
            <RadioButton id="delete-consumption-keep" value="keep" labelText="Keep consumption" />
          </RadioButtonGroup>
        )}
        {error && (
          <InlineNotification kind="error" lowContrast hideCloseButton title="Delete failed" subtitle={error} />
        )}
      </Stack>
    </Modal>
  );
}

const invalidateAll = (client: ReturnType<typeof useQueryClient>) =>
  client.invalidateQueries({ queryKey: machineLogbookKeys.all });

type JobProps = { job: MachineJob; open: boolean; onClose: () => void };

/** Deletes a job; its recorded runs are deleted too (default) or become unassigned runs. */
export function DeleteJobModal({ job, open, onClose }: JobProps) {
  if (!open) return null;
  return <DeleteJobDialog job={job} onClose={onClose} />;
}

function DeleteJobDialog({ job, onClose }: Omit<JobProps, 'open'>) {
  const can = useCan();
  const client = useQueryClient();
  const notify = useNotify();
  const navigate = useNavigate();
  const [deleteRecorded, setDeleteRecorded] = useState(true);
  const association = useQuery({ ...jobOrderQuery(job.id), enabled: can('orders.read') });
  const runs = activeRuns(job);
  const recorded = runs.filter((run) => run.source === 'recorded');
  const deleting = recorded.length > 0 && deleteRecorded ? runs : runs.filter((run) => run.source === 'manual');
  const orderId = association.data?.orderId ?? null;

  const remove = useMutation({
    mutationFn: (reverseConsumption: boolean) =>
      deleteMachineJob(job.id, {
        expectedVersion: job.version,
        reverseConsumption,
        deleteRecordedRuns: recorded.length > 0 && deleteRecorded,
      }),
    onSuccess: async () => {
      await invalidateAll(client);
      notify({ kind: 'success', title: 'Job deleted', subtitle: `${job.displayId} was deleted.` });
      onClose();
      navigate(machineLogbookPaths.jobs());
    },
  });
  const serverOnOrder = errorCode(remove.error) === 'job_on_order';
  const onOrder = orderId !== null || serverOnOrder;

  return (
    <DeleteShell
      heading="Delete this job?"
      confirmLabel="Delete job"
      usages={deleting.flatMap((run) => run.usages)}
      pending={remove.isPending}
      blocked={onOrder}
      onClose={onClose}
      error={
        remove.isError && !serverOnOrder
          ? saveError(remove.error, 'The job could not be deleted. Reload the page and try again.').message
          : undefined
      }
      onConfirm={(reverse) => remove.mutate(reverse)}
    >
      <p>
        {job.displayId} and its manual runs are deleted. Deleted jobs disappear from lists, statistics and machine
        figures; the job number is never reused.
      </p>
      {onOrder && (
        <>
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="This job is on an order"
            subtitle="Remove it from the order first, then delete the job."
          />
          {orderId && (
            <p>
              <CarbonLink as={Link} to={`/orders/${orderId}`}>
                Open order {association.data?.orderReference}
              </CarbonLink>
            </p>
          )}
        </>
      )}
      {recorded.length > 0 && (
        <Checkbox
          id="delete-recorded-runs"
          labelText={`Also delete recorded runs (${recorded.map((run) => run.displayId).join(', ')})`}
          checked={deleteRecorded}
          helperText={deleteRecorded ? undefined : 'Recorded runs stay as unassigned runs.'}
          onChange={(_event, { checked }) => setDeleteRecorded(checked)}
        />
      )}
    </DeleteShell>
  );
}

type RunProps = {
  open: boolean;
  onClose: () => void;
  /** Run already loaded by the page; otherwise it is fetched by `runId`. */
  run?: MachineRun;
  runId: string;
  /** The job the run belongs to, when the page has it; used to recognise the last run early. */
  job?: MachineJob;
  /** Offered as "Delete job instead" when this is the last run of its job. */
  onDeleteJob?: () => void;
  /** Called after the run was deleted (for example to leave its page). */
  onDeleted?: () => void;
};

/** Deletes one run, manual or recorded, asking whether its material consumption is reversed. */
export function DeleteRunModal({ open, ...props }: RunProps) {
  if (!open) return null;
  return <DeleteRunDialog {...props} />;
}

function DeleteRunDialog({ run: loaded, runId, job, onClose, onDeleteJob, onDeleted }: Omit<RunProps, 'open'>) {
  const can = useCan();
  const client = useQueryClient();
  const notify = useNotify();
  const now = useNow();
  const fetched = useQuery({ ...runQuery(runId), enabled: !loaded });
  const run: MachineRun | undefined = loaded ?? fetched.data;
  const remove = useMutation({
    mutationFn: (reverseConsumption: boolean) =>
      deleteMachineRun(runId, { expectedVersion: run!.version, reverseConsumption }),
    onSuccess: async () => {
      await invalidateAll(client);
      notify({ kind: 'success', title: 'Run deleted', subtitle: `${run?.displayId ?? 'The run'} was deleted.` });
      onClose();
      onDeleted?.();
    },
  });
  const lastRun =
    errorCode(remove.error) === 'last_run' ||
    (job !== undefined && activeRuns(job).length === 1 && activeRuns(job)[0].id === runId);
  const live = run !== undefined && run.source === 'recorded' && isRunLive(run, now);

  if (!run) {
    return (
      <Modal
        open
        danger
        alert
        modalHeading="Delete this run?"
        primaryButtonText="Delete run"
        secondaryButtonText="Cancel"
        primaryButtonDisabled
        onRequestClose={onClose}
        onSecondarySubmit={onClose}
      >
        {fetched.isError ? (
          <InlineNotification kind="error" lowContrast hideCloseButton title="The run could not be loaded" />
        ) : (
          <p>Loading the run…</p>
        )}
      </Modal>
    );
  }

  return (
    <DeleteShell
      heading="Delete this run?"
      confirmLabel="Delete run"
      usages={lastRun ? [] : run.usages}
      pending={remove.isPending}
      blocked={lastRun || !canDeleteRun(can, run)}
      onClose={onClose}
      error={
        remove.isError && errorCode(remove.error) !== 'last_run'
          ? saveError(remove.error, 'The run could not be deleted. Reload the page and try again.').message
          : undefined
      }
      onConfirm={(reverse) => remove.mutate(reverse)}
    >
      <p>
        {run.displayId} is deleted. It disappears from lists, statistics and machine figures; the run number is never
        reused.
      </p>
      {live && (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title="This run is still running"
          subtitle="Further printer reports for this run are ignored after it is deleted."
        />
      )}
      {run.source === 'recorded' && !live && (
        <p className="mj-secondary">Further printer reports for a deleted run are ignored.</p>
      )}
      {lastRun && (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title="This is the last run of its job"
          subtitle="A job always keeps at least one run."
        />
      )}
      {lastRun && onDeleteJob && can('machine_jobs.delete') && (
        <div>
          <Button kind="tertiary" size="sm" onClick={onDeleteJob}>
            Delete job instead
          </Button>
        </div>
      )}
    </DeleteShell>
  );
}
