import { deleteCashCount, deleteCashMovement } from '../../api/generated/payments/payments';
import type { CashJournalEntry } from '../../api/generated/models';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { useNotify } from '../machinelogbook/shared/toasts';
import { entryEffect } from './cashJournal';
import { formatCents, toCents } from './money';
import { useFinanceMutation } from './queries';

const noun = (entry: CashJournalEntry) =>
  entry.kind === 'count' ? 'count' : entry.kind === 'withdrawal' ? 'withdrawal' : 'deposit';

/** The money a withdrawal or deposit moved, or what a count found. */
const entryAmount = (entry: CashJournalEntry) =>
  formatCents(entry.count ? toCents(entry.count.countedAmount) : Math.abs(entryEffect(entry)));

/** Deletes a withdrawal, deposit or count of the cash register for good (cash_movements.manage). */
export function DeleteCashEntryDialog({
  entry,
  onDeleted,
  onClose,
}: {
  entry: CashJournalEntry;
  onDeleted: () => void;
  onClose: () => void;
}) {
  const notify = useNotify();
  const what = noun(entry);
  const mutation = useFinanceMutation(
    () => {
      const body = { expectedVersion: entry.version ?? 1 };
      return entry.source === 'count' ? deleteCashCount(entry.id, body) : deleteCashMovement(entry.id, body);
    },
    () => {
      notify({
        kind: 'success',
        title: `${what[0].toUpperCase()}${what.slice(1)} deleted`,
        subtitle: `${entry.reference} (${entryAmount(entry)}) is no longer in the cash register.`,
      });
      onDeleted();
    },
  );
  const hasCorrection = !!entry.count && toCents(entry.count.difference) !== 0;
  return (
    <DestructiveActionDialog
      open
      title={`Delete ${what}?`}
      fate="permanent"
      confirmLabel="Delete"
      pending={mutation.isPending}
      error={mutation.error?.message}
      onConfirm={() => mutation.mutate(undefined)}
      onClose={onClose}
    >
      {entry.count ? (
        <p>
          Count {entry.reference} found {entryAmount(entry)}.{' '}
          {hasCorrection ? 'Its correction is removed too, ' : 'It booked no correction; '}
          and the next count is recalculated without it.
        </p>
      ) : (
        <p>
          The {what} {entry.reference} of {entryAmount(entry)} is removed from the cash register. Counts after it are
          recalculated.
        </p>
      )}
    </DestructiveActionDialog>
  );
}
