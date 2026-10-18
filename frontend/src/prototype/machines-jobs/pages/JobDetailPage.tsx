import { useState } from 'react';
import {
  Accordion, AccordionItem, Button, Select, SelectItem, DataTable, Link as CarbonLink, InlineNotification, OverflowMenu, OverflowMenuItem, ProgressBar, Table, TableBody, TableCell, TableContainer,
  TableHead, TableHeader, TableRow, Tag, Tile,
} from '@carbon/react';
import { Edit, InProgress, Link as LinkIcon, StopOutline } from '@carbon/icons-react';
import { Link, useParams } from 'react-router-dom';
import { formatDateTime as formatZoned } from '../../../app/dateTime';
import { DestructiveActionDialog } from '../../../app/DestructiveActionDialog';
import { PageShell } from '../../../app/PageShell';
import { EmptyState } from '../../../app/PageState';
import { QueryBoundary } from '../components/QueryBoundary';
import { BillingTag, effectivePrice, formatDuration, formatMoney, formatTime, isManualRunning, JobRowStatusTag, jobStatus, PrintStateTag, runProgress, outcomeLabel, outcomeOptions, jobName, adjustmentSummary } from '../derived';
import { JobFormModal } from '../dialogs/JobFormModal';
import { PriceAdjustmentModal } from '../dialogs/PriceAdjustmentModal';
import { RunThumb } from '../components/RunPreview';
import { runsOfJob } from '../runs';
import { LinkPrintModal } from '../dialogs/LinkPrintModal';
import { UsageFormModal } from '../dialogs/UsageFormModal';
import { orderOfJob } from '../sales/logic';
import { useNow, useSimulatedMutation, useSimulatedQuery, useStore } from '../store';
import type { Job, JobOutcome } from '../types';
import '../styles/jobs.scss';

const usageHeaders = [{ key: 'material', header: 'Material' }, { key: 'source', header: 'Source' }, { key: 'quantity', header: 'Quantity' }];

function JobDetail({ job }: { job: Job }) {
  const store = useStore();
  const [dialog, setDialog] = useState<'edit' | 'usage' | 'override' | 'clear' | 'cancel' | 'link' | null>(null);
  const close = () => setDialog(null);
  const machine = store.machines.find((item) => item.id === job.machineId);
  const now = useNow();
  const print = job.printId ? store.prints.find((item) => item.id === job.printId) : undefined;
  const runs = runsOfJob(job.id, store.prints).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const unlinkedPrints = store.prints.filter((item) => item.machineId === job.machineId && item.linkedJobId === null);
  const canEdit = store.can('machine_jobs.edit');
  const canOverride = store.can('machine_jobs.override_price');
  const manualRunning = isManualRunning(job, now);
  const status = jobStatus(job, print, now);
  const missingRules = job.pricingSnapshot?.rules.filter((rule) => rule.missing) ?? [];
  const price = effectivePrice(job);
  const { mutate: clearOverride, pending: clearing } = useSimulatedMutation(() => store.setPriceAdjustment(job.id, null));
  const { mutate: cancelRun, pending: cancelling } = useSimulatedMutation(() => store.cancelRun(job.id));
  const [outcomeChoice, setOutcomeChoice] = useState<JobOutcome | ''>('');
  const { mutate: saveOutcome, pending: savingOutcome } = useSimulatedMutation((outcome: JobOutcome) => store.setOutcome(job.id, outcome));

  const primary = canEdit ? <Button renderIcon={Edit} onClick={() => setDialog('edit')}>Edit job</Button> : null;
  const menuItems = [
    canEdit && <OverflowMenuItem key="usage" itemText="Edit material usage" onClick={() => setDialog('usage')} />,
    canOverride && <OverflowMenuItem key="override" itemText={job.priceAdjustment ? 'Change price adjustment' : 'Adjust price'} onClick={() => setDialog('override')} />,
    canOverride && job.priceAdjustment && <OverflowMenuItem key="clear" itemText="Remove price adjustment" onClick={() => setDialog('clear')} />,
  ].filter(Boolean);
  const canLinkPrint = canEdit && unlinkedPrints.length > 0;

  const usageRows = job.usages.map((usage) => ({
    id: usage.id, material: usage.materialName,
    source: usage.ownership === 'external' ? 'Customer material' : usage.spoolDisplayId ? `Spool ${usage.spoolDisplayId}${usage.spoolId && store.spools.some((spool) => spool.id === usage.spoolId) ? '' : ' (deleted)'}` : 'Makerspace stock',
    quantity: `${usage.quantity} ${usage.unit}`,
  }));

  return (
    <PageShell
      title={jobName(job, print)} titleAdornment={<JobRowStatusTag status={status} />} width="wide"
      description={[jobName(job, print) !== job.displayId && job.displayId, machine?.name ?? 'Unknown machine', formatZoned(job.startsAt)].filter(Boolean).join(' · ')}
      breadcrumbs={[{ label: 'Workshop', to: '/' }, { label: 'Jobs', to: '/jobs' }]}
      actions={<>{primary}{menuItems.length > 0 && <OverflowMenu aria-label="More job actions" iconDescription="More job actions" flipped>{menuItems}</OverflowMenu>}</>}
    >
      <div className="mj-stack">
        {status === 'needs_outcome' && (canEdit ? (
          <Tile className="mj-outcome-prompt">
            <div>
              <h2 className="mj-section-title">Record the outcome</h2>
              <p>The run ended {formatZoned(job.endsAt)}. How did it go?</p>
            </div>
            <form
              className="mj-outcome-prompt__form"
              onSubmit={async (event) => {
                event.preventDefault();
                if (!outcomeChoice) return;
                await saveOutcome(outcomeChoice);
                store.notify({ kind: 'success', title: 'Outcome recorded', subtitle: `${job.displayId} is marked ${outcomeLabel(outcomeChoice).toLowerCase()}.` });
              }}
            >
              <Select id="job-outcome-prompt" labelText="Outcome" value={outcomeChoice} onChange={(event) => setOutcomeChoice(event.target.value as JobOutcome)}>
                <SelectItem value="" text="Select an outcome" hidden />
                {outcomeOptions.filter((option) => option.id !== 'unknown').map((option) => <SelectItem key={option.id} value={option.id} text={option.label} />)}
              </Select>
              <Button type="submit" disabled={!outcomeChoice || savingOutcome}>{savingOutcome ? 'Saving…' : 'Save outcome'}</Button>
            </form>
          </Tile>
        ) : <InlineNotification kind="info" lowContrast hideCloseButton title="Outcome not recorded yet" subtitle="The run has ended; someone with job edit access records how it went." />)}
        {job.pricingStatus === 'incomplete' && (
          <InlineNotification
            kind="error" lowContrast hideCloseButton title="Price incomplete"
            subtitle={`No pricing rate for ${missingRules.map((rule) => rule.label).join(', ') || 'this job'}${store.can('machine_jobs.override_price') ? '. You can set the price manually.' : '.'}`}
          />
        )}
        <Tile>
          <dl className="mj-facts">
            <div><dt>Customer</dt><dd>{job.customer ? <>{job.customer.displayName}<br /><span className="mj-secondary">{job.customer.pricingGroup}</span></> : '—'}</dd></div>
            <div><dt>Operator</dt><dd>{job.operator?.displayName ?? '—'}</dd></div>
            <div><dt>Start</dt><dd>{formatZoned(job.startsAt)}</dd></div>
            <div><dt>Runtime</dt><dd className="mj-cell-stack"><span>{formatDuration(job.durationSeconds)}</span><span className="mj-secondary">Ends {formatZoned(job.endsAt)}</span></dd></div>
            <div><dt>Source</dt><dd>{job.run === 'automatic' ? 'From printer' : 'Manual'}{job.externalId && <><br /><span className="mj-secondary">{job.externalId}</span></>}</dd></div>
          </dl>
        </Tile>
        <Tile>
          <h2 className="mj-section-title">{runs.length > 1 ? 'Runs' : 'Run'}</h2>
          <div className="mj-stack">
            {job.run === 'automatic' && print ? (
              <>
                <div className="mj-inline">
                  <Tag type="green" size="md">From printer</Tag>
                  {runs.length > 1 && <Tag type="outline" size="md">{runs.length} runs</Tag>}
                </div>
                {runs.map((run) => (
                  <div key={run.id} className="mj-stack">
                    <div className="mj-title-with-thumb">
                      <RunThumb run={run} />
                      <p>
                        <CarbonLink as={Link} to={`/jobs/runs/${run.id}`}>{run.displayId}</CarbonLink>
                        <span className="mj-secondary"> · {run.fileName} · via {run.connectorName}</span>
                      </p>
                      <PrintStateTag state={run.state} size="sm" />
                    </div>
                    {run.state === 'printing' && (
                      <ProgressBar label="Run progress" value={run.progress ?? 0} max={100} helperText={`${run.progress ?? 0} %${run.estimatedEndAt ? ` · ends ~${formatTime(run.estimatedEndAt)}` : ''}`} />
                    )}
                  </div>
                ))}
              </>
            ) : manualRunning ? (
              <>
                <div className="mj-inline"><Tag type="blue" size="md" renderIcon={InProgress}>Running · manual</Tag></div>
                <ProgressBar label="Run progress" value={runProgress(job, now)} max={100} helperText={`${runProgress(job, now)} % · Ends ${formatTime(job.endsAt)}`} />
                <p className="mj-secondary">The run ends at the defined time, or earlier if it is cancelled.</p>
              </>
            ) : (
              <>
                <div className="mj-inline"><Tag type="gray" size="md">Manual run</Tag></div>
                <p className="mj-secondary">{job.outcome === 'cancelled' ? 'Cancelled' : 'Recorded by hand'}; ended {formatZoned(job.endsAt)}. No recorded run is assigned.</p>
              </>
            )}
            {job.run === 'manual' && (canEdit && (manualRunning || canLinkPrint)) && (
              <div className="mj-inline">
                {manualRunning && <Button kind="danger--tertiary" size="md" renderIcon={StopOutline} onClick={() => setDialog('cancel')}>Cancel run</Button>}
                {canLinkPrint && <Button kind="tertiary" size="md" renderIcon={LinkIcon} onClick={() => setDialog('link')}>Assign recorded run</Button>}
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
              <p className="mj-notes">{job.notes ?? <span className="mj-secondary">No notes.</span>}</p>
            </Tile>
          </div>
          <Tile>
            <h3 className="mj-section-title">Price &amp; billing</h3>
            <div className="mj-price">{formatMoney(price)}</div>
            <div className="mj-inline"><BillingTag job={job} />{job.pricingStatus === 'pending' && <span className="mj-secondary">Price pending</span>}</div>
            <dl className="mj-price-details">
              <div><dt>Calculated</dt><dd>{formatMoney(job.calculatedPrice)}</dd></div>
              {job.priceAdjustment && (() => {
                const difference = price != null && job.calculatedPrice != null ? price - job.calculatedPrice : null;
                return <>
                  <div><dt>{adjustmentSummary(job.priceAdjustment)}</dt><dd>{difference == null ? '—' : `${difference > 0 ? '+' : difference < 0 ? '−' : '±'}${formatMoney(Math.abs(difference))}`}</dd></div>
                  <div><dt>Final</dt><dd><strong>{formatMoney(price)}</strong></dd></div>
                  <div><dt>Reason</dt><dd>{job.priceAdjustment.reason}</dd></div>
                </>;
              })()}
            </dl>
            {job.pricingSnapshot && (
              <Accordion size="md">
                <AccordionItem title="How this was calculated">
                  <dl className="mj-price-details">
                    <div><dt>Pricing group</dt><dd>{job.pricingSnapshot.pricingGroupName}</dd></div>
                    <div><dt>Revision</dt><dd>{job.pricingSnapshot.revision}</dd></div>
                    <div><dt>Captured</dt><dd>{formatZoned(job.pricingSnapshot.capturedAt)}</dd></div>
                  </dl>
                  <ul className="mj-rule-list">
                    {job.pricingSnapshot.rules.map((rule) => (
                      <li key={rule.label}><span>{rule.label}</span>{rule.missing ? <Tag type="red" size="sm">No rate</Tag> : <span>{rule.rate} / {rule.unit}</span>}</li>
                    ))}
                  </ul>
                </AccordionItem>
              </Accordion>
            )}
            {store.can('orders.read') && (() => {
              const held = orderOfJob(job, store.orders);
              return (
                <div className="mj-stack">
                  <h4 className="mj-section-title">Order</h4>
                  {held ? (
                    <>
                      <p><CarbonLink as={Link} to={`/sales/orders/${held.order.id}`}>{held.order.reference}</CarbonLink> <span className="mj-secondary">{held.claimed ? 'charges this job' : 'draft that contains this job'}</span></p>
                      {job.order?.sourceChanged && <InlineNotification kind="warning" lowContrast hideCloseButton title="Changed after charge" subtitle="This job changed after it was charged. The order amount has not been updated. Use Correct order on the order to change the charge." />}
                    </>
                  ) : job.pricingStatus === 'complete' && job.customer && !isManualRunning(job, now) && job.outcome !== 'unknown'
                    ? <p className="mj-secondary">Not on an order. It is ready to bill: select it in the Jobs list and choose Add to order.</p>
                    : <p className="mj-secondary">Not on an order.</p>}
                </div>
              );
            })()}
          </Tile>
        </div>
      </div>
      <JobFormModal open={dialog === 'edit'} onClose={close} mode="edit" job={job} />
      <UsageFormModal open={dialog === 'usage'} onClose={close} job={job} />
      <LinkPrintModal open={dialog === 'link'} onClose={close} job={job} />
      <DestructiveActionDialog
        open={dialog === 'cancel'} title="Cancel this run?" confirmLabel="Cancel run" cancelLabel="Keep running" pending={cancelling} onClose={close}
        onConfirm={async () => { await cancelRun(); store.notify({ kind: 'success', title: 'Run cancelled', subtitle: `${job.displayId} ended now and its price was recalculated.` }); close(); }}
      >
        <p>The run ends now and the job is marked cancelled. The price is recalculated for the shortened runtime.</p>
      </DestructiveActionDialog>
      <PriceAdjustmentModal open={dialog === 'override'} onClose={close} job={job} />
      <DestructiveActionDialog
        open={dialog === 'clear'} title="Remove price adjustment?" confirmLabel="Remove adjustment" pending={clearing} onClose={close}
        onConfirm={async () => { await clearOverride(); store.notify({ kind: 'success', title: 'Price adjustment removed', subtitle: `${job.displayId} uses the calculated price again.` }); close(); }}
      >
        <p>{job.priceAdjustment ? adjustmentSummary(job.priceAdjustment) : 'The adjustment'} is removed and the calculated price of {formatMoney(job.calculatedPrice)} applies again. Existing order charges stay unchanged.</p>
      </DestructiveActionDialog>
    </PageShell>
  );
}

export function JobDetailPage() {
  const { jobId } = useParams();
  const query = useSimulatedQuery((data) => data.jobs.find((job) => job.id === jobId) ?? null, null as Job | null);
  const crumbs = [{ label: 'Workshop', to: '/' }, { label: 'Jobs', to: '/jobs' }];
  if (query.status === 'success' && query.data) return <JobDetail job={query.data} />;
  return (
    <PageShell title={query.status === 'success' ? 'Job not found' : 'Job'} breadcrumbs={crumbs} width="wide">
      <QueryBoundary query={query} errorMessage="The job could not be loaded.">
        <EmptyState title="This job does not exist" description="It may have been removed, or the link is incorrect." action={<Button kind="tertiary" as={Link} to="/jobs">Back to jobs</Button>} />
      </QueryBoundary>
    </PageShell>
  );
}
