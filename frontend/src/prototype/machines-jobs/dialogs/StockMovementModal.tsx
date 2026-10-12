import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { Modal, Select, SelectItem, Stack, TextArea, TextInput } from '@carbon/react';
import { formatQuantity, parseDecimal, unitLabel } from '../components/inventoryShared';
import { useSimulatedMutation, useStore } from '../store';
import type { Material, Spool } from '../types';

export type MovementMode = 'purchase' | 'consumption' | 'correction' | 'disposal';

type Values = { quantity: string; price: string; supplier: string; jobId: string; note: string };

const copy: Record<MovementMode, { title: string; submit: string; done: string; quantity: string }> = {
  purchase: { title: 'Add stock', submit: 'Add stock', done: 'Stock added', quantity: 'Quantity received' },
  consumption: { title: 'Record consumption', submit: 'Record consumption', done: 'Consumption recorded', quantity: 'Quantity used' },
  correction: { title: 'Correct stock', submit: 'Correct stock', done: 'Stock corrected', quantity: 'Physical quantity' },
  disposal: { title: 'Record disposal', submit: 'Record disposal', done: 'Disposal recorded', quantity: 'Quantity discarded' },
};

/** One dialog for every stock movement; the fields follow the mode. Pass a spool to act on that spool (grams). */
export function StockMovementModal({ open, onClose, mode, material, spool }: { open: boolean; onClose: () => void; mode: MovementMode; material: Material; spool?: Spool }) {
  const store = useStore();
  const { mutate, pending } = useSimulatedMutation(store.recordMovement);
  const current = spool ? spool.remainingQuantity : material.quantity;
  const subject = spool ? `${spool.displayId}` : material.name;
  const { register, handleSubmit, reset, watch, formState: { errors } } = useForm<Values>({ defaultValues: { quantity: '', price: '', supplier: '', jobId: '', note: '' } });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (open) reset({ quantity: '', price: '', supplier: '', jobId: '', note: '' }); }, [open, mode]);
  const typed = parseDecimal(watch('quantity'));
  const text = copy[mode];

  const validateQuantity = (value: string) => {
    const quantity = parseDecimal(value);
    if (quantity == null) return 'Enter a number.';
    if (mode === 'correction') {
      if (quantity < 0) return 'The physical quantity cannot be negative.';
      return quantity === current ? 'This matches the recorded stock. Nothing to correct.' : true;
    }
    if (quantity <= 0) return 'Enter a quantity above zero.';
    if ((mode === 'consumption' || mode === 'disposal') && quantity > current) return `Only ${formatQuantity(current, material.unit)} on record.`;
    return true;
  };

  const after = typed == null ? null : mode === 'purchase' ? current + typed : mode === 'correction' ? typed : current - typed;
  const submit = handleSubmit(async (values) => {
    const quantity = parseDecimal(values.quantity) ?? 0;
    await mutate(material.id, spool?.id ?? null, mode, mode === 'correction' ? quantity - current : quantity, {
      totalPrice: mode === 'purchase' ? parseDecimal(values.price) : null,
      supplier: mode === 'purchase' ? values.supplier.trim() || null : null,
      jobId: mode === 'consumption' ? values.jobId || null : null,
      note: values.note.trim() || null,
    });
    store.notify({ kind: 'success', title: text.done, subtitle: `${subject}: ${mode === 'correction' ? `now ${formatQuantity(quantity, material.unit)}` : formatQuantity(quantity, material.unit)}` });
    onClose();
  });

  const reasonRequired = mode === 'correction' || mode === 'disposal';

  return (
    <Modal
      open={open} size="sm" modalHeading={text.title} modalLabel={subject}
      primaryButtonText={pending ? 'Saving…' : text.submit} secondaryButtonText="Cancel" primaryButtonDisabled={pending}
      preventCloseOnClickOutside shouldSubmitOnEnter={false}
      onRequestClose={() => { if (!pending) onClose(); }} onRequestSubmit={() => { void submit(); }}
    >
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }} noValidate>
        <Stack gap={6}>
          <p className="mj-secondary">On record: {formatQuantity(current, material.unit)}{after != null && validateQuantity(String(typed)) === true ? ` · after: ${formatQuantity(Math.max(0, after), material.unit)}` : ''}</p>
          <TextInput
            id="movement-quantity" labelText={`${text.quantity} (${unitLabel(material.unit)})`} inputMode="decimal" autoComplete="off"
            invalid={Boolean(errors.quantity)} invalidText={errors.quantity?.message} {...register('quantity', { validate: validateQuantity })}
          />
          {mode === 'purchase' && (
            <>
              <TextInput
                id="movement-price" labelText="Total price in EUR (optional)" helperText="Updates the average acquisition cost." inputMode="decimal" autoComplete="off"
                invalid={Boolean(errors.price)} invalidText={errors.price?.message}
                {...register('price', { validate: (value) => !value.trim() || ((parseDecimal(value) ?? -1) >= 0) || 'Enter an amount of zero or more.' })}
              />
              <TextInput id="movement-supplier" labelText="Supplier (optional)" autoComplete="off" {...register('supplier')} />
            </>
          )}
          {mode === 'consumption' && (
            <Select id="movement-job" labelText="Job (optional)" helperText="Links this consumption to a job." {...register('jobId')}>
              <SelectItem value="" text="Not linked to a job" />
              {store.jobs.slice(0, 20).map((job) => <SelectItem key={job.id} value={job.id} text={`${job.displayId}${job.title ? ` · ${job.title}` : ''}`} />)}
            </Select>
          )}
          <TextArea
            id="movement-note" labelText={reasonRequired ? 'Reason' : 'Note (optional)'} rows={3}
            invalid={Boolean(errors.note)} invalidText={errors.note?.message}
            {...register('note', { validate: (value) => !reasonRequired || value.trim() ? true : 'Enter a reason.' })}
          />
        </Stack>
      </form>
    </Modal>
  );
}
