import { LinkifiedText } from '../components/RefLink';
import { useEffect, useState } from 'react';
import { Checkbox, InlineNotification, Modal, RadioButton, RadioButtonGroup, Stack } from '@carbon/react';
import type { JobRow } from '../derived';
import { deleteBlocker, hasBookedMaterial, runsOfJob } from '../runs';
import { useSimulatedMutation, useStore, type DeleteSelectionInput } from '../store';

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** Mass delete of jobs and unassigned runs from the Jobs table. */
export function DeleteSelectionModal({ open, onClose, rows, onDone }: { open: boolean; onClose: () => void; rows: JobRow[]; onDone: () => void }) {
  const store = useStore();
  const [material, setMaterial] = useState<'reverse' | 'keep' | ''>('');
  const [alsoRuns, setAlsoRuns] = useState(true);
  useEffect(() => { if (open) { setMaterial(''); setAlsoRuns(true); } }, [open]);
  const { mutate, pending } = useSimulatedMutation((input: DeleteSelectionInput) => store.deleteSelection(input));

  const skipped = rows.flatMap((row) => { const reason = deleteBlocker(row); return reason ? [reason] : []; });
  const jobs = rows.filter((row) => row.job && deleteBlocker(row) === null);
  const runs = rows.filter((row) => row.kind === 'print' && deleteBlocker(row) === null);
  const linkedRuns = jobs.reduce((sum, row) => sum + runsOfJob(row.id, store.prints).length, 0);
  const needsMaterialChoice = jobs.some((row) => hasBookedMaterial(row.job!));
  const summary = [jobs.length > 0 && plural(jobs.length, 'job'), runs.length > 0 && plural(runs.length, 'run')].filter(Boolean).join(', ');

  const confirm = async () => {
    const result = await mutate({ jobIds: jobs.map((row) => row.id), runIds: runs.map((row) => row.id), deleteRuns: alsoRuns, material: needsMaterialChoice ? material || null : null });
    store.notify({
      kind: 'success', title: `Deleted ${[result.jobs > 0 && plural(result.jobs, 'job'), result.runs > 0 && plural(result.runs, 'run')].filter(Boolean).join(' and ')}`,
      subtitle: [needsMaterialChoice && (material === 'reverse' ? 'Booked material was returned to stock.' : 'Stock was left unchanged.'), result.skipped.length > 0 && `${plural(result.skipped.length, 'item')} skipped.`].filter(Boolean).join(' ') || undefined,
    });
    onDone();
    onClose();
  };

  return (
    <Modal
      danger open={open} size="md" modalHeading={summary ? `Delete ${summary}?` : 'Nothing to delete'} secondaryButtonText="Cancel"
      primaryButtonText={pending ? 'Deleting…' : 'Delete'} primaryButtonDisabled={pending || (jobs.length + runs.length === 0) || (needsMaterialChoice && !material)}
      preventCloseOnClickOutside onRequestClose={() => { if (!pending) onClose(); }} onRequestSubmit={() => { void confirm(); }}
    >
      <Stack gap={5}>
        <p>
          {jobs.length + runs.length === 0 ? 'None of the selected items can be deleted.' : `${summary} will be deleted permanently. This can't be undone.`}
        </p>
        {skipped.length > 0 && (
          <InlineNotification
            kind="warning" lowContrast hideCloseButton title={`${plural(skipped.length, 'item')} will be skipped`}
          >
            <ul className="mj-skip-list">{skipped.map((reason) => <li key={reason}><LinkifiedText text={reason} onNavigate={onClose} /></li>)}</ul>
          </InlineNotification>
        )}
        {linkedRuns > 0 && (
          <Checkbox
            id="delete-selection-runs" labelText={`Also delete their recorded runs (${linkedRuns})`} checked={alsoRuns}
            helperText={alsoRuns ? undefined : 'The runs stay and show as unassigned runs.'} onChange={(_event, { checked }) => setAlsoRuns(checked)}
          />
        )}
        {needsMaterialChoice && (
          <RadioButtonGroup
            legendText="Material consumption" name="delete-selection-material" orientation="vertical" valueSelected={material}
            helperText="Some of these jobs have material booked against stock. Choose what happens to it."
            onChange={(value) => setMaterial(value as 'reverse' | 'keep')}
          >
            <RadioButton id="delete-selection-reverse" value="reverse" labelText="Reverse — return the booked material to stock" />
            <RadioButton id="delete-selection-keep" value="keep" labelText="Keep — the material counts as consumed" />
          </RadioButtonGroup>
        )}
      </Stack>
    </Modal>
  );
}
