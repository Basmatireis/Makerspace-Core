/* eslint-disable react-refresh/only-export-components -- the job form and its shared field helpers belong together */
import { useState } from 'react';
import {
  ActionableNotification,
  Button,
  Checkbox,
  ComposedModal,
  InlineNotification,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Stack,
  TextArea,
  TextInput,
} from '@carbon/react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Controller, FormProvider, useForm, useFormContext, useWatch } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { createMachineJob, updateMachineJob } from '../../../api/generated/machine-jobs/machine-jobs';
import type { BillingParty, MachineJob, MachineRunOutcome, Operator } from '../../../api/generated/models';
import { FuzzyComboBox, FuzzySelectField } from '../../../app/components/FuzzyComboBox';
import { UnsavedChangesDialog } from '../../../app/UnsavedChangesDialog';
import { useUnsavedChanges } from '../../../app/useUnsavedChanges';
import { useCurrentUser } from '../../auth/auth';
import { canLookupJobParties } from '../../auth/permissions';
import {
  billingPartySearchQuery,
  machineLogbookKeys,
  machinesQuery,
  operatorSearchQuery,
  pricingQuery,
} from '../queries';
import { machineLogbookPaths } from '../shared/paths';
import { useNotify } from '../shared/toasts';
import { useCan } from '../shared/useCan';
import {
  blankUsage,
  signedInOperator,
  saveError,
  toUsageInputs,
  type JobInitialValues,
  type PartyValues,
  type UsagesValues,
} from './jobFormHelpers';
import { RunTimingFields } from './RunFields';
import { outcomeFor, resolveTimes, runDefaults, runOutcomeChoices, type RunValues } from './runFormHelpers';
import { toMeasures } from './processFormHelpers';
import { MeasureFields } from './ProcessRunFields';
import { UsageRowsEditor } from './UsageFormModal';
import '../styles/jobs.scss';
import '../jobs/jobs.scss';

export type { JobInitialValues } from './jobFormHelpers';

/** "Pricing group Partner from the organization’s group." for the recipient chosen in a job form. */
export function recipientHelper(customer: BillingParty | null | undefined) {
  if (!customer) return 'Who gets the result and is charged.';
  if (!customer.pricingGroup) return 'No pricing group; the default group applies.';
  return `Pricing group ${customer.pricingGroup.name} from the ${customer.kind === 'organization' ? 'organization’s group' : 'member’s role'}.`;
}

/**
 * Recipient and operator of a job (side by side), with the suggestion to bill the organization a person belongs to.
 * `withNotes` adds the notes field (bulk creation); the job dialogs edit notes on the job page instead.
 */
export function JobPartyFields({
  idPrefix,
  current,
  withNotes = false,
}: {
  idPrefix: string;
  current?: MachineJob;
  withNotes?: boolean;
}) {
  const currentUser = useCurrentUser();
  const canLookup = canLookupJobParties(currentUser);
  const { control, register, setValue } = useFormContext<PartyValues>();
  const customer = useWatch({ control, name: 'customer' });
  // A person who belongs to exactly one organization may be billed through it; the choice stays with the user.
  const suggestedOrganization =
    customer?.kind === 'person' && customer.memberOrganizations?.length === 1 ? customer.memberOrganizations[0] : null;
  const [customerSearch, setCustomerSearch] = useState('');
  const [operatorSearch, setOperatorSearch] = useState('');
  const parties = useQuery({
    ...billingPartySearchQuery(customer && customerSearch === customer.displayName ? '' : customerSearch),
    enabled: canLookup,
    placeholderData: keepPreviousData,
  });
  const operator = useWatch({ control, name: 'operator' });
  // While the field shows the chosen operator (the signed-in person for a new job), every operator is offered, so
  // switching to someone else needs no clearing first.
  const showsChosenOperator = !!operator && operatorSearch === operator.displayName;
  const operators = useQuery({
    ...operatorSearchQuery(showsChosenOperator ? '' : operatorSearch),
    enabled: canLookup,
    placeholderData: keepPreviousData,
  });
  const lookupFailed = parties.isError || operators.isError;
  // A confirmed job whose recipient was deleted keeps no recipient unless one is chosen; everything else needs one.
  const customerRequired = !current || !!current.customer;
  const withChosen = <T extends { id?: string; personId?: string }>(items: T[], chosen: T | null, key: keyof T) =>
    chosen && !items.some((item) => item[key] === chosen[key]) ? [chosen, ...items] : items;
  return (
    <Stack gap={6}>
      {!canLookup && (
        <p className="mj-secondary">
          Recipient and operator lookups are unavailable with your permissions. Existing assignments are kept.
        </p>
      )}
      {lookupFailed && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Some choices could not be loaded"
          subtitle="Check your catalog permissions and try again."
        />
      )}
      <div className="mj-form-grid">
        <Controller
          control={control}
          name="customer"
          rules={{ required: customerRequired }}
          render={({ field, fieldState }) => (
            <FuzzyComboBox<BillingParty>
              autoAlign
              id={`${idPrefix}-customer`}
              titleText="Recipient"
              placeholder="Select a member or organization"
              helperText={recipientHelper(field.value)}
              disabled={!canLookup}
              items={withChosen(parties.data?.items ?? [], field.value, 'id')}
              itemToString={(item) =>
                item ? `${item.displayName}${item.kind === 'organization' ? ' (organization)' : ''}` : ''
              }
              selectedItem={field.value}
              onInputChange={setCustomerSearch}
              onChange={({ selectedItem }) => field.onChange(selectedItem ?? null)}
              invalid={fieldState.invalid}
              invalidText="Select a recipient."
            />
          )}
        />
        <Controller
          control={control}
          name="operator"
          rules={{ required: true }}
          render={({ field, fieldState }) => (
            <FuzzyComboBox<Operator>
              autoAlign
              id={`${idPrefix}-operator`}
              titleText="Operator"
              placeholder="Search operators"
              helperText={
                field.value?.personId === currentUser.person.id
                  ? 'You, as the signed-in person; change it if someone else is responsible.'
                  : 'The person responsible for this job.'
              }
              disabled={!canLookup}
              items={withChosen(operators.data?.items ?? [], field.value, 'personId')}
              itemToString={(item) => item?.displayName ?? ''}
              selectedItem={field.value}
              onInputChange={setOperatorSearch}
              onChange={({ selectedItem }) => field.onChange(selectedItem ?? null)}
              invalid={fieldState.invalid}
              invalidText="Select an operator."
            />
          )}
        />
      </div>
      {suggestedOrganization && (
        <ActionableNotification
          inline
          role="status"
          kind="info"
          lowContrast
          hideCloseButton
          title={`${customer?.displayName} belongs to ${suggestedOrganization.name}.`}
          subtitle="Bill the organization instead of the person?"
          actionButtonLabel={`Bill to ${suggestedOrganization.name}`}
          onActionButtonClick={() =>
            setValue(
              'customer',
              {
                kind: 'organization',
                id: suggestedOrganization.id,
                displayName: suggestedOrganization.name,
                pricingGroupAssignmentVersion: 0,
              },
              { shouldDirty: true, shouldValidate: true },
            )
          }
        />
      )}
      {withNotes && <TextArea id={`${idPrefix}-notes`} labelText="Notes" rows={3} {...register('notes')} />}
    </Stack>
  );
}

/** The signage opt-out of a job: nothing of it or its runs appears on any display. */
export function SignageCheckbox({
  id,
  checked,
  onChange,
  labelText = 'Keep this job off the signage screens',
  helperText = 'No live status, no camera stream and no timelapse of its runs on any display; the job itself stays visible to staff.',
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  labelText?: string;
  helperText?: string;
}) {
  return (
    <Checkbox
      id={id}
      labelText={labelText}
      helperText={helperText}
      checked={checked}
      onChange={(_event, { checked: next }) => onChange(next)}
    />
  );
}

type Values = PartyValues &
  UsagesValues &
  RunValues & {
    title: string;
    machineId: string;
    pricingGroupId: string;
    outcomeOverride: MachineRunOutcome | '';
    hiddenFromSignage: boolean;
  };

type JobFormProps = {
  onClose: () => void;
  mode: 'create' | 'edit';
  job?: MachineJob;
  initialValues?: JobInitialValues;
  onSaved?: (job: MachineJob) => void;
};

function JobForm({ onClose, mode, job, initialValues, onSaved }: JobFormProps) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const notify = useNotify();
  const can = useCan();
  const currentUser = useCurrentUser();
  const creating = mode === 'create';
  const source = job
    ? {
        title: job.title,
        machineId: job.machine.id,
        customer: job.customer ?? null,
        operator: job.operator ?? null,
        notes: job.notes,
      }
    : initialValues;
  const hasRecordedRun = !!job?.runs.some((item) => item.source === 'recorded' && item.state !== 'replaced');
  const form = useForm<Values>({
    defaultValues: {
      title: source?.title ?? '',
      machineId: source?.machineId ?? '',
      pricingGroupId: '',
      customer: source?.customer ?? null,
      operator: source?.operator ?? (creating ? signedInOperator(currentUser.person) : null),
      notes: source?.notes ?? '',
      outcomeOverride: job?.outcomeOverridden && job.outcome !== 'unknown' ? (job.outcome as MachineRunOutcome) : '',
      hiddenFromSignage: job?.hiddenFromSignage ?? false,
      ...runDefaults(undefined, true, 'now'),
      usages: creating ? [blankUsage()] : [],
      measures: {},
    },
  });
  const guard = useUnsavedChanges({ isDirty: form.formState.isDirty });
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canReadMachines = can('machines.read');
  const machines = useQuery({ ...machinesQuery({ page: 1, pageSize: 100 }), enabled: canReadMachines });
  const canReadPricing = can('pricing.read');
  const pricing = useQuery({ ...pricingQuery(), enabled: canReadPricing && creating });
  const [machineId, customer] = useWatch({ control: form.control, name: ['machineId', 'customer'] });
  const machine = (machines.data?.items ?? []).find((item) => item.id === machineId);
  const process = machine?.process;
  const machineChoices = (machines.data?.items ?? [])
    .filter((item) => (item.status !== 'retired' && item.status !== 'maintenance') || item.id === job?.machine.id)
    .map((item) => ({ id: item.id, label: `${item.name} · ${item.process.name}` }));
  if (job && !machineChoices.some((item) => item.id === job.machine.id))
    machineChoices.unshift({ id: job.machine.id, label: job.machine.name });

  const mutation = useMutation({
    mutationFn: async ({ values, times }: { values: Values; times?: { startsAt?: string; endsAt: string } }) => {
      const title = values.title.trim() || null;
      const customerRef = values.customer ? { kind: values.customer.kind, id: values.customer.id } : undefined;
      const operatorPersonId = (values.operator as Operator).personId;
      const pricingGroupId = values.pricingGroupId || undefined;
      if (mode === 'edit' && job) {
        return updateMachineJob(job.id, {
          machineId: values.machineId,
          customer: customerRef,
          operatorPersonId,
          title,
          notes: job.notes ?? null,
          outcomeOverride: values.outcomeOverride || null,
          hiddenFromSignage: values.hiddenFromSignage,
          expectedVersion: job.version,
        });
      }
      const first = times!;
      return createMachineJob({
        machineId: values.machineId,
        customer: customerRef!,
        operatorPersonId,
        title,
        notes: values.notes.trim() || null,
        pricingGroupId,
        hiddenFromSignage: values.hiddenFromSignage,
        run: {
          ...first,
          outcome: outcomeFor(values, first.endsAt),
          usages: toUsageInputs(values.usages),
          measures: toMeasures(values.measures, process?.measures ?? []),
        },
      });
    },
    onSuccess: async (saved, { values }) => {
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
      const repriced =
        mode === 'edit' && job && (job.machine.id !== values.machineId || job.customer?.id !== values.customer?.id);
      notify({
        kind: 'success',
        title: creating ? 'Job created' : 'Job saved',
        subtitle: `${saved.displayId}${saved.title ? ` · ${saved.title}` : ''}${repriced ? ' · price recalculated' : ''}`,
      });
      guard.bypassAfterSubmit(() => {
        onClose();
        if (creating) {
          if (onSaved) onSaved(saved);
          else void navigate(machineLogbookPaths.job(saved.id));
        } else onSaved?.(saved);
      });
    },
    onError: (cause) => {
      const failure = saveError(cause);
      setError(failure.message);
      if (failure.field)
        form.setError(
          failure.field === 'machine' ? 'machineId' : failure.field === 'outcome' ? 'outcome' : failure.field,
          { type: 'server', message: failure.message },
        );
    },
  });
  const pending = mutation.isPending;

  const submit = form.handleSubmit(
    (values) => {
      setError(null);
      if (creating) {
        const times = resolveTimes(values);
        if ('error' in times) {
          setError(times.error);
          return;
        }
        mutation.mutate({ values, times });
      } else mutation.mutate({ values });
    },
    (errors) =>
      setError(
        errors.startsAt
          ? 'Enter a valid start time (DD.MM.YYYY, HH:MM).'
          : errors.runtimeHours || errors.runtimeMinutes
            ? 'Enter a duration longer than zero.'
            : 'Check the highlighted fields.',
      ),
  );

  const derivedOutcome =
    job && !job.outcomeOverridden && job.outcome !== 'unknown'
      ? runOutcomeChoices.find((option) => option.id === job.outcome)?.label
      : undefined;
  const heading = creating ? 'New job' : 'Edit job';
  const machineHelper = hasRecordedRun
    ? 'The machine cannot change while the job has a recorded run.'
    : !machine
      ? 'Which machine does the work?'
      : machine.automaticCollectionEnabled
        ? 'Automatic machine: recorded runs attach themselves to the open job of the recipient.'
        : 'Manual machine: enter the run below.';

  return (
    <>
      <ComposedModal
        open={!guard.dialogOpen && !picking}
        size="lg"
        preventCloseOnClickOutside
        className="jobs-form-modal"
        selectorPrimaryFocus={creating ? '#job-form-machine' : '#job-form-title'}
        aria-label={heading}
        onClose={() => {
          if (!pending) guard.requestDiscard(onClose);
          return false;
        }}
      >
        <ModalHeader title={heading} label={job ? `${job.displayId} · Jobs` : 'Jobs'} />
        <ModalBody hasForm>
          <FormProvider {...form}>
            <Stack gap={6}>
              {error && (
                <InlineNotification kind="error" lowContrast hideCloseButton title="Job not saved" subtitle={error} />
              )}
              <div className="mj-form-grid">
                <Controller
                  control={form.control}
                  name="machineId"
                  rules={{ required: true }}
                  render={({ field, fieldState }) => (
                    <FuzzySelectField
                      autoAlign
                      id="job-form-machine"
                      titleText="Machine"
                      placeholder={machines.isPending && canReadMachines ? 'Loading machines…' : 'Select a machine'}
                      options={machineChoices}
                      value={field.value || null}
                      invalid={fieldState.invalid}
                      invalidText={fieldState.error?.message || 'Select a machine.'}
                      disabled={hasRecordedRun}
                      helperText={machineHelper}
                      onChange={(id) => {
                        field.onChange(id ?? '');
                        // Materials of another process no longer fit.
                        if (creating) form.setValue('usages', [blankUsage()]);
                      }}
                    />
                  )}
                />
                <TextInput
                  id="job-form-title"
                  labelText="Title (optional)"
                  placeholder="For example Bracket set for the racing team"
                  maxLength={200}
                  helperText="Shown instead of the job number."
                  {...form.register('title')}
                />
              </div>
              <JobPartyFields idPrefix="job-form" current={job} />
              {creating && canReadPricing && (
                <Controller
                  control={form.control}
                  name="pricingGroupId"
                  render={({ field }) => (
                    <FuzzySelectField
                      autoAlign
                      id="job-form-pricing-group"
                      titleText="Pricing group (optional)"
                      placeholder="Recipient’s pricing group"
                      helperText="Leave empty to use the recipient’s pricing group."
                      options={(pricing.data?.items ?? [])
                        .filter((group) => group.active)
                        .map((group) => ({ id: group.id, label: group.name }))}
                      value={field.value || null}
                      onChange={(id) => field.onChange(id ?? '')}
                    />
                  )}
                />
              )}
              {mode === 'edit' && (
                <Controller
                  control={form.control}
                  name="outcomeOverride"
                  render={({ field }) => (
                    <FuzzySelectField
                      autoAlign
                      id="job-form-outcome-override"
                      titleText="Outcome override"
                      placeholder="Derived from runs"
                      helperText={
                        job?.outcomeOverridden
                          ? 'Set by staff; the outcomes of the runs are ignored.'
                          : derivedOutcome
                            ? `Derived from the runs: ${derivedOutcome}.`
                            : 'Leave empty to derive the outcome from the runs.'
                      }
                      options={runOutcomeChoices}
                      value={field.value || null}
                      onChange={(id) => field.onChange(id ?? '')}
                    />
                  )}
                />
              )}
              <Controller
                control={form.control}
                name="hiddenFromSignage"
                render={({ field }) => (
                  <SignageCheckbox id="job-form-signage" checked={field.value} onChange={field.onChange} />
                )}
              />
              {creating && machine && (
                <section className="jobs-form-run" aria-labelledby="job-form-run-title" data-guide="workshop-job-run">
                  <h3 id="job-form-run-title" className="jobs-form-run__title">
                    First run
                  </h3>
                  <Stack gap={6}>
                    <RunTimingFields idPrefix="job-form" withWhen />
                    {process && process.measures.length > 0 && (
                      <div className="mj-form-grid">
                        <MeasureFields idPrefix="job-form" measures={process.measures} />
                      </div>
                    )}
                    <div>
                      <h4 className="jobs-form-run__subtitle">Material usage</h4>
                      <p className="mj-secondary">
                        Record everything consumed, including waste from failed outcomes. Stock is deducted when the job
                        is saved.
                      </p>
                    </div>
                    <UsageRowsEditor idPrefix="job-form-usage" process={process} onPickingChange={setPicking} />
                  </Stack>
                </section>
              )}
            </Stack>
          </FormProvider>
        </ModalBody>
        <ModalFooter>
          <Button kind="secondary" disabled={pending} onClick={() => guard.requestDiscard(onClose)}>
            Cancel
          </Button>
          <Button
            kind="primary"
            disabled={pending || !machineId || (creating && !customer)}
            onClick={() => void submit()}
            data-guide="workshop-job-submit"
          >
            {pending ? 'Saving…' : creating ? 'Create job' : 'Save job'}
          </Button>
        </ModalFooter>
      </ComposedModal>
      <UnsavedChangesDialog guard={guard} />
    </>
  );
}

/** Create or edit a job. Create navigates to the new job unless `onSaved` is given. */
export function JobFormModal({
  open,
  onClose,
  mode,
  job,
  initialValues,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  mode: 'create' | 'edit';
  job?: MachineJob;
  initialValues?: JobInitialValues;
  onSaved?: (job: MachineJob) => void;
}) {
  return open ? (
    <JobForm onClose={onClose} mode={mode} job={job} initialValues={initialValues} onSaved={onSaved} />
  ) : null;
}
