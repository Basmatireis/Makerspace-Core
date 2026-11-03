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
  TextInput,
} from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormProvider, useForm, useWatch } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { createMachineJobFromRun } from '../../../api/generated/machine-runs/machine-runs';
import type { MachineRun, Operator, WorkItem } from '../../../api/generated/models';
import { FuzzySelectField } from '../../../app/components/FuzzyComboBox';
import { useCurrentUser } from '../../auth/auth';
import { JobPartyFields, SignageCheckbox } from '../dialogs/JobFormModal';
import { saveError, signedInOperator, type PartyValues } from '../dialogs/jobFormHelpers';
import { jobQuery, machineLogbookKeys, runQuery, workItemsQuery } from '../queries';
import { formatDuration, formatRelative } from '../shared/format';
import { machineLogbookPaths } from '../shared/paths';
import { ReplaceComparison } from '../shared/ReplaceComparison';
import { manualRuns, nameFromFile, runConsumptionText, runName, workItemName } from '../shared/status';
import { useNotify } from '../shared/toasts';
import { jobStatuses, useAttachRunToJob } from './jobsQueries';
import '../styles/jobs.scss';
import './jobs.scss';

type Values = PartyValues & { title: string; hiddenFromSignage: boolean };

const openStatuses = new Set(['planned', 'running', 'needs_outcome']);
const jobLabel = (job: WorkItem) =>
  `${workItemName(job)} · ${job.displayId} · ${job.customer?.displayName ?? 'No recipient'}${openStatuses.has(job.status) ? '' : ' (finished)'}`;

function ClaimForm({ onClose, run, canCreate, canAttach }: ClaimProps & { run: MachineRun }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const notify = useNotify();
  const currentUser = useCurrentUser();
  const jobs = useQuery({
    ...workItemsQuery({
      machineId: [run.machineId],
      status: jobStatuses,
      sort: 'startedAt',
      direction: 'desc',
      page: 1,
      pageSize: 50,
    }),
    enabled: canAttach,
  });
  const candidates = [...(jobs.data?.items ?? [])].sort(
    (a, b) => Number(!openStatuses.has(a.status)) - Number(!openStatuses.has(b.status)),
  );
  const openCount = candidates.filter((job) => openStatuses.has(job.status)).length;
  const [chosenMode, setMode] = useState<'existing' | 'new' | null>(null);
  const mode = chosenMode ?? (canAttach && openCount > 0 ? 'existing' : canCreate ? 'new' : 'existing');
  const [jobId, setJobId] = useState<string | null>(null);
  const targetId = jobId ?? candidates[0]?.id ?? null;
  const detail = useQuery({ ...jobQuery(targetId ?? ''), enabled: mode === 'existing' && targetId !== null });
  const [replace, setReplace] = useState(true);
  const [jobSignage, setJobSignage] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const form = useForm<Values>({
    defaultValues: {
      customer: null,
      operator: signedInOperator(currentUser.person),
      notes: '',
      title: run.fileName ? nameFromFile(run.fileName) : '',
      hiddenFromSignage: run.hiddenFromSignage,
    },
  });
  const [customer, hiddenFromSignage] = useWatch({ control: form.control, name: ['customer', 'hiddenFromSignage'] });
  const attach = useAttachRunToJob();
  const create = useMutation({
    mutationFn: (values: Values) =>
      createMachineJobFromRun(run.id, {
        title: values.title.trim() || null,
        customer: { kind: values.customer!.kind, id: values.customer!.id },
        operatorPersonId: (values.operator as Operator).personId,
        hiddenFromSignage: values.hiddenFromSignage,
      }),
    onSuccess: async (job) => {
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
      notify({ kind: 'success', title: 'Job created', subtitle: `${job.displayId} contains ${run.displayId}.` });
      onClose();
      navigate(machineLogbookPaths.job(job.id));
    },
    onError: (cause) => setError(saveError(cause).message),
  });
  const job = detail.data;
  const hasManual = job ? manualRuns(job).length > 0 : false;
  const offSignage = jobSignage ?? job?.hiddenFromSignage ?? false;
  const pending = attach.isPending || create.isPending;

  const submit = () => {
    setError(null);
    if (mode === 'existing') {
      if (!job) return;
      attach.mutate(
        {
          runId: run.id,
          job,
          replaceManualRuns: hasManual && replace,
          hiddenFromSignage: offSignage !== job.hiddenFromSignage ? offSignage : undefined,
        },
        {
          onSuccess: () => {
            notify({ kind: 'success', title: 'Run attached', subtitle: `${run.displayId} → ${job.displayId}` });
            onClose();
            navigate(machineLogbookPaths.job(job.id));
          },
          onError: (cause) => setError(saveError(cause, 'The run could not be attached.').message),
        },
      );
      return;
    }
    void form.handleSubmit(
      (values) => create.mutate(values),
      () => setError('Select a recipient and an operator.'),
    )();
  };

  return (
    <ComposedModal
      open
      size="md"
      preventCloseOnClickOutside
      aria-label="Claim run"
      onClose={() => {
        if (!pending) onClose();
        return false;
      }}
    >
      <ModalHeader title="Claim run" label={`${run.displayId} · ${run.machineName}`} />
      <ModalBody hasForm>
        <FormProvider {...form}>
          <Stack gap={6}>
            {error && (
              <InlineNotification kind="error" lowContrast hideCloseButton title="Run not claimed" subtitle={error} />
            )}
            <dl className="jobs-summary">
              <div>
                <dt>Run</dt>
                <dd>
                  {runName(run)} · {formatRelative(run.startedAt)} · {formatDuration(run.durationSeconds)}
                  {run.state === 'running' ? ' so far' : ''}
                </dd>
              </div>
              <div>
                <dt>Material</dt>
                <dd>
                  {runConsumptionText(run) || '—'}
                  {run.state === 'running' ? ' (estimated until the run ends)' : ''}
                </dd>
              </div>
            </dl>
            <RadioButtonGroup
              name="claim-mode"
              legendText="Who gets this run?"
              orientation="vertical"
              valueSelected={mode}
              onChange={(value) => setMode(value as 'existing' | 'new')}
            >
              <RadioButton
                id="claim-existing"
                value="existing"
                disabled={!canAttach || candidates.length === 0}
                labelText={`Attach to a job on ${run.machineName}`}
              />
              <RadioButton id="claim-new" value="new" disabled={!canCreate} labelText="New job" />
            </RadioButtonGroup>
            <p className="mj-secondary">
              {mode === 'existing'
                ? openCount > 0
                  ? `${openCount} open ${openCount === 1 ? 'job' : 'jobs'} on this machine.`
                  : candidates.length > 0
                    ? 'Only finished jobs on this machine.'
                    : 'No job on this machine yet.'
                : 'The run becomes the first run of a new job for a recipient.'}
            </p>
            {mode === 'existing' ? (
              <>
                <FuzzySelectField
                  id="claim-job"
                  titleText="Job"
                  placeholder="Select a job"
                  options={candidates.map((item) => ({ id: item.id, label: jobLabel(item) }))}
                  value={targetId}
                  onChange={(id) => {
                    setJobId(id);
                    setJobSignage(null);
                  }}
                />
                {hasManual && (
                  <Checkbox
                    id="claim-replace"
                    labelText={`Replace the job’s manual ${manualRuns(job!).length === 1 ? 'run' : 'runs'}`}
                    helperText="Kept as history; their material is returned to stock."
                    checked={replace}
                    onChange={(_event, { checked }) => setReplace(checked)}
                  />
                )}
                {job && <ReplaceComparison job={job} run={run} replace={hasManual && replace} />}
                {job && (
                  <SignageCheckbox
                    id="claim-signage"
                    labelText="Keep the job off the signage screens"
                    helperText={
                      job.hiddenFromSignage
                        ? 'The job is already off signage; this run follows it.'
                        : 'Hides the live status, stream and timelapses of all the job’s runs on every display.'
                    }
                    checked={offSignage}
                    onChange={setJobSignage}
                  />
                )}
              </>
            ) : (
              <>
                <JobPartyFields idPrefix="claim" />
                <TextInput id="claim-title" labelText="Title" maxLength={200} {...form.register('title')} />
                <SignageCheckbox
                  id="claim-new-signage"
                  labelText="Keep off the signage screens"
                  helperText="The new job and all its runs stay off every display: no live status, no stream, no timelapse."
                  checked={hiddenFromSignage}
                  onChange={(checked) => form.setValue('hiddenFromSignage', checked, { shouldDirty: true })}
                />
              </>
            )}
          </Stack>
        </FormProvider>
      </ModalBody>
      <ModalFooter>
        <Button kind="secondary" disabled={pending} onClick={onClose}>
          Cancel
        </Button>
        <Button kind="primary" disabled={pending || (mode === 'existing' ? !job : !customer)} onClick={submit}>
          {pending ? 'Saving…' : mode === 'new' ? 'Create job' : 'Attach to job'}
        </Button>
      </ModalFooter>
    </ComposedModal>
  );
}

type ClaimProps = { onClose: () => void; canCreate: boolean; canAttach: boolean };

/**
 * Claim an unassigned recorded run: attach it to a job on its machine (open jobs first) or make it the first run of
 * a new job. Either way the job can be kept off signage. Opens the job afterwards.
 */
export function ClaimRunModal({ runId, onClose, canCreate, canAttach }: ClaimProps & { runId: string | null }) {
  const run = useQuery({ ...runQuery(runId ?? ''), enabled: runId !== null });
  if (!runId || !run.data) return null;
  return <ClaimForm onClose={onClose} run={run.data} canCreate={canCreate} canAttach={canAttach} />;
}
