import { useState } from 'react';
import { InlineNotification, Modal, Stack, TextArea } from '@carbon/react';
import type { MachineJob } from '../../../api/generated/models';
import { saveError } from '../dialogs/jobFormHelpers';
import { machineJobName } from '../shared/status';
import { useNotify } from '../shared/toasts';
import { useUpdateJobFacts } from './jobsQueries';

function NotesForm({ job, onClose }: { job: MachineJob; onClose: () => void }) {
  const notify = useNotify();
  const [notes, setNotes] = useState(job.notes ?? '');
  const update = useUpdateJobFacts(job);
  return (
    <Modal
      open
      size="sm"
      modalHeading="Edit notes"
      modalLabel={`${job.displayId} · ${machineJobName(job)}`}
      primaryButtonText={update.isPending ? 'Saving…' : 'Save notes'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={update.isPending}
      selectorPrimaryFocus="#job-notes"
      preventCloseOnClickOutside
      onRequestClose={() => {
        if (!update.isPending) onClose();
      }}
      onRequestSubmit={() =>
        update.mutate(
          { notes: notes.trim() || null },
          {
            onSuccess: () => {
              notify({ kind: 'success', title: 'Notes saved', subtitle: machineJobName(job) });
              onClose();
            },
          },
        )
      }
    >
      <Stack gap={5}>
        {update.isError && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Notes not saved"
            subtitle={saveError(update.error, update.error instanceof Error ? update.error.message : undefined).message}
          />
        )}
        <TextArea
          id="job-notes"
          labelText="Notes"
          rows={5}
          maxCount={2000}
          enableCounter
          placeholder="Anything the next person should know about this job"
          helperText="Visible to staff only; not printed on the order."
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
      </Stack>
    </Modal>
  );
}

/** Notes of a job, edited on their own from the job page. */
export function JobNotesModal({ open, job, onClose }: { open: boolean; job: MachineJob; onClose: () => void }) {
  return open ? <NotesForm job={job} onClose={onClose} /> : null;
}
