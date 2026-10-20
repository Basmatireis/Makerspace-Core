import { Controller, useForm } from 'react-hook-form';
import { InlineNotification, Modal, Select, SelectItem, Stack, TextArea, TextInput } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { createCashMovement } from '../../api/generated/payments/payments';
import type { CashMovementKind, CashMovementReason } from '../../api/generated/models';
import { DateTimeInput } from '../../app/DateInput';
import { instantToZonedDateTimeValue, isZonedDateTimeValue, zonedDateTimeValueToISO } from '../../app/dateTime';
import { useNotify } from '../machinelogbook/shared/toasts';
import { cashMovementKindLabel, cashMovementReasons } from './labels';
import { formatCents, fromCents, parseMoneyInput, toCents } from './money';
import { useOperationKeys } from './operations';
import { cashRegisterQuery, useFinanceMutation } from './queries';

type Values = { amount: string; time: string; reason: CashMovementReason; note: string };

/** Money taken out of the register (a withdrawal) or added to it (a deposit, for example a change float). Not tied to an order. */
export function CashMovementModal({ kind, onClose }: { kind: CashMovementKind; onClose: () => void }) {
  const notify = useNotify();
  const key = useOperationKeys();
  const register = useQuery(cashRegisterQuery());
  const held = toCents(register.data?.expected);
  const form = useForm<Values>({
    defaultValues: {
      amount: '',
      time: instantToZonedDateTimeValue(new Date()),
      reason: kind === 'withdrawal' ? 'bank_deposit' : 'float',
      note: '',
    },
  });
  const { errors } = form.formState;
  const reason = form.watch('reason');
  const mutation = useFinanceMutation(
    (values: Values) => {
      const input = {
        kind,
        amount: fromCents(parseMoneyInput(values.amount)!),
        reason: values.reason,
        note: values.note.trim(),
        occurredAt: zonedDateTimeValueToISO(values.time),
      };
      return createCashMovement({ ...input, operationKey: key('movement', input) });
    },
    (_result, values) => {
      notify({
        kind: 'success',
        title: kind === 'withdrawal' ? 'Cash withdrawal recorded' : 'Cash deposit recorded',
        subtitle: `${formatCents(parseMoneyInput(values.amount) ?? 0)} ${kind === 'withdrawal' ? 'taken out of' : 'added to'} the register.`,
      });
      onClose();
    },
  );
  return (
    <Modal
      open
      size="sm"
      modalHeading={kind === 'withdrawal' ? 'Record cash withdrawal' : 'Record cash deposit'}
      modalLabel="Cash register"
      primaryButtonText={mutation.isPending ? 'Saving…' : 'Record'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={mutation.isPending}
      preventCloseOnClickOutside
      onRequestClose={() => {
        if (!mutation.isPending) onClose();
      }}
      onRequestSubmit={form.handleSubmit((values) => mutation.mutate(values))}
    >
      <Stack gap={5}>
        <p>
          {kind === 'withdrawal'
            ? 'Money taken out of the register, for example to bring it to the bank.'
            : 'Money added to the register, for example a change float.'}
        </p>
        <TextInput
          id="movement-amount"
          labelText="Amount (€)"
          inputMode="decimal"
          invalid={!!errors.amount}
          invalidText={errors.amount?.message}
          helperText={
            kind === 'withdrawal' && register.data ? `The register should hold ${formatCents(held)} now.` : undefined
          }
          {...form.register('amount', {
            validate: (value) => {
              const cents = parseMoneyInput(value);
              if (cents === null || cents <= 0) return 'Enter an amount greater than zero, e.g. 50';
              if (kind === 'withdrawal' && register.data && cents > held)
                return `The register should only hold ${formatCents(held)}`;
              return true;
            },
          })}
        />
        <Controller
          control={form.control}
          name="time"
          rules={{ validate: (value) => isZonedDateTimeValue(value) || 'Enter a valid date and time' }}
          render={({ field }) => (
            <DateTimeInput
              id="movement-time"
              labelText={kind === 'withdrawal' ? 'Taken out' : 'Added'}
              value={field.value}
              onChange={field.onChange}
              required
            />
          )}
        />
        {errors.time && <p className="sales-field-error">{errors.time.message}</p>}
        <Select id="movement-reason" labelText="Reason" {...form.register('reason')}>
          {cashMovementReasons.map((item) => (
            <SelectItem key={item.id} value={item.id} text={item.label} />
          ))}
        </Select>
        <TextArea
          id="movement-note"
          labelText={reason === 'other' ? 'Note (required)' : 'Note (optional)'}
          rows={2}
          maxCount={500}
          enableCounter
          helperText="Shown in the cashbook. Do not add personal data."
          invalid={!!errors.note}
          invalidText={errors.note?.message}
          {...form.register('note', {
            validate: (value) => reason !== 'other' || value.trim() !== '' || 'Say what the money was for',
          })}
        />
        <p className="mj-secondary">Recorded as a {cashMovementKindLabel(kind).toLowerCase()} in your name.</p>
        {mutation.error && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Nothing was saved"
            subtitle={mutation.error.message}
          />
        )}
      </Stack>
    </Modal>
  );
}
