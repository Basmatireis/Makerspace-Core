import { useMutation, useQuery } from '@tanstack/react-query';
import { deleteMaterial } from '../../../api/generated/inventory/inventory';
import type { Material } from '../../../api/generated/models';
import { DestructiveActionDialog } from '../../../app/DestructiveActionDialog';
import { formatQuantity, isFilament } from '../components/inventoryShared';
import { formatMoney } from '../shared/format';
import { useNotify } from '../shared/toasts';
import { allSpoolsQuery, spoolErrorMessage, useRefreshInventory } from '../spoolData';

/**
 * Moves an article into the inventory recycle bin (`inventory.delete`). Its stock, spools and prices leave every list
 * and total until it is restored; nothing is written off.
 */
export function DeleteArticleModal({
  material,
  onClose,
  onDeleted,
}: {
  material: Material;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const notify = useNotify();
  const refresh = useRefreshInventory();
  const spools = useQuery({
    ...allSpoolsQuery({ materialId: material.id, lifecycle: 'active' }),
    enabled: isFilament(material),
  });
  const active = spools.data ?? [];
  const mounted = active.filter((spool) => spool.mounted).length;
  const removal = useMutation({
    mutationFn: () => deleteMaterial(material.id, { expectedVersion: material.version }),
    onSuccess: async () => {
      notify({
        kind: 'success',
        title: 'Article moved to the recycle bin',
        subtitle: `${material.displayId} · ${material.name}`,
      });
      onDeleted?.();
      onClose();
      await refresh();
    },
    onError: () => {
      void refresh();
    },
  });
  const quantity = Number(material.quantity);

  return (
    <DestructiveActionDialog
      open
      title="Delete article?"
      fate="recycle"
      confirmLabel="Delete article"
      pending={removal.isPending}
      error={removal.isError ? spoolErrorMessage(removal.error, 'The article could not be deleted.') : undefined}
      onClose={onClose}
      onConfirm={() => removal.mutate()}
    >
      <p>
        {material.displayId} · {material.name} leaves the article lists, pickers and stock totals.
        {quantity > 0
          ? ` Its ${formatQuantity(material.quantity, material.unit)} (${formatMoney(material.inventoryValue)}) are not written off; they come back with the article.`
          : ''}
      </p>
      {active.length > 0 && (
        <p>
          {active.length === 1 ? 'Its spool goes' : `Its ${active.length} spools go`} along with it
          {mounted > 0 ? `; ${mounted === 1 ? 'the mounted spool is' : `${mounted} mounted spools are`} unmounted` : ''}
          .
        </p>
      )}
      <p className="mj-secondary">Runs and orders keep their lines with the article name.</p>
    </DestructiveActionDialog>
  );
}
