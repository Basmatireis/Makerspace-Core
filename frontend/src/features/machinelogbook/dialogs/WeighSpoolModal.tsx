import { useEffect } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { InlineNotification, Modal, Stack } from '@carbon/react';
import { useMutation } from '@tanstack/react-query';
import { correctFilamentSpoolStock } from '../../../api/generated/filament-spools/filament-spools';
import type { FilamentSpool, Material } from '../../../api/generated/models';
import { DecimalField } from '../../../app/DecimalField';
import { decimalNumber, decimalText, decimalValidator } from '../../../app/decimalInput';
import { useLatestCallback } from '../../../app/useLatestCallback';
import { formatGrams, formatSigned, toDecimal } from '../components/inventoryShared';
import { remainingOf } from '../components/spoolShared';
import { useNotify } from '../shared/toasts';
import { spoolErrorMessage, useRefreshInventory } from '../spoolData';

type Values = { gross: string; tare: string };

/**
 * Weighs a spool: gross weight minus tare is the filament left. The difference to the system's remainder is booked as
 * a correction with the reason "inventory count".
 */
export function WeighSpoolModal({
  open,
  onClose,
  spool,
  material,
}: {
  open: boolean;
  onClose: () => void;
  spool: FilamentSpool;
  /** The spool's article, for its inventory version. */
  material: Pick<Material, 'inventoryVersion'>;
}) {
  const notify = useNotify();
  const refresh = useRefreshInventory();
  const defaults = (): Values => ({ gross: '', tare: decimalText(spool.tareWeightG) });
  const { control, handleSubmit, reset } = useForm<Values>({ defaultValues: defaults() });
  const values = useWatch({ control });
  const gross = decimalNumber(values.gross);
  const tare = decimalNumber(values.tare) ?? 0;
  const net = gross == null ? null : Math.max(0, gross - tare);
  const delta = net == null ? null : net - remainingOf(spool);
  const save = useMutation({
    mutationFn: (physical: number) =>
      correctFilamentSpoolStock(spool.id, {
        physicalQuantity: toDecimal(physical),
        reason: 'inventory_count',
        occurredAt: new Date().toISOString(),
        expectedInventoryVersion: material.inventoryVersion,
        expectedSpoolVersion: spool.version,
      }),
    onSuccess: async () => {
      notify({ kind: 'success', title: `${spool.displayId} weighed`, subtitle: `${formatGrams(net ?? 0)} remaining` });
      onClose();
      await refresh();
    },
    onError: () => {
      void refresh();
    },
  });
  const resetForm = useLatestCallback(() => {
    reset(defaults());
    save.reset();
  });
  useEffect(() => {
    if (open) resetForm();
  }, [open, spool.id, resetForm]);
  const pending = save.isPending;
  const submit = handleSubmit(() => {
    if (net != null) save.mutate(net);
  });

  return (
    <Modal
      open={open}
      size="sm"
      modalLabel={`${spool.displayId} · ${spool.materialName}`}
      modalHeading="Weigh spool"
      primaryButtonText={pending ? 'Saving…' : 'Save correction'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={pending || delta === 0}
      preventCloseOnClickOutside
      shouldSubmitOnEnter={false}
      onRequestClose={() => {
        if (!pending) onClose();
      }}
      onRequestSubmit={() => {
        void submit();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        noValidate
      >
        <Stack gap={6}>
          {save.isError && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Not saved"
              subtitle={spoolErrorMessage(save.error)}
            />
          )}
          <div className="mj-form-row">
            <Controller
              control={control}
              name="gross"
              rules={{ validate: decimalValidator({ requiredMessage: 'Enter the weight on the scale.' }) }}
              render={({ field, fieldState }) => (
                <DecimalField
                  id="weigh-gross"
                  labelText="Gross weight in g"
                  helperText="Spool with filament on the scale."
                  value={field.value}
                  onChange={field.onChange}
                  invalid={fieldState.invalid}
                  invalidText={fieldState.error?.message}
                />
              )}
            />
            <Controller
              control={control}
              name="tare"
              rules={{ validate: decimalValidator({ optional: true }) }}
              render={({ field, fieldState }) => (
                <DecimalField
                  id="weigh-tare"
                  labelText="Tare in g"
                  helperText="The empty spool; 0 for a refill without its own spool."
                  value={field.value}
                  onChange={field.onChange}
                  invalid={fieldState.invalid}
                  invalidText={fieldState.error?.message}
                />
              )}
            />
          </div>
          <p className="inv-calc" aria-live="polite">
            {net == null
              ? `The system has ${formatGrams(remainingOf(spool))} on record.`
              : delta === 0
                ? `Remaining ${formatGrams(net)}, as on record. No correction needed.`
                : `Remaining ${formatGrams(net)} (on record ${formatGrams(remainingOf(spool))}): a correction of ${formatSigned(delta ?? 0, 'g')} is booked with the reason "inventory count".`}
          </p>
        </Stack>
      </form>
    </Modal>
  );
}
