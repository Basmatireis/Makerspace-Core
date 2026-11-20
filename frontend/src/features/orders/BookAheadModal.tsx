import { useForm } from 'react-hook-form';
import { InlineNotification, Modal, Stack, TextInput } from '@carbon/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createWorkingGroupIncome } from '../../api/generated/working-groups/working-groups';
import { useNotify } from '../machinelogbook/shared/toasts';
import { workingGroupKeys } from '../workinggroups/queries';
import { formatCents, fromCents, parseMoneyInput, toCents } from './money';
import { cashRegisterQuery, useFinanceMutation } from './queries';

type Values = { amount: string; note: string };

/**
 * Books money that is still in the register into the budget of the current working-group period
 * (working_group_finances.manage). No cash moves; it is a note that the money belongs to the budget.
 */
export function BookAheadModal({ onClose }: { onClose: () => void }) {
  const notify = useNotify();
  const register = useQuery(cashRegisterQuery());
  const free = Math.max(0, toCents(register.data?.expected) - toCents(register.data?.bookedAhead));
  const client = useQueryClient();
  const form = useForm<Values>({ defaultValues: { amount: '', note: '' } });
  const { errors } = form.formState;
  const mutation = useFinanceMutation(
    (values: Values) =>
      createWorkingGroupIncome({ amount: fromCents(parseMoneyInput(values.amount)!), note: values.note.trim() }),
    async (_result, values) => {
      await client.invalidateQueries({ queryKey: workingGroupKeys.all });
      notify({
        kind: 'success',
        title: 'Booked ahead to the budget',
        subtitle: `${formatCents(parseMoneyInput(values.amount) ?? 0)} counts in the budget; the cash stays in the register.`,
      });
      onClose();
    },
  );
  return (
    <Modal
      open
      size="sm"
      modalHeading="Book ahead to the budget"
      modalLabel="Cash register"
      primaryButtonText={mutation.isPending ? 'Saving…' : 'Book'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={mutation.isPending}
      preventCloseOnClickOutside
      onRequestClose={() => {
        if (!mutation.isPending) onClose();
      }}
      onRequestSubmit={() => void form.handleSubmit((values) => mutation.mutate(values))()}
    >
      <Stack gap={5}>
        <p>Counts money that is still in the register in the budget of the current period.</p>
        <TextInput
          id="book-ahead-amount"
          labelText="Amount (€)"
          inputMode="decimal"
          invalid={!!errors.amount}
          invalidText={errors.amount?.message}
          helperText={`${formatCents(free)} in the register is not booked yet.`}
          {...form.register('amount', {
            validate: (value) => {
              const cents = parseMoneyInput(value);
              if (cents === null || cents <= 0) return 'Enter an amount greater than zero, e.g. 50';
              if (cents > free) return `Only ${formatCents(free)} in the register is not booked yet`;
              return true;
            },
          })}
        />
        <TextInput
          id="book-ahead-note"
          labelText="Reason"
          maxLength={160}
          invalid={!!errors.note}
          invalidText={errors.note?.message}
          {...form.register('note', {
            validate: (value) => value.trim() !== '' || 'Say what the money is from, e.g. Sales in November',
          })}
        />
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
