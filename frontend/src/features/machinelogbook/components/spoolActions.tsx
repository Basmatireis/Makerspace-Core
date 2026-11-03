/* eslint-disable react-refresh/only-export-components -- the spool dialogs and the permission helper belong together */
import { useMutation, useQuery } from '@tanstack/react-query';
import type { FilamentSpool } from '../../../api/generated/models';
import { unmountPrinterSpool } from '../../../api/generated/printing/printing';
import { DestructiveActionDialog } from '../../../app/DestructiveActionDialog';
import { BinActionDialog } from '../dialogs/BinDialogs';
import { EditSpoolModal } from '../dialogs/EditSpoolModal';
import { IdentifierModal } from '../dialogs/IdentifierModal';
import { MountSpoolModal } from '../dialogs/MountSpoolModal';
import { RetireSpoolModal } from '../dialogs/RetireSpoolModal';
import { WeighSpoolModal } from '../dialogs/WeighSpoolModal';
import { materialQuery } from '../queries';
import { useNotify } from '../shared/toasts';
import { useCan } from '../shared/useCan';
import { spoolErrorMessage, useRefreshInventory } from '../spoolData';
import { isRetired, mountText } from './spoolShared';

export type SpoolDialog = 'weigh' | 'retire' | 'edit' | 'identifier' | 'mount' | 'unmount' | 'restore' | 'purge';

/** What the person may do with spools. Everything that moves stock needs `inventory.manage` as well. */
export function useSpoolPermissions() {
  const can = useCan();
  const spools = can('filament_spools.manage');
  return {
    /** Weigh, retire, restore and register: spool and stock permissions. */
    move: spools && can('inventory.manage'),
    /** Descriptive fields and identifiers. */
    edit: spools,
    mount: can('printer_slots.assign') && can('machines.read'),
    purge: spools && can('inventory.delete'),
  };
}

/** Which actions a spool offers, in menu order. */
export function spoolActionsFor(spool: FilamentSpool, allowed: ReturnType<typeof useSpoolPermissions>) {
  const retired = isRetired(spool);
  const items: { id: SpoolDialog; label: string; danger?: boolean }[] = [];
  if (retired) {
    if (allowed.move) items.push({ id: 'restore', label: 'Restore' });
    if (allowed.purge) items.push({ id: 'purge', label: 'Delete permanently', danger: true });
    return items;
  }
  if (allowed.move) items.push({ id: 'weigh', label: 'Weigh' });
  if (allowed.mount) items.push({ id: 'mount', label: spool.mounted ? 'Move to another slot' : 'Mount' });
  if (allowed.mount && spool.mounted && spool.mountedOn) items.push({ id: 'unmount', label: 'Unmount' });
  if (allowed.edit) items.push({ id: 'identifier', label: 'Add identifier' });
  if (allowed.edit) items.push({ id: 'edit', label: 'Edit spool' });
  if (allowed.move) items.push({ id: 'retire', label: 'Retire', danger: true });
  return items;
}

function UnmountDialog({ spool, onClose }: { spool: FilamentSpool; onClose: () => void }) {
  const notify = useNotify();
  const refresh = useRefreshInventory();
  const unmount = useMutation({
    mutationFn: () => unmountPrinterSpool(spool.mountedOn?.slotId ?? ''),
    onSuccess: async () => {
      notify({ kind: 'success', title: `${spool.displayId} unmounted` });
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
      title={`Unmount ${spool.displayId}?`}
      fate="none"
      confirmLabel="Unmount"
      pending={unmount.isPending}
      error={unmount.isError ? spoolErrorMessage(unmount.error) : undefined}
      onClose={onClose}
      onConfirm={() => unmount.mutate()}
    >
      <p>
        The spool leaves {mountText(spool.mountedOn) ?? 'its slot'} and is in storage again. Runs on that slot no longer
        book on it.
      </p>
    </DestructiveActionDialog>
  );
}

/** The dialog of one spool action. Render it while `dialog` is set. */
export function SpoolDialogs({
  spool,
  dialog,
  onClose,
  onGone,
}: {
  spool: FilamentSpool;
  dialog: SpoolDialog | null;
  onClose: () => void;
  /** The spool left the current list (retired, restored, purged). */
  onGone?: () => void;
}) {
  // Weighing needs the article's inventory version.
  const material = useQuery({ ...materialQuery(spool.materialId), enabled: dialog === 'weigh' });
  if (!dialog) return null;
  switch (dialog) {
    case 'weigh':
      return material.data ? <WeighSpoolModal open onClose={onClose} spool={spool} material={material.data} /> : null;
    case 'retire':
      return <RetireSpoolModal spool={spool} onClose={onClose} onRetired={onGone} />;
    case 'edit':
      return <EditSpoolModal open onClose={onClose} spool={spool} />;
    case 'identifier':
      return <IdentifierModal open onClose={onClose} spool={spool} />;
    case 'mount':
      return <MountSpoolModal spool={spool} onClose={onClose} />;
    case 'unmount':
      return <UnmountDialog spool={spool} onClose={onClose} />;
    case 'restore':
    case 'purge':
      return (
        <BinActionDialog
          mode={dialog}
          entry={{ kind: 'spool', item: spool }}
          onClose={onClose}
          onDone={dialog === 'purge' ? onGone : undefined}
        />
      );
  }
}
