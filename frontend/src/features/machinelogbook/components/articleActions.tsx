/* eslint-disable react-refresh/only-export-components -- the article dialogs, their type and the selection hook belong together */
import { useMutation } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { markMaterialEmpty } from '../../../api/generated/inventory/inventory';
import type { InventoryTransaction, Material } from '../../../api/generated/models';
import { DestructiveActionDialog } from '../../../app/DestructiveActionDialog';
import { DeleteArticleModal } from '../dialogs/DeleteArticleModal';
import { DeleteLedgerEntryModal } from '../dialogs/DeleteLedgerEntryModal';
import { MaterialFormModal } from '../dialogs/MaterialFormModal';
import { ReceiveStockModal } from '../dialogs/ReceiveStockModal';
import { RegisterSpoolModal } from '../dialogs/RegisterSpoolModal';
import { StockMovementModal, type MovementMode } from '../dialogs/StockMovementModal';
import { useNotify } from '../shared/toasts';
import { useCan } from '../shared/useCan';
import { spoolErrorMessage, useRefreshInventory } from '../spoolData';
import { formatQuantity, isFilament, unitLabel } from './inventoryShared';

export type ArticleDialog =
  | { name: 'receive' | 'edit' | 'register' | 'delete' | 'empty' }
  | { name: 'movement'; mode: MovementMode }
  | { name: 'ledger-delete'; transaction: InventoryTransaction };

/** The selected row of a list-and-panel table, kept in the URL (`?selected=`) so the panel survives a reload. */
export function useSelectedRow(param = 'selected') {
  const [params, setParams] = useSearchParams();
  const selected = params.get(param);
  const select = (id: string | null) =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (id) next.set(param, id);
        else next.delete(param);
        return next;
      },
      { replace: true },
    );
  return [selected, select] as const;
}

/** What the person may do with articles. */
export function useArticlePermissions() {
  const can = useCan();
  return {
    manage: can('inventory.manage'),
    delete: can('inventory.delete'),
    deleteLedger: can('inventory.ledger.delete'),
    register: can('inventory.manage') && can('filament_spools.manage'),
  };
}

function MarkEmptyDialog({ material, onClose }: { material: Material; onClose: () => void }) {
  const notify = useNotify();
  const refresh = useRefreshInventory();
  const emptying = useMutation({
    mutationFn: () =>
      markMaterialEmpty(material.id, {
        occurredAt: new Date().toISOString(),
        expectedInventoryVersion: material.inventoryVersion,
      }),
    onSuccess: async () => {
      notify({
        kind: 'success',
        title: 'Marked as empty',
        subtitle: `${material.name} stock is now 0 ${unitLabel(material.unit)}.`,
      });
      onClose();
      await refresh();
    },
    onError: () => {
      void refresh();
    },
  });
  return (
    <DestructiveActionDialog
      open
      title="Mark as empty?"
      fate="none"
      confirmLabel="Mark as empty"
      pending={emptying.isPending}
      onClose={onClose}
      error={emptying.isError ? spoolErrorMessage(emptying.error) : undefined}
      onConfirm={() => emptying.mutate()}
    >
      <p>
        The remaining {formatQuantity(material.quantity, material.unit)} of {material.name} is written off as a disposal
        and stock becomes 0. The ledger keeps every entry.
      </p>
    </DestructiveActionDialog>
  );
}

/** The dialog of one article action. Render it while `dialog` is set. */
export function ArticleDialogs({
  material,
  dialog,
  onClose,
  onDeleted,
}: {
  material: Material;
  dialog: ArticleDialog | null;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  if (!dialog) return null;
  switch (dialog.name) {
    case 'receive':
      return <ReceiveStockModal open onClose={onClose} kind={material.kind} article={material} />;
    case 'edit':
      return <MaterialFormModal open onClose={onClose} material={material} />;
    case 'register':
      return isFilament(material) ? (
        <RegisterSpoolModal open onClose={onClose} initialMaterialId={material.id} />
      ) : null;
    case 'delete':
      return <DeleteArticleModal material={material} onClose={onClose} onDeleted={onDeleted} />;
    case 'empty':
      return <MarkEmptyDialog material={material} onClose={onClose} />;
    case 'movement':
      return <StockMovementModal open onClose={onClose} mode={dialog.mode} material={material} />;
    case 'ledger-delete':
      return <DeleteLedgerEntryModal transaction={dialog.transaction} material={material} onClose={onClose} />;
  }
}
