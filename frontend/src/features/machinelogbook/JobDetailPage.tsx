import { useState } from 'react';
import { RefLink } from '../../app/RefLink';
import {
  Button,
  DataTable,
  ActionableNotification,
  InlineNotification,
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
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { PageShell } from '../../app/PageShell';
import { EmptyState } from '../../app/PageState';
import { JobRunsTable, type RunAction } from './components/JobRunsTable';
import { DeleteJobModal, DeleteRunModal } from './dialogs/DeleteDialogs';
import { AttachRunModal } from './dialogs/AttachRunModal';
import { JobFormModal } from './dialogs/JobFormModal';
import { jobOrderQuery, unassignedRunsParams } from './dialogs/jobFormHelpers';
import { PriceAdjustmentModal } from './dialogs/PriceAdjustmentModal';
import { RepriceJobModal } from './dialogs/RepriceJobModal';
import { RunFormModal } from './dialogs/RunFormModal';
import { UsageFormModal } from './dialogs/UsageFormModal';
import { jobQuery, jobRecordingsQuery, machineLogbookKeys, runsQuery } from './queries';
import { FactsBar } from './recording/FactsBar';
import { JobPreviewTile, JobTimelapseTile } from './recording/RecordingTiles';
import { jobConsumption } from './processConfig';
import { formatDateTime, formatDuration, formatMoney, formatQuantity } from './shared/format';
import { machineLogbookPaths } from './shared/paths';
import { QueryBoundary } from './shared/QueryBoundary';
import {
  activeRuns,
  adjustmentSummary,
  FromMachineTag,
  JobRowStatusTag,
  machineJobName,
  OutcomeTag,
} from './shared/status';
import { useNotify } from './shared/toasts';
import { useCan } from './shared/useCan';
import { useNow } from './shared/useNow';
import { usageHeaders, errorText, statusNow, runsNeedingOutcome, JobDialog } from './jobDetail/jobDetailShared';
import { RunOutcomeRow } from './jobDetail/RunOutcomeRow';
import { PriceBillingTile } from './jobDetail/PriceBillingTile';
import './styles/jobs.scss';

function JobDetail({ job }: { job: MachineJob }) {
  const can = useCan();
  const notify = useNotify();
  const client = useQueryClient();
  const [dialog, setDialog] = useState<JobDialog>(null);
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
  // FDM jobs (grams only, no measures) keep the usage table as their only consumption display.
  const consumption = runs.every(
    (run) => run.usages.every((usage) => usage.unit === 'g') && Object.keys(run.measures).length === 0,
  )
    ? null
    : jobConsumption({ runs, measures: job.measures });
  const replacedCount = job.runs.length - runs.length;
  const pendingOutcomes = status === 'needs_outcome' ? runsNeedingOutcome(job, now) : [];

  const unassigned = useQuery({ ...runsQuery(unassignedRunsParams(job.machine.id)), enabled: canEdit });
  const canAttach = (unassigned.data?.items.length ?? 0) > 0;
  const association = useQuery({ ...jobOrderQuery(job.id), enabled: canReadOrders });

  // Previews and files of the job's recorded runs; the job page works without them if this fails.
  const recordings = useQuery(jobRecordingsQuery(job.id));
  const gramsOnly = consumption === null;
  const materialText = gramsOnly
    ? runs.some((run) => run.usages.length > 0)
      ? `${formatQuantity(runs.flatMap((run) => run.usages).reduce((sum, usage) => sum + Number(usage.quantity), 0))} g`
      : 'None recorded'
    : consumption;
  const refresh = () => client.invalidateQueries({ queryKey: machineLogbookKeys.all });
  const close = () => {
    setDialog(null);
    setRunDialog(null);
  };
  const targetRun = runDialog ? job.runs.find((run) => run.id === runDialog.runId) : undefined;
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
  const open = (next: NonNullable<JobDialog>) => {
    resetMutations();
    setDialog(next);
  };
  const openRun = (action: RunAction, run: MachineRun) => {
    resetMutations();
    setRunDialog({ action, runId: run.id });
  };

  const primary = canEdit ? (
    <Button renderIcon={Edit} onClick={() => open('edit')}>
      Edit job
    </Button>
  ) : null;
  const menuItems = [
    canOverride && (
      <OverflowMenuItem
        key="override"
        itemText={job.priceAdjustment ? 'Change price adjustment' : 'Adjust price'}
        onClick={() => open('override')}
      />
    ),
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
      material: usage.materialName,
      source:
        usage.ownership === 'external'
          ? 'Customer material'
          : usage.spoolDisplayId
            ? `Spool ${usage.spoolDisplayId}${usage.spoolId ? '' : ' (deleted)'}`
            : 'Makerspace stock',
      quantity: `${formatQuantity(usage.quantity)} ${usage.unit}`,
    })),
  );
  const name = machineJobName(job);
  const adjustmentDifference = price != null && calculated != null ? price - calculated : null;
  const running = status === 'running';

  return (
    <PageShell
      title={name}
      titleAdornment={<JobRowStatusTag status={status} />}
      width="wide"
      description={[
        name !== job.displayId && job.displayId,
        job.machine.name,
        job.startedAt && formatDateTime(job.startedAt),
      ]
        .filter(Boolean)
        .join(' · ')}
      breadcrumbs={[
        { label: 'Workshop', to: machineLogbookPaths.overview() },
        { label: 'Jobs', to: machineLogbookPaths.jobs() },
      ]}
      actions={
        <>
          {primary}
          {menuItems.length > 0 && (
            <OverflowMenu aria-label="More job actions" iconDescription="More job actions" flipped>
              {menuItems}
            </OverflowMenu>
          )}
        </>
      }
    >
      <div className="mj-stack">
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
        <div className="mj-detail-layout">
          <div className="mj-stack">
            <FactsBar
              metrics={[
                {
                  label: 'Runtime',
                  value: formatDuration(job.durationSeconds),
                  note: runs.length > 1 ? 'All runs together' : undefined,
                },
                { label: 'Material', value: materialText },
                {
                  label: 'Outcome',
                  value:
                    status === 'planned' ? (
                      <span className="mj-secondary">No run yet</span>
                    ) : status === 'running' || status === 'needs_outcome' ? (
                      <span className="mj-secondary">Not recorded yet</span>
                    ) : (
                      <OutcomeTag outcome={job.outcome} size="sm" />
                    ),
                  note: job.outcomeOverridden
                    ? 'Set by staff'
                    : !['planned', 'running', 'needs_outcome'].includes(status)
                      ? 'Derived from the runs'
                      : undefined,
                },
                {
                  label: 'Customer',
                  value: job.customer?.displayName ?? '—',
                  note: job.customer?.pricingGroup?.name,
                },
              ]}
              details={[
                { label: 'Operator', value: job.operator?.displayName ?? '—' },
                { label: 'Start', value: job.startedAt ? formatDateTime(job.startedAt) : '—' },
                {
                  label: running && !job.endedAt ? 'Expected end' : 'End',
                  value: job.endedAt
                    ? formatDateTime(job.endedAt)
                    : job.expectedEndAt
                      ? formatDateTime(job.expectedEndAt)
                      : '—',
                },
                {
                  label: 'Runs',
                  value: runs.length,
                  note: replacedCount > 0 ? `${replacedCount} replaced` : undefined,
                },
              ]}
            />
            <JobRunsTable
              job={job}
              now={now}
              canEdit={canEdit}
              canDelete={canDelete}
              canAttach={canAttach}
              onAction={openRun}
              onAdd={() => open('add-run')}
              onAttach={() => open('attach')}
            />
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
                                <span>{usage.materialName}</span>
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
            <Tile>
              <h3 className="mj-section-title">Notes</h3>
              <p className="mj-notes">{job.notes ? job.notes : <span className="mj-secondary">No notes.</span>}</p>
            </Tile>
          </div>
          <div className="mj-stack">
            {recordings.data && recordings.data.items.length > 0 && (
              <>
                <JobPreviewTile recordings={recordings.data.items} />
                <JobTimelapseTile recordings={recordings.data.items} />
              </>
            )}
            <PriceBillingTile
              job={job}
              price={price}
              calculated={calculated}
              adjustmentDifference={adjustmentDifference}
              association={association}
              canReadOrders={canReadOrders}
              onReprice={canEdit ? () => open('reprice') : undefined}
            />
          </div>
        </div>
      </div>
      <JobFormModal open={dialog === 'edit'} onClose={close} mode="edit" job={job} />
      <RunFormModal open={dialog === 'add-run'} onClose={close} mode="add" job={job} />
      <AttachRunModal open={dialog === 'attach'} onClose={close} job={job} />
      {targetRun && runDialog?.action === 'edit' && <RunFormModal open onClose={close} mode="edit" run={targetRun} />}
      {targetRun && runDialog?.action === 'usage' && <UsageFormModal open onClose={close} run={targetRun} />}
      <DestructiveActionDialog
        open={runDialog?.action === 'cancel' && !!targetRun}
        title="Cancel this run?"
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
        { label: 'Workshop', to: machineLogbookPaths.overview() },
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
