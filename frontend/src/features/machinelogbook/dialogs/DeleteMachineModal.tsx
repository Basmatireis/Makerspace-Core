import { InlineNotification, Modal, Stack } from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { deleteMachine } from '../../../api/generated/machines/machines';
import type { Machine } from '../../../api/generated/models';
import { ApiError } from '../../../api/http-client';
import { connectorKeys } from '../connectorQueries';
import { machineLogbookKeys } from '../queries';
import { machineLogbookPaths } from '../shared/paths';
import { useNotify } from '../shared/toasts';

type Props = { machine: Machine; open: boolean; onClose: () => void };

/** Mount only while open so a previous error never shows in a fresh dialog. */
export function DeleteMachineModal({ machine, open, onClose }: Props) {
  if (!open) return null;
  return <DeleteMachineDialog machine={machine} onClose={onClose} />;
}

function DeleteMachineDialog({ machine, onClose }: Omit<Props, 'open'>) {
  const client = useQueryClient();
  const notify = useNotify();
  const navigate = useNavigate();
  const remove = useMutation({
    mutationFn: () => deleteMachine(machine.id, { expectedVersion: machine.version }),
    onSuccess: async () => {
      client.removeQueries({ queryKey: machineLogbookKeys.machine(machine.id) });
      navigate(machineLogbookPaths.machines());
      onClose();
      notify({ kind: 'success', title: 'Machine deleted', subtitle: `${machine.name} was deleted.` });
      await Promise.all([
        client.invalidateQueries({ queryKey: machineLogbookKeys.all }),
        client.invalidateQueries({ queryKey: connectorKeys.all }),
      ]);
    },
  });
  const status = remove.error instanceof ApiError ? remove.error.status : undefined;
  const code = remove.error instanceof ApiError ? remove.error.data?.code : undefined;
  const inUse = code === 'machine_in_use';
  const mounted = code === 'machine_has_mounted_spools';
  const stale = code === 'stale_write';
  const forbidden = status === 403;
  const blocked = inUse || mounted || forbidden;
  return (
    <Modal
      open danger alert modalHeading="Delete this machine?" primaryButtonText={remove.isPending ? 'Deleting…' : 'Delete machine'} secondaryButtonText="Cancel"
      primaryButtonDisabled={remove.isPending || blocked} preventCloseOnClickOutside selectorPrimaryFocus=".cds--btn--secondary" shouldSubmitOnEnter={false}
      onRequestClose={() => { if (!remove.isPending) onClose(); }} onSecondarySubmit={() => { if (!remove.isPending) onClose(); }}
      onRequestSubmit={() => { if (!remove.isPending && !blocked) remove.mutate(); }}
    >
      <Stack gap={5}>
        <p>
          {machine.name} will be deleted permanently together with its printer setup and connector connection. This cannot be undone.
          Machines with jobs or runs cannot be deleted; retire them instead to keep their history.
        </p>
        {inUse && (
          <InlineNotification
            kind="error" lowContrast hideCloseButton title="Machine has history"
            subtitle="Jobs or runs belong to this machine, so it cannot be deleted. Set its status to Retired instead, or delete its jobs and runs first."
          />
        )}
        {mounted && <InlineNotification kind="error" lowContrast hideCloseButton title="Spools are mounted" subtitle="Unmount the spools of this machine first, then delete it." />}
        {forbidden && (
          <InlineNotification
            kind="error" lowContrast hideCloseButton title="Not allowed"
            subtitle="Deleting a machine that is connected to a printer connector also needs the permission to manage printer connectors."
          />
        )}
        {stale && <InlineNotification kind="error" lowContrast hideCloseButton title="Machine changed" subtitle="Someone else changed this machine. Reload the page and try again." />}
        {remove.isError && !blocked && !stale && <InlineNotification kind="error" lowContrast hideCloseButton title="Delete failed" subtitle="The machine could not be deleted. Reload the page and try again." />}
      </Stack>
    </Modal>
  );
}
