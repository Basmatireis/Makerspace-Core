import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { InlineNotification, Modal, Select, SelectItem, Stack, TextArea, TextInput } from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  consumeFilamentSpool,
  correctFilamentSpoolStock,
} from '../../../api/generated/filament-spools/filament-spools';
import {
  addMaterialPurchase,
  correctMaterialStock,
  recordMaterialConsumption,
} from '../../../api/generated/inventory/inventory';
import type { FilamentSpool, InventoryAdjustmentReason, Material } from '../../../api/generated/models';
import { ApiError } from '../../../api/http-client';
import { formatQuantity, parseDecimal, toDecimal, toMoney, unitLabel } from '../components/inventoryShared';
import { machineLogbookKeys } from '../queries';
import { useNotify } from '../shared/toasts';
import { useLatestCallback } from '../../../app/useLatestCallback';

export type MovementMode = 'purchase' | 'consumption' | 'correction' | 'disposal';

type Values = {
  quantity: string;
  price: string;
  supplier: string;
  unitCost: string;
  reason: InventoryAdjustmentReason;
  note: string;
};
const EMPTY: Values = { quantity: '', price: '', supplier: '', unitCost: '', reason: 'inventory_count', note: '' };

const copy: Record<MovementMode, { title: string; submit: string; done: string; quantity: string }> = {
  purchase: { title: 'Add stock', submit: 'Add stock', done: 'Stock added', quantity: 'Quantity received' },
  consumption: {
    title: 'Record consumption',
    submit: 'Record consumption',
    done: 'Consumption recorded',
    quantity: 'Quantity used',
  },
  correction: {
    title: 'Correct stock',
    submit: 'Correct stock',
    done: 'Stock corrected',
    quantity: 'Physical quantity',
  },
  disposal: {
    title: 'Record disposal',
    submit: 'Record disposal',
    done: 'Disposal recorded',
    quantity: 'Quantity discarded',
  },
};
const correctionReasons: { id: InventoryAdjustmentReason; label: string }[] = [
  { id: 'inventory_count', label: 'Inventory count' },
  { id: 'unrecorded_consumption', label: 'Unrecorded consumption' },
  { id: 'damaged', label: 'Damaged' },
  { id: 'other', label: 'Other' },
];

/**
 * One dialog for every stock movement; the fields follow the mode. Pass a spool to act on that spool (grams).
 * Without a spool, consumption and disposal draw on loose stock only: filament on spools is booked on the spool.
 */
export function StockMovementModal({
  open,
  onClose,
  mode,
  material,
  spool,
}: {
  open: boolean;
  onClose: () => void;
  mode: MovementMode;
  material: Material;
  spool?: FilamentSpool;
}) {
  const client = useQueryClient();
  const notify = useNotify();
  const onRecord = spool ? Number(spool.remainingQuantity) : Number(material.quantity);
  // What a consumption or disposal can take: the spool's content, or the stock that is not on a spool.
  const available = spool ? Number(spool.remainingQuantity) : Number(material.unassignedQuantity);
  const onSpools = spool ? 0 : Number(material.assignedQuantity);
  const subject = spool ? spool.displayId : material.name;
  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors },
  } = useForm<Values>({ defaultValues: EMPTY });
  const text = copy[mode];
  const typed = parseDecimal(watch('quantity'));
  const looseOnly = mode === 'consumption' || mode === 'disposal';
  const current = looseOnly ? available : onRecord;
  const needsUnitCost =
    mode === 'correction' && typed != null && typed > onRecord && Number(material.averageUnitCost) === 0;

  const validateQuantity = (value: string) => {
    const quantity = parseDecimal(value);
    if (quantity == null) return 'Enter a number.';
    if (mode === 'correction') {
      if (quantity < 0) return 'The physical quantity cannot be negative.';
      if (quantity < onSpools)
        return `${formatQuantity(onSpools, material.unit)} are on spools. Correct those spools instead.`;
      return quantity === onRecord ? 'This matches the recorded stock. Nothing to correct.' : true;
    }
    if (quantity <= 0) return 'Enter a quantity above zero.';
    if (looseOnly && quantity > available)
      return `Only ${formatQuantity(available, material.unit)} on record${onSpools > 0 ? ' that is not on a spool' : ''}.`;
    return true;
  };

  const save = useMutation({
    mutationFn: (values: Values) => {
      const quantity = toDecimal(parseDecimal(values.quantity) ?? 0);
      const note = values.note.trim() || null;
      const occurredAt = new Date().toISOString();
      const expectedInventoryVersion = material.inventoryVersion;
      if (mode === 'purchase') {
        return addMaterialPurchase(material.id, {
          quantity,
          totalPrice: toMoney(parseDecimal(values.price) ?? 0),
          occurredAt,
          supplier: values.supplier.trim() || null,
          note,
          expectedInventoryVersion,
        });
      }
      if (mode === 'correction') {
        const acquisitionUnitCost = needsUnitCost ? toDecimal(parseDecimal(values.unitCost) ?? 0) : null;
        return spool
          ? correctFilamentSpoolStock(spool.id, {
              physicalQuantity: quantity,
              reason: values.reason,
              acquisitionUnitCost,
              note,
              occurredAt,
              expectedInventoryVersion,
              expectedSpoolVersion: spool.version,
            })
          : correctMaterialStock(material.id, {
              physicalQuantity: quantity,
              reason: values.reason,
              acquisitionUnitCost,
              note,
              occurredAt,
              expectedInventoryVersion,
            });
      }
      const disposal = mode === 'disposal';
      const reason = disposal ? 'disposed' : null;
      return spool
        ? consumeFilamentSpool(spool.id, {
            quantity,
            disposal,
            reason,
            note,
            occurredAt,
            expectedInventoryVersion,
            expectedSpoolVersion: spool.version,
          })
        : recordMaterialConsumption(material.id, {
            quantity,
            disposal,
            reason,
            note,
            occurredAt,
            expectedInventoryVersion,
          });
    },
    onSuccess: async (_result, values) => {
      const quantity = parseDecimal(values.quantity) ?? 0;
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
      notify({
        kind: 'success',
        title: text.done,
        subtitle: `${subject}: ${mode === 'correction' ? `now ${formatQuantity(quantity, material.unit)}` : formatQuantity(quantity, material.unit)}`,
      });
      onClose();
    },
    onError: () => {
      void client.invalidateQueries({ queryKey: machineLogbookKeys.all });
    },
  });
  const resetForm = useLatestCallback(() => {
    reset(EMPTY);
    save.reset();
  });
  useEffect(() => {
    if (open) resetForm();
  }, [open, mode, resetForm]);
  const pending = save.isPending;
  const after =
    typed == null ? null : mode === 'purchase' ? current + typed : mode === 'correction' ? typed : current - typed;
  const noteRequired = mode === 'disposal';
  const submit = handleSubmit((values) => {
    save.mutate(values);
  });

  return (
    <Modal
      open={open}
      size="sm"
      modalHeading={text.title}
      modalLabel={subject}
      aria-label={`${text.title} ${subject}`}
      primaryButtonText={pending ? 'Saving…' : text.submit}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={pending}
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
          <p className="mj-secondary">
            {looseOnly && onSpools > 0 ? 'Loose stock' : 'On record'}: {formatQuantity(current, material.unit)}
            {after != null && validateQuantity(String(typed)) === true
              ? ` · after: ${formatQuantity(Math.max(0, after), material.unit)}`
              : ''}
          </p>
          <TextInput
            id="movement-quantity"
            labelText={`${text.quantity} (${unitLabel(material.unit)})`}
            inputMode="decimal"
            autoComplete="off"
            invalid={Boolean(errors.quantity)}
            invalidText={errors.quantity?.message}
            {...register('quantity', { validate: validateQuantity })}
          />
          {mode === 'purchase' && (
            <>
              <TextInput
                id="movement-price"
                labelText="Total price in EUR"
                helperText="Updates the average acquisition cost."
                inputMode="decimal"
                autoComplete="off"
                invalid={Boolean(errors.price)}
                invalidText={errors.price?.message}
                {...register('price', {
                  validate: (value) => (parseDecimal(value) ?? -1) >= 0 || 'Enter an amount of zero or more.',
                })}
              />
              <TextInput
                id="movement-supplier"
                labelText="Supplier (optional)"
                autoComplete="off"
                {...register('supplier')}
              />
            </>
          )}
          {mode === 'correction' && (
            <Select id="movement-reason" labelText="Reason" {...register('reason')}>
              {correctionReasons.map((item) => (
                <SelectItem key={item.id} value={item.id} text={item.label} />
              ))}
            </Select>
          )}
          {needsUnitCost && (
            <TextInput
              id="movement-unit-cost"
              labelText={`Cost per ${unitLabel(material.unit)} in EUR`}
              helperText="This material has no average cost yet, so the added stock needs one."
              inputMode="decimal"
              autoComplete="off"
              invalid={Boolean(errors.unitCost)}
              invalidText={errors.unitCost?.message}
              {...register('unitCost', {
                validate: (value) => (parseDecimal(value) ?? -1) >= 0 || 'Enter an amount of zero or more.',
              })}
            />
          )}
          <TextArea
            id="movement-note"
            labelText={noteRequired ? 'Reason' : 'Note (optional)'}
            rows={3}
            invalid={Boolean(errors.note)}
            invalidText={errors.note?.message}
            {...register('note', { validate: (value) => (!noteRequired || value.trim() ? true : 'Enter a reason.') })}
          />
          {save.isError && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="The stock was not updated"
              subtitle={
                save.error instanceof ApiError
                  ? save.error.message
                  : 'The stock may have changed. Check the figures above and try again.'
              }
            />
          )}
        </Stack>
      </form>
    </Modal>
  );
}
