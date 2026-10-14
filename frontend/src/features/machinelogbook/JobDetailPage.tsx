import { useState } from 'react';
import {
  Accordion, AccordionItem, Button, Select, SelectItem, DataTable, Link as CarbonLink, InlineNotification, OverflowMenu, OverflowMenuItem, Table, TableBody, TableCell, TableContainer,
  TableHead, TableHeader, TableRow, Tag, Tile,
} from '@carbon/react';
import { Edit } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { clearMachineJobPriceAdjustment } from '../../api/generated/machine-jobs/machine-jobs';
import { cancelMachineRun, deleteMachineRun, detachMachineRun, updateMachineRun } from '../../api/generated/machine-runs/machine-runs';
import type { JobOrderAssociation, MachineJob, MachineRun, MachineRunOutcome, WorkItemBilling } from '../../api/generated/models';
import { ApiError } from '../../api/http-client';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { PageShell } from '../../app/PageShell';
import { EmptyState } from '../../app/PageState';
import { JobRunsTable, type RunAction } from './components/JobRunsTable';
import { AttachRunModal } from './dialogs/AttachRunModal';
import { JobFormModal } from './dialogs/JobFormModal';
import { jobOrderQuery, saveError, unassignedRunsParams } from './dialogs/jobFormHelpers';
import { PriceAdjustmentModal } from './dialogs/PriceAdjustmentModal';
import { runOutcomeChoices } from './dialogs/runFormHelpers';
import { RunFormModal } from './dialogs/RunFormModal';
import { UsageFormModal } from './dialogs/UsageFormModal';
import { jobQuery, machineLogbookKeys, runsQuery } from './queries';
import { formatDateTime, formatDuration, formatMoney, formatQuantity } from './shared/format';
import { machineLogbookPaths } from './shared/paths';
import { QueryBoundary } from './shared/QueryBoundary';
import { activeRuns, adjustmentSummary, BillingTag, FromMachineTag, isRunLive, JobRowStatusTag, machineJobName, OutcomeTag, outcomeLabel, type JobRowStatus } from './shared/status';
import { useNotify } from './shared/toasts';
import { useCan } from './shared/useCan';
import { useNow } from './shared/useNow';
import './styles/jobs.scss';

const usageHeaders = [{ key: 'material', header: 'Material' }, { key: 'run', header: 'Run' }, { key: 'source', header: 'Source' }, { key: 'quantity', header: 'Quantity' }];

/** What the job list shows as billing state; the job itself carries no billing field, only price status and the order association. */
function jobBilling(job: MachineJob, association: JobOrderAssociation | undefined): WorkItemBilling | undefined {
  if (association?.orderId) return { state: association.sourceChanged ? 'order_outdated' : 'on_order', orderId: association.orderId, orderReference: association.orderReference };
  if (job.pricingStatus === 'pending') return { state: 'pending' };
  if (job.pricingStatus === 'incomplete') return { state: 'price_incomplete' };
  return association ? { state: 'not_on_order' } : undefined;
}

const errorText = (error: unknown, fallback: string) => saveError(error, fallback).message;

/** Status of the job now: a run whose planned end has passed since the last refresh no longer counts as running. */
function statusNow(job: MachineJob, now: number): JobRowStatus {
  if (job.status !== 'running') return job.status;
  if (activeRuns(job).some((run) => isRunLive(run, now))) return 'running';
  if (job.outcomeOverridden) return job.outcome === 'unknown' ? 'needs_outcome' : job.outcome;
  return activeRuns(job).some((run) => !run.outcome) || job.outcome === 'unknown' ? 'needs_outcome' : job.outcome;
}

/** Runs that have ended without a recorded outcome. */
const runsNeedingOutcome = (job: MachineJob, now: number) => activeRuns(job).filter((run) => !run.outcome && !isRunLive(run, now));

function RunOutcomeRow({ run }: { run: MachineRun }) {
  const client = useQueryClient();
  const notify = useNotify();
  const [choice, setChoice] = useState<MachineRunOutcome | ''>('');
  const save = useMutation({
    mutationFn: (outcome: MachineRunOutcome) => updateMachineRun(run.id, { outcome, expectedVersion: run.version }),
    onSuccess: async (_saved, outcome) => {
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
      notify({ kind: 'success', title: 'Outcome recorded', subtitle: `${run.displayId} is marked ${outcomeLabel(outcome).toLowerCase()}.` });
    },
  });
  return (
    <div>
      {save.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Outcome not saved" subtitle={errorText(save.error, 'The outcome could not be saved.')} />}
      <form
        className="mj-outcome-prompt__form"
        onSubmit={(event) => {
          event.preventDefault();
          if (choice) save.mutate(choice);
        }}
      >
        <Select id={`run-outcome-${run.id}`} labelText={`Outcome of ${run.displayId}`} helperText={`Ended ${run.endedAt ? formatDateTime(run.endedAt) : 'earlier'}`} value={choice} onChange={(event) => setChoice(event.target.value as MachineRunOutcome)}>
          <SelectItem value="" text="Select an outcome" hidden />
          {runOutcomeChoices.map((option) => <SelectItem key={option.id} value={option.id} text={option.label} />)}
        </Select>
        <Button type="submit" disabled={!choice || save.isPending}>{save.isPending ? 'Saving…' : 'Save outcome'}</Button>
      </form>
    </div>
  );
}

type JobDialog = 'edit' | 'override' | 'clear' | 'add-run' | 'attach' | null;

function JobDetail({ job }: { job: MachineJob }) {
  const can = useCan();
  const notify = useNotify();
  const client = useQueryClient();
  const [dialog, setDialog] = useState<JobDialog>(null);
  const [runDialog, setRunDialog] = useState<{ action: RunAction; runId: string } | null>(null);
  const now = useNow();
  const canEdit = can('machine_jobs.edit');
  const canOverride = can('machine_jobs.override_price');
  const canReadOrders = can('orders.read');
  const status = statusNow(job, now);
  const missingRules = job.pricingSnapshot?.rules.filter((rule) => rule.missing) ?? [];
  const price = job.effectivePrice == null ? null : Number(job.effectivePrice);
  const calculated = job.calculatedPrice == null ? null : Number(job.calculatedPrice);
  const runs = activeRuns(job);
  const replacedCount = job.runs.length - runs.length;
  const pendingOutcomes = status === 'needs_outcome' ? runsNeedingOutcome(job, now) : [];

  const unassigned = useQuery({ ...runsQuery(unassignedRunsParams(job.machine.id)), enabled: canEdit });
  const canAttach = (unassigned.data?.items.length ?? 0) > 0;
  const association = useQuery({ ...jobOrderQuery(job.id), enabled: canReadOrders });

  const refresh = () => client.invalidateQueries({ queryKey: machineLogbookKeys.all });
  const close = () => { setDialog(null); setRunDialog(null); };
  const targetRun = runDialog ? job.runs.find((run) => run.id === runDialog.runId) : undefined;
  const clearAdjustment = useMutation({
    mutationFn: () => clearMachineJobPriceAdjustment(job.id, { expectedVersion: job.version }),
    onSuccess: async () => { await refresh(); notify({ kind: 'success', title: 'Price adjustment removed', subtitle: `${job.displayId} uses the calculated price again.` }); close(); },
  });
  const cancelRun = useMutation({
    mutationFn: (run: MachineRun) => cancelMachineRun(run.id, { expectedVersion: run.version }),
    onSuccess: async (_saved, run) => { await refresh(); notify({ kind: 'success', title: 'Run cancelled', subtitle: `${run.displayId} ended now and the price of ${job.displayId} was recalculated.` }); close(); },
  });
  const removeRun = useMutation({
    mutationFn: (run: MachineRun) => deleteMachineRun(run.id, { expectedVersion: run.version }),
    onSuccess: async (_saved, run) => { await refresh(); notify({ kind: 'success', title: 'Run removed', subtitle: `${run.displayId} was removed from ${job.displayId}.` }); close(); },
  });
  const detachRun = useMutation({
    mutationFn: (run: MachineRun) => detachMachineRun(run.id, { expectedJobVersion: job.version }),
    onSuccess: async (_saved, run) => { await refresh(); notify({ kind: 'success', title: 'Run detached', subtitle: `${run.displayId} is an unassigned run again.` }); close(); },
  });
  const resetMutations = () => { clearAdjustment.reset(); cancelRun.reset(); removeRun.reset(); detachRun.reset(); };
  const open = (next: NonNullable<JobDialog>) => { resetMutations(); setDialog(next); };
  const openRun = (action: RunAction, run: MachineRun) => { resetMutations(); setRunDialog({ action, runId: run.id }); };

  const primary = canEdit ? <Button renderIcon={Edit} onClick={() => open('edit')}>Edit job</Button> : null;
  const menuItems = [
    canOverride && <OverflowMenuItem key="override" itemText={job.priceAdjustment ? 'Change price adjustment' : 'Adjust price'} onClick={() => open('override')} />,
    canOverride && job.priceAdjustment && <OverflowMenuItem key="clear" itemText="Remove price adjustment" onClick={() => open('clear')} />,
  ].filter(Boolean);

  const usageRows = runs.flatMap((run) => run.usages.map((usage) => ({
    id: `${run.id}-${usage.id}`, run, usage, material: usage.materialName,
    source: usage.ownership === 'external' ? 'Customer material' : usage.spoolDisplayId ? `Spool ${usage.spoolDisplayId}${usage.spoolId ? '' : ' (deleted)'}` : 'Makerspace stock',
    quantity: `${formatQuantity(usage.quantity)} ${usage.unit}`,
  })));
  const name = machineJobName(job);
  const adjustmentDifference = price != null && calculated != null ? price - calculated : null;
  const running = status === 'running';

  return (
    <PageShell
      title={name} titleAdornment={<JobRowStatusTag status={status} />} width="wide"
      description={[name !== job.displayId && job.displayId, job.machine.name, job.startedAt && formatDateTime(job.startedAt)].filter(Boolean).join(' · ')}
      breadcrumbs={[{ label: 'Workshop', to: machineLogbookPaths.overview() }, { label: 'Jobs', to: machineLogbookPaths.jobs() }]}
      actions={<>{primary}{menuItems.length > 0 && <OverflowMenu aria-label="More job actions" iconDescription="More job actions" flipped>{menuItems}</OverflowMenu>}</>}
    >
      <div className="mj-stack">
        {pendingOutcomes.length > 0 && (canEdit ? (
          <Tile className="mj-outcome-prompt">
            <div>
              <h2 className="mj-section-title">Record the outcome</h2>
              <p>{pendingOutcomes.length === 1 ? 'A run of this job has ended. How did it go?' : `${pendingOutcomes.length} runs of this job have ended. How did each one go?`}</p>
            </div>
            <div className="mj-outcome-prompt__rows">
              {pendingOutcomes.map((run) => <RunOutcomeRow key={run.id} run={run} />)}
            </div>
          </Tile>
        ) : <InlineNotification kind="info" lowContrast hideCloseButton title="Outcome not recorded yet" subtitle="A run has ended; someone with job edit access records how it went." />)}
        {job.pricingStatus === 'incomplete' && (
          <InlineNotification
            kind="error" lowContrast hideCloseButton title="Price incomplete"
            subtitle={`No pricing rate for ${missingRules.map((rule) => rule.label).join(', ') || 'this job'}${canOverride ? '. You can set the price manually.' : '.'}`}
          />
        )}
        <Tile>
          <dl className="mj-facts">
            <div><dt>Customer</dt><dd>{job.customer ? <>{job.customer.displayName}{job.customer.pricingGroup && <><br /><span className="mj-secondary">{job.customer.pricingGroup.name}</span></>}</> : '—'}</dd></div>
            <div><dt>Operator</dt><dd>{job.operator?.displayName ?? '—'}</dd></div>
            <div><dt>Start</dt><dd>{job.startedAt ? formatDateTime(job.startedAt) : '—'}</dd></div>
            <div><dt>Runtime</dt><dd className="mj-cell-stack"><span>{formatDuration(job.durationSeconds)}</span>{runs.length > 1 && <span className="mj-secondary">All runs together</span>}</dd></div>
            <div><dt>{running && !job.endedAt ? 'Expected end' : 'End'}</dt><dd>{job.endedAt ? formatDateTime(job.endedAt) : job.expectedEndAt ? formatDateTime(job.expectedEndAt) : '—'}</dd></div>
            <div><dt>Runs</dt><dd className="mj-cell-stack"><span>{runs.length}</span>{replacedCount > 0 && <span className="mj-secondary">{replacedCount} replaced</span>}</dd></div>
            <div>
              <dt>Outcome</dt>
              <dd className="mj-cell-stack">
                {status === 'running' || status === 'needs_outcome' ? <span className="mj-secondary">Not recorded yet</span> : <span><OutcomeTag outcome={job.outcome} size="sm" /></span>}
                {job.outcomeOverridden ? <span className="mj-secondary">Set by staff</span> : status !== 'running' && status !== 'needs_outcome' ? <span className="mj-secondary">Derived from the runs</span> : null}
              </dd>
            </div>
          </dl>
        </Tile>
        <JobRunsTable
          job={job} now={now} canEdit={canEdit} canAttach={canAttach}
          onAction={openRun} onAdd={() => open('add-run')} onAttach={() => open('attach')}
        />
        <div className="mj-detail-layout">
          <div className="mj-stack">
            <DataTable rows={usageRows} headers={usageHeaders} size="md">
              {({ rows, headers, getTableProps, getHeaderProps, getRowProps }) => (
                <TableContainer title="Material usage" description="Everything consumed by the runs of this job.">
                  <Table {...getTableProps()} aria-label="Material usage">
                    <TableHead>
                      <TableRow>{headers.map((header) => { const { key, ...props } = getHeaderProps({ header }); return <TableHeader key={key} {...props}>{header.header}</TableHeader>; })}</TableRow>
                    </TableHead>
                    <TableBody>
                      {rows.length === 0 && <TableRow><TableCell colSpan={4}>No material recorded.</TableCell></TableRow>}
                      {rows.map((row) => {
                        const entry = usageRows.find((item) => item.id === row.id);
                        if (!entry) return null;
                        const { usage, run } = entry;
                        const { key, ...props } = getRowProps({ row });
                        return (
                          <TableRow key={key} {...props}>
                            <TableCell><div className="mj-cell-stack"><span>{usage.materialName}</span><span className="mj-secondary">{usage.category}</span></div></TableCell>
                            <TableCell>
                              <div className="mj-cell-stack">
                                <CarbonLink as={Link} to={machineLogbookPaths.run(run.id)}>{run.displayId}</CarbonLink>
                                {run.usagesFromMachine && <span><FromMachineTag /></span>}
                              </div>
                            </TableCell>
                            <TableCell>{row.cells[2].value}</TableCell>
                            <TableCell>{row.cells[3].value} {usage.quantityBasis === 'estimated' && <Tag type="outline" size="sm">Estimated</Tag>}</TableCell>
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
          <Tile>
            <h3 className="mj-section-title">Price &amp; billing</h3>
            <div className="mj-price">{formatMoney(price)}</div>
            <div className="mj-inline"><BillingTag billing={jobBilling(job, association.data)} />{job.pricingStatus === 'pending' && <span className="mj-secondary">Price pending</span>}</div>
            <dl className="mj-price-details">
              <div><dt>Calculated</dt><dd>{formatMoney(calculated)}</dd></div>
              {job.priceAdjustment && (
                <>
                  <div><dt>{adjustmentSummary(job.priceAdjustment)}</dt><dd>{adjustmentDifference == null ? '—' : `${adjustmentDifference > 0 ? '+' : adjustmentDifference < 0 ? '−' : '±'}${formatMoney(Math.abs(adjustmentDifference))}`}</dd></div>
                  <div><dt>Final</dt><dd><strong>{formatMoney(price)}</strong></dd></div>
                  <div><dt>Reason</dt><dd>{job.priceAdjustment.reason}</dd></div>
                </>
              )}
            </dl>
            {job.pricingSnapshot && (
              <Accordion size="md">
                <AccordionItem title="How this was calculated">
                  <dl className="mj-price-details">
                    <div><dt>Pricing group</dt><dd>{job.pricingSnapshot.pricingGroupName}</dd></div>
                    <div><dt>Revision</dt><dd>{job.pricingSnapshot.revision}</dd></div>
                    <div><dt>Captured</dt><dd>{formatDateTime(job.pricingSnapshot.capturedAt)}</dd></div>
                  </dl>
                  <ul className="mj-rule-list">
                    {job.pricingSnapshot.rules.map((rule) => (
                      <li key={`${rule.kind}-${rule.selector}-${rule.label}`}><span>{rule.label}</span>{rule.missing ? <Tag type="red" size="sm">No rate</Tag> : <span>{formatMoney(rule.rate)} / {rule.unit}</span>}</li>
                    ))}
                  </ul>
                </AccordionItem>
              </Accordion>
            )}
            {canReadOrders && (
              <div className="mj-stack">
                <h4 className="mj-section-title">Order</h4>
                {association.isError ? <p className="mj-secondary">The order could not be loaded.</p> : association.data?.orderId ? (
                  <>
                    <p><CarbonLink as={Link} to={`/orders/${association.data.orderId}`}>{association.data.orderReference}</CarbonLink></p>
                    {association.data.sourceChanged && <InlineNotification kind="warning" lowContrast hideCloseButton title="Changed after charge" subtitle="This job changed after it was charged. The order amount has not been updated." />}
                  </>
                ) : association.data ? <p className="mj-secondary">Not on an order.</p> : null}
              </div>
            )}
          </Tile>
        </div>
      </div>
      <JobFormModal open={dialog === 'edit'} onClose={close} mode="edit" job={job} />
      <RunFormModal open={dialog === 'add-run'} onClose={close} mode="add" job={job} />
      <AttachRunModal open={dialog === 'attach'} onClose={close} job={job} />
      {targetRun && runDialog?.action === 'edit' && <RunFormModal open onClose={close} mode="edit" run={targetRun} />}
      {targetRun && runDialog?.action === 'usage' && <UsageFormModal open onClose={close} run={targetRun} />}
      <DestructiveActionDialog
        open={runDialog?.action === 'cancel' && !!targetRun} title="Cancel this run?" confirmLabel="Cancel run" cancelLabel="Keep running" pending={cancelRun.isPending} onClose={close}
        error={cancelRun.isError ? errorText(cancelRun.error, 'The run could not be cancelled. Reload the page and try again.') : undefined}
        onConfirm={() => { if (targetRun) cancelRun.mutate(targetRun); }}
      >
        <p>{targetRun?.displayId} ends now and is marked cancelled. Runtime and price of {job.displayId} are recalculated for the shortened run.</p>
      </DestructiveActionDialog>
      <DestructiveActionDialog
        open={runDialog?.action === 'remove' && !!targetRun} title="Remove this run?" confirmLabel="Remove run" pending={removeRun.isPending} onClose={close}
        error={removeRun.isError ? errorText(removeRun.error, 'The run could not be removed. Reload the page and try again.') : undefined}
        onConfirm={() => { if (targetRun) removeRun.mutate(targetRun); }}
      >
        <p>{targetRun?.displayId} is deleted from {job.displayId}. Its material usage goes back to stock and the price is recalculated. A job always keeps at least one run.</p>
      </DestructiveActionDialog>
      <DestructiveActionDialog
        open={runDialog?.action === 'detach' && !!targetRun} title="Detach this run?" confirmLabel="Detach" pending={detachRun.isPending} onClose={close}
        error={detachRun.isError ? errorText(detachRun.error, 'The run could not be detached. Reload the page and try again.') : undefined}
        onConfirm={() => { if (targetRun) detachRun.mutate(targetRun); }}
      >
        <p>
          {targetRun?.displayId} is no longer part of {job.displayId} and shows as an unassigned run again. It keeps its material usage and the stock it consumed.
          {runs.length === 1 && ` Because it is the only run, ${job.displayId} gets a manual run with the same start, end and outcome, but without material.`}
        </p>
      </DestructiveActionDialog>
      <PriceAdjustmentModal open={dialog === 'override'} onClose={close} job={job} />
      <DestructiveActionDialog
        open={dialog === 'clear'} title="Remove price adjustment?" confirmLabel="Remove adjustment" pending={clearAdjustment.isPending} onClose={close}
        error={clearAdjustment.isError ? errorText(clearAdjustment.error, 'The adjustment could not be removed. Reload the page and try again.') : undefined}
        onConfirm={() => clearAdjustment.mutate()}
      >
        <p>{job.priceAdjustment ? adjustmentSummary(job.priceAdjustment) : 'The adjustment'} is removed and the calculated price of {formatMoney(calculated)} applies again. Existing order charges stay unchanged.</p>
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
      title={notFound ? 'Job not found' : 'Job'} width="wide"
      breadcrumbs={[{ label: 'Workshop', to: machineLogbookPaths.overview() }, { label: 'Jobs', to: machineLogbookPaths.jobs() }]}
    >
      {notFound
        ? <EmptyState title="This job does not exist" description="It may have been removed, or the link is incorrect." action={<Button kind="tertiary" as={Link} to={machineLogbookPaths.jobs()}>Back to jobs</Button>} />
        : <QueryBoundary query={query} errorMessage="The job could not be loaded.">{null}</QueryBoundary>}
    </PageShell>
  );
}
