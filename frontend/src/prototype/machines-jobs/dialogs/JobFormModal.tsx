import { useState } from 'react';
import { Button, ComboBox, ComposedModal, FormGroup, InlineNotification, ModalBody, ModalFooter, ModalHeader, NumberInput, Select, SelectItem, Stack, TextArea, TextInput } from '@carbon/react';
import { Controller, FormProvider, useForm, useFormContext } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { DateTimeInput } from '../../../app/DateInput';
import { instantToZonedDateTimeValue, isZonedDateTimeValue, zonedDateTimeValueToISO } from '../../../app/dateTime';
import { UnsavedChangesDialog } from '../../../app/UnsavedChangesDialog';
import { useUnsavedChanges } from '../../../app/useUnsavedChanges';
import { formatDateTime, nameFromFile, outcomeOptions } from '../derived';
import { lookups, useSimulatedMutation, useStore, type JobFactsInput } from '../store';
import type { Job, JobOutcome } from '../types';
import { blankUsage, matchesName, toUsageInputs, type JobInitialValues, type PartyValues, type UsageRow, type UsagesValues } from './jobFormHelpers';
import { UsageRowsEditor } from './UsageFormModal';
import '../styles/jobs.scss';

export function JobPartyFields({ idPrefix, showOutcome = true }: { idPrefix: string; showOutcome?: boolean }) {
  const { control, register, formState } = useFormContext<PartyValues>();
  return (
    <Stack gap={6}>
      <div className="mj-form-grid">
        <Controller control={control} name="customer" rules={{ required: true }} render={({ field, fieldState }) => (
          <ComboBox autoAlign
            id={`${idPrefix}-customer`} titleText="Customer" placeholder="Search people or organizations" items={lookups.people}
            itemToString={(item) => item?.displayName ?? ''} shouldFilterItem={matchesName} selectedItem={field.value}
            onChange={({ selectedItem }) => field.onChange(selectedItem ?? null)} invalid={fieldState.invalid} invalidText="Select a customer."
          />
        )} />
        <Controller control={control} name="operator" rules={{ required: true }} render={({ field, fieldState }) => (
          <ComboBox autoAlign
            id={`${idPrefix}-operator`} titleText="Operator" placeholder="Search operators" items={lookups.operators}
            itemToString={(item) => item?.displayName ?? ''} shouldFilterItem={matchesName} selectedItem={field.value}
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

function JobForm({ onClose, mode, job, initialValues, onSaved }: {
  onClose: () => void; mode: 'create' | 'edit'; job?: Job; initialValues?: JobInitialValues; onSaved?: (job: Job) => void;
}) {
  const store = useStore();
  const navigate = useNavigate();
  const source = job ?? initialValues;
  const linkedPrint = job?.printId ? store.prints.find((print) => print.id === job.printId) : undefined;
  const printFile = linkedPrint?.fileName ?? initialValues?.printFileName;
  const printName = printFile ? nameFromFile(printFile) : null;
  const now = Date.now();
  const runtimeMinutes = source?.startsAt && source.endsAt
    ? Math.max(1, Math.round((new Date(source.endsAt).getTime() - new Date(source.startsAt).getTime()) / 60_000))
    : 60;
  const form = useForm<Values>({
    defaultValues: {
      title: source?.title ?? '',
      machineId: source?.machineId ?? '',
      startsAt: instantToZonedDateTimeValue(source?.startsAt ?? new Date(now - 3_600_000)),
      runtimeHours: Math.floor(runtimeMinutes / 60),
      runtimeMinutes: runtimeMinutes % 60,
      customer: source?.customer ?? null,
      operator: source?.operator ?? null,
      // Never preselect an outcome for an existing job that has none recorded yet.
      outcome: (source?.outcome && source.outcome !== 'unknown' ? source.outcome : mode === 'create' ? 'successful' : '') as JobOutcome,
      notes: source?.notes ?? '',
      usages: mode === 'create' ? initialValues?.usages?.length ? initialValues.usages : [blankUsage() as UsageRow] : [],
    },
  });
  const guard = useUnsavedChanges({ isDirty: form.formState.isDirty });
  const [error, setError] = useState<string | null>(null);
  const { mutate, pending } = useSimulatedMutation((facts: JobFactsInput, usages: UsagesValues['usages']) => {
    if (mode === 'create') return store.createJob(facts, toUsageInputs(usages));
    store.updateJobFacts(job!.id, facts);
    return job!;
  });
  const machines = store.machines.filter((machine) => machine.status !== 'retired' || machine.id === job?.machineId);

  const submit = form.handleSubmit(async (values) => {
    setError(null);
    const endsAt = endFrom(values.startsAt, values.runtimeHours, values.runtimeMinutes);
    if (!endsAt) { setError('Enter a valid start time and a runtime longer than zero.'); return; }
    let facts: JobFactsInput;
    try {
      facts = {
        title: values.title.trim() || null, machineId: values.machineId, startsAt: zonedDateTimeValueToISO(values.startsAt), endsAt,
        customer: values.customer, operator: values.operator, outcome: new Date(endsAt).getTime() > Date.now() ? 'unknown' : values.outcome, notes: values.notes.trim() || null,
      };
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Check the start time.');
      return;
    }
    const saved = await mutate(facts, values.usages);
    const repriced = mode === 'edit' && (job!.machineId !== facts.machineId || job!.customer?.id !== facts.customer?.id);
    store.notify({ kind: 'success', title: mode === 'create' ? `${saved.displayId} created` : `${saved.displayId} updated`, subtitle: repriced ? 'Price recalculated.' : undefined });
    guard.bypassAfterSubmit(() => {
      onClose();
      if (mode === 'create') { if (onSaved) onSaved(saved); else navigate(`/jobs/${saved.id}`); } else onSaved?.(saved);
    });
  }, (errors) => setError(errors.startsAt ? 'Enter a valid start time (DD.MM.YYYY, HH:MM).' : errors.runtimeHours || errors.runtimeMinutes ? 'Enter a runtime longer than zero.' : 'Check the highlighted fields.'));
  const [watchedStart, watchedHours, watchedMinutes] = form.watch(['startsAt', 'runtimeHours', 'runtimeMinutes']);
  const previewEnd = endFrom(watchedStart, watchedHours, watchedMinutes);
  const endInFuture = !!previewEnd && new Date(previewEnd).getTime() > Date.now();
  const endsInFuture = previewEnd !== null && new Date(previewEnd).getTime() > now;

  return (
    <>
      <ComposedModal open={!guard.dialogOpen} size="lg" preventCloseOnClickOutside selectorPrimaryFocus="#job-form-title" aria-label={mode === 'create' ? 'New job' : 'Edit job'} onClose={() => { if (!pending) guard.requestDiscard(onClose); return false; }}>
        <ModalHeader title={mode === 'create' ? 'New job' : 'Edit job'} label={job?.displayId} />
        <ModalBody hasForm>
          <FormProvider {...form}>
            <Stack gap={6}>
              <p>
                {mode === 'create'
                  ? 'Use this when a printer cannot report the print. The run is manual and priced from the customer’s pricing group when saved.'
                  : 'Changing customer or machine recalculates the price; existing order charges stay unchanged. Material usage is edited separately.'}
              </p>
              {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Job not saved" subtitle={error} />}
              <TextInput
                id="job-form-title" labelText="Name (optional)" placeholder="e.g. Gearbox housing for Jonas" maxLength={120}
                helperText={printName ? `Leave empty to show the printer's name “${printName}”.` : 'Leave empty to show the job number.'}
                {...form.register('title')}
              />
              <Select id="job-form-machine" labelText="Machine" invalid={!!form.formState.errors.machineId} invalidText="Select a machine." {...form.register('machineId', { required: true })}>
                <SelectItem value="" text="Select a machine" />
                {machines.map((machine) => <SelectItem key={machine.id} value={machine.id} text={machine.name} />)}
              </Select>
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
              <JobPartyFields idPrefix="job-form" showOutcome={!endInFuture} />
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

export function JobFormModal({ open, onClose, mode, job, initialValues, onSaved }: {
  open: boolean; onClose: () => void; mode: 'create' | 'edit'; job?: Job; initialValues?: JobInitialValues; onSaved?: (job: Job) => void;
}) {
  return open ? <JobForm onClose={onClose} mode={mode} job={job} initialValues={initialValues} onSaved={onSaved} /> : null;
}
