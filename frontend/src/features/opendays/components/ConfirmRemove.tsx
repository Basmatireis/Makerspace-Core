import { DestructiveActionDialog } from '../../../app/DestructiveActionDialog';
import { plural } from '../model/dates';

export type RemovalRequest = {
  ids: string[];
  /** What the dialog names, for example "Tue, 3 Nov". */
  label: string;
  /** Saved open days among them (unsaved ones are just dropped). */
  saved: number;
  assigned: number;
  draft: boolean;
};

/** Confirms deleting (draft period) or cancelling open days. Nothing is sent before the schedule is saved. */
export function ConfirmRemove({
  request,
  onConfirm,
  onClose,
}: {
  request: RemovalRequest | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const verb = request?.draft ? 'Delete' : 'Cancel';
  const noun = request ? plural(request.ids.length, 'open day') : '';
  return (
    <DestructiveActionDialog
      open={request !== null}
      title={`${verb} ${noun}?`}
      fate="none"
      confirmLabel={`${verb} ${noun}`}
      cancelLabel="Keep"
      onClose={onClose}
      onConfirm={onConfirm}
    >
      <p>{request?.label}</p>
      <p>
        {request && request.saved === 0
          ? 'These open days exist only in your working copy and are simply dropped.'
          : request?.draft
            ? 'They are removed for good when you save the schedule.'
            : `They are cancelled when you save the schedule.${request && request.assigned ? ` ${plural(request.assigned, 'sign-up')} on these days; people get a message. Who was assigned stays on record.` : ''}`}
      </p>
    </DestructiveActionDialog>
  );
}
