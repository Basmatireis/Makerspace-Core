import { getJobOrderAssociation } from '../../api/generated/orders/orders';
import { Link } from 'react-router-dom';
import { Button, DefinitionTooltip, Modal, Stack, StructuredListBody, StructuredListCell, StructuredListHead, StructuredListRow, StructuredListWrapper, Tag, TextInput, Tile } from '@carbon/react';
import { Money } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useParams } from 'react-router-dom';
import { clearMachineJobPriceOverride, overrideMachineJobPrice } from '../../api/generated/machine-jobs/machine-jobs';
import { PageShell } from '../../app/PageShell';
import { ErrorState, FullPageLoading } from '../../app/PageState';
import { PermissionId, hasPermission } from '../auth/permissions';
import { useCurrentUser } from '../auth/auth';
import { OutcomeTag } from './components';
import { formatDateTime, formatDuration, formatMoney } from './formatting';
import { jobQuery, machineLogbookKeys } from './queries';

type OverrideFields = { amount: string; reason: string };

export function JobDetailPage() {
  const { jobId = '' } = useParams();
  const currentUser = useCurrentUser();
  const client = useQueryClient();
  const query = useQuery(jobQuery(jobId));
  const association = useQuery({queryKey: ['orders', 'job-association', jobId], queryFn: () => getJobOrderAssociation(jobId), enabled: hasPermission(currentUser, PermissionId.ordersread)});
  const [overrideOpen, setOverrideOpen] = useState(false);
  const overrideForm = useForm<OverrideFields>();
  const refresh = async () => { await client.invalidateQueries({ queryKey: machineLogbookKeys.all }); };
  const overrideMutation = useMutation({ mutationFn: (values: OverrideFields) => overrideMachineJobPrice(jobId, { expectedVersion: query.data!.version, finalPrice: values.amount, reason: values.reason }), onSuccess: async () => { setOverrideOpen(false); await refresh(); } });
  const clearMutation = useMutation({ mutationFn: () => clearMachineJobPriceOverride(jobId, { expectedVersion: query.data!.version }), onSuccess: refresh });
  if (query.isPending) return <FullPageLoading label="Loading job" />;
  if (query.isError) return <ErrorState message="This job could not be loaded." onRetry={() => query.refetch()} />;
  const job = query.data;
  return <PageShell title={job.displayId} description={`${job.machine.name} · ${formatDateTime(job.startsAt)}`} breadcrumbs={[{ label: 'Machines', to: '/machine-logbook' }, { label: 'Jobs', to: '/machine-logbook/jobs' }, { label: job.displayId }]} actions={<><OutcomeTag outcome={job.outcome} />{job.source === 'automatic' && <Tag type="gray">Automatic</Tag>}</>} width="wide" className="machine-logbook-page detail-page">
    <div className="detail-grid">
      <DetailTile title="Machine & timing" rows={[['Machine', job.machine.name], ['Machine type', job.machine.machineType.name], ['Start', formatDateTime(job.startsAt)], ['End', formatDateTime(job.endsAt)], ['Duration', formatDuration(job.durationSeconds)], ['External ID', job.externalId ?? '—']]} />
      <DetailTile title="Customer & operator" rows={[['Customer', job.customer?.displayName ?? 'Deleted / unassigned'], ['Customer type', job.customer?.kind ?? '—'], ['Pricing group', job.pricingSnapshot?.pricingGroupName ?? '—'], ['Operator', job.operator?.displayName ?? 'Deleted / unassigned']]} />
      <Tile><h2>Material usage</h2>{job.usages.length === 0 ? <p className="section-description">No material usage recorded.</p> : <StructuredListWrapper><StructuredListHead><StructuredListRow head><StructuredListCell head>Material</StructuredListCell><StructuredListCell head>Category</StructuredListCell><StructuredListCell head>Quantity</StructuredListCell></StructuredListRow></StructuredListHead><StructuredListBody>{job.usages.map((usage) => <StructuredListRow key={usage.id}><StructuredListCell>{usage.materialName}</StructuredListCell><StructuredListCell>{usage.category}</StructuredListCell><StructuredListCell>{usage.quantity} {usage.unit}</StructuredListCell></StructuredListRow>)}</StructuredListBody></StructuredListWrapper>}</Tile>
      <Tile><div className="section-heading"><h2>Pricing</h2><div className="button-cluster">{hasPermission(currentUser, PermissionId.machine_jobsoverride_price) && <Button size="sm" kind="ghost" renderIcon={Money} onClick={() => { overrideForm.reset({ amount: job.finalPrice ?? job.calculatedPrice ?? '0', reason: '' }); setOverrideOpen(true); }}>Override price</Button>}</div></div>
        {job.pricingSnapshot && <div className="pricing-snapshot"><strong>Pricing snapshot revision {job.pricingSnapshot.revision}</strong><p>{job.pricingSnapshot.pricingGroupName} · captured {formatDateTime(job.pricingSnapshot.capturedAt)}</p><ul>{job.pricingSnapshot.rules.map((rule) => <li key={`${rule.kind}-${rule.label}-${rule.selector}-${rule.unit}`}><span>{rule.label}</span><span>{rule.missing ? 'Missing rule' : `€ ${rule.rate} / ${rule.unit}`}</span></li>)}</ul></div>}
        <dl className="amount-list"><div><dt>Calculated price</dt><dd>{formatMoney(job.calculatedPrice)}</dd></div><div><dt>Final price</dt><dd>{formatMoney(job.finalPrice)}</dd></div><div><dt><DefinitionTooltip definition="Final override when present; otherwise calculated price.">Effective amount</DefinitionTooltip></dt><dd><strong>{formatMoney(job.effectivePrice)}</strong></dd></div></dl>
        {job.priceOverrideReason && <p className="section-description">Override reason: {job.priceOverrideReason}</p>}{job.finalPrice != null && hasPermission(currentUser, PermissionId.machine_jobsoverride_price) && <Button kind="danger--tertiary" size="sm" disabled={clearMutation.isPending} onClick={() => clearMutation.mutate()}>Clear override</Button>}
      </Tile>
      <Tile><h2>Order association</h2>{association.data?.orderId ? <><Link to={`/orders/${association.data.orderId}`}>{association.data.orderReference}</Link><p>{association.data.sourceChanged ? "Job changed since charge capture. Correct the charge through Order reversal/replacement." : "Order charge is an immutable snapshot."}</p></> : <p>No active Order association.</p>}</Tile>
      <Tile><h2>Outcome & notes</h2><dl className="amount-list"><div><dt>Outcome</dt><dd><OutcomeTag outcome={job.outcome} /></dd></div><div><dt>Notes</dt><dd>{job.notes ?? '—'}</dd></div></dl></Tile>
    </div>
    <Modal open={overrideOpen} modalHeading="Override final price" primaryButtonText={overrideMutation.isPending ? 'Saving…' : 'Save override'} secondaryButtonText="Cancel" primaryButtonDisabled={overrideMutation.isPending} onRequestClose={() => setOverrideOpen(false)} onRequestSubmit={overrideForm.handleSubmit((values) => overrideMutation.mutate(values))}><Stack gap={5}><TextInput id="override-amount" labelText="Final price (€)" {...overrideForm.register('amount', { required: true })} /><TextInput id="override-reason" labelText="Reason" {...overrideForm.register('reason', { required: true })} />{overrideMutation.isError && <p className="form-error">The override could not be saved. Reload if the job changed.</p>}</Stack></Modal>
  </PageShell>;
}

function DetailTile({ title, rows }: { title: string; rows: Array<[string, string]> }) {
  return <Tile><h2>{title}</h2><StructuredListWrapper><StructuredListBody>{rows.map(([label, value]) => <StructuredListRow key={label}><StructuredListCell>{label}</StructuredListCell><StructuredListCell>{value}</StructuredListCell></StructuredListRow>)}</StructuredListBody></StructuredListWrapper></Tile>;
}
