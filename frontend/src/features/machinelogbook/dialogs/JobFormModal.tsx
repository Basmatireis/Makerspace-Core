import { useMemo, useState } from 'react';
import { Button, ComboBox, ComposedModal, FormGroup, InlineNotification, ModalBody, ModalFooter, ModalHeader, NumberInput, Select, SelectItem, Stack, TextArea, TextInput } from '@carbon/react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Controller, FormProvider, useForm, useFormContext } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { createMachineJob, updateMachineJob } from '../../../api/generated/machine-jobs/machine-jobs';
import { createMachineJobFromPrint } from '../../../api/generated/prints/prints';
import type { MachineJob, MachineJobOutcome, Operator } from '../../../api/generated/models';
import { DateTimeInput } from '../../../app/DateInput';
import { instantToZonedDateTimeValue, isZonedDateTimeValue, zonedDateTimeValueToISO } from '../../../app/dateTime';
import { UnsavedChangesDialog } from '../../../app/UnsavedChangesDialog';
import { useUnsavedChanges } from '../../../app/useUnsavedChanges';
import { useCurrentUser } from '../../auth/auth';
import { canLookupJobParties } from '../../auth/permissions';
import { billingPartySearchQuery, machineLogbookKeys, machinesQuery, operatorSearchQuery, printQuery } from '../queries';
import { formatDateTime, formatDuration } from '../shared/format';
import { machineLogbookPaths } from '../shared/paths';
import { nameFromFile, outcomeOptions } from '../shared/status';
import { useNotify } from '../shared/toasts';
import { useCan } from '../shared/useCan';
import { blankUsage, matchesName, saveError, toUsageInputs, type JobInitialValues, type PartyValues, type UsagesValues } from './jobFormHelpers';
import { UsageRowsEditor } from './UsageFormModal';
import '../styles/jobs.scss';

export type { JobInitialValues } from './jobFormHelpers';

function JobPartyFields({ idPrefix, showOutcome, current }: { idPrefix: string; showOutcome: boolean; current?: MachineJob }) {
  const currentUser = useCurrentUser();
  const canLookup = canLookupJobParties(currentUser);
  const { control, register, formState } = useFormContext<PartyValues>();
  const [customerSearch, setCustomerSearch] = useState('');
  const [operatorSearch, setOperatorSearch] = useState('');
  const parties = useQuery({ ...billingPartySearchQuery(customerSearch), enabled: canLookup, placeholderData: keepPreviousData });
  const operators = useQuery({ ...operatorSearchQuery(operatorSearch), enabled: canLookup, placeholderData: keepPreviousData });
  const lookupFailed = parties.isError || operators.isError;
  // A confirmed job whose customer was deleted keeps no customer unless one is chosen; everything else needs one.
  const customerRequired = !current || !!current.customer || current.reviewState === 'needs_review';
  return (
    <Stack gap={6}>
      {!canLookup && <p className="mj-secondary">Customer and operator lookups are unavailable with your permissions. Existing assignments are kept.</p>}
      {lookupFailed && <InlineNotification kind="error" lowContrast hideCloseButton title="Some choices could not be loaded" subtitle="Check your catalog permissions and try again." />}
      <div className="mj-form-grid">
        <Controller control={control} name="customer" rules={{ required: customerRequired }} render={({ field, fieldState }) => (
          <ComboBox autoAlign
            id={`${idPrefix}-customer`} titleText="Customer" placeholder="Search people or organizations" disabled={!canLookup}
            items={parties.data?.items ?? (current?.customer ? [current.customer] : [])}
            itemToString={(item) => item?.displayName ?? ''} shouldFilterItem={matchesName} selectedItem={field.value}
            onInputChange={setCustomerSearch}
            onChange={({ selectedItem }) => field.onChange(selectedItem ?? null)} invalid={fieldState.invalid} invalidText="Select a customer."
          />
        )} />
        <Controller control={control} name="operator" rules={{ required: true }} render={({ field, fieldState }) => (
          <ComboBox autoAlign
            id={`${idPrefix}-operator`} titleText="Operator" placeholder="Search operators" disabled={!canLookup}
            items={operators.data?.items ?? (current?.operator ? [current.operator] : [])}
            itemToString={(item) => item?.displayName ?? ''} shouldFilterItem={matchesName} selectedItem={field.value}
            onInputChange={setOperatorSearch}
            onChange={({ selectedItem }) => field.onChange(selectedItem ?? null)} invalid={fieldState.invalid} invalidText="Select an operator."
          />
        )} />
      </div>
      {showOutcome && (
        <Select
          id={`${idPrefix}-outcome`} labelText="Outcome" invalid={!!formState.errors.outcome} invalidText="Select how the run ended."
          {...register('outcome', { validate: (value) => !showOutcome || (!!value && value !== 'unknown') })}
        >
          <SelectItem value="" text="Select an outcome" hidden />
          {outcomeOptions.filter((option) => option.id !== 'unknown').map((option) => <SelectItem key={option.id} value={option.id} text={option.label} />)}
        </Select>
      )}
      <TextArea id={`${idPrefix}-notes`} labelText="Notes" rows={3} {...register('notes')} />
    </Stack>
  );
}

type Values = PartyValues & UsagesValues & { title: string; machineId: string; startsAt: string; runtimeHours: number; runtimeMinutes: number };

// The backend stores start and end; the form asks for start + runtime and derives the end.
function endFrom(startsAt: string, hours: number, minutes: number): string | null {
  if (!isZonedDateTimeValue(startsAt)) return null;
  const total = (Number(hours) || 0) * 60 + (Number(minutes) || 0);
  return total > 0 ? new Date(new Date(zonedDateTimeValueToISO(startsAt)).getTime() + total * 60_000).toISOString() : null;
}

type JobFormProps = { onClose: () => void; mode: 'create' | 'edit'; job?: MachineJob; initialValues?: JobInitialValues; printId?: string; onSaved?: (job: MachineJob) => void };

function JobForm({ onClose, mode, job, initialValues, printId, onSaved }: JobFormProps) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const notify = useNotify();
  const can = useCan();
  const fromPrint = mode === 'create' && !!printId;
  const printQueryResult = useQuery({ ...printQuery(printId ?? ''), enabled: fromPrint });
  const source = job
    ? { title: job.title, machineId: job.machine.id, startsAt: job.startsAt, endsAt: job.endsAt, customer: job.customer ?? null, operator: job.operator ?? null, outcome: job.outcome, notes: job.notes }
    : initialValues;
  const printFile = job?.print?.fileName ?? initialValues?.printFileName ?? printQueryResult.data?.fileName;
  const printName = printFile ? nameFromFile(printFile) : null;
  const now = useMemo(() => Date.now(), []);
  const runtimeMinutes = source?.startsAt && source.endsAt
    ? Math.max(1, Math.round((new Date(source.endsAt).getTime() - new Date(source.startsAt).getTime()) / 60_000))
    : 60;
  const initialStart = instantToZonedDateTimeValue(source?.startsAt ?? new Date(now - 3_600_000));
  const form = useForm<Values>({
    defaultValues: {
      title: source?.title ?? '',
      machineId: source?.machineId ?? '',
      startsAt: initialStart,
      runtimeHours: Math.floor(runtimeMinutes / 60),
      runtimeMinutes: runtimeMinutes % 60,
      customer: source?.customer ?? null,
      operator: source?.operator ?? null,
      // Never preselect an outcome for an existing job that has none recorded yet.
      outcome: (source?.outcome && source.outcome !== 'unknown' ? source.outcome : mode === 'create' ? 'successful' : '') as MachineJobOutcome | '',
      notes: source?.notes ?? '',
      usages: mode === 'create' ? initialValues?.usages?.length ? initialValues.usages : fromPrint ? [] : [blankUsage()] : [],
    },
  });
  const guard = useUnsavedChanges({ isDirty: form.formState.isDirty });
  const [error, setError] = useState<string | null>(null);

  const canReadMachines = can('machines.read');
  const machines = useQuery({ ...machinesQuery({ page: 1, pageSize: 100 }), enabled: canReadMachines && !fromPrint });
  const machineChoices = useMemo(() => {
    const items = (machines.data?.items ?? []).filter((machine) => machine.status !== 'retired' || machine.id === job?.machine.id).map((machine) => ({ id: machine.id, name: machine.name }));
    if (job && !items.some((item) => item.id === job.machine.id)) items.unshift({ id: job.machine.id, name: job.machine.name });
    if (fromPrint && printQueryResult.data) items.unshift({ id: printQueryResult.data.machineId, name: printQueryResult.data.machineName });
    return items;
  }, [machines.data, job, fromPrint, printQueryResult.data]);

  const mutation = useMutation({
    mutationFn: async ({ values, startsAt, endsAt, outcome }: { values: Values; startsAt: string; endsAt: string; outcome: MachineJobOutcome }) => {
      const title = values.title.trim() || null;
      const notes = values.notes.trim() || null;
      const customer = values.customer ? { kind: values.customer.kind, id: values.customer.id } : undefined;
      const operatorPersonId = (values.operator as Operator).personId;
      if (mode === 'edit' && job) {
        return updateMachineJob(job.id, { machineId: values.machineId, startsAt, endsAt, customer, operatorPersonId, outcome, title, notes, expectedVersion: job.version });
      }
      if (printId) {
        // Machine, start and end come from the print.
        return createMachineJobFromPrint(printId, { title, customer: customer!, operatorPersonId, outcome, notes, usages: toUsageInputs(values.usages) });
      }
      return createMachineJob({ machineId: values.machineId, startsAt, endsAt, customer: customer!, operatorPersonId, outcome, title, notes, usages: toUsageInputs(values.usages) });
    },
    onSuccess: async (saved, { values }) => {
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
      const repriced = mode === 'edit' && job && (job.machine.id !== values.machineId || job.customer?.id !== values.customer?.id);
      if (fromPrint) {
        const printLabel = printQueryResult.data?.displayId;
        notify({ kind: 'success', title: 'Job created and linked', subtitle: printLabel ? `${saved.displayId} uses the data from ${printLabel}.` : saved.displayId });
      } else {
        notify({ kind: 'success', title: mode === 'create' ? `${saved.displayId} created` : `${saved.displayId} updated`, subtitle: repriced ? 'Price recalculated.' : undefined });
      }
      guard.bypassAfterSubmit(() => {
        onClose();
        if (mode === 'create') { if (onSaved) onSaved(saved); else navigate(machineLogbookPaths.job(saved.id)); } else onSaved?.(saved);
      });
    },
    onError: (cause) => {
      const failure = saveError(cause);
      setError(failure.message);
      if (failure.field) form.setError(failure.field, { type: 'server', message: failure.message });
    },
  });
  const pending = mutation.isPending;

  const submit = form.handleSubmit((values) => {
    setError(null);
    // The form shows minutes only; untouched times keep the exact values the job has.
    const untouched = mode === 'edit' && !!job && values.startsAt === initialStart && Number(values.runtimeHours) === Math.floor(runtimeMinutes / 60) && Number(values.runtimeMinutes) === runtimeMinutes % 60;
    const endsAt = untouched ? job.endsAt : fromPrint ? initialValues?.endsAt ?? null : endFrom(values.startsAt, values.runtimeHours, values.runtimeMinutes);
    if (!endsAt) { setError('Enter a valid start time and a runtime longer than zero.'); return; }
    let startsAt: string;
    try {
      startsAt = untouched ? job.startsAt : fromPrint ? initialValues?.startsAt ?? new Date().toISOString() : zonedDateTimeValueToISO(values.startsAt);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Check the start time.');
      return;
    }
    // Outcome only exists once the run has ended.
    const outcome = new Date(endsAt).getTime() > Date.now() ? 'unknown' : values.outcome as MachineJobOutcome;
    mutation.mutate({ values, startsAt, endsAt, outcome });
  }, (errors) => setError(errors.startsAt ? 'Enter a valid start time (DD.MM.YYYY, HH:MM).' : errors.runtimeHours || errors.runtimeMinutes ? 'Enter a runtime longer than zero.' : 'Check the highlighted fields.'));
  const [watchedStart, watchedHours, watchedMinutes] = form.watch(['startsAt', 'runtimeHours', 'runtimeMinutes']);
  const previewEnd = fromPrint ? initialValues?.endsAt ?? null : endFrom(watchedStart, watchedHours, watchedMinutes);
  const endInFuture = !!previewEnd && new Date(previewEnd).getTime() > Date.now();
  const endsInFuture = previewEnd !== null && new Date(previewEnd).getTime() > now;
  const printRuntime = fromPrint && initialValues?.startsAt && initialValues.endsAt
    ? Math.max(0, Math.round((new Date(initialValues.endsAt).getTime() - new Date(initialValues.startsAt).getTime()) / 1000))
    : null;

  return (
    <>
      <ComposedModal open={!guard.dialogOpen} size="lg" preventCloseOnClickOutside selectorPrimaryFocus="#job-form-title" aria-label={mode === 'create' ? 'New job' : 'Edit job'} onClose={() => { if (!pending) guard.requestDiscard(onClose); return false; }}>
        <ModalHeader title={mode === 'create' ? 'New job' : 'Edit job'} label={job?.displayId} />
        <ModalBody hasForm>
          <FormProvider {...form}>
            <Stack gap={6}>
              <p>
                {mode === 'create'
                  ? fromPrint
                    ? 'The job is linked to the print: machine, start, end and material come from the printer. The price is calculated from the customer’s pricing group when saved.'
                    : 'Use this when a printer cannot report the print. The run is manual and priced from the customer’s pricing group when saved.'
                  : 'Changing customer or machine recalculates the price; existing order charges stay unchanged. Material usage is edited separately.'}
              </p>
              {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Job not saved" subtitle={error} />}
              <TextInput
                id="job-form-title" labelText="Name (optional)" placeholder="e.g. Gearbox housing for Jonas" maxLength={120}
                helperText={printName ? `Leave empty to show the printer's name “${printName}”.` : 'Leave empty to show the job number.'}
                {...form.register('title')}
              />
              {fromPrint ? (
                <TextInput id="job-form-machine" labelText="Machine" readOnly value={machineChoices[0]?.name ?? ''} helperText="From the printer." />
              ) : (
                <Controller control={form.control} name="machineId" rules={{ required: true }} render={({ field, fieldState }) => (
                  <Select id="job-form-machine" labelText="Machine" value={field.value} invalid={fieldState.invalid} invalidText="Select a machine." onChange={(event) => field.onChange(event.target.value)}>
                    <SelectItem value="" text={machines.isPending && canReadMachines ? 'Loading machines…' : 'Select a machine'} />
                    {machineChoices.map((machine) => <SelectItem key={machine.id} value={machine.id} text={machine.name} />)}
                  </Select>
                )} />
              )}
              {fromPrint ? (
                <div className="mj-form-grid">
                  <TextInput id="job-form-start-print" labelText="Start" readOnly value={initialValues?.startsAt ? formatDateTime(initialValues.startsAt) : ''} helperText="From the printer." />
                  <TextInput id="job-form-runtime-print" labelText="Runtime" readOnly value={printRuntime === null ? '' : formatDuration(printRuntime)} helperText={previewEnd ? `Ends ${formatDateTime(previewEnd)}` : undefined} />
                </div>
              ) : (
                <div className="mj-form-grid">
                  <Controller control={form.control} name="startsAt" rules={{ validate: (value) => isZonedDateTimeValue(value) || 'Enter a valid start time.' }} render={({ field }) => <DateTimeInput id="job-form-start" labelText="Start" value={field.value} onChange={field.onChange} required />} />
                  <FormGroup legendText="Runtime" className="mj-runtime">
                    <div className="mj-runtime__fields">
                      <Controller
                        control={form.control} name="runtimeHours"
                        rules={{ validate: (value, all) => (Number(value) || 0) * 60 + (Number(all.runtimeMinutes) || 0) > 0 }}
                        render={({ field }) => <NumberInput id="job-form-runtime-hours" label="Hours" min={0} max={999} step={1} value={field.value} invalid={!!form.formState.errors.runtimeHours} invalidText="Runtime must be longer than zero." onChange={(_event, { value }) => field.onChange(Number(value) || 0)} />}
                      />
                      <Controller
                        control={form.control} name="runtimeMinutes"
                        render={({ field }) => <NumberInput id="job-form-runtime-minutes" label="Minutes" min={0} max={59} step={1} value={field.value} onChange={(_event, { value }) => field.onChange(Number(value) || 0)} />}
                      />
                    </div>
                    <p className="cds--form__helper-text">{previewEnd ? `Ends ${formatDateTime(previewEnd)}` : 'Enter a start and a runtime.'}</p>
                    {endsInFuture && <p className="cds--form__helper-text">The end is in the future, so the job shows as running until then and can be cancelled early. The outcome is recorded once the run has ended.</p>}
                  </FormGroup>
                </div>
              )}
              <JobPartyFields idPrefix="job-form" showOutcome={!endInFuture} current={job} />
              {mode === 'create' && (
                <Stack gap={5}>
                  <div>
                    <h3 className="mj-section-title">Material usage</h3>
                    <p className="mj-secondary">Record everything consumed, including waste from failed outcomes. Stock is deducted when the job is saved.</p>
                  </div>
                  <UsageRowsEditor idPrefix="job-form-usage" />
                </Stack>
              )}
            </Stack>
          </FormProvider>
        </ModalBody>
        <ModalFooter>
          <Button kind="secondary" disabled={pending} onClick={() => guard.requestDiscard(onClose)}>Cancel</Button>
          <Button kind="primary" disabled={pending} onClick={submit}>{pending ? 'Saving…' : mode === 'create' ? 'Create job' : 'Save changes'}</Button>
        </ModalFooter>
      </ComposedModal>
      <UnsavedChangesDialog guard={guard} />
    </>
  );
}

/**
 * Create or edit a job. `printId` creates the job from an unlinked print (machine and times come from the print).
 * Create navigates to the new job unless `onSaved` is given.
 */
export function JobFormModal({ open, onClose, mode, job, initialValues, printId, onSaved }: {
  open: boolean; onClose: () => void; mode: 'create' | 'edit'; job?: MachineJob; initialValues?: JobInitialValues; printId?: string; onSaved?: (job: MachineJob) => void;
}) {
  return open ? <JobForm onClose={onClose} mode={mode} job={job} initialValues={initialValues} printId={printId} onSaved={onSaved} /> : null;
}
