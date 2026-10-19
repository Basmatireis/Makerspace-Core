import { useMemo, useState } from 'react';
import { ActionableNotification, Button, ComboBox, ComposedModal, InlineNotification, ModalBody, ModalFooter, ModalHeader, Select, SelectItem, Stack, TextArea, TextInput } from '@carbon/react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Controller, FormProvider, useForm, useFormContext, useWatch } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { createMachineJob, updateMachineJob } from '../../../api/generated/machine-jobs/machine-jobs';
import { createMachineJobFromRun } from '../../../api/generated/machine-runs/machine-runs';
import type { MachineJob, MachineRun, MachineRunOutcome, Operator } from '../../../api/generated/models';
import { UnsavedChangesDialog } from '../../../app/UnsavedChangesDialog';
import { useUnsavedChanges } from '../../../app/useUnsavedChanges';
import { useCurrentUser } from '../../auth/auth';
import { canLookupJobParties } from '../../auth/permissions';
import { billingPartySearchQuery, machineLogbookKeys, machinesQuery, operatorSearchQuery, pricingQuery } from '../queries';
import { formatDateTime, formatDuration } from '../shared/format';
import { machineLogbookPaths } from '../shared/paths';
import { nameFromFile } from '../shared/status';
import { useNotify } from '../shared/toasts';
import { useCan } from '../shared/useCan';
import { blankUsage, matchesName, saveError, toUsageInputs, type JobInitialValues, type PartyValues, type UsagesValues } from './jobFormHelpers';
import { RunOutcomeField, RunTimingFields } from './RunFields';
import { resolveTimes, runDefaults, runOutcomeChoices, type RunValues } from './runFormHelpers';
import { UsageRowsEditor } from './UsageFormModal';
import '../styles/jobs.scss';

export type { JobInitialValues } from './jobFormHelpers';

function JobPartyFields({ idPrefix, current }: { idPrefix: string; current?: MachineJob }) {
  const currentUser = useCurrentUser();
  const canLookup = canLookupJobParties(currentUser);
  const { control, register, setValue } = useFormContext<PartyValues>();
  const customer = useWatch({ control, name: 'customer' });
  // A person who belongs to exactly one organization may be billed through it; the choice stays with the user.
  const suggestedOrganization = customer?.kind === 'person' && customer.memberOrganizations?.length === 1 ? customer.memberOrganizations[0] : null;
  const [customerSearch, setCustomerSearch] = useState('');
  const [operatorSearch, setOperatorSearch] = useState('');
  const parties = useQuery({ ...billingPartySearchQuery(customerSearch), enabled: canLookup, placeholderData: keepPreviousData });
  const operators = useQuery({ ...operatorSearchQuery(operatorSearch), enabled: canLookup, placeholderData: keepPreviousData });
  const lookupFailed = parties.isError || operators.isError;
  // A confirmed job whose customer was deleted keeps no customer unless one is chosen; everything else needs one.
  const customerRequired = !current || !!current.customer;
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
      {suggestedOrganization && (
        <ActionableNotification
          inline kind="info" lowContrast hideCloseButton title={`${customer?.displayName} belongs to ${suggestedOrganization.name}.`}
          subtitle="Bill the organization instead of the person?"
          actionButtonLabel={`Bill to ${suggestedOrganization.name}`}
          onActionButtonClick={() => setValue('customer', { kind: 'organization', id: suggestedOrganization.id, displayName: suggestedOrganization.name, pricingGroupAssignmentVersion: 0 }, { shouldDirty: true, shouldValidate: true })}
        />
      )}
      <TextArea id={`${idPrefix}-notes`} labelText="Notes" rows={3} {...register('notes')} />
    </Stack>
  );
}


type Values = PartyValues & UsagesValues & RunValues & { title: string; machineId: string; pricingGroupId: string; outcomeOverride: MachineRunOutcome | '' };

type JobFormProps = { onClose: () => void; mode: 'create' | 'edit'; job?: MachineJob; initialValues?: JobInitialValues; run?: MachineRun; onSaved?: (job: MachineJob) => void };

function JobForm({ onClose, mode, job, initialValues, run, onSaved }: JobFormProps) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const notify = useNotify();
  const can = useCan();
  const fromRun = mode === 'create' && !!run;
  const source = job
    ? { title: job.title, machineId: job.machine.id, customer: job.customer ?? null, operator: job.operator ?? null, notes: job.notes }
    : initialValues;
  const runName = run?.fileName ? nameFromFile(run.fileName) : null;
  const hasRecordedRun = !!job?.runs.some((item) => item.source === 'recorded' && item.state !== 'replaced');
  const form = useForm<Values>({
    defaultValues: {
      title: source?.title ?? (runName ?? ''),
      machineId: source?.machineId ?? run?.machineId ?? '',
      pricingGroupId: '',
      customer: source?.customer ?? null,
      operator: source?.operator ?? null,
      notes: source?.notes ?? '',
      outcomeOverride: job?.outcomeOverridden && job.outcome !== 'unknown' ? job.outcome as MachineRunOutcome : '',
      ...runDefaults(),
      usages: mode === 'create' && !fromRun ? [blankUsage()] : [],
    },
  });
  const guard = useUnsavedChanges({ isDirty: form.formState.isDirty });
  const [error, setError] = useState<string | null>(null);

  const canReadMachines = can('machines.read');
  const machines = useQuery({ ...machinesQuery({ page: 1, pageSize: 100 }), enabled: canReadMachines && !fromRun });
  const canReadPricing = can('pricing.read');
  const pricing = useQuery({ ...pricingQuery(), enabled: canReadPricing && mode === 'create' });
  const machineChoices = useMemo(() => {
    const items = (machines.data?.items ?? []).filter((machine) => machine.status !== 'retired' || machine.id === job?.machine.id).map((machine) => ({ id: machine.id, name: machine.name }));
    if (job && !items.some((item) => item.id === job.machine.id)) items.unshift({ id: job.machine.id, name: job.machine.name });
    return items;
  }, [machines.data, job]);

  const mutation = useMutation({
    mutationFn: async ({ values, times }: { values: Values; times?: { startsAt: string; endsAt: string } }) => {
      const title = values.title.trim() || null;
      const notes = values.notes.trim() || null;
      const customer = values.customer ? { kind: values.customer.kind, id: values.customer.id } : undefined;
      const operatorPersonId = (values.operator as Operator).personId;
      const pricingGroupId = values.pricingGroupId || undefined;
      if (mode === 'edit' && job) {
        return updateMachineJob(job.id, { machineId: values.machineId, customer, operatorPersonId, title, notes, outcomeOverride: values.outcomeOverride || null, expectedVersion: job.version });
      }
      if (run) return createMachineJobFromRun(run.id, { title, customer: customer!, operatorPersonId, notes, pricingGroupId });
      const first = times!;
      return createMachineJob({
        machineId: values.machineId, customer: customer!, operatorPersonId, title, notes, pricingGroupId,
        // The outcome only exists once the first run has ended.
        run: { ...first, outcome: new Date(first.endsAt).getTime() > Date.now() || !values.outcome ? null : values.outcome, usages: toUsageInputs(values.usages) },
      });
    },
    onSuccess: async (saved, { values }) => {
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
      const repriced = mode === 'edit' && job && (job.machine.id !== values.machineId || job.customer?.id !== values.customer?.id);
      if (fromRun) {
        notify({ kind: 'success', title: 'Job created', subtitle: `${saved.displayId} contains ${run.displayId}; material from the machine is consumed automatically.` });
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
      if (failure.field) form.setError(failure.field === 'machine' ? 'machineId' : failure.field === 'outcome' ? 'outcome' : failure.field, { type: 'server', message: failure.message });
    },
  });
  const pending = mutation.isPending;

  const submit = form.handleSubmit((values) => {
    setError(null);
    if (mode === 'create' && !fromRun) {
      const times = resolveTimes(values);
      if ('error' in times) { setError(times.error); return; }
      mutation.mutate({ values, times });
    } else mutation.mutate({ values });
  }, (errors) => setError(errors.startsAt ? 'Enter a valid start time (DD.MM.YYYY, HH:MM).' : errors.runtimeHours || errors.runtimeMinutes ? 'Enter a runtime longer than zero.' : 'Check the highlighted fields.'));

  const derivedOutcome = job && !job.outcomeOverridden && job.outcome !== 'unknown' ? runOutcomeChoices.find((option) => option.id === job.outcome)?.label : undefined;
  const title = mode === 'create' ? 'New job' : 'Edit job';

  return (
    <>
      <ComposedModal open={!guard.dialogOpen} size="lg" preventCloseOnClickOutside selectorPrimaryFocus="#job-form-title" aria-label={title} onClose={() => { if (!pending) guard.requestDiscard(onClose); return false; }}>
        <ModalHeader title={title} label={job?.displayId} />
        <ModalBody hasForm>
          <FormProvider {...form}>
            <Stack gap={6}>
              <p>
                {mode === 'create'
                  ? fromRun
                    ? `The job contains ${run.displayId}: machine, start, end and material come from the machine. The price is calculated from the customer’s pricing group when saved.`
                    : 'Use this when a machine cannot report the run. The first run is entered by hand and the job is priced from the customer’s pricing group when saved. Runs reported by the machine can be attached later.'
                  : 'Changing customer or machine recalculates the price; existing order charges stay unchanged. Runs and their material are edited on the job page.'}
              </p>
              {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Job not saved" subtitle={error} />}
              <TextInput
                id="job-form-title" labelText="Name (optional)" placeholder="e.g. Gearbox housing for Jonas" maxLength={120}
                helperText={runName ? `Prefilled from the machine’s file name. Leave empty to show “${runName}”.` : 'Leave empty to show the file name of the latest recorded run, or the job number.'}
                {...form.register('title')}
              />
              {fromRun ? (
                <TextInput id="job-form-machine" labelText="Machine" readOnly value={run.machineName} helperText="From the recorded run." />
              ) : (
                <Controller control={form.control} name="machineId" rules={{ required: true }} render={({ field, fieldState }) => (
                  <Select
                    id="job-form-machine" labelText="Machine" value={field.value} invalid={fieldState.invalid} invalidText={fieldState.error?.message || 'Select a machine.'} disabled={hasRecordedRun}
                    helperText={hasRecordedRun ? 'The machine cannot change while the job has a recorded run.' : undefined} onChange={(event) => field.onChange(event.target.value)}
                  >
                    <SelectItem value="" text={machines.isPending && canReadMachines ? 'Loading machines…' : 'Select a machine'} />
                    {machineChoices.map((machine) => <SelectItem key={machine.id} value={machine.id} text={machine.name} />)}
                  </Select>
                )} />
              )}
              <JobPartyFields idPrefix="job-form" current={job} />
              {mode === 'create' && canReadPricing && (
                <Select id="job-form-pricing-group" labelText="Pricing group (optional)" helperText="Leave empty to use the customer’s pricing group." {...form.register('pricingGroupId')}>
                  <SelectItem value="" text="Customer’s pricing group" />
                  {(pricing.data?.items ?? []).filter((group) => group.active).map((group) => <SelectItem key={group.id} value={group.id} text={group.name} />)}
                </Select>
              )}
              {mode === 'edit' && (
                <Select
                  id="job-form-outcome-override" labelText="Outcome override"
                  helperText={job?.outcomeOverridden ? 'Set by staff; the outcomes of the runs are ignored.' : derivedOutcome ? `Derived from the runs: ${derivedOutcome}.` : 'Leave empty to derive the outcome from the runs.'}
                  {...form.register('outcomeOverride')}
                >
                  <SelectItem value="" text="Derived from runs" />
                  {runOutcomeChoices.map((option) => <SelectItem key={option.id} value={option.id} text={option.label} />)}
                </Select>
              )}
              {mode === 'create' && !fromRun && (
                <Stack gap={5}>
                  <div>
                    <h3 className="mj-section-title">First run</h3>
                    <p className="mj-secondary">Entered by hand. Add further runs, such as a reprint, on the job page.</p>
                  </div>
                  <RunTimingFields idPrefix="job-form" />
                  <RunOutcomeField idPrefix="job-form" />
                  <div>
                    <h3 className="mj-section-title">Material usage</h3>
                    <p className="mj-secondary">Record everything consumed, including waste from failed outcomes. Stock is deducted when the job is saved.</p>
                  </div>
                  <UsageRowsEditor idPrefix="job-form-usage" />
                </Stack>
              )}
              {fromRun && (
                <div className="mj-form-grid">
                  <TextInput id="job-form-run" labelText="Run" readOnly value={`${run.displayId}${run.fileName ? ` · ${run.fileName}` : ''}`} />
                  <TextInput id="job-form-run-start" labelText="Start" readOnly value={formatDateTime(run.startedAt)} helperText={run.state === 'running' ? 'Still running; the job is running until the run ends.' : `Runtime ${formatDuration(run.durationSeconds)}`} />
                </div>
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
 * Create or edit a job. `run` creates the job from an unassigned recorded run (machine, times and material come from the run).
 * Create navigates to the new job unless `onSaved` is given.
 */
export function JobFormModal({ open, onClose, mode, job, initialValues, run, onSaved }: {
  open: boolean; onClose: () => void; mode: 'create' | 'edit'; job?: MachineJob; initialValues?: JobInitialValues; run?: MachineRun; onSaved?: (job: MachineJob) => void;
}) {
  return open ? <JobForm onClose={onClose} mode={mode} job={job} initialValues={initialValues} run={run} onSaved={onSaved} /> : null;
}
