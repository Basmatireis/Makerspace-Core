import { Renew } from '@carbon/icons-react';
import { Button, CodeSnippet, InlineNotification, Modal, Select, SelectItem, Stack, Tag, TextInput, Tile } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useParams } from 'react-router-dom';
import { createPrintAttempt, linkPrintAttemptJob, reconcilePrinterEvent, transitionPrintAttempt } from '../../api/generated/printing/printing';
import type { PrintAttempt, PrinterEvent } from '../../api/generated/models';
import { PageShell } from '../../app/PageShell';
import { ErrorState, FullPageLoading } from '../../app/PageState';
import { newUUIDv7 } from '../../app/uuid';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { formatDateTime } from './formatting';
import { machineLogbookKeys, submissionQuery } from './queries';

type Dialog = 'link' | 'reconcile' | null;
type Fields = { jobId: string; jobVersion: number; ownership: 'makerspace' | 'external'; materialId: string; spoolId: string; externalMaterialName: string; quantity: string; quantityBasis: 'actual' | 'estimated' };

export function PrintSubmissionDetailPage() {
  const { submissionId = '' } = useParams();
  const currentUser = useCurrentUser();
  const client = useQueryClient();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [selectedAttempt, setSelectedAttempt] = useState<PrintAttempt | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<PrinterEvent | null>(null);
  const form = useForm<Fields>({ defaultValues: { jobVersion: 1, ownership: 'makerspace', quantityBasis: 'actual' } });
  const ownership = form.watch('ownership');
  const query = useQuery(submissionQuery(submissionId));
  const refresh = async () => client.invalidateQueries({ queryKey: machineLogbookKeys.all });
  const attempt = useMutation({ mutationFn: () => createPrintAttempt(submissionId, { machineId: query.data!.machineId, operationKey: newUUIDv7(), expectedSubmissionVersion: query.data!.version }), onSuccess: refresh });
  const transition = useMutation({ mutationFn: ({ item, state }: { item: PrintAttempt; state: 'accepted' | 'printing' | 'completed' | 'failed' | 'cancelled' }) => transitionPrintAttempt(item.id, { state, expectedVersion: item.version }), onSuccess: refresh });
  const link = useMutation({ mutationFn: (values: Fields) => linkPrintAttemptJob(selectedAttempt!.id, { machineJobId: values.jobId, expectedVersion: selectedAttempt!.version }), onSuccess: async () => { setDialog(null); await refresh(); } });
  const reconcile = useMutation({
    mutationFn: ({ values, decision, event = selectedEvent! }: { values: Fields; decision: 'accepted' | 'rejected'; event?: PrinterEvent }) => reconcilePrinterEvent(event.id, decision === 'rejected' ? { decision, operationKey: newUUIDv7(), machineJobId: null, expectedJobVersion: null, usages: [] } : { decision, operationKey: newUUIDv7(), machineJobId: values.jobId, expectedJobVersion: Number(values.jobVersion), usages: [{ ownership: values.ownership, materialId: values.ownership === 'makerspace' ? values.materialId || null : null, spoolId: values.ownership === 'makerspace' ? values.spoolId || null : null, externalMaterialName: values.ownership === 'external' ? values.externalMaterialName : null, quantity: values.quantity, quantityBasis: values.quantityBasis }] }),
    onSuccess: async () => { setDialog(null); await refresh(); },
  });
  if (query.isPending) return <FullPageLoading label="Loading print submission" />;
  if (query.isError) return <ErrorState message="This print submission could not be loaded." onRetry={() => query.refetch()} />;
  const item = query.data;
  const canManage = hasPermission(currentUser, PermissionId.print_submissionsmanage);
  const openLink = (value: PrintAttempt) => { setSelectedAttempt(value); form.reset({ jobId: '', jobVersion: 1, ownership: 'makerspace', materialId: '', spoolId: '', externalMaterialName: '', quantity: '', quantityBasis: 'actual' }); setDialog('link'); };
  const openReconcile = (event: PrinterEvent, value: PrintAttempt) => { setSelectedEvent(event); setSelectedAttempt(value); form.reset({ jobId: value.machineJobId ?? '', jobVersion: 1, ownership: 'makerspace', materialId: '', spoolId: '', externalMaterialName: '', quantity: '', quantityBasis: 'actual' }); setDialog('reconcile'); };
  return <PageShell title={item.displayId} description={`${item.title} · ${item.machineName}`} breadcrumbs={[{ label: 'Machines', to: '/machine-logbook' }, { label: 'Print submissions', to: '/machine-logbook/print-submissions' }, { label: item.displayId }]} actions={<><Tag type={item.state === 'completed' ? 'green' : item.state === 'failed' ? 'red' : 'blue'}>{item.state}</Tag>{canManage && item.state !== 'completed' && item.state !== 'cancelled' && <Button renderIcon={item.attempts.length ? Renew : undefined} disabled={attempt.isPending} onClick={() => attempt.mutate()}>{item.attempts.length ? 'Start another attempt' : 'Start attempt'}</Button>}</>} width="wide" className="machine-logbook-page detail-page">
    <div className="detail-grid">
      <Tile><h2>Submission</h2><dl className="amount-list"><div><dt>Customer</dt><dd>{item.customer ? `${item.customer.kind} · ${item.customer.id}` : 'Unassigned'}</dd></div><div><dt>Printer</dt><dd><Link to={`/machine-logbook/machines/${item.machineId}/printer`}>{item.machineName}</Link></dd></div><div><dt>Created</dt><dd>{formatDateTime(item.createdAt)}</dd></div><div><dt>Notes</dt><dd>{item.notes || '—'}</dd></div></dl></Tile>
      <Tile><h2>Declared filament</h2>{item.declarations.length === 0 ? <p className="section-description">No filament declared.</p> : <ul className="summary-list">{item.declarations.map((declaration) => <li key={declaration.id}><span><strong>{declaration.materialName}</strong><small>{declaration.ownership}{declaration.spoolDisplayId ? ` · ${declaration.spoolDisplayId}` : ''}</small></span><span>{declaration.estimatedQuantityG ? `${declaration.estimatedQuantityG} g` : 'No estimate'}</span></li>)}</ul>}</Tile>
      {item.attempts.map((value) => <Tile key={value.id}><div className="section-heading"><div><h2>Attempt {value.attemptNumber}</h2><Tag type={value.state === 'completed' ? 'green' : value.state === 'failed' ? 'red' : 'blue'}>{value.state}</Tag></div>{canManage && <div className="button-cluster">{!value.machineJobId && <Button kind="ghost" size="sm" onClick={() => openLink(value)}>Link job</Button>}{value.state === 'queued' && <Button size="sm" onClick={() => transition.mutate({ item: value, state: 'accepted' })}>Accept</Button>}{(value.state === 'queued' || value.state === 'accepted') && <Button size="sm" onClick={() => transition.mutate({ item: value, state: 'printing' })}>Mark printing</Button>}{value.state === 'printing' && <><Button size="sm" onClick={() => transition.mutate({ item: value, state: 'completed' })}>Complete</Button><Button kind="danger--tertiary" size="sm" onClick={() => transition.mutate({ item: value, state: 'failed' })}>Fail</Button></>}</div>}</div>
        {value.machineJobId && <p>Machine job: <Link to={`/machine-logbook/jobs/${value.machineJobId}`}>{value.machineJobId}</Link></p>}
        <h3>Printer events</h3>{value.events.length === 0 ? <p className="section-description">No connector events received.</p> : <Stack gap={3}>{value.events.map((event) => <Tile key={event.id}><div className="section-heading"><div><strong>{event.kind}</strong><p className="section-description">{formatDateTime(event.occurredAt)} · {event.sourceId}</p></div><Tag type={event.reconciliationState === 'pending' ? 'purple' : 'gray'}>{event.reconciliationState}</Tag></div><CodeSnippet type="multi">{JSON.stringify(event.payload, null, 2)}</CodeSnippet>{canManage && event.reconciliationState === 'pending' && <div className="button-cluster"><Button kind="danger--tertiary" size="sm" onClick={() => reconcile.mutate({ values: form.getValues(), decision: 'rejected', event })}>Reject</Button><Button size="sm" onClick={() => openReconcile(event, value)}>Review usage</Button></div>}</Tile>)}</Stack>}
      </Tile>)}
      {item.attempts.length === 0 && <Tile><h2>No attempts</h2><p>Start an attempt when staff accepts this print for the selected machine.</p></Tile>}
    </div>
    {(attempt.isError || transition.isError) && <InlineNotification kind="error" lowContrast hideCloseButton title="Print workflow was not updated" subtitle="Reload the submission and retry with its current version." />}
    <Modal open={dialog !== null} modalHeading={dialog === 'link' ? 'Link machine job' : 'Review reported filament usage'} primaryButtonText={dialog === 'link' ? 'Link job' : 'Accept usage'} secondaryButtonText="Cancel" primaryButtonDisabled={link.isPending || reconcile.isPending} onRequestClose={() => setDialog(null)} onRequestSubmit={form.handleSubmit((values) => dialog === 'link' ? link.mutate(values) : reconcile.mutate({ values, decision: 'accepted' }))}><Stack gap={5}>
      <TextInput id="attempt-job-id" labelText="Machine job ID" {...form.register('jobId', { required: true })} />
      {dialog === 'reconcile' && <><TextInput id="job-version" type="number" labelText="Current machine job version" {...form.register('jobVersion', { valueAsNumber: true, required: true })} /><Select id="usage-ownership" labelText="Filament ownership" {...form.register('ownership')}><SelectItem value="makerspace" text="Makerspace stock" /><SelectItem value="external" text="Customer / external" /></Select>{ownership === 'makerspace' ? <><TextInput id="usage-material" labelText="Material ID" {...form.register('materialId', { required: true })} /><TextInput id="usage-spool" labelText="Spool ID (optional)" {...form.register('spoolId')} /></> : <TextInput id="usage-external" labelText="External filament description" {...form.register('externalMaterialName', { required: true })} />}<TextInput id="usage-quantity" labelText="Reviewed quantity" {...form.register('quantity', { required: true })} /><Select id="usage-basis" labelText="Quantity basis" {...form.register('quantityBasis')}><SelectItem value="actual" text="Actual" /><SelectItem value="estimated" text="Estimated" /></Select></>}
      {(link.isError || reconcile.isError) && <InlineNotification kind="error" lowContrast hideCloseButton title="Review not saved" subtitle="Check the job version, usage, and remaining spool stock." />}
    </Stack></Modal>
  </PageShell>;
}
