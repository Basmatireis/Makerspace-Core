import { InlineNotification } from '@carbon/react';
import { useMutation } from '@tanstack/react-query';
import { deleteInventoryTransaction } from '../../../api/generated/inventory/inventory';
import type { InventoryTransaction, Material } from '../../../api/generated/models';
import { DestructiveActionDialog } from '../../../app/DestructiveActionDialog';
import { formatSigned } from '../components/inventoryShared';
import { ledgerQuantityText, ledgerReferenceText, transactionKindLabel } from '../components/InventoryLedgerTable';
import { formatDateTime } from '../shared/format';
import { useNotify } from '../shared/toasts';
import { spoolErrorMessage, useRefreshInventory } from '../spoolData';

const consequence = (tx: InventoryTransaction) => {
  switch (tx.kind) {
    case 'machine_run_consumption':
      return 'The run keeps its material line, but nothing stays booked for it.';
    case 'order_sale':
    case 'order_sale_reversal':
      return 'The order item is not touched; only the stock movement disappears.';
    case 'purchase':
      return 'The purchase price leaves the stock value; the audit log keeps the entry.';
    case 'spool_transfer':
      return 'The quantity moves back where it came from.';
    default:
      return 'An audit event records who deleted the entry.';
  }
};

/**
 * Deletes one ledger entry (`inventory.ledger.delete`): its quantity and value leave the balance and the spool's
 * remainder. The entry moves to the inventory recycle bin, where it can be restored.
 */
export function DeleteLedgerEntryModal({
  transaction,
  material,
  onClose,
}: {
  transaction: InventoryTransaction;
  /** The entry's article, for its unit and inventory version. */
  material: Pick<Material, 'name' | 'unit' | 'countLabel' | 'inventoryVersion'>;
  onClose: () => void;
}) {
  const notify = useNotify();
  const refresh = useRefreshInventory();
  const removal = useMutation({
    mutationFn: () =>
      deleteInventoryTransaction(transaction.id, { expectedInventoryVersion: material.inventoryVersion }),
    onSuccess: async () => {
      notify({
        kind: 'success',
        title: 'Ledger entry deleted',
        subtitle: `${transactionKindLabel(transaction)} · ${ledgerQuantityText(transaction, material.unit, material.countLabel)} reversed`,
      });
      onClose();
      await refresh();
    },
    onError: () => {
      void refresh();
    },
  });
  const delta = -Number(transaction.quantityDelta);
  const reference = ledgerReferenceText(transaction);

  return (
    <DestructiveActionDialog
      open
      title="Delete ledger entry?"
      fate="recycle"
      confirmLabel="Delete entry"
      pending={removal.isPending}
      error={removal.isError ? spoolErrorMessage(removal.error, 'The entry could not be deleted.') : undefined}
      onClose={onClose}
      onConfirm={() => removal.mutate()}
    >
      <dl className="inv-summary">
        <dt>Article</dt>
        <dd>{material.name}</dd>
        <dt>Entry</dt>
        <dd>
          {transactionKindLabel(transaction)} · {ledgerQuantityText(transaction, material.unit, material.countLabel)}
        </dd>
        <dt>Date</dt>
        <dd>{formatDateTime(transaction.occurredAt)}</dd>
        <dt>Reference</dt>
        <dd>{reference || '—'}</dd>
        <dt>Booked by</dt>
        <dd>{transaction.actorName ?? '—'}</dd>
      </dl>
      <InlineNotification
        kind="warning"
        lowContrast
        hideCloseButton
        title={
          transaction.kind === 'spool_transfer'
            ? 'The article total stays the same.'
            : `The stock changes by ${formatSigned(delta, material.unit, material.countLabel)}.`
        }
        subtitle={consequence(transaction)}
      />
    </DestructiveActionDialog>
  );
}
