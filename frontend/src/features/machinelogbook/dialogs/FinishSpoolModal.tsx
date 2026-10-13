import { useEffect } from 'react';
import { FormProvider, useForm } from 'react-hook-form';
import { InlineNotification, Modal, Stack } from '@carbon/react';
import { useMutation } from '@tanstack/react-query';
import { finishFilamentSpool } from '../../../api/generated/filament-spools/filament-spools';
import type { FilamentSpool } from '../../../api/generated/models';
import { LeftoverFields, leftoverDefaults, saveTareWeight, toLeftoverInput, type LeftoverValues } from '../components/LeftoverFields';
import { formatGrams } from '../components/inventoryShared';
import { initialOf, remainingOf, removedFromText, spoolNameText } from '../components/spoolShared';
import { formatDateTime } from '../shared/format';
import { useNotify } from '../shared/toasts';
import { spoolErrorMessage, useRefreshInventory } from '../spoolData';

/** Closes the current fill of a spool: single-use spools are archived, reusable ones wait for a refill. */
export function FinishSpoolModal({ open, onClose, spool }: { open: boolean; onClose: () => void; spool: FilamentSpool }) {
  const notify = useNotify();
  const refresh = useRefreshInventory();
  const single = spool.kind === 'single_use';
  const form = useForm<LeftoverValues>({ defaultValues: leftoverDefaults(spool) });
  const mutation = useMutation({
    mutationFn: async (values: LeftoverValues) => finishFilamentSpool(spool.id, {
      leftover: toLeftoverInput(spool, values), occurredAt: new Date().toISOString(), expectedVersion: await saveTareWeight(spool, values),
    }),
  });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (open) { form.reset(leftoverDefaults(spool)); mutation.reset(); } }, [open, spool.id]);
  const title = single ? 'Finish spool' : 'Empty spool';
  const pending = mutation.isPending;

  const submit = form.handleSubmit(async (values) => {
    try {
      await mutation.mutateAsync(values);
    } catch {
      await refresh();
      return;
    }
    await refresh();
    notify(single
      ? { kind: 'success', title: `${spool.displayId} finished`, subtitle: 'The spool is archived. Its usage history stays on the material.' }
      : { kind: 'success', title: `${spool.displayId} emptied`, subtitle: 'The spool needs a refill.' });
    onClose();
  });

  return (
    <Modal
      open={open} size="md" modalHeading={title} modalLabel={spoolNameText(spool)} aria-label={`${title} ${spoolNameText(spool)}`}
      primaryButtonText={pending ? 'Saving…' : title} secondaryButtonText="Cancel" primaryButtonDisabled={pending}
      preventCloseOnClickOutside shouldSubmitOnEnter={false}
      onRequestClose={() => { if (!pending) onClose(); }} onRequestSubmit={() => { void submit(); }}
    >
      <FormProvider {...form}>
        <form onSubmit={(event) => { event.preventDefault(); void submit(); }} noValidate>
          <Stack gap={6}>
            {mutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Not saved" subtitle={spoolErrorMessage(mutation.error)} />}
            <dl className="mj-facts">
              <div><dt>Current fill</dt><dd>{spool.materialName} · fill {spool.fillNumber}{spool.filledAt ? `, since ${formatDateTime(spool.filledAt)}` : ''}</dd></div>
              <div><dt>Expected remaining</dt><dd>{formatGrams(remainingOf(spool))} of {formatGrams(initialOf(spool))}</dd></div>
            </dl>
            <LeftoverFields spool={spool} idPrefix="finish" />
            <p className="mj-secondary">
              {single
                ? 'The fill is closed and the spool is archived. Its usage history stays on the material and on jobs; archived single-use spools can be cleaned up later.'
                : 'The fill is closed and kept in the fill history. The spool then waits for a refill.'}
              {removedFromText(spool)}
            </p>
          </Stack>
        </form>
      </FormProvider>
    </Modal>
  );
}
