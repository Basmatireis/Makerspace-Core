import { useState } from 'react';
import { Button, ComposedModal, InlineNotification, ModalBody, ModalFooter, ModalHeader, Stack } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Controller, FormProvider, useForm } from 'react-hook-form';
import { updateMachineRun } from '../../../api/generated/machine-runs/machine-runs';
import type { MachineRun, Process } from '../../../api/generated/models';
import { FuzzySelectField } from '../../../app/components/FuzzyComboBox';
import { UnsavedChangesDialog } from '../../../app/UnsavedChangesDialog';
import { useUnsavedChanges } from '../../../app/useUnsavedChanges';
import { machineLogbookKeys, machineQuery } from '../queries';
import { useCan } from '../shared/useCan';
import { useNotify } from '../shared/toasts';
import { saveError, type UsagesValues } from './jobFormHelpers';
import { RunTimingFields } from './RunFields';
import { resolveTimes, runDefaults, runOutcomeChoices, type RunValues } from './runFormHelpers';
import { measureValuesFrom, toMeasures } from './processFormHelpers';
import { MeasureFields } from './ProcessRunFields';
import '../styles/jobs.scss';

type EditProps = { mode: 'edit'; run: MachineRun };

function EditRunForm({ onClose, run }: { onClose: () => void; run: MachineRun }) {
  const can = useCan();
  const machine = useQuery({ ...machineQuery(run.machineId), enabled: can('machines.read') });
  // Built once the process is known, so the process fields start with the run's values.
  if (can('machines.read') && machine.isPending) return null;
  return <EditRunFormBody onClose={onClose} run={run} process={machine.data?.process} />;
}

function EditRunFormBody({ onClose, run, process }: { onClose: () => void; run: MachineRun; process?: Process }) {
  const client = useQueryClient();
  const notify = useNotify();
  const manual = run.source === 'manual';
  const measureDefinitions = manual ? (process?.measures ?? []) : [];
  const endsAt = run.endedAt ?? run.estimatedEndAt ?? run.startedAt;
  const form = useForm<RunValues & Pick<UsagesValues, 'measures'>>({
    defaultValues: {
      ...runDefaults({ startsAt: run.startedAt, endsAt, outcome: run.outcome ?? null }, false),
      measures: measureValuesFrom(measureDefinitions, run.measures),
    },
  });
  const guard = useUnsavedChanges({ isDirty: form.formState.isDirty });
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: ({
      values,
      times,
    }: {
      values: RunValues & Pick<UsagesValues, 'measures'>;
      times?: { startsAt?: string; endsAt: string };
    }) =>
      updateMachineRun(run.id, {
        // Start and end exist only on manual runs; a running run cannot have an outcome yet.
        ...(times ?? {}),
        outcome: values.outcome && (!times || new Date(times.endsAt).getTime() <= Date.now()) ? values.outcome : null,
        // Measures only exist on manual runs; sending them replaces the stored ones, so an emptied field clears the count.
        ...(measureDefinitions.length ? { measures: toMeasures(values.measures, measureDefinitions) } : {}),
        expectedVersion: run.version,
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
      notify({
        kind: 'success',
        title: 'Run updated',
        subtitle: run.job ? `${run.displayId} saved; ${run.job.displayId} is recalculated.` : `${run.displayId} saved.`,
      });
      guard.bypassAfterSubmit(onClose);
    },
    onError: (cause) => setError(saveError(cause, 'The run could not be saved.').message),
  });
  const pending = mutation.isPending;
  const submit = form.handleSubmit(
    (values) => {
      setError(null);
      if (!manual) {
        mutation.mutate({ values });
        return;
      }
      const times = resolveTimes(values, { startsAt: run.startedAt, endsAt });
      if ('error' in times) {
        setError(times.error);
        return;
      }
      mutation.mutate({ values, times });
    },
    () => setError('Check the highlighted fields.'),
  );

  return (
    <>
      <ComposedModal
        open={!guard.dialogOpen}
        size="md"
        preventCloseOnClickOutside
        aria-label="Edit run"
        onClose={() => {
          if (!pending) guard.requestDiscard(onClose);
          return false;
        }}
      >
        <ModalHeader title="Edit run" label={run.displayId} />
        <ModalBody hasForm>
          <FormProvider {...form}>
            <Stack gap={6}>
              <p>
                {manual
                  ? 'Correct when this run started, how long it took and how it ended. Material usage is edited separately.'
                  : 'Start, end and material come from the machine and cannot be edited here. You can record how the run ended.'}
              </p>
              {error && (
                <InlineNotification kind="error" lowContrast hideCloseButton title="Run not saved" subtitle={error} />
              )}
              {manual ? (
                <>
                  <RunTimingFields idPrefix="edit-run" />
                  {measureDefinitions.length > 0 && (
                    <div className="mj-form-grid">
                      <MeasureFields idPrefix="edit-run" measures={measureDefinitions} />
                    </div>
                  )}
                </>
              ) : (
                <Controller
                  control={form.control}
                  name="outcome"
                  render={({ field }) => (
                    <FuzzySelectField
                      id="edit-run-outcome"
                      titleText="Outcome"
                      placeholder="Not recorded yet"
                      helperText={
                        run.outcomeFromMachine
                          ? 'Reported by the machine; choosing another outcome overrides it.'
                          : undefined
                      }
                      options={runOutcomeChoices}
                      value={field.value || null}
                      onChange={(id) => field.onChange(id ?? '')}
                    />
                  )}
                />
              )}
            </Stack>
          </FormProvider>
        </ModalBody>
        <ModalFooter>
          <Button kind="secondary" disabled={pending} onClick={() => guard.requestDiscard(onClose)}>
            Cancel
          </Button>
          <Button kind="primary" disabled={pending} onClick={() => void submit()}>
            {pending ? 'Saving…' : 'Save changes'}
          </Button>
        </ModalFooter>
      </ComposedModal>
      <UnsavedChangesDialog guard={guard} />
    </>
  );
}

/** Corrects an existing run: start, runtime, outcome and measures of a manual run, the outcome of a recorded one. */
export function RunFormModal({ open, onClose, ...props }: { open: boolean; onClose: () => void } & EditProps) {
  if (!open) return null;
  return <EditRunForm onClose={onClose} run={props.run} />;
}
