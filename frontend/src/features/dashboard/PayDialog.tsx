import { useState } from 'react';
import { Checkbox, CheckboxGroup, InlineNotification, Modal, Stack } from '@carbon/react';
import { useQueryClient } from '@tanstack/react-query';
import { payOwnBalance } from '../../api/generated/payments/payments';
import type { PersonalBalance } from '../../api/generated/models';
import { ApiError } from '../../api/http-client';
import { useNotify } from '../machinelogbook/shared/toasts';
import { formatCents, fromCents } from '../orders/money';
import { useOperationKeys } from '../orders/operations';
import { checkEntry, newPaymentEntry, PaymentEntryForm, presetEntry, toPaymentInputs } from '../orders/PaymentEntry';
import { useFinanceMutation } from '../orders/queries';
import { jobItems, orderItems, type PayItem } from './balance';
import { plural } from './format';
import { dashboardKeys } from './queries';

type Props = {
  balance: PersonalBalance;
  /** Ids ticked when the dialog opens. */
  initialSelected: string[];
  /** Jobs need orders.write and orders.finalize to be put on an order; without them they are listed but cannot be ticked. */
  canPayJobs: boolean;
  onClose: () => void;
};

const STALE_CODES = ['payment_total_changed', 'order_not_payable', 'job_not_payable'];

function staleMessage(code: string): string {
  return code === 'payment_total_changed'
    ? 'Your open balance changed while this dialog was open. The list is updated; check the amount and pay again.'
    : 'One of the selected items can no longer be paid, for example because it was paid or invoiced in the meantime. The list is updated.';
}

function errorText(error: Error): string {
  if (error instanceof ApiError && error.data?.code && STALE_CODES.includes(error.data.code))
    return staleMessage(error.data.code);
  return error.message;
}

/**
 * Pays selected unpaid orders and jobs with the sales payment form (cash with change, card with terminal reference,
 * split). Selected items are paid in full; jobs without an order go onto one new order that the payment settles.
 * Remount it for every opening: the selection and the entry start fresh.
 */
export function PayDialog({ balance, initialSelected, canPayJobs, onClose }: Props) {
  const client = useQueryClient();
  const notify = useNotify();
  const key = useOperationKeys();
  const orders = orderItems(balance);
  const jobs = jobItems(balance);
  const [selected, setSelected] = useState(initialSelected);
  const selectable = canPayJobs ? [...orders, ...jobs] : orders;
  const chosen = selectable.filter((item) => selected.includes(item.id));
  const chosenOrders = chosen.filter((item) => item.kind === 'order');
  const chosenJobs = chosen.filter((item) => item.kind === 'job');
  const total = chosen.reduce((sum, item) => sum + item.cents, 0);
  const [entry, setEntry] = useState(() => newPaymentEntry(total));
  const [syncedTotal, setSyncedTotal] = useState(total);
  // The amount follows the selection (and a refetched balance) until the person edits it.
  if (total !== syncedTotal) {
    setSyncedTotal(total);
    setEntry(presetEntry(entry, entry.preset, total));
  }
  const check = checkEntry(entry, total, true);

  const pay = useFinanceMutation(
    async () => {
      const input = {
        orderIds: chosenOrders.map((item) => item.id),
        jobIds: chosenJobs.map((item) => item.id),
        payments: toPaymentInputs(entry),
        expectedTotal: fromCents(total),
      };
      try {
        return await payOwnBalance({ ...input, operationKey: key('pay-own', input) });
      } catch (error) {
        const code = error instanceof ApiError ? error.data?.code : undefined;
        if (code && STALE_CODES.includes(code)) await client.invalidateQueries({ queryKey: dashboardKeys.personal() });
        throw error;
      }
    },
    async (result) => {
      await client.invalidateQueries({ queryKey: dashboardKeys.personal() });
      notify({
        kind: 'success',
        title: 'Payment recorded',
        subtitle: `${formatCents(total)} paid${result.createdOrderId ? '; your jobs are on a new order' : ''}.`,
        ...(result.createdOrderId ? { link: { label: 'Open the order', to: `/orders/${result.createdOrderId}` } } : {}),
      });
      onClose();
    },
  );

  const toggle = (id: string, checked: boolean) =>
    setSelected((current) => (checked ? [...current, id] : current.filter((value) => value !== id)));
  const group = (legend: string, items: PayItem[], disabled = false) => (
    <CheckboxGroup legendText={legend}>
      {items.map((item) => (
        <Checkbox
          key={item.id}
          id={`db-pay-${item.id}`}
          labelText={`${item.label} · ${item.detail} · ${formatCents(item.cents)}`}
          checked={!disabled && selected.includes(item.id)}
          disabled={disabled || pay.isPending}
          onChange={(_, { checked }) => toggle(item.id, checked)}
        />
      ))}
    </CheckboxGroup>
  );

  return (
    <Modal
      open
      size="md"
      modalLabel="Your open balance"
      modalHeading="Pay now"
      secondaryButtonText="Cancel"
      primaryButtonText={
        pay.isPending ? 'Saving…' : chosen.length === 0 ? 'Select something to pay' : `Pay ${formatCents(total)}`
      }
      primaryButtonDisabled={chosen.length === 0 || !check.ok || pay.isPending}
      preventCloseOnClickOutside
      onRequestClose={() => {
        if (!pay.isPending) onClose();
      }}
      onRequestSubmit={() => pay.mutate()}
    >
      <Stack gap={5}>
        {pay.error && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Not paid"
            subtitle={errorText(pay.error)}
          />
        )}
        {orders.length + jobs.length > 1 && (
          <Checkbox
            id="db-pay-all"
            labelText={`Everything (${formatCents(selectable.reduce((sum, item) => sum + item.cents, 0))})`}
            checked={chosen.length === selectable.length}
            indeterminate={chosen.length > 0 && chosen.length < selectable.length}
            disabled={pay.isPending}
            onChange={(_, { checked }) => setSelected(checked ? selectable.map((item) => item.id) : [])}
          />
        )}
        {orders.length > 0 && group('Unpaid orders', orders)}
        {jobs.length > 0 && group('Jobs not on an order yet', jobs, !canPayJobs)}
        {jobs.length > 0 && !canPayJobs && (
          <p className="mj-secondary">
            Jobs can only be paid by someone who may create and finalize orders, because they are put on a new order
            first.
          </p>
        )}
        <div className="sales-modal-summary">
          <div>
            <span className="mj-secondary">To pay</span>
            <strong className="sales-modal-summary__amount">{formatCents(total)}</strong>
          </div>
          <div className="mj-cell-stack">
            <span>{chosen.length === 1 ? chosen[0].label : plural(chosen.length, 'item')}</span>
            <span className="mj-secondary">Recorded under your name</span>
          </div>
        </div>
        {chosenJobs.length > 0 && (
          <p className="mj-secondary">
            {plural(chosenJobs.length, 'job')} without an order {chosenJobs.length === 1 ? 'is' : 'are'} put on a new
            order for you, which this payment settles.
          </p>
        )}
        {chosen.length > 0 && (
          <PaymentEntryForm
            idPrefix="db-pay"
            entry={entry}
            onChange={setEntry}
            due={total}
            requireFull
            disabled={pay.isPending}
          />
        )}
      </Stack>
    </Modal>
  );
}
