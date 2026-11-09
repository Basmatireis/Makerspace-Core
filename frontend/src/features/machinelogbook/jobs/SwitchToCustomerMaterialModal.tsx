import { useMutation, useQueryClient } from '@tanstack/react-query';
import { switchMachineRunUsageToCustomerMaterial } from '../../../api/generated/machine-runs/machine-runs';
import type { MachineJobUsage, MachineRun } from '../../../api/generated/models';
import { DestructiveActionDialog } from '../../../app/DestructiveActionDialog';
import { saveError } from '../dialogs/jobFormHelpers';
import { machineLogbookKeys } from '../queries';
import { formatQuantity } from '../shared/format';
import { useNotify } from '../shared/toasts';

/** Switches one booked makerspace usage of a run to customer material (`machine_jobs.edit`). */
export function SwitchToCustomerMaterialModal({
  run,
  usage,
  onClose,
}: {
  run: MachineRun;
  usage: MachineJobUsage | null;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const notify = useNotify();
  const mutation = useMutation({
    mutationFn: (target: MachineJobUsage) =>
      switchMachineRunUsageToCustomerMaterial(run.id, target.id, { expectedVersion: run.version }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
      notify({ kind: 'success', title: 'Switched to customer material', subtitle: run.displayId });
      onClose();
    },
  });
  return (
    <DestructiveActionDialog
      open={usage !== null}
      title="Switch to customer material"
      fate="none"
      confirmLabel={mutation.isPending ? 'Switching…' : 'Switch to customer material'}
      pending={mutation.isPending}
      error={mutation.isError ? saveError(mutation.error, 'The usage could not be switched.').message : undefined}
      onConfirm={() => {
        if (usage) mutation.mutate(usage);
      }}
      onClose={() => {
        mutation.reset();
        onClose();
      }}
    >
      {usage && (
        <p>
          {formatQuantity(usage.quantity)} g {usage.materialName} was booked from stock. It is put back into stock, the
          run records it as customer material and the job is priced again without charging it.
        </p>
      )}
    </DestructiveActionDialog>
  );
}
