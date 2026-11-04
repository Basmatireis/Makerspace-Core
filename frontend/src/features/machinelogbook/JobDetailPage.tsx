import { useState } from 'react';
import { RefLink } from '../../app/RefLink';
import {
  ActionableNotification,
  Button,
  DataTable,
  InlineNotification,
  Link as CarbonLink,
  OverflowMenu,
  OverflowMenuItem,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
  Tile,
} from '@carbon/react';
import { Edit } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { clearMachineJobPriceAdjustment } from '../../api/generated/machine-jobs/machine-jobs';
import { cancelMachineRun, detachMachineRun } from '../../api/generated/machine-runs/machine-runs';
import type { MachineJob, MachineRun } from '../../api/generated/models';
import { ApiError } from '../../api/http-client';
import { StackCard } from '../../app/components/CardList';
import { FactTiles } from '../../app/components/Facts';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { PageShell } from '../../app/PageShell';
import { EmptyState } from '../../app/PageState';
import { JobRunsTable, type RunAction } from './components/JobRunsTable';
import { DeleteJobModal, DeleteRunModal } from './dialogs/DeleteDialogs';
import { JobFormModal } from './dialogs/JobFormModal';
import { jobOrderQuery } from './dialogs/jobFormHelpers';
import { PriceAdjustmentModal } from './dialogs/PriceAdjustmentModal';
import { RepriceJobModal } from './dialogs/RepriceJobModal';
import { RunFormModal } from './dialogs/RunFormModal';
import { UsageFormModal } from './dialogs/UsageFormModal';
import { AddToJobModal } from './jobs/AddToJobModal';
import { AddToOrderModal } from './jobs/AddToOrderModal';
import { JobNotesModal } from './jobs/JobNotesModal';
import { jobPhase, JobPhaseTag, OutcomeStatusTag } from './jobs/jobStatus';
import { useUpdateJobFacts } from './jobs/jobsQueries';
import { MediaCard } from './jobs/MediaCard';
import { jobQuery, jobRecordingsQuery, machineLogbookKeys } from './queries';
import { jobConsumption, unitText } from './processConfig';
import { formatDateTime, formatDuration, formatMoney, formatQuantity, formatTime } from './shared/format';
import { machineLogbookPaths } from './shared/paths';
import { QueryBoundary } from './shared/QueryBoundary';
import {
  activeRuns,
  adjustmentSummary,
  FromMachineTag,
  isRunLive,
  machineJobName,
  outcomeLabel,
} from './shared/status';
import { useNotify } from './shared/toasts';
import { useCan } from './shared/useCan';
import { useNow } from './shared/useNow';
import { usageHeaders, errorText, statusNow, runsNeedingOutcome } from './jobDetail/jobDetailShared';
import { RunOutcomeRow } from './jobDetail/RunOutcomeRow';
import { PriceBillingTile } from './jobDetail/PriceBillingTile';
import './styles/jobs.scss';

type Dialog = 'edit' | 'override' | 'clear' | 'add-run' | 'delete' | 'reprice' | 'notes' | 'order' | null;

function JobDetail({ job }: { job: MachineJob }) {
  const can = useCan();
  const notify = useNotify();
  const client = useQueryClient();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [runDialog, setRunDialog] = useState<{ action: RunAction; runId: string } | null>(null);
  const now = useNow();
  const canEdit = can('machine_jobs.edit');
  const canDelete = can('machine_jobs.delete');
  const canOverride = can('machine_jobs.override_price');
  const canReadOrders = can('orders.read');
  const status = statusNow(job, now);
  const missingRules = job.pricingSnapshot?.rules.filter((rule) => rule.missing) ?? [];
  const price = job.effectivePrice == null ? null : Number(job.effectivePrice);
  const calculated = job.calculatedPrice == null ? null : Number(job.calculatedPrice);
  const runs = activeRuns(job);
  const replacedCount = job.runs.length - runs.length;
  const pendingOutcomes = status === 'needs_outcome' ? runsNeedingOutcome(job, now) : [];
  const association = useQuery({ ...jobOrderQuery(job.id), enabled: canReadOrders });
  // Previews and files of the job's recorded runs; the job page works without them if this fails.
  const recordings = useQuery(jobRecordingsQuery(job.id));
  const materialText = jobConsumption({ runs, measures: job.measures }) ?? 'None recorded';
  const refresh = () => client.invalidateQueries({ queryKey: machineLogbookKeys.all });
  const close = () => {
    setDialog(null);
    setRunDialog(null);
  };
  const targetRun = runDialog ? job.runs.find((run) => run.id === runDialog.runId) : undefined;
  const signage = useUpdateJobFacts(job);
  const toggleSignage = () =>
    signage.mutate(
      { hiddenFromSignage: !job.hiddenFromSignage },
      {
        onSuccess: (saved) =>
          notify({
            kind: 'success',
            title: saved.hiddenFromSignage ? 'Kept off signage' : 'Back on signage',
            subtitle: `${machineJobName(saved)} · stream and timelapses of all its runs`,
          }),
        onError: (cause) =>
          notify({ kind: 'error', title: 'Signage not changed', subtitle: errorText(cause, 'Reload and try again.') }),
      },
    );
  const clearAdjustment = useMutation({
    mutationFn: () => clearMachineJobPriceAdjustment(job.id, { expectedVersion: job.version }),
    onSuccess: async () => {
      await refresh();
      notify({
        kind: 'success',
        title: 'Price adjustment removed',
        subtitle: `${job.displayId} uses the calculated price again.`,
      });
      close();
    },
  });
  const cancelRun = useMutation({
    mutationFn: (run: MachineRun) => cancelMachineRun(run.id, { expectedVersion: run.version }),
    onSuccess: async (_saved, run) => {
      await refresh();
      notify({
        kind: 'success',
        title: 'Run cancelled',
        subtitle: `${run.displayId} ended now and the price of ${job.displayId} was recalculated.`,
      });
      close();
    },
  });
  const detachRun = useMutation({
    mutationFn: (run: MachineRun) => detachMachineRun(run.id, { expectedJobVersion: job.version }),
    onSuccess: async (_saved, run) => {
      await refresh();
      notify({ kind: 'success', title: 'Run detached', subtitle: `${run.displayId} is an unassigned run again.` });
      close();
    },
  });
  const resetMutations = () => {
    clearAdjustment.reset();
    cancelRun.reset();
    detachRun.reset();
  };
  const open = (next: NonNullable<Dialog>) => {
    resetMutations();
    setDialog(next);
  };
  const openRun = (action: RunAction, run: MachineRun) => {
    resetMutations();
    setRunDialog({ action, runId: run.id });
  };

  const menuItems = [
    canOverride && job.priceAdjustment && (
      <OverflowMenuItem key="clear" itemText="Remove price adjustment" onClick={() => open('clear')} />
    ),
    canDelete && (
      <OverflowMenuItem key="delete" itemText="Delete job" isDelete hasDivider onClick={() => open('delete')} />
    ),
  ].filter(Boolean);

  const usageRows = runs.flatMap((run) =>
    run.usages.map((usage) => ({
      id: `${run.id}-${usage.id}`,
      run,
      usage,
      material: usage.ownership === 'external' ? usage.label || usage.materialName : usage.materialName,
      source:
        usage.ownership === 'external'
          ? 'Recipient’s own (not charged)'
          : usage.spoolDisplayId
            ? `Spool ${usage.spoolDisplayId}${usage.spoolId ? '' : ' (deleted)'}`
            : 'Makerspace stock',
      quantity: `${formatQuantity(usage.quantity)} ${unitText(usage.unit)}`,
    })),
  );
  const name = machineJobName(job);
  const adjustmentDifference = price != null && calculated != null ? price - calculated : null;
  const running = status === 'running';
  const finished = status !== 'planned' && status !== 'running';
  const live = runs.find((run) => isRunLive(run, now));
  const types = [...new Set(runs.flatMap((run) => run.usages.map((usage) => usage.materialTypeName)))];
  const isPrinter = job.machine.process.integration === 'fdm_printer' || runs.some((run) => run.source === 'recorded');
  const canToggleSignage = canEdit && !!job.operator;
  const attention = job.attention ?? [];
  const notYet = status === 'planned' || status === 'running';

  return (
    <PageShell
      title={name}
      titleAdornment={
        <span className="mj-inline">
          <JobPhaseTag status={status} />
          {jobPhase(status) === 'finished' && <OutcomeStatusTag status={status} />}
          {job.hiddenFromSignage && (
            <Tag type="outline" size="md">
              Off signage
            </Tag>
          )}
        </span>
      }
      width="wide"
      breadcrumbs={[
        { label: 'Workshop', to: machineLogbookPaths.home() },
        { label: 'Jobs', to: machineLogbookPaths.jobs() },
      ]}
      actions={
        <>
          {canEdit && (
            <Button kind="secondary" renderIcon={Edit} onClick={() => open('edit')}>
              Edit job
            </Button>
          )}
          {menuItems.length > 0 && (
            <OverflowMenu aria-label="More job actions" iconDescription="More job actions" flipped>
              {menuItems}
            </OverflowMenu>
          )}
        </>
      }
    >
      <div className="mj-stack">
        {attention.length > 0 && (
          <InlineNotification
            kind="warning"
            lowContrast
            hideCloseButton
            title="Needs attention"
            subtitle={`${attention.map((item) => item.message).join(' · ')}.`}
          />
        )}
        {pendingOutcomes.length > 0 &&
          (canEdit ? (
            <Tile className="mj-outcome-prompt">
              <div>
                <h2 className="mj-section-title">Record the outcome</h2>
                <p>
                  {pendingOutcomes.length === 1
                    ? 'A run of this job has ended. How did it go?'
                    : `${pendingOutcomes.length} runs of this job have ended. How did each one go?`}
                </p>
              </div>
              <div className="mj-outcome-prompt__rows">
                {pendingOutcomes.map((run) => (
                  <RunOutcomeRow key={run.id} run={run} />
                ))}
              </div>
            </Tile>
          ) : (
            <InlineNotification
              kind="info"
              lowContrast
              hideCloseButton
              title="Outcome not recorded yet"
              subtitle="A run has ended; someone with job edit access records how it went."
            />
          ))}
        {job.pricingStatus === 'incomplete' && (
          <ActionableNotification
            kind="error"
            lowContrast
            hideCloseButton
            inline
            role="status"
            title="Price incomplete"
            subtitle={`No pricing rate for ${missingRules.map((rule) => rule.label).join(', ') || 'this job'}${canOverride ? '. You can set the price manually.' : '.'}`}
            actionButtonLabel={canEdit ? 'Recalculate price' : undefined}
            onActionButtonClick={() => open('reprice')}
          />
        )}
        <FactTiles
          label="Job facts"
          items={[
            {
              label: 'Started',
              value: job.startedAt ? formatDateTime(job.startedAt) : '—',
              helper: `${formatDuration(job.durationSeconds)}${running ? ' so far' : ''}${replacedCount > 0 ? ` · ${replacedCount} replaced` : ''}`,
            },
            {
              label: 'Material',
              value: materialText,
              helper: types.length > 1 ? 'Mixed materials' : types[0],
            },
            {
              label: 'Outcome',
              value: notYet ? 'Not yet' : status === 'needs_outcome' ? 'Not recorded' : outcomeLabel(job.outcome),
              helper: job.outcomeOverridden
                ? 'set by staff'
                : notYet
                  ? 'until the runs end'
                  : status === 'needs_outcome'
                    ? 'record it when the work is done'
                    : 'derived from the runs',
            },
            {
              label: 'Recipient',
              value: job.customer?.displayName ?? '—',
              helper: job.customer?.pricingGroup?.name,
            },
            { label: 'Operator', value: job.operator?.displayName ?? '—' },
            {
              label: 'Machine',
              value: can('machines.read') ? (
                <CarbonLink as={Link} to={machineLogbookPaths.machine(job.machine.id)}>
                  {job.machine.name}
                </CarbonLink>
              ) : (
                job.machine.name
              ),
              helper:
                live && live.source === 'recorded' && live.progressPercent != null
                  ? `${live.progressPercent} %${live.estimatedEndAt ? ` · ETA ${formatTime(live.estimatedEndAt)}` : ''}`
                  : job.machine.process.name,
            },
          ]}
        />
        <div className="mj-detail-layout">
          <div className="mj-stack">
            <div data-guide="workshop-job-runs">
              <JobRunsTable
                job={job}
                now={now}
                canEdit={canEdit}
                canDelete={canDelete}
                onAction={openRun}
                onAdd={() => open('add-run')}
              />
            </div>
            <DataTable rows={usageRows} headers={usageHeaders} size="md">
              {({ rows, headers, getTableProps, getHeaderProps, getRowProps }) => (
                <TableContainer title="Material usage" description="Everything consumed by the runs of this job.">
                  <Table {...getTableProps()} aria-label="Material usage">
                    <TableHead>
                      <TableRow>
                        {headers.map((header) => {
                          const { key, ...props } = getHeaderProps({ header });
                          return (
                            <TableHeader key={key} {...props}>
                              {header.header}
                            </TableHeader>
                          );
                        })}
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {rows.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={4}>No material recorded.</TableCell>
                        </TableRow>
                      )}
                      {rows.map((row) => {
                        const entry = usageRows.find((item) => item.id === row.id);
                        if (!entry) return null;
                        const { usage, run } = entry;
                        const { key, ...props } = getRowProps({ row });
                        return (
                          <TableRow key={key} {...props}>
                            <TableCell>
                              <div className="mj-cell-stack">
                                <span>{entry.material}</span>
                                <span className="mj-secondary">{usage.materialTypeName}</span>
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className="mj-cell-stack">
                                <RefLink kind="run" reference={run.displayId} id={run.id} />
                                {run.usagesFromMachine && (
                                  <span>
                                    <FromMachineTag />
                                  </span>
                                )}
                              </div>
                            </TableCell>
                            <TableCell>{row.cells[2].value}</TableCell>
                            <TableCell>
                              {row.cells[3].value}{' '}
                              {usage.quantityBasis === 'estimated' && (
                                <Tag type="outline" size="sm">
                                  Estimated
                                </Tag>
                              )}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </TableContainer>
              )}
            </DataTable>
            <StackCard
              title="Notes"
              action={
                canEdit && job.operator ? (
                  <Button kind="ghost" size="sm" renderIcon={Edit} onClick={() => open('notes')}>
                    {job.notes ? 'Edit' : 'Add'}
                  </Button>
                ) : undefined
              }
            >
              <p className="mj-notes">{job.notes ? job.notes : <span className="mj-secondary">No notes.</span>}</p>
            </StackCard>
          </div>
          <div className="mj-stack">
            {isPrinter && (
              <MediaCard
                recordings={recordings.data?.items ?? []}
                offSignage={job.hiddenFromSignage}
                signagePending={signage.isPending}
                onToggleSignage={canToggleSignage ? toggleSignage : undefined}
              />
            )}
            <PriceBillingTile
              job={job}
              price={price}
              calculated={calculated}
              adjustmentDifference={adjustmentDifference}
              association={association}
              canReadOrders={canReadOrders}
              finished={finished}
              onReprice={canEdit ? () => open('reprice') : undefined}
              onAddToOrder={can('orders.write') && job.customer ? () => open('order') : undefined}
              onAdjust={canOverride ? () => open('override') : undefined}
            />
          </div>
        </div>
      </div>
      <JobNotesModal open={dialog === 'notes'} job={job} onClose={close} />
      <AddToOrderModal open={dialog === 'order'} job={job} onClose={close} />
      <JobFormModal open={dialog === 'edit'} onClose={close} mode="edit" job={job} />
      <AddToJobModal open={dialog === 'add-run'} onClose={close} job={job} />
      {targetRun && runDialog?.action === 'edit' && <RunFormModal open onClose={close} mode="edit" run={targetRun} />}
      {targetRun && runDialog?.action === 'usage' && <UsageFormModal open onClose={close} run={targetRun} />}
      <DestructiveActionDialog
        open={runDialog?.action === 'cancel' && !!targetRun}
        title="Cancel this run?"
        fate="none"
        confirmLabel="Cancel run"
        cancelLabel="Keep running"
        pending={cancelRun.isPending}
        onClose={close}
        error={
          cancelRun.isError
            ? errorText(cancelRun.error, 'The run could not be cancelled. Reload the page and try again.')
            : undefined
        }
        onConfirm={() => {
          if (targetRun) cancelRun.mutate(targetRun);
        }}
      >
        <p>
          {targetRun?.displayId} ends now and is marked cancelled. Runtime and price of {job.displayId} are recalculated
          for the shortened run.
        </p>
      </DestructiveActionDialog>
      {targetRun && (
        <DeleteRunModal
          open={runDialog?.action === 'delete'}
          onClose={close}
          run={targetRun}
          runId={targetRun.id}
          job={job}
          onDeleteJob={
            canDelete
              ? () => {
                  setRunDialog(null);
                  setDialog('delete');
                }
              : undefined
          }
        />
      )}
      <DeleteJobModal open={dialog === 'delete'} onClose={close} job={job} />
      <DestructiveActionDialog
        open={runDialog?.action === 'detach' && !!targetRun}
        title="Detach this run?"
        fate="none"
        confirmLabel="Detach"
        pending={detachRun.isPending}
        onClose={close}
        error={
          detachRun.isError
            ? errorText(detachRun.error, 'The run could not be detached. Reload the page and try again.')
            : undefined
        }
        onConfirm={() => {
          if (targetRun) detachRun.mutate(targetRun);
        }}
      >
        <p>
          {targetRun?.displayId} is no longer part of {job.displayId} and shows as an unassigned run again. It keeps its
          material usage and the stock it consumed.
          {runs.length === 1 &&
            ` Because it is the only run, ${job.displayId} gets a manual run with the same start, end and outcome, but without material.`}
        </p>
      </DestructiveActionDialog>
      <RepriceJobModal open={dialog === 'reprice'} onClose={close} job={job} />
      <PriceAdjustmentModal open={dialog === 'override'} onClose={close} job={job} />
      <DestructiveActionDialog
        open={dialog === 'clear'}
        title="Remove price adjustment?"
        fate="none"
        confirmLabel="Remove adjustment"
        pending={clearAdjustment.isPending}
        onClose={close}
        error={
          clearAdjustment.isError
            ? errorText(clearAdjustment.error, 'The adjustment could not be removed. Reload the page and try again.')
            : undefined
        }
        onConfirm={() => clearAdjustment.mutate()}
      >
        <p>
          {job.priceAdjustment ? adjustmentSummary(job.priceAdjustment) : 'The adjustment'} is removed and the
          calculated price of {formatMoney(calculated)} applies again. Existing order charges stay unchanged.
        </p>
      </DestructiveActionDialog>
    </PageShell>
  );
}

export function JobDetailPage() {
  const { jobId = '' } = useParams();
  const query = useQuery(jobQuery(jobId));
  if (query.data) return <JobDetail job={query.data} />;
  const notFound = query.error instanceof ApiError && query.error.status === 404;
  return (
    <PageShell
      title={notFound ? 'Job not found' : 'Job'}
      width="wide"
      breadcrumbs={[
        { label: 'Workshop', to: machineLogbookPaths.home() },
        { label: 'Jobs', to: machineLogbookPaths.jobs() },
      ]}
    >
      {notFound ? (
        <EmptyState
          title="This job does not exist"
          description="It may have been removed, or the link is incorrect."
          action={
            <Button kind="tertiary" as={Link} to={machineLogbookPaths.jobs()}>
              Back to jobs
            </Button>
          }
        />
      ) : (
        <QueryBoundary query={query} errorMessage="The job could not be loaded.">
          {null}
        </QueryBoundary>
      )}
    </PageShell>
  );
}
