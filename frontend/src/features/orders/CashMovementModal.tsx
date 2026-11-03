import { Controller, useForm } from 'react-hook-form';
import { InlineNotification, Modal, Select, SelectItem, Stack, TextArea, TextInput } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { createCashMovement, updateCashMovement } from '../../api/generated/payments/payments';
import type {
  CashJournalEntry,
  CreateCashMovementRequestKind,
  CreateCashMovementRequestReason,
} from '../../api/generated/models';
import { DateTimeInput } from '../../app/DateInput';
import { instantToZonedDateTimeValue, isZonedDateTimeValue, zonedDateTimeValueToISO } from '../../app/dateTime';
import { useNotify } from '../machinelogbook/shared/toasts';
import { cashMovementKindLabel, cashMovementReasons } from './labels';
import { formatCents, fromCents, moneyInputText, parseMoneyInput, toCents } from './money';
import { useOperationKeys } from './operations';
import { cashRegisterQuery, useFinanceMutation } from './queries';

type Values = { amount: string; time: string; reason: CreateCashMovementRequestReason; note: string };

const editableReason = (reason: CashJournalEntry['movementReason']): reason is CreateCashMovementRequestReason =>
  !!reason && reason !== 'count_difference';

function initialValues(kind: CreateCashMovementRequestKind, entry?: CashJournalEntry): Values {
  if (!entry) {
    return {
      amount: '',
      time: instantToZonedDateTimeValue(new Date()),
      reason: kind === 'withdrawal' ? 'bank_deposit' : 'float',
      note: '',
    };
  }
  return {
    amount: moneyInputText(toCents(kind === 'withdrawal' ? entry.amountOut : entry.amountIn)),
    time: instantToZonedDateTimeValue(entry.occurredAt),
    reason: editableReason(entry.movementReason) ? entry.movementReason : 'other',
    note: entry.note,
  };
}

/**
 * Money taken out of the register (a withdrawal) or added to it (a deposit, for example a change float). Not tied to an
 * order. With `entry` the dialog edits that withdrawal or deposit (cash_movements.manage).
 */
export function CashMovementModal({
  kind,
  entry,
  onClose,
}: {
  kind: CreateCashMovementRequestKind;
  entry?: CashJournalEntry;
  onClose: () => void;
}) {
  const notify = useNotify();
  const key = useOperationKeys();
  const register = useQuery(cashRegisterQuery());
  const editing = !!entry;
  const original = editing ? toCents(kind === 'withdrawal' ? entry.amountOut : entry.amountIn) : 0;
  // Editing a withdrawal puts its own amount back before the new one is taken out.
  const held = toCents(register.data?.expected) + (editing && kind === 'withdrawal' ? original : 0);
  const initial = initialValues(kind, entry);
  const form = useForm<Values>({ defaultValues: initial });
  const { errors } = form.formState;
  const reason = form.watch('reason');
  const noun = kind === 'withdrawal' ? 'withdrawal' : 'deposit';
  const mutation = useFinanceMutation(
    (values: Values) => {
      const amount = fromCents(parseMoneyInput(values.amount)!);
      if (entry) {
        // The time field has minutes only: an untouched time keeps the stored instant with its seconds.
        return updateCashMovement(entry.id, {
          expectedVersion: entry.version ?? 1,
          amount,
          reason: values.reason,
          note: values.note.trim(),
          ...(values.time !== initial.time ? { occurredAt: zonedDateTimeValueToISO(values.time) } : {}),
        });
      }
      const input = {
        kind,
        amount,
        reason: values.reason,
        note: values.note.trim(),
        occurredAt: zonedDateTimeValueToISO(values.time),
      };
      return createCashMovement({ ...input, operationKey: key('movement', input) });
    },
    (result, values) => {
      const cents = formatCents(parseMoneyInput(values.amount) ?? 0);
      notify(
        editing
          ? {
              kind: 'success',
              title: kind === 'withdrawal' ? 'Withdrawal saved' : 'Deposit saved',
              subtitle: `${result.reference} is now ${cents}.`,
            }
          : {
              kind: 'success',
              title: kind === 'withdrawal' ? 'Cash withdrawal recorded' : 'Cash deposit recorded',
              subtitle: `${cents} ${kind === 'withdrawal' ? 'taken out of' : 'added to'} the register.`,
            },
      );
      onClose();
    },
  );
  const heading = editing ? `Edit ${noun}` : kind === 'withdrawal' ? 'Record cash withdrawal' : 'Record cash deposit';
  return (
    <Modal
      open
      size="sm"
      modalHeading={heading}
      modalLabel={editing ? `Cash register · ${entry.reference}` : 'Cash register'}
      primaryButtonText={mutation.isPending ? 'Saving…' : editing ? 'Save' : 'Record'}
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
          {editing
            ? `Counts after this ${noun} are recalculated when you save.`
            : kind === 'withdrawal'
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
            kind === 'withdrawal' && register.data
              ? editing
                ? `Without this withdrawal the register should hold ${formatCents(held)} now.`
                : `The register should hold ${formatCents(held)} now.`
              : undefined
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
        <p className="mj-secondary">
          {editing
            ? 'The change and the previous amount, time and reason are kept in the audit log.'
            : `Recorded as a ${cashMovementKindLabel(kind).toLowerCase()} in your name.`}
        </p>
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
