import './styles.scss';
import './jobs.scss';
import { Button, ComboBox, InlineNotification, Select, SelectItem, StructuredListBody, StructuredListWrapper, TextArea, Tile } from '@carbon/react';
import { ArrowLeft, ArrowRight } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { confirmMachineJob } from '../../api/generated/machine-jobs/machine-jobs';
import type { BillingParty, MachineJob, MachineJobList, MachineJobOutcome, Operator } from '../../api/generated/models';
import { DetailRow, DetailSection } from '../../app/DetailSection';
import { PageShell } from '../../app/PageShell';
import { EmptyState, ErrorState, FullPageLoading } from '../../app/PageState';
import { useUnsavedChanges } from '../../app/useUnsavedChanges';
import { UnsavedChangesDialog } from '../../app/UnsavedChangesDialog';
import { useCurrentUser } from '../auth/auth';
import { canLookupJobParties, hasPermission, PermissionId } from '../auth/permissions';
import { formatDateTime, formatDuration } from './formatting';
import { billingPartySearchQuery, machineLogbookKeys, operatorSearchQuery, reviewQuery } from './queries';

type ReviewForm = { customer: BillingParty | null; operator: Operator | null; outcome: MachineJobOutcome; notes: string };
const fieldsFor = (job?: MachineJob): ReviewForm => ({ customer: job?.customer ?? null, operator: job?.operator ?? null, outcome: job?.outcome === 'unknown' ? 'successful' : job?.outcome ?? 'successful', notes: job?.notes ?? '' });

export function ReviewPage() {
  const currentUser = useCurrentUser();
  const client = useQueryClient();
  const queue = useQuery(reviewQuery());
  // Retain the selected ID and its edit version even when the queue changes.
  const [selection, setSelection] = useState<MachineJob | null>(null);
  const [customerSearch, setCustomerSearch] = useState('');
  const [operatorSearch, setOperatorSearch] = useState('');
  const form = useForm<ReviewForm>({ defaultValues: fieldsFor() });
  const guard = useUnsavedChanges({ isDirty: form.formState.isDirty });
  const canLookup = canLookupJobParties(currentUser);
  const parties = useQuery({ ...billingPartySearchQuery(customerSearch), enabled: canLookup && selection !== null });
  const operators = useQuery({ ...operatorSearchQuery(operatorSearch), enabled: canLookup && selection !== null });
  useEffect(() => {
    if (!selection && queue.data?.items[0]) {
      setSelection(queue.data.items[0]);
      form.reset(fieldsFor(queue.data.items[0]));
    }
  }, [queue.data, selection, form]);
  const current = queue.data?.items.find((item) => item.id === selection?.id);
  const job = current ?? selection;
  const versionChanged = !!current && current.version !== selection?.version;
  const mutation = useMutation({
    mutationFn: (values: ReviewForm) => {
      if (!selection || !current || !values.customer || !values.operator) throw new Error('Select a current job, customer and operator');
      return confirmMachineJob(selection.id, { expectedVersion: selection.version, customer: { kind: values.customer.kind, id: values.customer.id }, operatorPersonId: values.operator.personId, outcome: values.outcome, notes: values.notes || null, pricingGroupId: null });
    },
    onSuccess: async () => {
      const confirmedId = selection?.id;
      const oldItems = queue.data?.items ?? [];
      const oldIndex = oldItems.findIndex((item) => item.id === confirmedId);
      const preferredId = oldItems[oldIndex + 1]?.id;
      form.reset(fieldsFor());
      // Remove the confirmed record immediately; a stale/failed refetch cannot select it again.
      client.setQueryData<MachineJobList>(machineLogbookKeys.review(), (data) => data ? { ...data, items: data.items.filter((item) => item.id !== confirmedId) } : data);
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
      const items = client.getQueryData<MachineJobList>(machineLogbookKeys.review())?.items.filter((item) => item.id !== confirmedId) ?? [];
      client.setQueryData<MachineJobList>(machineLogbookKeys.review(), (data) => data ? { ...data, items } : data);
      const next = items.find((item) => item.id === preferredId) ?? items[0] ?? null;
      setSelection(next); form.reset(fieldsFor(next ?? undefined)); setCustomerSearch(''); setOperatorSearch('');
    },
    onError: async () => { await client.invalidateQueries({ queryKey: machineLogbookKeys.review() }); },
  });
  const select = (next: MachineJob) => {
    if (mutation.isPending || next.id === selection?.id) return;
    guard.requestDiscard(() => { setSelection(next); form.reset(fieldsFor(next)); setCustomerSearch(''); setOperatorSearch(''); mutation.reset(); });
  };
  if (queue.isPending) return <FullPageLoading label="Loading review queue" />;
  if (!queue.data) return <ErrorState message="The review queue could not be loaded." onRetry={() => queue.refetch()} />;
  const index = queue.data.items.findIndex((item) => item.id === selection?.id);
  const canCounterSale = [PermissionId.orderswrite, PermissionId.ordersfinalize, PermissionId.ordersread, PermissionId.paymentsread, PermissionId.paymentsrecord].every((permission) => hasPermission(currentUser, permission));
  return <PageShell title="Review queue" description={`${queue.data.items.length} remaining`} breadcrumbs={[{ label: 'Workshop', to: '/machine-logbook' }, { label: 'Review' }]} actions={canCounterSale && current && <Button as={Link} to={`/orders/counter-sale?job=${current.id}`}>Anonymous counter sale</Button>} width="wide" className="machine-logbook-page review-page jobs-page">
    {!job && <EmptyState title="Review queue is clear" description="Automatically detected jobs that need assignment will appear here." />}
    {job && <div className="review-layout"><aside className="review-list" aria-label="Jobs awaiting review">{queue.data.items.map((item) => <Button type="button" kind="ghost" key={item.id} className={item.id === selection?.id ? 'review-list__item review-list__item--active' : 'review-list__item'} aria-pressed={item.id === selection?.id} disabled={mutation.isPending} onClick={() => select(item)}><strong>{item.machine.name}</strong><span>{formatDateTime(item.startsAt)}</span><span>{item.usages.map((usage) => `${usage.quantity} ${usage.unit} ${usage.materialName}`).join(', ') || 'No material usage'}</span></Button>)}</aside>
      <section className="review-detail" aria-label={`Review ${job.displayId}`}><div className="review-detail__heading"><div><h2>{job.machine.name}</h2><p>{job.displayId} · {formatDateTime(job.startsAt)} · {formatDuration(job.durationSeconds)}</p></div><div className="button-cluster"><Button hasIconOnly kind="ghost" size="sm" renderIcon={ArrowLeft} iconDescription="Previous job" disabled={mutation.isPending || index <= 0} onClick={() => select(queue.data.items[index - 1])} /><Button hasIconOnly kind="ghost" size="sm" renderIcon={ArrowRight} iconDescription="Next job" disabled={mutation.isPending || index < 0 || index >= queue.data.items.length - 1} onClick={() => select(queue.data.items[index + 1])} /></div></div>
        {!current && <InlineNotification kind="warning" lowContrast hideCloseButton title="This job is no longer awaiting review" subtitle="Your inputs are retained. Select another job to continue; this job cannot be confirmed again." />}
        {versionChanged && <><InlineNotification kind="warning" lowContrast hideCloseButton title="The job changed" subtitle="The machine data below is current. Your assignments and notes are retained. Review the changes before using the current version." /><Button kind="tertiary" disabled={mutation.isPending} onClick={() => { if (current) { setSelection(current); mutation.reset(); } }}>Use current version</Button></>}
        {queue.isError && <ErrorState message="The review queue could not be refreshed. Your draft is retained." onRetry={() => queue.refetch()} />}
        <DetailSection title="Machine data (auto-detected)"><StructuredListWrapper isCondensed><StructuredListBody><DetailRow label="Machine" value={job.machine.name} /><DetailRow label="Start" value={formatDateTime(job.startsAt)} /><DetailRow label="End" value={formatDateTime(job.endsAt)} /><DetailRow label="Duration" value={formatDuration(job.durationSeconds)} /><DetailRow label="Material" value={job.usages.map((usage) => usage.materialName).join(', ') || '—'} /><DetailRow label="Quantity" value={job.usages.map((usage) => `${usage.quantity} ${usage.unit}`).join(', ') || '—'} /></StructuredListBody></StructuredListWrapper></DetailSection>
        <form onSubmit={form.handleSubmit((values) => { if (!mutation.isPending && current && !versionChanged && canLookup) mutation.mutate(values); })} className="review-form">
          {!canLookup && <InlineNotification kind="info" hideCloseButton title="Assignment lookup unavailable" subtitle="Your permissions do not allow customer or operator lookup." />}
          <Tile><Controller control={form.control} name="customer" rules={{ required: true }} render={({ field, fieldState }) => <ComboBox id="review-customer" titleText="Customer" disabled={!canLookup} items={parties.data?.items ?? []} itemToString={(item) => item?.displayName ?? ''} selectedItem={field.value} onInputChange={setCustomerSearch} onChange={({ selectedItem }) => field.onChange(selectedItem ?? null)} invalid={fieldState.invalid} invalidText="Select a customer to confirm" placeholder="Search people or organizations…" />} /></Tile>
          <Tile><Controller control={form.control} name="operator" rules={{ required: true }} render={({ field, fieldState }) => <ComboBox id="review-operator" titleText="Operator" disabled={!canLookup} items={operators.data?.items ?? []} itemToString={(item) => item?.displayName ?? ''} selectedItem={field.value} onInputChange={setOperatorSearch} onChange={({ selectedItem }) => field.onChange(selectedItem ?? null)} invalid={fieldState.invalid} invalidText="Select an enabled operator to confirm" placeholder="Search users…" />} /></Tile>
          {(parties.isError || operators.isError) && <ErrorState message="Assignment choices could not be loaded." onRetry={() => { parties.refetch(); operators.refetch(); }} />}
          <Tile><Controller control={form.control} name="outcome" render={({ field }) => <Select id="review-outcome" labelText="Outcome" {...field}><SelectItem value="successful" text="Successful" /><SelectItem value="partial_failure" text="Partial failure" /><SelectItem value="failed" text="Failed" /><SelectItem value="cancelled" text="Cancelled" /><SelectItem value="unknown" text="Unknown" /></Select>} /></Tile>
          <Tile><TextArea id="review-notes" labelText="Notes" placeholder="Optional notes…" {...form.register('notes')} /></Tile>
          {mutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Job was not confirmed" subtitle="Stock may be insufficient or the job changed. Your assignments and notes are retained. Review the latest machine data before retrying." />}
          <div className="review-submit"><Button type="submit" disabled={mutation.isPending || !current || versionChanged || !canLookup}>{mutation.isPending ? 'Confirming…' : 'Confirm job'}</Button><span>{index >= 0 ? `${index + 1} of ${queue.data.items.length}` : 'No longer in queue'}</span></div>
        </form>
      </section></div>}
    <UnsavedChangesDialog guard={guard} />
  </PageShell>;
}
