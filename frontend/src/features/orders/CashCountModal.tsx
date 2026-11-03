import { Controller, useForm } from 'react-hook-form';
import {
  InlineLoading,
  InlineNotification,
  Modal,
  Select,
  SelectItem,
  Stack,
  Tag,
  TextArea,
  TextInput,
} from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { recordCashCount, updateCashCount } from '../../api/generated/payments/payments';
import type { CashCount, CashCountReason, CashJournalEntry } from '../../api/generated/models';
import { DateTimeInput } from '../../app/DateInput';
import { instantToZonedDateTimeValue, isZonedDateTimeValue, zonedDateTimeValueToISO } from '../../app/dateTime';
import { useNotify } from '../machinelogbook/shared/toasts';
import { checkCount, countReasonNeedsNote, countReasons, justAfter, type CountValues } from './cashJournal';
import { formatCents, formatSignedCents, fromCents, moneyInputText, parseMoneyInput, toCents } from './money';
import { useOperationKeys } from './operations';
import { cashRegisterQuery, useFinanceMutation } from './queries';

const isoOf = (time: string) => {
  try {
    return isZonedDateTimeValue(time) ? zonedDateTimeValueToISO(time) : null;
  } catch {
    // A local time that does not exist (the hour skipped when clocks change) has no instant.
    return null;
  }
};

const initialValues = (entry?: CashJournalEntry): CountValues =>
  entry?.count
    ? {
        amount: moneyInputText(toCents(entry.count.countedAmount)),
        time: instantToZonedDateTimeValue(entry.occurredAt),
        reason: entry.count.reason ?? '',
        note: entry.note,
      }
    : { amount: '', time: instantToZonedDateTimeValue(new Date()), reason: '', note: '' };

const savedText = (count: CashCount) => {
  const difference = toCents(count.difference);
  return difference === 0
    ? `${count.reference} matches the expected ${formatCents(toCents(count.expectedAmount))}.`
    : `${count.reference} found ${formatCents(toCents(count.countedAmount))}, ${formatCents(toCents(count.expectedAmount))} were expected${count.correction ? ` (${count.correction.reference})` : ''}.`;
};

/**
 * Count the register: what was counted and when. The server knows what the register should have held at that time;
 * a difference is booked as a correction with a reason, never silently. With `entry` (a count of the journal) the
 * dialog edits that count (cash_movements.manage); its correction follows the new difference.
 */
export function CashCountModal({ entry, onClose }: { entry?: CashJournalEntry; onClose: () => void }) {
  const notify = useNotify();
  const key = useOperationKeys();
  const edited = entry?.count ? entry : null;
  const initial = initialValues(entry);
  const form = useForm<CountValues>({ defaultValues: initial });
  const values = form.watch();
  // The time field has minutes only: an untouched time keeps the stored instant with its seconds.
  const timeChanged = !edited || values.time !== initial.time;
  const countedAt = edited && !timeChanged ? edited.occurredAt : isoOf(values.time);
  // What the register should have held at the counting time, everything up to and including it.
  const expectedThen = useQuery({
    ...cashRegisterQuery(countedAt ? justAfter(countedAt) : undefined),
    enabled: !!countedAt,
  });
  // An edited count's own correction is booked at its stored time; it is not part of what was expected.
  const ownCorrection =
    edited?.count && countedAt && new Date(countedAt).getTime() >= new Date(edited.occurredAt).getTime()
      ? toCents(edited.count.difference)
      : 0;
  const expected = countedAt && expectedThen.data ? toCents(expectedThen.data.expected) - ownCorrection : null;
  const counted = parseMoneyInput(values.amount);
  const difference = counted !== null && counted >= 0 && expected !== null ? counted - expected : null;
  const { errors } = form.formState;

  const mutation = useFinanceMutation(
    (input: CountValues) => {
      if (edited) {
        return updateCashCount(edited.id, {
          expectedVersion: edited.version ?? 1,
          countedAmount: fromCents(parseMoneyInput(input.amount) ?? 0),
          ...(timeChanged ? { countedAt: zonedDateTimeValueToISO(input.time) } : {}),
          ...(difference !== 0 && input.reason ? { reason: input.reason as CashCountReason } : {}),
          note: input.note.trim(),
          ...(expected !== null ? { expectedAmount: fromCents(expected) } : {}),
        });
      }
      const request = {
        countedAmount: fromCents(parseMoneyInput(input.amount) ?? 0),
        countedAt: zonedDateTimeValueToISO(input.time),
        ...(difference !== 0 && input.reason ? { reason: input.reason as CashCountReason } : {}),
        ...(input.note.trim() ? { note: input.note.trim() } : {}),
        ...(expected !== null ? { expectedAmount: fromCents(expected) } : {}),
      };
      return recordCashCount({ ...request, operationKey: key('cash-count', request) });
    },
    (count) => {
      const booked = toCents(count.difference);
      notify({
        kind: 'success',
        title: edited
          ? 'Count saved'
          : booked === 0
            ? 'Count recorded'
            : `Difference ${formatSignedCents(booked)} booked as a correction`,
        subtitle: savedText(count),
      });
      onClose();
    },
  );

  const submit = form.handleSubmit((input) => {
    const found = checkCount(input, expected);
    const entries = Object.entries(found) as [keyof CountValues, string][];
    if (entries.length) {
      for (const [name, message] of entries) form.setError(name, { message });
      return;
    }
    if (expected === null) return;
    mutation.mutate(input);
  });

  const primary = edited
    ? 'Save'
    : difference === null || difference === 0
      ? 'Record count'
      : `Record count and book ${formatSignedCents(difference)}`;
  return (
    <Modal
      open
      size="sm"
      modalLabel={edited ? `Cash register · ${edited.reference}` : 'Cash register'}
      modalHeading={edited ? 'Edit count' : 'Count the register'}
      primaryButtonText={mutation.isPending ? 'Saving…' : primary}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={mutation.isPending || (!!countedAt && expectedThen.isPending)}
      preventCloseOnClickOutside
      onRequestClose={() => {
        if (!mutation.isPending) onClose();
      }}
      onRequestSubmit={() => void submit()}
    >
      <Stack gap={5}>
        <TextInput
          id="count-amount"
          labelText="Counted amount (€)"
          inputMode="decimal"
          placeholder="e.g. 85,70"
          invalid={!!errors.amount}
          invalidText={errors.amount?.message}
          {...form.register('amount', { onChange: () => form.clearErrors('amount') })}
        />
        <Controller
          control={form.control}
          name="time"
          render={({ field }) => (
            <DateTimeInput
              id="count-time"
              labelText="Counted at"
              value={field.value}
              onChange={(value) => {
                field.onChange(value);
                form.clearErrors('time');
              }}
              required
            />
          )}
        />
        {errors.time && <p className="sales-field-error">{errors.time.message}</p>}
        <dl className="sales-sum sales-sum--box" aria-live="polite">
          <div>
            <dt>Expected at that time</dt>
            <dd>
              {expected !== null ? (
                formatCents(expected)
              ) : countedAt && expectedThen.isPending ? (
                <InlineLoading description="Loading" />
              ) : (
                '—'
              )}
            </dd>
          </div>
          <div>
            <dt>Counted</dt>
            <dd>{counted !== null && counted >= 0 ? formatCents(counted) : '—'}</dd>
          </div>
          <div className="sales-sum__total">
            <dt>Difference</dt>
            <dd>
              {difference === null ? (
                '—'
              ) : (
                <Tag type={difference === 0 ? 'green' : 'red'} size="md">
                  {formatSignedCents(difference)}
                </Tag>
              )}
            </dd>
          </div>
        </dl>
        {expectedThen.isError && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="The expected amount could not be loaded"
            subtitle={expectedThen.error.message}
          />
        )}
        {difference === 0 && (
          <InlineNotification
            kind="success"
            lowContrast
            hideCloseButton
            title="The count matches."
            subtitle={
              edited
                ? 'Any correction of this count is removed when you save.'
                : 'It is written to the register journal as a count line.'
            }
          />
        )}
        {difference !== null && difference !== 0 && (
          <>
            <InlineNotification
              kind="warning"
              lowContrast
              hideCloseButton
              title={difference > 0 ? 'More cash than expected.' : 'Less cash than expected.'}
              subtitle="The difference is booked as a correction with your reason, never silently; the count itself is kept."
            />
            <Select
              id="count-reason"
              labelText="Reason for the difference"
              invalid={!!errors.reason}
              invalidText={errors.reason?.message}
              {...form.register('reason', { onChange: () => form.clearErrors(['reason', 'note']) })}
            >
              <SelectItem value="" text="Choose a reason" disabled hidden />
              {countReasons.map((reason) => (
                <SelectItem key={reason.id} value={reason.id} text={reason.label} />
              ))}
            </Select>
            <TextArea
              id="count-note"
              labelText={values.reason && countReasonNeedsNote(values.reason) ? 'Note (required)' : 'Note (optional)'}
              placeholder="What you found"
              rows={2}
              maxCount={500}
              enableCounter
              invalid={!!errors.note}
              invalidText={errors.note?.message}
              {...form.register('note', { onChange: () => form.clearErrors('note') })}
            />
          </>
        )}
        {mutation.error && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title={edited ? 'Nothing was saved' : 'Nothing was recorded'}
            subtitle={mutation.error.message}
          />
        )}
      </Stack>
    </Modal>
  );
}
