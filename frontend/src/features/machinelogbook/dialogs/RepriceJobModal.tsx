import { useState } from 'react';
import { InlineNotification, Modal } from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { repriceMachineJob } from '../../../api/generated/machine-jobs/machine-jobs';
import type { MachineJob } from '../../../api/generated/models';
import { errorText } from '../jobDetail/jobDetailShared';
import { machineLogbookKeys } from '../queries';
import { formatMoney } from '../shared/format';
import { useNotify } from '../shared/toasts';

function RepriceForm({ onClose, job }: { onClose: () => void; job: MachineJob }) {
  const client = useQueryClient();
  const notify = useNotify();
  const [error, setError] = useState<string | null>(null);
  const group = job.pricingSnapshot?.pricingGroupName ?? job.customer?.pricingGroup?.name;
  const mutation = useMutation({
    mutationFn: () => repriceMachineJob(job.id, { expectedVersion: job.version }),
    onSuccess: async (saved) => {
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
      notify({
        kind: 'success',
        title: 'Price recalculated',
        subtitle: `${job.displayId} now costs ${formatMoney(saved.effectivePrice)}.`,
      });
      onClose();
    },
    onError: (cause) =>
      setError(errorText(cause, 'The price could not be recalculated. Reload the page and try again.')),
  });
  const pending = mutation.isPending;

  return (
    <Modal
      open
      size="sm"
      modalHeading="Recalculate price"
      modalLabel={job.displayId}
      aria-label={`Recalculate price ${job.displayId}`}
      primaryButtonText={pending ? 'Recalculating…' : 'Recalculate price'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={pending}
      preventCloseOnClickOutside
      onRequestClose={() => {
        if (!pending) onClose();
      }}
      onRequestSubmit={() => {
        setError(null);
        mutation.mutate();
      }}
    >
      <p>
        The price is recalculated from the current rates of {group ? <strong>{group}</strong> : 'the pricing group'}. A
        price adjustment stays applied. Order charges keep their price until they are refreshed.
      </p>
      {error && (
        <InlineNotification kind="error" lowContrast hideCloseButton title="Price not recalculated" subtitle={error} />
      )}
    </Modal>
  );
}

export function RepriceJobModal({ open, onClose, job }: { open: boolean; onClose: () => void; job: MachineJob }) {
  return open ? <RepriceForm onClose={onClose} job={job} /> : null;
}
