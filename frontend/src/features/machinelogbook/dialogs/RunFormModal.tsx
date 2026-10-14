import { useState } from 'react';
import { Button, ComposedModal, InlineNotification, ModalBody, ModalFooter, ModalHeader, Select, SelectItem, Stack } from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FormProvider, useForm } from 'react-hook-form';
import { addManualMachineRun, updateMachineRun } from '../../../api/generated/machine-runs/machine-runs';
import type { MachineJob, MachineRun } from '../../../api/generated/models';
import { UnsavedChangesDialog } from '../../../app/UnsavedChangesDialog';
import { useUnsavedChanges } from '../../../app/useUnsavedChanges';
import { machineLogbookKeys } from '../queries';
import { useNotify } from '../shared/toasts';
import { blankUsage, saveError, toUsageInputs, type UsagesValues } from './jobFormHelpers';
import { RunOutcomeField, RunTimingFields } from './RunFields';
import { resolveTimes, runDefaults, runOutcomeChoices, type RunValues } from './runFormHelpers';
import { UsageRowsEditor } from './UsageFormModal';
import '../styles/jobs.scss';

type AddProps = { mode: 'add'; job: MachineJob };
type EditProps = { mode: 'edit'; run: MachineRun };

function AddRunForm({ onClose, job }: { onClose: () => void; job: MachineJob }) {
  const client = useQueryClient();
  const notify = useNotify();
  const form = useForm<RunValues & UsagesValues>({ defaultValues: { ...runDefaults(), usages: [blankUsage()] } });
  const guard = useUnsavedChanges({ isDirty: form.formState.isDirty });
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: ({ values, times }: { values: RunValues & UsagesValues; times: { startsAt: string; endsAt: string } }) => addManualMachineRun(job.id, {
      run: {
        ...times,
        // The outcome only exists once the run has ended.
        outcome: new Date(times.endsAt).getTime() > Date.now() || !values.outcome ? null : values.outcome,
        usages: toUsageInputs(values.usages),
      },
      expectedJobVersion: job.version,
    }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
      notify({ kind: 'success', title: 'Run added', subtitle: `${job.displayId} has another run; runtime and price are recalculated.` });
      guard.bypassAfterSubmit(onClose);
    },
    onError: (cause) => setError(saveError(cause, 'The run could not be added.').message),
  });
  const pending = mutation.isPending;
  const submit = form.handleSubmit((values) => {
    setError(null);
    const times = resolveTimes(values);
    if ('error' in times) { setError(times.error); return; }
    mutation.mutate({ values, times });
  }, () => setError('Check the highlighted fields. Every material row needs a material and a quantity above zero.'));

  return (
    <>
      <ComposedModal open={!guard.dialogOpen} size="lg" preventCloseOnClickOutside aria-label="Add run" onClose={() => { if (!pending) guard.requestDiscard(onClose); return false; }}>
        <ModalHeader title="Add run" label={job.displayId} />
        <ModalBody hasForm>
          <FormProvider {...form}>
            <Stack gap={6}>
              <p>Add another machine run to this job, for example a reprint. Runtime and material of all runs add up; the price is recalculated.</p>
              {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Run not added" subtitle={error} />}
              <RunTimingFields idPrefix="add-run" />
              <RunOutcomeField idPrefix="add-run" />
              <Stack gap={5}>
                <div>
                  <h3 className="mj-section-title">Material usage</h3>
                  <p className="mj-secondary">Record everything this run consumed, including waste from failed outcomes. Stock is deducted when the run is saved.</p>
                </div>
                <UsageRowsEditor idPrefix="add-run-usage" />
              </Stack>
            </Stack>
          </FormProvider>
        </ModalBody>
        <ModalFooter>
          <Button kind="secondary" disabled={pending} onClick={() => guard.requestDiscard(onClose)}>Cancel</Button>
          <Button kind="primary" disabled={pending} onClick={submit}>{pending ? 'Saving…' : 'Add run'}</Button>
        </ModalFooter>
      </ComposedModal>
      <UnsavedChangesDialog guard={guard} />
    </>
  );
}

function EditRunForm({ onClose, run }: { onClose: () => void; run: MachineRun }) {
  const client = useQueryClient();
  const notify = useNotify();
  const manual = run.source === 'manual';
  const endsAt = run.endedAt ?? run.estimatedEndAt ?? run.startedAt;
  const form = useForm<RunValues>({ defaultValues: runDefaults({ startsAt: run.startedAt, endsAt, outcome: run.outcome ?? null }, false) });
  const guard = useUnsavedChanges({ isDirty: form.formState.isDirty });
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: ({ values, times }: { values: RunValues; times?: { startsAt: string; endsAt: string } }) => updateMachineRun(run.id, {
      // Start and end exist only on manual runs; a running run cannot have an outcome yet.
      ...(times ?? {}),
      outcome: values.outcome && (!times || new Date(times.endsAt).getTime() <= Date.now()) ? values.outcome : null,
      expectedVersion: run.version,
    }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
      notify({ kind: 'success', title: 'Run updated', subtitle: run.job ? `${run.displayId} saved; ${run.job.displayId} is recalculated.` : `${run.displayId} saved.` });
      guard.bypassAfterSubmit(onClose);
    },
    onError: (cause) => setError(saveError(cause, 'The run could not be saved.').message),
  });
  const pending = mutation.isPending;
  const submit = form.handleSubmit((values) => {
    setError(null);
    if (!manual) { mutation.mutate({ values }); return; }
    const times = resolveTimes(values, { startsAt: run.startedAt, endsAt });
    if ('error' in times) { setError(times.error); return; }
    mutation.mutate({ values, times });
  }, () => setError('Check the highlighted fields.'));

  return (
    <>
      <ComposedModal open={!guard.dialogOpen} size="md" preventCloseOnClickOutside aria-label="Edit run" onClose={() => { if (!pending) guard.requestDiscard(onClose); return false; }}>
        <ModalHeader title="Edit run" label={run.displayId} />
        <ModalBody hasForm>
          <FormProvider {...form}>
            <Stack gap={6}>
              <p>{manual ? 'Correct when this run started, how long it took and how it ended. Material usage is edited separately.' : 'Start, end and material come from the machine and cannot be edited here. You can record how the run ended.'}</p>
              {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Run not saved" subtitle={error} />}
              {manual ? (
                <>
                  <RunTimingFields idPrefix="edit-run" />
                  <RunOutcomeField idPrefix="edit-run" />
                </>
              ) : (
                <Select
                  id="edit-run-outcome" labelText="Outcome"
                  helperText={run.outcomeFromMachine ? 'Reported by the machine; choosing another outcome overrides it.' : undefined}
                  {...form.register('outcome')}
                >
                  <SelectItem value="" text="Not recorded yet" />
                  {runOutcomeChoices.map((option) => <SelectItem key={option.id} value={option.id} text={option.label} />)}
                </Select>
              )}
            </Stack>
          </FormProvider>
        </ModalBody>
        <ModalFooter>
          <Button kind="secondary" disabled={pending} onClick={() => guard.requestDiscard(onClose)}>Cancel</Button>
          <Button kind="primary" disabled={pending} onClick={submit}>{pending ? 'Saving…' : 'Save changes'}</Button>
        </ModalFooter>
      </ComposedModal>
      <UnsavedChangesDialog guard={guard} />
    </>
  );
}

/** Add a manual run to a job (for example a reprint), or correct an existing run. */
export function RunFormModal({ open, onClose, ...props }: { open: boolean; onClose: () => void } & (AddProps | EditProps)) {
  if (!open) return null;
  return props.mode === 'add' ? <AddRunForm onClose={onClose} job={props.job} /> : <EditRunForm onClose={onClose} run={props.run} />;
}
