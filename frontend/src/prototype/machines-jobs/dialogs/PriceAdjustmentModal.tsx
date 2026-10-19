import { NotificationBody, RefLink } from '../components/RefLink';
import { Controller, useForm } from 'react-hook-form';
import { InlineNotification, Modal, NumberInput, RadioButton, RadioButtonGroup, Stack, TextArea } from '@carbon/react';
import { adjustmentKindLabels, adjustPrice, formatMoney } from '../derived';
import { useSimulatedMutation, useStore } from '../store';
import type { Job, PriceAdjustmentKind } from '../types';
import '../styles/jobs.scss';

type Values = { kind: PriceAdjustmentKind; value: number | ''; reason: string };

const KINDS = Object.keys(adjustmentKindLabels) as PriceAdjustmentKind[];

const valueField: Record<PriceAdjustmentKind, { label: string; min: number; max?: number; step: number; helper: string }> = {
  fixed: { label: 'Final price (EUR)', min: 0, step: 0.5, helper: 'Replaces the calculated price and stays fixed.' },
  discount_percent: { label: 'Discount (%)', min: 0, max: 100, step: 5, helper: 'Re-applied if the calculated price changes.' },
  discount_amount: { label: 'Discount (EUR)', min: 0, step: 0.5, helper: 'Subtracted from the calculated price; never below zero.' },
  multiplier: { label: 'Multiplier', min: 0, step: 0.05, helper: 'E.g. 0.5 for half price, 1.5 for a surcharge. Re-applied if the calculated price changes.' },
};

function AdjustmentForm({ onClose, job }: { onClose: () => void; job: Job }) {
  const store = useStore();
  const current = job.priceAdjustment;
  const form = useForm<Values>({
    defaultValues: current
      ? { kind: current.kind, value: current.value, reason: current.reason }
      : { kind: job.calculatedPrice == null ? 'fixed' : 'discount_percent', value: '', reason: '' },
  });
  const [kind, value] = form.watch(['kind', 'value']);
  const relativeUnavailable = job.calculatedPrice == null;
  const preview = value === '' ? null : adjustPrice(job.calculatedPrice, { kind, value: Number(value), reason: '' });
  const field = valueField[kind];
  const { mutate, pending } = useSimulatedMutation((values: Values) => store.setPriceAdjustment(job.id, { kind: values.kind, value: Number(values.value), reason: values.reason.trim() }));

  const submit = form.handleSubmit(async (values) => {
    await mutate(values);
    store.notify({ kind: 'success', title: 'Price adjusted', subtitle: `${job.displayId} now costs ${formatMoney(preview)}.` });
    onClose();
  });

  return (
    <Modal
      open size="sm" modalHeading="Adjust price" modalLabel={job.displayId} primaryButtonText={pending ? 'Saving…' : 'Save adjustment'} secondaryButtonText="Cancel"
      primaryButtonDisabled={pending} preventCloseOnClickOutside selectorPrimaryFocus={`#adjust-value-${job.id}`}
      onRequestClose={() => { if (!pending) onClose(); }} onRequestSubmit={submit}
    >
      <Stack gap={6}>
        <p>The calculated price stays visible on the job. Existing order charges are not changed.</p>
        {job.order && <InlineNotification kind="warning" lowContrast hideCloseButton title="On an order"><NotificationBody><RefLink reference={job.order.orderReference} id={job.order.orderId} onNavigate={onClose} />. The order is not updated automatically.</NotificationBody></InlineNotification>}
        <Controller control={form.control} name="kind" render={({ field: kindField }) => (
          <RadioButtonGroup
            legendText="Adjustment" name={`adjust-kind-${job.id}`} orientation="vertical" valueSelected={kindField.value}
            helperText={relativeUnavailable ? 'Discounts and multipliers need a calculated price; this job has none yet.' : undefined}
            onChange={(next) => { kindField.onChange(next); form.setValue('value', ''); }}
          >
            {KINDS.map((option) => (
              <RadioButton key={option} id={`adjust-kind-${job.id}-${option}`} value={option} labelText={adjustmentKindLabels[option]} disabled={option !== 'fixed' && relativeUnavailable} />
            ))}
          </RadioButtonGroup>
        )} />
        <Controller
          control={form.control} name="value"
          rules={{ validate: (input) => input !== '' && Number(input) >= field.min && (field.max === undefined || Number(input) <= field.max) }}
          render={({ field: valueInput, fieldState }) => (
            <NumberInput
              key={kind} id={`adjust-value-${job.id}`} label={field.label} allowEmpty min={field.min} max={field.max} step={field.step} value={valueInput.value}
              helperText={field.helper} invalid={fieldState.invalid} invalidText={field.max ? `Enter a value from ${field.min} to ${field.max}.` : 'Enter a value of zero or more.'}
              onChange={(_event, state) => valueInput.onChange(state.value === '' ? '' : Number(state.value))}
            />
          )}
        />
        <dl className="mj-price-details mj-price-preview">
          <div><dt>Calculated</dt><dd>{formatMoney(job.calculatedPrice)}</dd></div>
          <div><dt>New price</dt><dd><strong>{formatMoney(preview)}</strong></dd></div>
        </dl>
        <TextArea
          id={`adjust-reason-${job.id}`} labelText="Reason" rows={3} helperText="Shown to everyone who can see this job."
          invalid={!!form.formState.errors.reason} invalidText="Give a reason for the adjustment."
          {...form.register('reason', { validate: (input) => input.trim().length > 0 })}
        />
      </Stack>
    </Modal>
  );
}

export function PriceAdjustmentModal({ open, onClose, job }: { open: boolean; onClose: () => void; job: Job }) {
  return open ? <AdjustmentForm onClose={onClose} job={job} /> : null;
}
