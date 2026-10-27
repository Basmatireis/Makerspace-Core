import { useNavigate } from 'react-router-dom';
import {
  Modal,
  Select,
  SelectItem,
  Stack,
  StructuredListBody,
  StructuredListCell,
  StructuredListHead,
  StructuredListRow,
  StructuredListWrapper,
  TextInput,
} from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormProvider, useForm } from 'react-hook-form';
import {
  bulkCombineMachineRuns,
  bulkCreateMachineJobsFromRuns,
} from '../../../api/generated/machine-runs/machine-runs';
import type { WorkItem } from '../../../api/generated/models';
import { plural, referenceTargets } from '../bulkWork';
import { workItemConsumption } from '../processConfig';
import { machineLogbookKeys, pricingQuery } from '../queries';
import { formatDateTime } from '../shared/format';
import { machineLogbookPaths } from '../shared/paths';
import { nameFromFile } from '../shared/status';
import { useNotify } from '../shared/toasts';
import { useCan } from '../shared/useCan';
import { BulkError } from './BulkError';
import { JobPartyFields } from './JobFormModal';
import { signedInOperator, type PartyValues } from './jobFormHelpers';
import { useCurrentUser } from '../../auth/auth';

type Mode = 'separate' | 'combined';
type Props = { open: boolean; onClose: () => void; runs: WorkItem[]; onDone: () => void };
type Values = PartyValues & { title: string; pricingGroupId: string };

const BULK_ITEM = (item: WorkItem) => ({ id: item.id, expectedVersion: item.version ?? 0 });

/** One job per selected unassigned run; customer, operator, notes and pricing group are shared. */
export function CreateSeparateJobsModal({ open, ...props }: Props) {
  return open ? <BulkJobDialog mode="separate" {...props} /> : null;
}

/** One job that contains all selected unassigned runs of one machine. */
export function CreateCombinedJobModal({ open, ...props }: Props) {
  return open ? <BulkJobDialog mode="combined" {...props} /> : null;
}

function BulkJobDialog({ mode, onClose, runs, onDone }: Omit<Props, 'open'> & { mode: Mode }) {
  const client = useQueryClient();
  const notify = useNotify();
  const navigate = useNavigate();
  const can = useCan();
  const currentUser = useCurrentUser();
  const canReadPricing = can('pricing.read');
  const pricing = useQuery({ ...pricingQuery(), enabled: canReadPricing });
  const form = useForm<Values>({
    defaultValues: {
      title: '',
      customer: null,
      operator: signedInOperator(currentUser.person),
      notes: '',
      pricingGroupId: '',
    },
  });
  const targets = referenceTargets(runs);
  const machineName = runs[0]?.machineName ?? 'the machine';

  const create = useMutation({
    mutationFn: async (values: Values) => {
      const shared = {
        runs: runs.map(BULK_ITEM),
        customer: { kind: values.customer!.kind, id: values.customer!.id },
        operatorPersonId: values.operator!.personId,
        notes: values.notes.trim() || null,
        pricingGroupId: values.pricingGroupId || undefined,
      };
      return mode === 'separate'
        ? { jobs: (await bulkCreateMachineJobsFromRuns(shared)).jobs, combined: null }
        : { jobs: null, combined: await bulkCombineMachineRuns({ ...shared, title: values.title.trim() || null }) };
    },
    onSuccess: async (created) => {
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
      onDone();
      onClose();
      if (created.jobs) {
        notify({
          kind: 'success',
          title: `${plural(created.jobs.length, 'job')} created`,
          subtitle: `${created.jobs.map((job) => job.displayId).join(', ')}. Each job uses the data of its run.`,
        });
      } else {
        notify({
          kind: 'success',
          title: `${plural(runs.length, 'run')} combined`,
          subtitle: `${created.combined.displayId} holds all selected runs.`,
        });
        navigate(machineLogbookPaths.job(created.combined.id));
      }
    },
  });
  const pending = create.isPending;
  const label = mode === 'separate' ? `Create ${plural(runs.length, 'job')}` : 'Create combined job';

  return (
    <Modal
      open
      size="md"
      modalHeading={
        mode === 'separate'
          ? `Create ${plural(runs.length, 'separate job')}`
          : `Combine ${runs.length} runs into one job`
      }
      secondaryButtonText="Cancel"
      primaryButtonText={pending ? 'Creating…' : label}
      primaryButtonDisabled={pending}
      preventCloseOnClickOutside
      onRequestClose={() => {
        if (!pending) onClose();
      }}
      onRequestSubmit={() => {
        void form.handleSubmit((values) => create.mutate(values))();
      }}
    >
      <FormProvider {...form}>
        <Stack gap={6}>
          <p>
            {mode === 'separate'
              ? 'Every selected run becomes its own job, named after its file. The fields below apply to all of them.'
              : `All selected runs become one job on ${machineName}. Runtime and material are summed from the runs.`}
          </p>
          {mode === 'combined' && (
            <TextInput
              id="bulk-job-title"
              labelText="Name (optional)"
              placeholder={runs[0]?.fileName ? nameFromFile(runs[0].fileName) : undefined}
              maxLength={120}
              helperText="Leave empty to show the file name of the latest run."
              {...form.register('title')}
            />
          )}
          <JobPartyFields idPrefix="bulk-job" />
          {canReadPricing && (
            <Select
              id="bulk-job-pricing-group"
              labelText="Pricing group (optional)"
              helperText="Leave empty to use the customer’s pricing group."
              {...form.register('pricingGroupId')}
            >
              <SelectItem value="" text="Customer’s pricing group" />
              {(pricing.data?.items ?? [])
                .filter((group) => group.active)
                .map((group) => (
                  <SelectItem key={group.id} value={group.id} text={group.name} />
                ))}
            </Select>
          )}
          <StructuredListWrapper
            isCondensed
            aria-label={mode === 'separate' ? 'Jobs that will be created' : 'Runs that will be combined'}
          >
            <StructuredListHead>
              <StructuredListRow head>
                <StructuredListCell head>{mode === 'separate' ? 'Job name (run file)' : 'Run file'}</StructuredListCell>
                <StructuredListCell head>Started</StructuredListCell>
                <StructuredListCell head>Consumption</StructuredListCell>
              </StructuredListRow>
            </StructuredListHead>
            <StructuredListBody>
              {runs.map((run) => (
                <StructuredListRow key={run.id}>
                  <StructuredListCell>{run.fileName || run.displayId}</StructuredListCell>
                  <StructuredListCell>{formatDateTime(run.startedAt)}</StructuredListCell>
                  <StructuredListCell>{workItemConsumption(run.consumption) ?? 'None recorded'}</StructuredListCell>
                </StructuredListRow>
              ))}
            </StructuredListBody>
          </StructuredListWrapper>
          <BulkError
            error={create.error}
            title={mode === 'separate' ? 'The jobs could not be created' : 'The runs could not be combined'}
            targets={targets}
            onNavigate={onClose}
          />
        </Stack>
      </FormProvider>
    </Modal>
  );
}
