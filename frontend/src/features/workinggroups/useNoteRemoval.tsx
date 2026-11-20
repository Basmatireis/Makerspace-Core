import { useId, useState } from 'react';
import { Modal } from '@carbon/react';
import type { WorkingGroupNote } from '../../api/generated/models';
import { deleteWorkingGroupNote } from '../../api/generated/working-groups/working-groups';
import { useNotify } from '../../app/toasts';
import { useCurrentUser } from '../auth/auth';
import { useWgMutation } from './useWgMutation';

/**
 * Removing a pinboard note. The author's own note goes at once; a note of somebody else asks first. Afterwards focus
 * moves to the element with id `frameId` (the table's wrapper) (the table's wrapper).
 */
export function useNoteRemoval() {
  const me = useCurrentUser().person.id;
  const notify = useNotify();
  const remove = useWgMutation((id: string) => deleteWorkingGroupNote(id));
  const [confirming, setConfirming] = useState<WorkingGroupNote | null>(null);
  const frameId = `wg-note-frame-${useId()}`;

  const run = (note: WorkingGroupNote) =>
    remove.mutate(note.id, {
      onSuccess: () => {
        notify({ kind: 'success', title: 'Note removed' });
        setConfirming(null);
        window.setTimeout(() => document.getElementById(frameId)?.focus(), 0);
      },
      onError: () => {
        notify({ kind: 'error', title: 'Note not removed' });
        setConfirming(null);
      },
    });

  const dialog = confirming && (
    <Modal
      open
      danger
      size="sm"
      modalHeading="Remove note"
      primaryButtonText={remove.isPending ? 'Removing…' : 'Remove'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={remove.isPending}
      onRequestClose={() => setConfirming(null)}
      onRequestSubmit={() => run(confirming)}
    >
      <p>
        Remove the note “{confirming.text.slice(0, 60)}
        {confirming.text.length > 60 ? '…' : ''}” of {confirming.author?.displayName ?? 'a former member'}?
      </p>
    </Modal>
  );

  return {
    frameId,
    dialog,
    pending: remove.isPending,
    request: (note: WorkingGroupNote) => (note.author?.personId === me ? run(note) : setConfirming(note)),
  };
}
