import { useState } from 'react';
import { InlineNotification, RadioButton, RadioButtonGroup } from '@carbon/react';
import { useMutation } from '@tanstack/react-query';
import { retireFilamentSpool } from '../../../api/generated/filament-spools/filament-spools';
import type { FilamentSpool, SpoolRetireOutcome } from '../../../api/generated/models';
import { DestructiveActionDialog } from '../../../app/DestructiveActionDialog';
import { formatGrams } from '../components/inventoryShared';
import { mountText, remainingOf } from '../components/spoolShared';
import { useNotify } from '../shared/toasts';
import { spoolErrorMessage, useRefreshInventory } from '../spoolData';

/** Above this much filament on record the dialog suggests weighing the spool instead. */
const WEIGH_HINT_G = 50;

/**
 * Retires a spool (`POST /filament-spools/{id}/retire`): it ran empty, or the rest was thrown away. The remaining
 * quantity is booked as used or as disposed, the spool is unmounted and goes to the inventory recycle bin, and its
 * label number becomes free for the next spool of the article.
 */
export function RetireSpoolModal({
  spool,
  onClose,
  onRetired,
}: {
  spool: FilamentSpool;
  onClose: () => void;
  onRetired?: () => void;
}) {
  const notify = useNotify();
  const refresh = useRefreshInventory();
  const remaining = remainingOf(spool);
  const [outcome, setOutcome] = useState<SpoolRetireOutcome>('empty');
  const retire = useMutation({
    mutationFn: () => retireFilamentSpool(spool.id, { expectedVersion: spool.version, outcome }),
    onSuccess: async () => {
      notify({
        kind: 'success',
        title: `${spool.displayId} retired`,
        subtitle: outcome === 'empty' ? 'The spool ran empty.' : `${formatGrams(remaining)} written off as disposed.`,
      });
      onRetired?.();
      onClose();
      await refresh();
    },
    onError: () => {
      void refresh();
    },
  });
  const where = mountText(spool.mountedOn);

  return (
    <DestructiveActionDialog
      open
      title={`Retire ${spool.displayId}?`}
      fate="recycle"
      confirmLabel={outcome === 'discarded' && remaining > 0 ? `Write off ${formatGrams(remaining)}` : 'Retire spool'}
      pending={retire.isPending}
      error={retire.isError ? spoolErrorMessage(retire.error, 'The spool could not be retired.') : undefined}
      onClose={onClose}
      onConfirm={() => retire.mutate()}
    >
      <p>
        {spool.mounted ? `The spool is unmounted from ${where ?? 'its printer slot'}. ` : ''}It leaves the spool list
        and the label {spool.displayId} becomes free for the next spool of this article.
      </p>
      <RadioButtonGroup
        legendText="What happened to it?"
        name="retire-outcome"
        orientation="vertical"
        valueSelected={outcome}
        onChange={(value) => setOutcome(value as SpoolRetireOutcome)}
      >
        <RadioButton
          id="retire-outcome-empty"
          value="empty"
          labelText={
            remaining > 0
              ? `It ran empty: the ${formatGrams(remaining)} still on record are booked as consumption the printers did not report`
              : 'It ran empty'
          }
        />
        <RadioButton
          id="retire-outcome-discarded"
          value="discarded"
          disabled={remaining <= 0}
          labelText={
            remaining > 0
              ? `The rest was thrown away: ${formatGrams(remaining)} are written off as disposed`
              : 'The rest was thrown away (nothing left on record)'
          }
        />
      </RadioButtonGroup>
      {remaining > WEIGH_HINT_G && (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title={`Still ${formatGrams(remaining)} on record.`}
          subtitle="If the spool is not used up, weigh it instead."
        />
      )}
    </DestructiveActionDialog>
  );
}
