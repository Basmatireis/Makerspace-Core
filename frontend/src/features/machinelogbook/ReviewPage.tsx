import { Button, ComboBox, InlineNotification, Select, SelectItem, Stack, TextArea, Tile } from '@carbon/react';
import { ArrowLeft, ArrowRight } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { confirmMachineJob } from '../../api/generated/machine-jobs/machine-jobs';
import type { BillingParty, MachineJobOutcome, Operator } from '../../api/generated/models';
import { PageHeader } from '../../app/PageHeader';
import { ErrorState, FullPageLoading } from '../../app/PageState';
import { EmptyState } from './components';
import { formatDateTime, formatDuration } from './formatting';
import { billingPartySearchQuery, machineLogbookKeys, operatorSearchQuery, reviewQuery } from './queries';

type ReviewForm = { customer: BillingParty | null; operator: Operator | null; outcome: MachineJobOutcome; notes: string };

export function ReviewPage() {
  const client = useQueryClient();
  const queue = useQuery(reviewQuery());
  const [selected, setSelected] = useState(0);
  const [customerSearch, setCustomerSearch] = useState('');
  const [operatorSearch, setOperatorSearch] = useState('');
  const parties = useQuery(billingPartySearchQuery(customerSearch));
  const operators = useQuery(operatorSearchQuery(operatorSearch));
  const form = useForm<ReviewForm>({ defaultValues: { customer: null, operator: null, outcome: 'successful', notes: '' } });
  const job = queue.data?.items[selected];
  useEffect(() => { form.reset({ customer: null, operator: null, outcome: job?.outcome === 'unknown' ? 'successful' : job?.outcome ?? 'successful', notes: job?.notes ?? '' }); }, [form, job?.id, job?.notes, job?.outcome]);
  const mutation = useMutation({ mutationFn: (values: ReviewForm) => {
    if (!job || !values.customer || !values.operator) throw new Error('Customer and operator are required');
    return confirmMachineJob(job.id, { expectedVersion: job.version, customer: { kind: values.customer.kind, id: values.customer.id }, operatorPersonId: values.operator.personId, outcome: values.outcome, notes: values.notes || null, pricingGroupId: null });
  }, onSuccess: async () => { await client.invalidateQueries({ queryKey: machineLogbookKeys.all }); setSelected((current) => Math.min(current, Math.max((queue.data?.items.length ?? 1) - 2, 0))); }, onError: async () => { await client.invalidateQueries({ queryKey: machineLogbookKeys.review() }); } });
  if (queue.isPending) return <FullPageLoading label="Loading review queue" />;
  if (queue.isError) return <ErrorState message="The review queue could not be loaded." onRetry={() => queue.refetch()} />;
  if (queue.data.items.length === 0) return <Stack gap={7}><PageHeader title="Review queue" breadcrumbs={[{ label: 'Machine logbook', to: '/machine-logbook' }, { label: 'Review' }]} /><Tile><EmptyState title="Review queue is clear" description="Automatically detected jobs that need assignment will appear here." /></Tile></Stack>;

  const customerItems = parties.data?.items ?? [];
  const operatorItems = operators.data?.items ?? [];
  return <Stack gap={6} className="machine-logbook-page review-page">
    <PageHeader title="Review queue" description={`${queue.data.items.length} remaining`} breadcrumbs={[{ label: 'Machine logbook', to: '/machine-logbook' }, { label: 'Review' }]} />
    <div className="review-layout">
      <aside className="review-list" aria-label="Jobs awaiting review">{queue.data.items.map((item, index) => <button type="button" key={item.id} className={index === selected ? 'review-list__item review-list__item--active' : 'review-list__item'} onClick={() => setSelected(index)}><strong>{item.machine.name}</strong><span>{formatDateTime(item.startsAt)}</span><span>{item.usages.map((u) => `${u.quantity} ${u.unit} ${u.materialName}`).join(', ') || 'No material usage'}</span></button>)}</aside>
      <section className="review-detail">
        <div className="review-detail__heading"><div><h2>{job!.machine.name}</h2><p>{formatDateTime(job!.startsAt)} · {formatDuration(job!.durationSeconds)}</p></div><div className="button-cluster"><Button hasIconOnly kind="ghost" size="sm" renderIcon={ArrowLeft} iconDescription="Previous job" disabled={selected === 0} onClick={() => setSelected(selected - 1)} /><Button hasIconOnly kind="ghost" size="sm" renderIcon={ArrowRight} iconDescription="Next job" disabled={selected === queue.data.items.length - 1} onClick={() => setSelected(selected + 1)} /></div></div>
        <Tile><h3>Machine data (auto-detected)</h3><dl className="review-machine-data"><div><dt>Machine</dt><dd>{job!.machine.name}</dd></div><div><dt>Start</dt><dd>{formatDateTime(job!.startsAt)}</dd></div><div><dt>End</dt><dd>{formatDateTime(job!.endsAt)}</dd></div><div><dt>Duration</dt><dd>{formatDuration(job!.durationSeconds)}</dd></div><div><dt>Material</dt><dd>{job!.usages.map((u) => u.materialName).join(', ') || '—'}</dd></div><div><dt>Quantity</dt><dd>{job!.usages.map((u) => `${u.quantity} ${u.unit}`).join(', ') || '—'}</dd></div></dl></Tile>
        <form onSubmit={form.handleSubmit((values) => mutation.mutate(values))} className="review-form">
          <Tile><Controller control={form.control} name="customer" rules={{ required: true }} render={({ field, fieldState }) => <ComboBox id="review-customer" titleText="Customer" items={customerItems} itemToString={(item) => item?.displayName ?? ''} selectedItem={field.value} onInputChange={setCustomerSearch} onChange={({ selectedItem }) => field.onChange(selectedItem ?? null)} invalid={fieldState.invalid} invalidText="Select a customer to confirm" placeholder="Search people or organizations…" />} /></Tile>
          <Tile><Controller control={form.control} name="operator" rules={{ required: true }} render={({ field, fieldState }) => <ComboBox id="review-operator" titleText="Operator" items={operatorItems} itemToString={(item) => item?.displayName ?? ''} selectedItem={field.value} onInputChange={setOperatorSearch} onChange={({ selectedItem }) => field.onChange(selectedItem ?? null)} invalid={fieldState.invalid} invalidText="Select an enabled operator to confirm" placeholder="Search users…" />} /></Tile>
          <Tile><Controller control={form.control} name="outcome" render={({ field }) => <Select id="review-outcome" labelText="Outcome" {...field}><SelectItem value="successful" text="Successful" /><SelectItem value="partial_failure" text="Partial failure" /><SelectItem value="failed" text="Failed" /><SelectItem value="cancelled" text="Cancelled" /><SelectItem value="unknown" text="Unknown" /></Select>} /></Tile>
          <Tile><TextArea id="review-notes" labelText="Notes" placeholder="Optional notes…" {...form.register('notes')} /></Tile>
          {mutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Job was not confirmed" subtitle="Stock may be insufficient or the job changed. The latest queue has been loaded; review the values and retry." />}
          <div className="review-submit"><Button type="submit" disabled={mutation.isPending}>{mutation.isPending ? 'Confirming…' : 'Confirm job'}</Button><span>{selected + 1} of {queue.data.items.length}</span></div>
        </form>
      </section>
    </div>
  </Stack>;
}
