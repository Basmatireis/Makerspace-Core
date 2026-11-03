/* eslint-disable react-refresh/only-export-components -- the bin entry type and its dialogs belong together */
import { InlineNotification, Modal, Stack } from '@carbon/react';
import { useMutation } from '@tanstack/react-query';
import { purgeFilamentSpool, restoreFilamentSpool } from '../../../api/generated/filament-spools/filament-spools';
import {
  purgeInventoryTransaction,
  purgeMaterial,
  restoreInventoryTransaction,
  restoreMaterial,
} from '../../../api/generated/inventory/inventory';
import type { DeletedInventoryTransaction, DeletedMaterial, FilamentSpool } from '../../../api/generated/models';
import { DestructiveActionDialog } from '../../../app/DestructiveActionDialog';
import { formatGrams, formatQuantity } from '../components/inventoryShared';
import { ledgerQuantityText, transactionKindLabel } from '../components/InventoryLedgerTable';
import { toNumber } from '../components/spoolShared';
import { useNotify } from '../shared/toasts';
import { spoolErrorMessage, useRefreshInventory } from '../spoolData';

/** One entry of the inventory recycle bin. */
export type BinEntry =
  | { kind: 'material'; item: DeletedMaterial }
  | { kind: 'spool'; item: FilamentSpool }
  | { kind: 'ledger'; item: DeletedInventoryTransaction };

export const binEntryName = (entry: BinEntry) =>
  entry.kind === 'material'
    ? `${entry.item.displayId} · ${entry.item.name}`
    : entry.kind === 'spool'
      ? entry.item.displayId
      : `${transactionKindLabel(entry.item.transaction)} · ${entry.item.materialName}`;

async function run(mode: 'restore' | 'purge', entry: BinEntry) {
  if (entry.kind === 'material') {
    const request = { expectedVersion: entry.item.version };
    if (mode === 'restore') await restoreMaterial(entry.item.id, request);
    else await purgeMaterial(entry.item.id, request);
  } else if (entry.kind === 'spool') {
    const request = { expectedVersion: entry.item.version };
    if (mode === 'restore') await restoreFilamentSpool(entry.item.id, request);
    else await purgeFilamentSpool(entry.item.id, request);
  } else if (mode === 'restore') await restoreInventoryTransaction(entry.item.transaction.id);
  else await purgeInventoryTransaction(entry.item.transaction.id);
}

function restoreText(entry: BinEntry): string[] {
  if (entry.kind === 'material')
    return [
      `The article comes back unchanged with ${formatQuantity(entry.item.quantity, entry.item.unit)} in stock${
        entry.item.spoolCount > 0
          ? ` and ${entry.item.spoolCount === 1 ? 'its spool' : `its ${entry.item.spoolCount} spools`} (unmounted)`
          : ''
      }.`,
    ];
  if (entry.kind === 'spool')
    return [
      'The spool becomes active again, unmounted.',
      entry.item.retiredOutcome === 'discarded' && toNumber(entry.item.retiredQuantity) > 0
        ? `The ${formatGrams(entry.item.retiredQuantity ?? 0)} written off come back as stock.`
        : 'Filament booked as used when it was retired stays booked.',
      'If its label number was given to a new spool meanwhile, it gets the next free number.',
    ];
  return [
    `The entry counts again: the stock changes by ${ledgerQuantityText(entry.item.transaction, entry.item.unit)}.`,
  ];
}

function purgeText(entry: BinEntry): string {
  if (entry.kind === 'material')
    return `The article, its spools, its prices and every ledger entry are removed. Runs and orders keep the article name.`;
  if (entry.kind === 'spool')
    return 'The spool record, its identifiers and mount history are removed. Ledger entries and runs keep its label.';
  return 'The entry is removed from the ledger.';
}

/**
 * Confirms Restore or Delete permanently for an entry of the inventory recycle bin. Mount it only while `entry` is
 * set; `onDone` runs after the action succeeded.
 */
export function BinActionDialog({
  mode,
  entry,
  onClose,
  onDone,
}: {
  mode: 'restore' | 'purge';
  entry: BinEntry;
  onClose: () => void;
  onDone?: () => void;
}) {
  const notify = useNotify();
  const refresh = useRefreshInventory();
  const action = useMutation({
    mutationFn: () => run(mode, entry),
    onSuccess: async () => {
      notify({
        kind: 'success',
        title: mode === 'restore' ? `${binEntryName(entry)} restored` : `${binEntryName(entry)} deleted permanently`,
      });
      onDone?.();
      onClose();
      await refresh();
    },
    onError: () => {
      void refresh();
    },
  });
  const error = action.isError
    ? spoolErrorMessage(action.error, 'The action could not be completed. Reload the page and try again.')
    : undefined;

  if (mode === 'purge')
    return (
      <DestructiveActionDialog
        open
        title={`Delete ${binEntryName(entry)} permanently?`}
        fate="permanent"
        confirmLabel="Delete permanently"
        pending={action.isPending}
        error={error}
        onClose={onClose}
        onConfirm={() => action.mutate()}
      >
        <p>{purgeText(entry)}</p>
      </DestructiveActionDialog>
    );
  return (
    <Modal
      open
      size="sm"
      modalHeading={`Restore ${binEntryName(entry)}?`}
      primaryButtonText={action.isPending ? 'Restoring…' : 'Restore'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={action.isPending}
      preventCloseOnClickOutside
      onRequestClose={() => {
        if (!action.isPending) onClose();
      }}
      onRequestSubmit={() => {
        if (!action.isPending) action.mutate();
      }}
    >
      <Stack gap={5}>
        {restoreText(entry).map((sentence) => (
          <p key={sentence}>{sentence}</p>
        ))}
        {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Not restored" subtitle={error} />}
      </Stack>
    </Modal>
  );
}
