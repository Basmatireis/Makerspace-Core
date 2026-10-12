import { useEffect } from 'react';
import { FormProvider, useForm } from 'react-hook-form';
import { Modal, Stack } from '@carbon/react';
import { formatDateTime } from '../derived';
import { LeftoverFields, leftoverDefaults, resolveLeftover, type LeftoverValues } from '../components/LeftoverFields';
import { formatGrams, mountedOn, spoolNameText } from '../components/inventoryShared';
import { useSimulatedMutation, useStore } from '../store';
import type { Spool } from '../types';

/** Closes the current fill of a spool: single-use spools are archived, reusable ones wait for a refill. */
export function FinishSpoolModal({ open, onClose, spool }: { open: boolean; onClose: () => void; spool: Spool }) {
  const store = useStore();
  const { mutate, pending } = useSimulatedMutation(store.finishSpool);
  const single = spool.kind === 'single_use';
  const form = useForm<LeftoverValues>({ defaultValues: leftoverDefaults(spool) });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (open) form.reset(leftoverDefaults(spool)); }, [open, spool.id]);
  const mount = spool.mounted ? mountedOn(spool.id, store.printerProfiles, store.machines) : null;
  const title = single ? 'Finish spool' : 'Empty spool';

  const submit = form.handleSubmit(async (values) => {
    await mutate(spool.id, resolveLeftover(spool, values).choice);
    store.notify(single
      ? { kind: 'success', title: `${spool.displayId} finished`, subtitle: 'The spool is archived. Its usage history stays on the material.' }
      : { kind: 'success', title: `${spool.displayId} emptied`, subtitle: 'The spool needs a refill.' });
    onClose();
  });

  return (
    <Modal
      open={open} size="md" modalHeading={title} modalLabel={spoolNameText(spool)}
      primaryButtonText={pending ? 'Saving…' : title} secondaryButtonText="Cancel" primaryButtonDisabled={pending}
      preventCloseOnClickOutside shouldSubmitOnEnter={false}
      onRequestClose={() => { if (!pending) onClose(); }} onRequestSubmit={() => { void submit(); }}
    >
      <FormProvider {...form}>
        <form onSubmit={(event) => { event.preventDefault(); void submit(); }} noValidate>
          <Stack gap={6}>
            <dl className="mj-facts">
              <div><dt>Current fill</dt><dd>{spool.materialName} · fill {spool.fillNumber}{spool.filledAt ? `, since ${formatDateTime(spool.filledAt)}` : ''}</dd></div>
              <div><dt>Expected remaining</dt><dd>{formatGrams(spool.remainingQuantity)} of {formatGrams(spool.initialNetWeightG)}</dd></div>
            </dl>
            <LeftoverFields spool={spool} idPrefix="finish" />
            <p className="mj-secondary">
              {single
                ? 'The fill is closed and the spool is archived. Its usage history stays on the material and on jobs; archived single-use spools can be cleaned up later.'
                : 'The fill is closed and kept in the fill history. The spool then waits for a refill.'}
              {mount ? ` It is also removed from ${mount.machineName} (${mount.slotName}).` : ''}
            </p>
          </Stack>
        </form>
      </FormProvider>
    </Modal>
  );
}
