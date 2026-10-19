import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { InlineNotification, Modal, RadioButton, RadioButtonGroup, Stack, TextArea } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { setMachineJobPriceAdjustment } from '../../../api/generated/machine-jobs/machine-jobs';
import type { MachineJob, PriceAdjustmentKind } from '../../../api/generated/models';
import { machineLogbookKeys } from '../queries';
import { formatMoney } from '../shared/format';
import { adjustmentKindLabels, adjustPrice } from '../shared/status';
import { DecimalField } from '../../../app/DecimalField';
import { decimalNumber, decimalText, decimalValidator, parseDecimalText } from '../../../app/decimalInput';
import { useCan } from '../shared/useCan';
import { useNotify } from '../shared/toasts';
import { jobOrderQuery, saveError } from './jobFormHelpers';
import '../styles/jobs.scss';

type Values = { kind: PriceAdjustmentKind; value: string; reason: string };

const KINDS = Object.keys(adjustmentKindLabels) as PriceAdjustmentKind[];

// The API accepts a fixed price of zero or more; every other kind needs a value above zero (percent up to 100, multiplier up to 100).
const valueField: Record<PriceAdjustmentKind, { label: string; max?: number; helper: string }> = {
  fixed: { label: 'Final price (EUR)', helper: 'Replaces the calculated price and stays fixed.' },
  discount_percent: { label: 'Discount (%)', max: 100, helper: 'Re-applied if the calculated price changes.' },
  discount_amount: { label: 'Discount (EUR)', helper: 'Subtracted from the calculated price; never below zero.' },
  multiplier: { label: 'Multiplier', max: 100, helper: 'E.g. 0.5 for half price, 1.5 for a surcharge. Re-applied if the calculated price changes.' },
};

const validValue = (kind: PriceAdjustmentKind, input: string) => {
  const { max } = valueField[kind];
  return decimalValidator({ positive: kind !== 'fixed', max, places: 4 })(input) === true;
};

function AdjustmentForm({ onClose, job }: { onClose: () => void; job: MachineJob }) {
  const client = useQueryClient();
  const notify = useNotify();
  const can = useCan();
  const association = useQuery({ ...jobOrderQuery(job.id), enabled: can('orders.read') });
  const current = job.priceAdjustment;
  const calculated = job.calculatedPrice == null ? null : Number(job.calculatedPrice);
  const form = useForm<Values>({
    defaultValues: current
      ? { kind: current.kind, value: decimalText(current.value), reason: current.reason }
      : { kind: calculated == null ? 'fixed' : 'discount_percent', value: '', reason: '' },
  });
  const [error, setError] = useState<string | null>(null);
  const [kind, value] = form.watch(['kind', 'value']);
  const relativeUnavailable = calculated == null;
  const typedValue = decimalNumber(value, { places: 4 });
  const preview = typedValue === null ? null : adjustPrice(calculated, { kind, value: typedValue });
  const field = valueField[kind];
  const mutation = useMutation({
    mutationFn: (values: Values) => setMachineJobPriceAdjustment(job.id, { kind: values.kind, value: parseDecimalText(values.value, { places: 4 }) ?? values.value, reason: values.reason.trim(), expectedVersion: job.version }),
    onSuccess: async (saved) => {
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
      notify({ kind: 'success', title: 'Price adjusted', subtitle: `${job.displayId} now costs ${formatMoney(saved.effectivePrice ?? preview)}.` });
      onClose();
    },
    onError: (cause) => setError(saveError(cause, 'The price adjustment could not be saved.').message),
  });
  const pending = mutation.isPending;

  const submit = form.handleSubmit((values) => { setError(null); mutation.mutate(values); });

  return (
    <Modal
      open size="sm" modalHeading="Adjust price" modalLabel={job.displayId} aria-label={`Adjust price ${job.displayId}`} primaryButtonText={pending ? 'Saving…' : 'Save adjustment'} secondaryButtonText="Cancel"
      primaryButtonDisabled={pending} preventCloseOnClickOutside selectorPrimaryFocus={`#adjust-value-${job.displayId}`}
      onRequestClose={() => { if (!pending) onClose(); }} onRequestSubmit={submit}
    >
      <Stack gap={6}>
        <p>The calculated price stays visible on the job. Existing order charges are not changed.</p>
        {association.data?.orderId && <InlineNotification kind="warning" lowContrast hideCloseButton title={`On ${association.data.orderReference}`} subtitle="The order is not updated automatically." />}
        {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Adjustment not saved" subtitle={error} />}
        <Controller control={form.control} name="kind" render={({ field: kindField }) => (
          <RadioButtonGroup
            legendText="Adjustment" name={`adjust-kind-${job.displayId}`} orientation="vertical" valueSelected={kindField.value}
            helperText={relativeUnavailable ? 'Discounts and multipliers need a calculated price; this job has none yet.' : undefined}
            onChange={(next) => { kindField.onChange(next); form.setValue('value', ''); }}
          >
            {KINDS.map((option) => (
              <RadioButton key={option} id={`adjust-kind-${job.displayId}-${option}`} value={option} labelText={adjustmentKindLabels[option]} disabled={option !== 'fixed' && relativeUnavailable} />
            ))}
          </RadioButtonGroup>
        )} />
        <Controller
          control={form.control} name="value"
          rules={{ validate: (input) => validValue(kind, input) }}
          render={({ field: valueInput, fieldState }) => (
            <DecimalField
              key={kind} id={`adjust-value-${job.displayId}`} labelText={field.label} value={valueInput.value}
              helperText={field.helper} invalid={fieldState.invalid}
              invalidText={kind === 'fixed' ? 'Enter a value of zero or more.' : field.max ? `Enter a value above zero, up to ${field.max}.` : 'Enter a value above zero.'}
              onChange={valueInput.onChange}
            />
          )}
        />
        <dl className="mj-price-details mj-price-preview">
          <div><dt>Calculated</dt><dd>{formatMoney(job.calculatedPrice)}</dd></div>
          <div><dt>New price</dt><dd><strong>{formatMoney(preview)}</strong></dd></div>
        </dl>
        <TextArea
          id={`adjust-reason-${job.displayId}`} labelText="Reason" rows={3} helperText="Shown to everyone who can see this job."
          invalid={!!form.formState.errors.reason} invalidText="Give a reason for the adjustment."
          {...form.register('reason', { validate: (input) => input.trim().length > 0 })}
        />
      </Stack>
    </Modal>
  );
}

export function PriceAdjustmentModal({ open, onClose, job }: { open: boolean; onClose: () => void; job: MachineJob }) {
  return open ? <AdjustmentForm onClose={onClose} job={job} /> : null;
}
