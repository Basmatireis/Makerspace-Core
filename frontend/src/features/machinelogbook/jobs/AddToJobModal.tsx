import { useState } from 'react';
import {
  Button,
  Checkbox,
  ComposedModal,
  InlineNotification,
  ModalBody,
  ModalFooter,
  ModalHeader,
  RadioButton,
  RadioButtonGroup,
  Stack,
} from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormProvider, useForm } from 'react-hook-form';
import { addManualMachineRun } from '../../../api/generated/machine-runs/machine-runs';
import type { MachineJob, MachineRun } from '../../../api/generated/models';
import { FuzzySelectField } from '../../../app/components/FuzzyComboBox';
import { UnsavedChangesDialog } from '../../../app/UnsavedChangesDialog';
import { useUnsavedChanges } from '../../../app/useUnsavedChanges';
import {
  blankUsage,
  saveError,
  toUsageInputs,
  unassignedRunsParams,
  type UsagesValues,
} from '../dialogs/jobFormHelpers';
import { MeasureFields } from '../dialogs/ProcessRunFields';
import { measureValuesFrom, toMeasures } from '../dialogs/processFormHelpers';
import { RunTimingFields } from '../dialogs/RunFields';
import { outcomeFor, resolveTimes, runDefaults, type RunValues } from '../dialogs/runFormHelpers';
import { UsageRowsEditor } from '../dialogs/UsageFormModal';
import { machineLogbookKeys, runsQuery } from '../queries';
import { formatDuration, formatRelative } from '../shared/format';
import { ReplaceComparison } from '../shared/ReplaceComparison';
import { machineJobName, manualRuns, runName } from '../shared/status';
import { useNotify } from '../shared/toasts';
import { useAttachRunToJob } from './jobsQueries';
import '../styles/jobs.scss';

type Values = RunValues & UsagesValues;

const runLabel = (run: MachineRun) =>
  `${runName(run)} · ${run.displayId} · ${formatRelative(run.startedAt)} · ${formatDuration(run.durationSeconds)}${run.state === 'running' ? ' so far' : ''}`;

function AddToJobForm({ onClose, job }: { onClose: () => void; job: MachineJob }) {
  const client = useQueryClient();
  const notify = useNotify();
  const process = job.machine.process;
  const candidates = useQuery(runsQuery(unassignedRunsParams(job.machine.id)));
  const runs = candidates.data?.items ?? [];
  const [mode, setMode] = useState<'recorded' | 'manual' | null>(null);
  const kind = mode ?? (runs.length > 0 ? 'recorded' : 'manual');
  const [runId, setRunId] = useState<string | null>(null);
  const selectedRun = runs.find((run) => run.id === (runId ?? runs[0]?.id)) ?? null;
  const hasManual = manualRuns(job).length > 0;
  const [replace, setReplace] = useState(true);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const form = useForm<Values>({
    defaultValues: {
      ...runDefaults(undefined, true, 'past'),
      usages: [blankUsage()],
      measures: measureValuesFrom(process.measures),
    },
  });
  const guard = useUnsavedChanges({ isDirty: form.formState.isDirty });
  const attach = useAttachRunToJob();
  const addRun = useMutation({
    mutationFn: ({ values, times }: { values: Values; times: { startsAt?: string; endsAt: string } }) =>
      addManualMachineRun(job.id, {
        run: {
          ...times,
          outcome: outcomeFor(values, times.endsAt),
          usages: toUsageInputs(values.usages),
          measures: toMeasures(values.measures, process.measures),
        },
        expectedJobVersion: job.version,
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
      notify({ kind: 'success', title: 'Run added', subtitle: `${job.displayId} · runtime and price recalculated.` });
      guard.bypassAfterSubmit(onClose);
    },
    onError: (cause) => setError(saveError(cause, 'The run could not be added.').message),
  });
  const pending = attach.isPending || addRun.isPending;

  const submit = () => {
    setError(null);
    if (kind === 'recorded') {
      if (!selectedRun) return;
      attach.mutate(
        { runId: selectedRun.id, job, replaceManualRuns: hasManual && replace },
        {
          onSuccess: () => {
            notify({ kind: 'success', title: 'Run attached', subtitle: `${selectedRun.displayId} → ${job.displayId}` });
            guard.bypassAfterSubmit(onClose);
          },
          onError: (cause) => setError(saveError(cause, 'The run could not be attached.').message),
        },
      );
      return;
    }
    void form.handleSubmit(
      (values) => {
        const times = resolveTimes(values);
        if ('error' in times) {
          setError(times.error);
          return;
        }
        addRun.mutate({ values, times });
      },
      () => setError('Check the highlighted fields. Every material row needs a material and a quantity above zero.'),
    )();
  };

  return (
    <>
      <ComposedModal
        open={!guard.dialogOpen && !picking}
        size="md"
        preventCloseOnClickOutside
        aria-label="Add to job"
        onClose={() => {
          if (!pending) guard.requestDiscard(onClose);
          return false;
        }}
      >
        <ModalHeader title="Add to job" label={`${job.displayId} · ${machineJobName(job)}`} />
        <ModalBody hasForm>
          <FormProvider {...form}>
            <Stack gap={6}>
              {error && (
                <InlineNotification kind="error" lowContrast hideCloseButton title="Nothing added" subtitle={error} />
              )}
              <RadioButtonGroup
                name="add-to-job-kind"
                legendText="What do you want to add?"
                orientation="vertical"
                valueSelected={kind}
                onChange={(value) => setMode(value as 'recorded' | 'manual')}
              >
                <RadioButton
                  id="add-to-job-recorded"
                  value="recorded"
                  disabled={runs.length === 0}
                  labelText={`A run ${job.machine.name} recorded`}
                />
                <RadioButton id="add-to-job-manual" value="manual" labelText="A manual run" />
              </RadioButtonGroup>
              <p className="mj-secondary">
                {kind === 'recorded'
                  ? `${runs.length} unassigned ${runs.length === 1 ? 'run' : 'runs'} on this machine.`
                  : runs.length === 0 && candidates.isSuccess
                    ? 'No unassigned run on this machine. A manual run is work you enter yourself, for example a reprint.'
                    : 'Work you enter yourself, for example a reprint or a laser job.'}
              </p>
              {kind === 'recorded' ? (
                <>
                  <FuzzySelectField
                    id="add-to-job-run"
                    titleText="Recorded run"
                    placeholder="Select a run"
                    options={runs.map((run) => ({ id: run.id, label: runLabel(run) }))}
                    value={selectedRun?.id ?? null}
                    onChange={setRunId}
                  />
                  {hasManual && (
                    <Checkbox
                      id="add-to-job-replace"
                      labelText={`Replace the job’s manual ${manualRuns(job).length === 1 ? 'run' : 'runs'}`}
                      helperText="Kept as history; their material is returned to stock."
                      checked={replace}
                      onChange={(_event, { checked }) => setReplace(checked)}
                    />
                  )}
                  {selectedRun && <ReplaceComparison job={job} run={selectedRun} replace={hasManual && replace} />}
                  {selectedRun && (
                    <p className="jobs-calc">{runName(selectedRun)} joins the job; the job is repriced.</p>
                  )}
                </>
              ) : (
                <>
                  <RunTimingFields idPrefix="add-run" withWhen />
                  {process.measures.length > 0 && (
                    <div className="mj-form-grid">
                      <MeasureFields idPrefix="add-run" measures={process.measures} />
                    </div>
                  )}
                  <div>
                    <h3 className="jobs-form-run__subtitle">Material usage</h3>
                    <p className="mj-secondary">
                      Record everything consumed, including waste from failed outcomes. Stock is deducted when the run
                      is saved.
                    </p>
                  </div>
                  <UsageRowsEditor idPrefix="add-run-usage" process={process} onPickingChange={setPicking} />
                </>
              )}
            </Stack>
          </FormProvider>
        </ModalBody>
        <ModalFooter>
          <Button kind="secondary" disabled={pending} onClick={() => guard.requestDiscard(onClose)}>
            Cancel
          </Button>
          <Button kind="primary" disabled={pending || (kind === 'recorded' && !selectedRun)} onClick={submit}>
            {pending ? 'Saving…' : kind === 'recorded' ? 'Attach run' : 'Add run'}
          </Button>
        </ModalFooter>
      </ComposedModal>
      <UnsavedChangesDialog guard={guard} />
    </>
  );
}

/** "Add" on the job page: attach a run the machine recorded, or enter a manual run with its material. */
export function AddToJobModal({ open, onClose, job }: { open: boolean; onClose: () => void; job: MachineJob }) {
  return open ? <AddToJobForm onClose={onClose} job={job} /> : null;
}
