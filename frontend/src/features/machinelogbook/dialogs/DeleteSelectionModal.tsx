import { useState } from 'react';
import { Checkbox, Modal, RadioButton, RadioButtonGroup, Stack } from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { bulkDeleteMachineWork } from '../../../api/generated/machine-jobs/machine-jobs';
import type { WorkItem } from '../../../api/generated/models';
import { LinkifiedText } from '../../../app/RefLink';
import { RichNotification } from '../../../app/RichNotification';
import { deleteBlocker, hasBookedMaterial, plural, referenceTargets } from '../bulkWork';
import { machineLogbookKeys } from '../queries';
import { useNotify } from '../shared/toasts';
import { BulkError } from './BulkError';

type Props = { open: boolean; onClose: () => void; items: WorkItem[]; onDone: () => void };

/** Deletes the selected jobs and unassigned runs in one request. Jobs on an order and running runs are skipped and listed. */
export function DeleteSelectionModal({ open, ...props }: Props) {
  if (!open) return null;
  return <DeleteSelectionDialog {...props} />;
}

const BULK_ITEM = (item: WorkItem) => ({ id: item.id, expectedVersion: item.version ?? 0 });

function DeleteSelectionDialog({ onClose, items, onDone }: Omit<Props, 'open'>) {
  const client = useQueryClient();
  const notify = useNotify();
  const [material, setMaterial] = useState<'reverse' | 'keep' | ''>('');
  const [alsoRuns, setAlsoRuns] = useState(true);

  const skipped = items.flatMap((item) => {
    const reason = deleteBlocker(item);
    return reason ? [reason] : [];
  });
  const deletable = items.filter((item) => deleteBlocker(item) === null);
  const jobs = deletable.filter((item) => item.kind === 'job');
  const runs = deletable.filter((item) => item.kind === 'run');
  const recordedJobs = jobs.filter((job) => job.source === 'recorded');
  const needsMaterialChoice = deletable.some(hasBookedMaterial);
  const summary = [jobs.length > 0 && plural(jobs.length, 'job'), runs.length > 0 && plural(runs.length, 'run')]
    .filter(Boolean)
    .join(', ');
  const targets = referenceTargets(items);

  const remove = useMutation({
    mutationFn: () =>
      bulkDeleteMachineWork({
        jobs: jobs.map(BULK_ITEM),
        runs: runs.map(BULK_ITEM),
        deleteRuns: recordedJobs.length > 0 && alsoRuns,
        material: needsMaterialChoice ? material || null : null,
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
      notify({
        kind: 'success',
        title: `Deleted ${[jobs.length > 0 && plural(jobs.length, 'job'), runs.length > 0 && plural(runs.length, 'run')].filter(Boolean).join(' and ')}`,
        subtitle:
          [
            needsMaterialChoice &&
              (material === 'reverse' ? 'Booked material was returned to stock.' : 'Stock was left unchanged.'),
            skipped.length > 0 && `${plural(skipped.length, 'item')} skipped.`,
          ]
            .filter(Boolean)
            .join(' ') || undefined,
      });
      onDone();
      onClose();
    },
  });
  const pending = remove.isPending;

  return (
    <Modal
      open
      danger
      alert
      size="md"
      modalHeading={summary ? `Delete ${summary}?` : 'Nothing to delete'}
      secondaryButtonText="Cancel"
      primaryButtonText={pending ? 'Deleting…' : 'Delete'}
      primaryButtonDisabled={pending || deletable.length === 0 || (needsMaterialChoice && !material)}
      preventCloseOnClickOutside
      selectorPrimaryFocus=".cds--btn--secondary"
      shouldSubmitOnEnter={false}
      onRequestClose={() => {
        if (!pending) onClose();
      }}
      onSecondarySubmit={() => {
        if (!pending) onClose();
      }}
      onRequestSubmit={() => {
        if (!pending) remove.mutate();
      }}
    >
      <Stack gap={5}>
        <p>
          {deletable.length === 0
            ? 'None of the selected items can be deleted.'
            : `${summary} will be deleted. This can't be undone.`}
        </p>
        {skipped.length > 0 && (
          <RichNotification kind="warning" title={`${plural(skipped.length, 'item')} will be skipped`}>
            <ul className="mj-skip-list">
              {skipped.map((reason) => (
                <li key={reason}>
                  <LinkifiedText text={reason} targets={targets} onNavigate={onClose} />
                </li>
              ))}
            </ul>
          </RichNotification>
        )}
        {recordedJobs.length > 0 && (
          <Checkbox
            id="delete-selection-runs"
            labelText={`Also delete their recorded runs (in ${plural(recordedJobs.length, 'job')})`}
            checked={alsoRuns}
            helperText={alsoRuns ? undefined : 'The recorded runs stay and show as unassigned runs.'}
            onChange={(_event, { checked }) => setAlsoRuns(checked)}
          />
        )}
        {needsMaterialChoice && (
          <RadioButtonGroup
            legendText="Material consumption"
            name="delete-selection-material"
            orientation="vertical"
            valueSelected={material}
            helperText="Some of these items consumed material from stock. Choose what happens to it."
            onChange={(value) => setMaterial(value as 'reverse' | 'keep')}
          >
            <RadioButton
              id="delete-selection-reverse"
              value="reverse"
              labelText="Reverse consumption (return the material to stock)"
            />
            <RadioButton
              id="delete-selection-keep"
              value="keep"
              labelText="Keep consumption (the material counts as consumed)"
            />
          </RadioButtonGroup>
        )}
        <BulkError
          error={remove.error}
          title="The selection could not be deleted"
          targets={targets}
          onNavigate={onClose}
        />
      </Stack>
    </Modal>
  );
}
