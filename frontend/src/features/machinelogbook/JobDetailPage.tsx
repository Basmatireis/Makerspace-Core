import { useState } from 'react';
import {
  Accordion, AccordionItem, Button, Select, SelectItem, DataTable, Link as CarbonLink, InlineNotification, OverflowMenu, OverflowMenuItem, ProgressBar, Table, TableBody, TableCell, TableContainer,
  TableHead, TableHeader, TableRow, Tag, Tile,
} from '@carbon/react';
import { Edit, InProgress, Link as LinkIcon, StopOutline } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { cancelMachineJobRun, clearMachineJobPriceAdjustment, updateMachineJob } from '../../api/generated/machine-jobs/machine-jobs';
import { unlinkPrintFromMachineJob } from '../../api/generated/prints/prints';
import type { JobOrderAssociation, MachineJob, MachineJobOutcome, WorkItemBilling } from '../../api/generated/models';
import { ApiError } from '../../api/http-client';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { PageShell } from '../../app/PageShell';
import { EmptyState } from '../../app/PageState';
import { JobFormModal } from './dialogs/JobFormModal';
import { jobOrderQuery, linkablePrints, saveError, unlinkedPrintsParams } from './dialogs/jobFormHelpers';
import { LinkPrintModal } from './dialogs/LinkPrintModal';
import { PriceAdjustmentModal } from './dialogs/PriceAdjustmentModal';
import { UsageFormModal } from './dialogs/UsageFormModal';
import { jobQuery, machineLogbookKeys, printQuery, printsQuery } from './queries';
import { formatDateTime, formatDuration, formatMoney, formatQuantity, formatTime } from './shared/format';
import { machineLogbookPaths } from './shared/paths';
import { QueryBoundary } from './shared/QueryBoundary';
import { adjustmentSummary, BillingTag, isManualRunning, JobRowStatusTag, machineJobName, outcomeLabel, outcomeOptions, PrintStateTag, runProgress, type JobRowStatus } from './shared/status';
import { useNotify } from './shared/toasts';
import { useCan } from './shared/useCan';
import { useNow } from './shared/useNow';
import './styles/jobs.scss';

const usageHeaders = [{ key: 'material', header: 'Material' }, { key: 'source', header: 'Source' }, { key: 'quantity', header: 'Quantity' }];

/** What the job list shows as billing state; the job itself carries no billing field, only price status and the order association. */
function jobBilling(job: MachineJob, association: JobOrderAssociation | undefined): WorkItemBilling | undefined {
  if (association?.orderId) return { state: association.sourceChanged ? 'order_outdated' : 'on_order', orderId: association.orderId, orderReference: association.orderReference };
  if (job.pricingStatus === 'pending') return { state: 'pending' };
  if (job.pricingStatus === 'incomplete') return { state: 'price_incomplete' };
  return association ? { state: 'not_on_order' } : undefined;
}

const errorText = (error: unknown, fallback: string) => saveError(error, fallback).message;

function JobDetail({ job }: { job: MachineJob }) {
  const can = useCan();
  const notify = useNotify();
  const client = useQueryClient();
  const [dialog, setDialog] = useState<'edit' | 'usage' | 'override' | 'clear' | 'cancel' | 'link' | 'unlink' | null>(null);
  const now = useNow();
  const print = job.print ?? undefined;
  const canEdit = can('machine_jobs.edit');
  const canOverride = can('machine_jobs.override_price');
  const canReadOrders = can('orders.read');
  const manualRunning = isManualRunning(job, now);
  const status: JobRowStatus = job.status === 'running' && !manualRunning && new Date(job.endsAt).getTime() <= now ? 'needs_outcome' : job.status;
  const missingRules = job.pricingSnapshot?.rules.filter((rule) => rule.missing) ?? [];
  const price = job.effectivePrice == null ? null : Number(job.effectivePrice);
  const calculated = job.calculatedPrice == null ? null : Number(job.calculatedPrice);

  const unlinked = useQuery({ ...printsQuery(unlinkedPrintsParams(job.machine.id)), enabled: canEdit && job.run === 'manual' });
  const canLinkPrint = canEdit && linkablePrints(unlinked.data?.items).length > 0;
  const printing = useQuery({ ...printQuery(print?.id ?? ''), enabled: print?.state === 'printing' });
  const association = useQuery({ ...jobOrderQuery(job.id), enabled: canReadOrders });

  const refresh = () => client.invalidateQueries({ queryKey: machineLogbookKeys.all });
  const close = () => setDialog(null);
  const cancelRun = useMutation({
    mutationFn: () => cancelMachineJobRun(job.id, { expectedVersion: job.version }),
    onSuccess: async () => { await refresh(); notify({ kind: 'success', title: 'Run cancelled', subtitle: `${job.displayId} ended now and its price was recalculated.` }); close(); },
  });
  const clearAdjustment = useMutation({
    mutationFn: () => clearMachineJobPriceAdjustment(job.id, { expectedVersion: job.version }),
    onSuccess: async () => { await refresh(); notify({ kind: 'success', title: 'Price adjustment removed', subtitle: `${job.displayId} uses the calculated price again.` }); close(); },
  });
  const unlinkPrint = useMutation({
    mutationFn: () => unlinkPrintFromMachineJob(print!.id, { expectedJobVersion: job.version }),
    onSuccess: async () => { await refresh(); notify({ kind: 'success', title: 'Print unlinked', subtitle: `${job.displayId} keeps its values and is a manual run again.` }); close(); },
  });
  const [outcomeChoice, setOutcomeChoice] = useState<MachineJobOutcome | ''>('');
  const saveOutcome = useMutation({
    mutationFn: (outcome: MachineJobOutcome) => updateMachineJob(job.id, {
      machineId: job.machine.id, startsAt: job.startsAt, endsAt: job.endsAt, customer: job.customer ? { kind: job.customer.kind, id: job.customer.id } : undefined,
      operatorPersonId: job.operator!.personId, outcome, title: job.title ?? null, notes: job.notes ?? null, expectedVersion: job.version,
    }),
    onSuccess: async (_saved, outcome) => { await refresh(); notify({ kind: 'success', title: 'Outcome recorded', subtitle: `${job.displayId} is marked ${outcomeLabel(outcome).toLowerCase()}.` }); },
  });
  const open = (next: NonNullable<typeof dialog>) => { cancelRun.reset(); clearAdjustment.reset(); unlinkPrint.reset(); setDialog(next); };

  const primary = canEdit ? <Button renderIcon={Edit} onClick={() => open('edit')}>Edit job</Button> : null;
  const menuItems = [
    canEdit && <OverflowMenuItem key="usage" itemText="Edit material usage" onClick={() => open('usage')} />,
    canOverride && <OverflowMenuItem key="override" itemText={job.priceAdjustment ? 'Change price adjustment' : 'Adjust price'} onClick={() => open('override')} />,
    canOverride && job.priceAdjustment && <OverflowMenuItem key="clear" itemText="Remove price adjustment" onClick={() => open('clear')} />,
    canEdit && job.run === 'automatic' && print && <OverflowMenuItem key="unlink" itemText="Unlink print" onClick={() => open('unlink')} />,
  ].filter(Boolean);

  const usageRows = job.usages.map((usage) => ({
    id: usage.id, material: usage.materialName,
    source: usage.ownership === 'external' ? 'Customer material' : usage.spoolDisplayId ? `Spool ${usage.spoolDisplayId}${usage.spoolId ? '' : ' (deleted)'}` : 'Makerspace stock',
    quantity: `${formatQuantity(usage.quantity)} ${usage.unit}`,
  }));
  const name = machineJobName(job);
  const progress = runProgress(job, now);
  const adjustmentDifference = price != null && calculated != null ? price - calculated : null;

  return (
    <PageShell
      title={name} titleAdornment={<JobRowStatusTag status={status} />} width="wide"
      description={[name !== job.displayId && job.displayId, job.machine.name, formatDateTime(job.startsAt)].filter(Boolean).join(' · ')}
      breadcrumbs={[{ label: 'Workshop', to: machineLogbookPaths.overview() }, { label: 'Jobs', to: machineLogbookPaths.jobs() }]}
      actions={<>{primary}{menuItems.length > 0 && <OverflowMenu aria-label="More job actions" iconDescription="More job actions" flipped>{menuItems}</OverflowMenu>}</>}
    >
      <div className="mj-stack">
        {status === 'needs_outcome' && (canEdit ? (
          <Tile className="mj-outcome-prompt">
            <div>
              <h2 className="mj-section-title">Record the outcome</h2>
              <p>The run ended {formatDateTime(job.endsAt)}. How did it go?</p>
              {saveOutcome.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Outcome not saved" subtitle={errorText(saveOutcome.error, 'The outcome could not be saved.')} />}
            </div>
            {job.operator ? (
              <form
                className="mj-outcome-prompt__form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (outcomeChoice) saveOutcome.mutate(outcomeChoice);
                }}
              >
                <Select id="job-outcome-prompt" labelText="Outcome" value={outcomeChoice} onChange={(event) => setOutcomeChoice(event.target.value as MachineJobOutcome)}>
                  <SelectItem value="" text="Select an outcome" hidden />
                  {outcomeOptions.filter((option) => option.id !== 'unknown').map((option) => <SelectItem key={option.id} value={option.id} text={option.label} />)}
                </Select>
                <Button type="submit" disabled={!outcomeChoice || saveOutcome.isPending}>{saveOutcome.isPending ? 'Saving…' : 'Save outcome'}</Button>
              </form>
            ) : <Button kind="tertiary" onClick={() => open('edit')}>Choose an operator</Button>}
          </Tile>
        ) : <InlineNotification kind="info" lowContrast hideCloseButton title="Outcome not recorded yet" subtitle="The run has ended; someone with job edit access records how it went." />)}
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
            <div><dt>Start</dt><dd>{formatDateTime(job.startsAt)}</dd></div>
            <div><dt>Runtime</dt><dd className="mj-cell-stack"><span>{formatDuration(job.durationSeconds)}</span><span className="mj-secondary">Ends {formatDateTime(job.endsAt)}</span></dd></div>
            <div><dt>Source</dt><dd>{job.run === 'automatic' ? 'From printer' : 'Manual'}{job.externalId && <><br /><span className="mj-secondary">{job.externalId}</span></>}</dd></div>
          </dl>
        </Tile>
        <Tile>
          <h2 className="mj-section-title">Run</h2>
          <div className="mj-stack">
            {job.run === 'automatic' && print ? (
              <>
                <div className="mj-inline">
                  <Tag type="green" size="md">From printer</Tag>
                  <PrintStateTag state={print.state} size="md" />
                </div>
                <p>
                  <CarbonLink as={Link} to={machineLogbookPaths.print(print.id)}>{print.displayId}</CarbonLink>
                  <span className="mj-secondary">{[print.fileName && ` · ${print.fileName}`, print.connectorName && ` · via ${print.connectorName}`].filter(Boolean).join('')}</span>
                </p>
                {print.state === 'printing' && printing.data && (
                  <ProgressBar label="Print progress" value={printing.data.progressPercent ?? 0} max={100} helperText={`${printing.data.progressPercent ?? 0} %${printing.data.estimatedEndAt ? ` · ends ~${formatTime(printing.data.estimatedEndAt)}` : ''}`} />
                )}
              </>
            ) : manualRunning ? (
              <>
                <div className="mj-inline"><Tag type="blue" size="md" renderIcon={InProgress}>Running · manual</Tag></div>
                <ProgressBar label="Run progress" value={progress} max={100} helperText={`${progress} % · Ends ${formatTime(job.endsAt)}`} />
                <p className="mj-secondary">The run ends at the defined time, or earlier if it is cancelled.</p>
              </>
            ) : (
              <>
                <div className="mj-inline"><Tag type="gray" size="md">Manual run</Tag></div>
                <p className="mj-secondary">{job.outcome === 'cancelled' ? 'Cancelled' : 'Recorded by hand'}; ended {formatDateTime(job.endsAt)}. No printer data is linked.</p>
              </>
            )}
            {job.run === 'manual' && (canEdit && (manualRunning || canLinkPrint)) && (
              <div className="mj-inline">
                {manualRunning && <Button kind="danger--tertiary" size="md" renderIcon={StopOutline} onClick={() => open('cancel')}>Cancel run</Button>}
                {canLinkPrint && <Button kind="tertiary" size="md" renderIcon={LinkIcon} onClick={() => open('link')}>Link printer data</Button>}
              </div>
            )}
          </div>
        </Tile>
        <div className="mj-detail-layout">
          <div className="mj-stack">
            <DataTable rows={usageRows} headers={usageHeaders} size="md">
              {({ rows, headers, getTableProps, getHeaderProps, getRowProps }) => (
                <TableContainer title="Material usage" description="Everything consumed by this job.">
                  <Table {...getTableProps()} aria-label="Material usage">
                    <TableHead>
                      <TableRow>{headers.map((header) => { const { key, ...props } = getHeaderProps({ header }); return <TableHeader key={key} {...props}>{header.header}</TableHeader>; })}</TableRow>
                    </TableHead>
                    <TableBody>
                      {rows.length === 0 && <TableRow><TableCell colSpan={3}>No material recorded.</TableCell></TableRow>}
                      {rows.map((row) => {
                        const usage = job.usages.find((item) => item.id === row.id);
                        if (!usage) return null;
                        const { key, ...props } = getRowProps({ row });
                        return (
                          <TableRow key={key} {...props}>
                            <TableCell><div className="mj-cell-stack"><span>{usage.materialName}</span><span className="mj-secondary">{usage.category}</span></div></TableCell>
                            <TableCell>{row.cells[1].value}</TableCell>
                            <TableCell>{row.cells[2].value} {usage.quantityBasis === 'estimated' && <Tag type="outline" size="sm">Estimated</Tag>}</TableCell>
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
      <UsageFormModal open={dialog === 'usage'} onClose={close} job={job} />
      <LinkPrintModal open={dialog === 'link'} onClose={close} job={job} />
      <DestructiveActionDialog
        open={dialog === 'cancel'} title="Cancel this run?" confirmLabel="Cancel run" cancelLabel="Keep running" pending={cancelRun.isPending} onClose={close}
        error={cancelRun.isError ? errorText(cancelRun.error, 'The run could not be cancelled. Reload the page and try again.') : undefined}
        onConfirm={() => cancelRun.mutate()}
      >
        <p>The run ends now and the job is marked cancelled. The price is recalculated for the shortened runtime.</p>
      </DestructiveActionDialog>
      <PriceAdjustmentModal open={dialog === 'override'} onClose={close} job={job} />
      <DestructiveActionDialog
        open={dialog === 'clear'} title="Remove price adjustment?" confirmLabel="Remove adjustment" pending={clearAdjustment.isPending} onClose={close}
        error={clearAdjustment.isError ? errorText(clearAdjustment.error, 'The adjustment could not be removed. Reload the page and try again.') : undefined}
        onConfirm={() => clearAdjustment.mutate()}
      >
        <p>{job.priceAdjustment ? adjustmentSummary(job.priceAdjustment) : 'The adjustment'} is removed and the calculated price of {formatMoney(calculated)} applies again. Existing order charges stay unchanged.</p>
      </DestructiveActionDialog>
      <DestructiveActionDialog
        open={dialog === 'unlink'} title="Unlink this print?" confirmLabel="Unlink" pending={unlinkPrint.isPending} onClose={close}
        error={unlinkPrint.isError ? errorText(unlinkPrint.error, 'The print could not be unlinked. Reload the page and try again.') : undefined}
        onConfirm={() => unlinkPrint.mutate()}
      >
        <p>{job.displayId} keeps its current times and material, but becomes a manual run again. {print?.displayId ?? 'The print'} shows as unlinked.</p>
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
