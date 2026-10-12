import { CatalogFormModal } from './CatalogFormModal';
import { useLatestCallback } from '../../app/useLatestCallback';
import './styles.scss';
import './catalog.scss';
import { Renew } from '@carbon/icons-react';
import { Button, CodeSnippet, InlineNotification, Select, SelectItem, Stack, StructuredListBody, StructuredListWrapper, Tag, TextInput, Tile } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useParams } from 'react-router-dom';
import { createPrintAttempt, linkPrintAttemptJob, reconcilePrinterEvent, transitionPrintAttempt } from '../../api/generated/printing/printing';
import type { PrintAttempt, PrinterEvent } from '../../api/generated/models';
import { PageShell } from '../../app/PageShell';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { DetailRow, DetailSection } from '../../app/DetailSection';
import { RowActions } from '../../app/RowActions';
import { EmptyState, ErrorState, FullPageLoading } from '../../app/PageState';
import { useUnsavedChanges } from '../../app/useUnsavedChanges';
import { UnsavedChangesDialog } from '../../app/UnsavedChangesDialog';
import { newUUIDv7 } from '../../app/uuid';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { formatDateTime } from './formatting';
import { machineLogbookKeys, submissionQuery } from './queries';

type Dialog = 'link' | 'reconcile' | null;
type Fields = { jobId: string; jobVersion: number; ownership: 'makerspace' | 'external'; materialId: string; spoolId: string; externalMaterialName: string; quantity: string; quantityBasis: 'actual' | 'estimated' };
const defaults: Fields = { jobId: '', jobVersion: 1, ownership: 'makerspace', materialId: '', spoolId: '', externalMaterialName: '', quantity: '', quantityBasis: 'actual' };
type TransitionState = 'accepted' | 'printing' | 'completed' | 'failed' | 'cancelled';

export function PrintSubmissionDetailPage() {
  const { submissionId = '' } = useParams();
  const currentUser = useCurrentUser();
  const canManage = hasPermission(currentUser, PermissionId.print_submissionsmanage);
  const canReadJobs = hasPermission(currentUser, PermissionId.machine_jobsread);
  const canReadMachines = hasPermission(currentUser, PermissionId.machinesread);
  const canEditJobs = hasPermission(currentUser, PermissionId.machine_jobsedit);
  const client = useQueryClient();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [selectedAttempt, setSelectedAttempt] = useState<PrintAttempt | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<PrinterEvent | null>(null);
  const [transitionTarget, setTransitionTarget] = useState<{ item: PrintAttempt; state: 'failed' | 'cancelled' } | null>(null);
  const [rejectTarget, setRejectTarget] = useState<PrinterEvent | null>(null);
  const form = useForm<Fields>({ defaultValues: defaults, shouldUnregister: true });
  const ownership = form.watch('ownership');
  const guard = useUnsavedChanges({ isDirty: dialog !== null && form.formState.isDirty, onDiscard: () => { form.reset(defaults); setDialog(null); } });
  const query = useQuery(submissionQuery(submissionId));
  const refresh = async () => client.invalidateQueries({ queryKey: machineLogbookKeys.all });
  const attempt = useMutation({ mutationFn: () => createPrintAttempt(submissionId, { machineId: query.data!.machineId, operationKey: newUUIDv7(), expectedSubmissionVersion: query.data!.version }), onSuccess: refresh });
  const transition = useMutation({ mutationFn: ({ item, state }: { item: PrintAttempt; state: TransitionState }) => transitionPrintAttempt(item.id, { state, expectedVersion: item.version }), onSuccess: async () => { setTransitionTarget(null); await refresh(); } });
  const link = useMutation({ mutationFn: (values: Fields) => linkPrintAttemptJob(selectedAttempt!.id, { machineJobId: values.jobId, expectedVersion: selectedAttempt!.version }), onSuccess: async () => { form.reset(defaults); setDialog(null); await refresh(); } });
  const reconcile = useMutation({
    mutationFn: ({ values, decision, event = selectedEvent! }: { values: Fields; decision: 'accepted' | 'rejected'; event?: PrinterEvent }) => reconcilePrinterEvent(event.id, decision === 'rejected' ? { decision, operationKey: newUUIDv7(), machineJobId: null, expectedJobVersion: null, usages: [] } : { decision, operationKey: newUUIDv7(), machineJobId: values.jobId, expectedJobVersion: Number(values.jobVersion), usages: [{ ownership: values.ownership, materialId: values.ownership === 'makerspace' ? values.materialId || null : null, spoolId: values.ownership === 'makerspace' ? values.spoolId || null : null, externalMaterialName: values.ownership === 'external' ? values.externalMaterialName : null, quantity: values.quantity, quantityBasis: values.quantityBasis }] }),
    onSuccess: async () => { form.reset(defaults); setDialog(null); setRejectTarget(null); await refresh(); },
  });
  const busy = attempt.isPending || transition.isPending || link.isPending || reconcile.isPending;
  const close = useLatestCallback(() => { if (!busy) guard.requestDiscard(() => { form.reset(defaults); setDialog(null); }); });
  if (query.isPending) return <FullPageLoading label="Loading print submission" />;
  if (!query.data) return <ErrorState message="This print submission could not be loaded." onRetry={() => query.refetch()} />;
  const item = query.data;
  const openLink = (value: PrintAttempt) => { link.reset(); reconcile.reset(); setSelectedAttempt(value); form.reset(defaults); setDialog('link'); };
  const openReconcile = (event: PrinterEvent, value: PrintAttempt) => { reconcile.reset(); link.reset(); setSelectedEvent(event); setSelectedAttempt(value); form.reset({ ...defaults, jobId: value.machineJobId ?? '' }); setDialog('reconcile'); };
  const changeState = (value: PrintAttempt, state: TransitionState) => { if (!busy && canManage) transition.mutate({ item: value, state }); };
  return <PageShell title={item.displayId} description={`${item.title} · ${item.machineName}`} breadcrumbs={[{ label: 'Workshop', to: '/machine-logbook' }, { label: 'Print submissions', to: '/machine-logbook/print-submissions' }, { label: item.displayId }]} titleAdornment={<Tag type={item.state === 'completed' ? 'green' : item.state === 'failed' ? 'red' : 'blue'}>{item.state}</Tag>} actions={canManage && item.state !== 'completed' && item.state !== 'cancelled' && <Button renderIcon={item.attempts.length ? Renew : undefined} disabled={busy} onClick={() => { if (!busy) attempt.mutate(); }}>{item.attempts.length ? 'Start another attempt' : 'Start attempt'}</Button>} width="wide" className="machine-logbook-page detail-page machine-catalog">
    <div className="detail-grid">
      <DetailSection title="Submission"><StructuredListWrapper isCondensed><StructuredListBody><DetailRow label="Customer" value={item.customer ? item.customerDisplayName ?? 'Unknown customer' : 'Unassigned'} /><DetailRow label="Printer" value={canReadMachines ? <Link to={`/machine-logbook/machines/${item.machineId}/printer`}>{item.machineName}</Link> : item.machineName} /><DetailRow label="Created" value={formatDateTime(item.createdAt)} /><DetailRow label="Notes" value={item.notes || '—'} /></StructuredListBody></StructuredListWrapper></DetailSection>
      <DetailSection title="Declared filament">{item.declarations.length === 0 ? <p className="section-description">No filament declared.</p> : <ul className="summary-list">{item.declarations.map((declaration) => <li key={declaration.id}><span><strong>{declaration.materialName}</strong><small>{declaration.ownership}{declaration.spoolDisplayId ? ` · ${declaration.spoolDisplayId}` : ''}</small></span><span>{declaration.estimatedQuantityG ? `${declaration.estimatedQuantityG} g` : 'No estimate'}</span></li>)}</ul>}</DetailSection>
    </div>
    <Stack gap={6}>{item.attempts.map((value) => <DetailSection key={value.id} title={`Attempt ${value.attemptNumber}`} meta={<Tag type={value.state === 'completed' ? 'green' : value.state === 'failed' ? 'red' : 'blue'}>{value.state}</Tag>} action={canManage && <RowActions label={`Actions for attempt ${value.attemptNumber}`}>
      {!value.machineJobId && canReadJobs && canEditJobs && <Button kind="ghost" size="sm" disabled={busy} onClick={() => openLink(value)}>Link job</Button>}
      {value.state === 'queued' && <Button size="sm" disabled={busy} onClick={() => changeState(value, 'accepted')}>Accept</Button>}
      {(value.state === 'queued' || value.state === 'accepted') && <Button size="sm" disabled={busy} onClick={() => changeState(value, 'printing')}>Mark printing</Button>}
      {value.state === 'printing' && <Button size="sm" disabled={busy} onClick={() => changeState(value, 'completed')}>Complete</Button>}
      {['queued', 'accepted', 'printing'].includes(value.state) && <><Button kind="danger--tertiary" size="sm" disabled={busy} onClick={() => { transition.reset(); setTransitionTarget({ item: value, state: 'failed' }); }}>Fail</Button><Button kind="danger--tertiary" size="sm" disabled={busy} onClick={() => { transition.reset(); setTransitionTarget({ item: value, state: 'cancelled' }); }}>Cancel attempt</Button></>}
    </RowActions>}>
      <StructuredListWrapper isCondensed><StructuredListBody><DetailRow label="Printer" value={value.machineName} /><DetailRow label="Machine job" value={value.machineJobId ? (canReadJobs ? <Link to={`/machine-logbook/jobs/${value.machineJobId}`}>{value.machineJobId}</Link> : value.machineJobId) : 'Not linked'} /><DetailRow label="Accepted" value={value.acceptedAt ? formatDateTime(value.acceptedAt) : '—'} /><DetailRow label="Started" value={value.startedAt ? formatDateTime(value.startedAt) : '—'} /><DetailRow label="Ended" value={value.endedAt ? formatDateTime(value.endedAt) : '—'} /></StructuredListBody></StructuredListWrapper>
      <h3>Printer events</h3>{value.events.length === 0 ? <p className="section-description">No connector events received.</p> : <Stack gap={3}>{value.events.map((event) => <Tile key={event.id}><div className="section-heading"><div><strong>{event.kind}</strong><p className="section-description">{formatDateTime(event.occurredAt)} · {event.sourceId}</p></div><Tag type={event.reconciliationState === 'pending' ? 'purple' : 'gray'}>{event.reconciliationState}</Tag></div><CodeSnippet type="multi">{JSON.stringify(event.payload, null, 2)}</CodeSnippet>{canManage && event.kind === 'consumption_report' && event.reconciliationState === 'pending' && <><RowActions label="Printer event actions"><Button kind="danger--tertiary" size="sm" disabled={busy} onClick={() => { reconcile.reset(); setRejectTarget(event); }}>Reject</Button>{canEditJobs && <Button size="sm" disabled={busy || !value.machineJobId} title={!value.machineJobId ? 'Link a machine job before reviewing usage.' : undefined} onClick={() => openReconcile(event, value)}>Review usage</Button>}</RowActions>{canEditJobs && !value.machineJobId && <p className="section-description">Link a machine job before reviewing reported usage.</p>}</>}</Tile>)}</Stack>}
    </DetailSection>)}</Stack>
    {item.attempts.length === 0 && <EmptyState title="No attempts" description="Start an attempt when staff accepts this print for the selected machine." />}
    {(attempt.isError || (transition.isError && !transitionTarget)) && <InlineNotification kind="error" lowContrast hideCloseButton title="Print workflow was not updated" subtitle="Reload the submission and retry with its current version." />}
    {dialog !== null && <CatalogFormModal open={!guard.dialogOpen} selectorPrimaryFocus={dialog === 'link' ? '#attempt-job-id' : '#job-version'} modalHeading={dialog === 'link' ? 'Link machine job' : 'Review reported filament usage'} primaryButtonText={busy ? 'Saving…' : dialog === 'link' ? 'Link job' : 'Accept usage'} secondaryButtonText="Cancel" primaryButtonDisabled={busy} preventCloseOnClickOutside onRequestClose={close} onRequestSubmit={form.handleSubmit((values) => { if (busy || !canManage || !canEditJobs) return; if (dialog === 'link' && canReadJobs) link.mutate(values); else if (dialog === 'reconcile') reconcile.mutate({ values, decision: 'accepted' }); })}><Stack gap={5}>
      <TextInput id="attempt-job-id" labelText="Machine job ID" readOnly={dialog === 'reconcile'} invalid={!!form.formState.errors.jobId} invalidText="Enter a machine job ID." {...form.register('jobId', { required: true })} />
      {dialog === 'reconcile' && <><p>Accepting replaces the linked job’s recorded usages with the reviewed usage below. Check its current version and stock before saving.</p><TextInput id="job-version" type="number" min={1} labelText="Current machine job version" invalid={!!form.formState.errors.jobVersion} invalidText="Enter a positive whole-number version." {...form.register('jobVersion', { valueAsNumber: true, required: true, min: 1, validate: Number.isInteger })} /><Select id="usage-ownership" labelText="Filament ownership" {...form.register('ownership')}><SelectItem value="makerspace" text="Makerspace stock" /><SelectItem value="external" text="Customer / external" /></Select>{ownership === 'makerspace' ? <><TextInput id="usage-material" labelText="Material ID" invalid={!!form.formState.errors.materialId} invalidText="Enter a material ID." {...form.register('materialId', { required: true })} /><TextInput id="usage-spool" labelText="Spool ID (optional)" {...form.register('spoolId')} /></> : <TextInput id="usage-external" labelText="External filament description" invalid={!!form.formState.errors.externalMaterialName} invalidText="Describe the external filament." {...form.register('externalMaterialName', { required: true })} />}<TextInput id="usage-quantity" labelText="Reviewed quantity" invalid={!!form.formState.errors.quantity} invalidText="Enter a positive quantity." {...form.register('quantity', { required: true, validate: (value) => Number(value) > 0 })} /><Select id="usage-basis" labelText="Quantity basis" {...form.register('quantityBasis')}><SelectItem value="actual" text="Actual" /><SelectItem value="estimated" text="Estimated" /></Select></>}
      {(link.isError || reconcile.isError) && <InlineNotification kind="error" lowContrast hideCloseButton title="Review not saved" subtitle="Check the job version, usage, and remaining spool stock. Your inputs have been retained." />}
    </Stack></CatalogFormModal>}
    <UnsavedChangesDialog guard={guard} />
    <DestructiveActionDialog open={!!transitionTarget} title={transitionTarget?.state === 'cancelled' ? 'Cancel print attempt?' : 'Mark print attempt failed?'} confirmLabel={transitionTarget?.state === 'cancelled' ? 'Cancel attempt' : 'Mark failed'} pending={transition.isPending} error={transition.isError ? 'This attempt changed or could not be updated. Reload and retry.' : undefined} onClose={() => setTransitionTarget(null)} onConfirm={() => { if (transitionTarget) changeState(transitionTarget.item, transitionTarget.state); }}><p>This records the attempt as {transitionTarget?.state} and marks the submission failed so another attempt can be started. The attempt, job and printer-event history are retained.</p><p>This action does not stop the physical printer. Stop it separately if it is still printing.</p></DestructiveActionDialog>
    <DestructiveActionDialog open={!!rejectTarget} title="Reject reported usage?" confirmLabel="Reject usage" pending={reconcile.isPending} error={reconcile.isError ? 'The event is no longer pending or could not be updated. Reload and retry.' : undefined} onClose={() => setRejectTarget(null)} onConfirm={() => { if (rejectTarget) reconcile.mutate({ values: defaults, decision: 'rejected', event: rejectTarget }); }}>The event is retained as rejected. Its reported consumption will not be applied to the job or inventory.</DestructiveActionDialog>
  </PageShell>;
}
