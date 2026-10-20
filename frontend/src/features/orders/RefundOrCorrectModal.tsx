import { useState } from 'react';
import {
  InlineNotification,
  Modal,
  RadioButton,
  RadioButtonGroup,
  Stack,
  StructuredListBody,
  StructuredListCell,
  StructuredListRow,
  StructuredListWrapper,
  TextArea,
  TextInput,
} from '@carbon/react';
import { reverseOrderPayment } from '../../api/generated/payments/payments';
import type { Order, OrderPayment, PaymentReversalInputReasonKind } from '../../api/generated/models';
import { DateTimeInput } from '../../app/DateInput';
import { LinkifiedText, RefLink } from '../../app/RefLink';
import { RichNotification } from '../../app/RichNotification';
import {
  formatDateTime,
  instantToZonedDateTimeValue,
  isZonedDateTimeValue,
  zonedDateTimeValueToISO,
} from '../../app/dateTime';
import { useNotify } from '../machinelogbook/shared/toasts';
import { methodLabel, reasonKindHelp } from './labels';
import { reversalOptions } from './logic';
import { formatCents, toCents } from './money';
import { useOperationKeys } from './operations';
import { useFinanceMutation } from './queries';

/**
 * Undoes one receipt, in the words of the cashbook: give the money back, fix an entry made by mistake, or record an accounting correction from wiRef.
 * Only the reasons the rules allow for this payment are offered, and what would block the others is said up front.
 */
export function RefundOrCorrectModal({
  payment,
  reversal,
  order,
  onClose,
}: {
  payment: OrderPayment;
  reversal: OrderPayment | undefined;
  order: Order;
  onClose: () => void;
}) {
  const notify = useNotify();
  const key = useOperationKeys();
  const options = reversalOptions(payment, reversal, order);
  const [kind, setKind] = useState<PaymentReversalInputReasonKind>(options.kinds[0] ?? 'refund');
  const [time, setTime] = useState(() => instantToZonedDateTimeValue(new Date()));
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const bookedAtOriginal = kind === 'recording_error';
  const timeOk = bookedAtOriginal || isZonedDateTimeValue(time);
  const needsReference = payment.method === 'card' || payment.method === 'external';
  const reasonOk = reason.trim().length > 0 && reason.trim().length <= 500;
  const ok =
    options.blocker === null &&
    !options.prerequisite &&
    options.kinds.includes(kind) &&
    timeOk &&
    (!needsReference || reference.trim() !== '') &&
    reasonOk;

  const mutation = useFinanceMutation(
    () => {
      const input = {
        expectedVersion: order.version,
        reversal: {
          paymentId: payment.id,
          reasonKind: kind,
          reason: reason.trim(),
          occurredAt: bookedAtOriginal ? payment.occurredAt : zonedDateTimeValueToISO(time),
          externalReference: reference.trim() || undefined,
        },
      };
      return reverseOrderPayment(payment.id, { ...input, operationKey: key('reverse', input) });
    },
    () => {
      notify({
        kind: 'success',
        title: kind === 'refund' ? `${payment.reference} refunded` : `${payment.reference} corrected`,
        subtitle: `${formatCents(toCents(payment.amount))} no longer counts towards ${order.reference}.`,
      });
      onClose();
    },
  );
  const pending = mutation.isPending;
  const kindWord =
    kind === 'refund'
      ? 'Refunded'
      : kind === 'recording_error'
        ? 'Corrected (recorded by mistake)'
        : 'Corrected from wiRef';
  return (
    <Modal
      open
      size="md"
      danger
      modalHeading="Refund or correct"
      modalLabel={`${payment.reference} · ${methodLabel(payment.method)} ${formatCents(toCents(payment.amount))}`}
      primaryButtonText={pending ? 'Saving…' : kind === 'refund' ? 'Refund payment' : 'Correct payment'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={!ok || pending}
      preventCloseOnClickOutside
      onRequestClose={() => {
        if (!pending) onClose();
      }}
      onRequestSubmit={() => mutation.mutate()}
    >
      <Stack gap={6}>
        <p>
          Receipts are never edited or deleted. This adds a new line that undoes{' '}
          <RefLink reference={payment.reference} id={payment.id} kind="payment" onNavigate={onClose} /> on{' '}
          <RefLink reference={order.reference} id={order.id} kind="order" onNavigate={onClose} />; both stay on the
          record.
        </p>
        {options.blocker && (
          <RichNotification kind="error" title="This payment cannot be refunded or corrected">
            <LinkifiedText text={options.blocker} targets={{}} />
          </RichNotification>
        )}
        {options.prerequisite && (
          <RichNotification kind="warning" title="Cancel the wiRef request first">
            {options.prerequisite} Core records what happened in wiRef; it does not change the accounting itself.{' '}
            <RefLink reference={order.reference} id={order.id} kind="order" onNavigate={onClose}>
              Open the order
            </RefLink>
          </RichNotification>
        )}
        {!options.blocker && (
          <>
            <RadioButtonGroup
              legendText="What happened?"
              name="reversal-kind"
              orientation="vertical"
              valueSelected={kind}
              onChange={(value) => setKind(value as PaymentReversalInputReasonKind)}
            >
              {options.kinds.map((item) => (
                <RadioButton key={item} id={`reversal-${item}`} value={item} labelText={reasonKindHelp[item].title} />
              ))}
            </RadioButtonGroup>
            <p className="mj-secondary">{reasonKindHelp[kind].help}</p>
            {kind !== 'recording_error' && (
              <DateTimeInput
                id="reversal-time"
                labelText={kind === 'refund' ? 'Money given back' : 'Correction effective'}
                value={time}
                onChange={setTime}
                required
              />
            )}
            {kind === 'recording_error' && (
              <p className="mj-secondary">It is booked at the original time, {formatDateTime(payment.occurredAt)}.</p>
            )}
            {!timeOk && <p className="sales-field-error">Enter a valid date and time</p>}
            {needsReference && (
              <TextInput
                id="reversal-reference"
                labelText={
                  payment.method === 'external'
                    ? 'Reference of the accounting correction'
                    : 'Terminal reference of the refund or correction'
                }
                value={reference}
                onChange={(event) => setReference(event.target.value)}
                helperText={
                  payment.method === 'card'
                    ? 'From the terminal slip of the refund or the voided payment.'
                    : 'Credit note, corrected invoice or other evidence from wiRef.'
                }
              />
            )}
            <TextArea
              id="reversal-reason"
              labelText="Reason"
              rows={3}
              maxCount={500}
              enableCounter
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              helperText="Shown on the payment and the order. Do not add personal data."
              invalid={reason.length > 0 && !reasonOk}
              invalidText="Give a reason of up to 500 characters"
            />
            <StructuredListWrapper isCondensed aria-label="What will change">
              <StructuredListBody>
                <StructuredListRow>
                  <StructuredListCell noWrap>New line</StructuredListCell>
                  <StructuredListCell>
                    {kindWord}, −{formatCents(toCents(payment.amount))}
                    {bookedAtOriginal ? ` at ${formatDateTime(payment.occurredAt)}` : ''}.
                  </StructuredListCell>
                </StructuredListRow>
                <StructuredListRow>
                  <StructuredListCell noWrap>Order</StructuredListCell>
                  <StructuredListCell>{`${formatCents(toCents(order.outstandingAmount))} outstanding becomes ${formatCents(toCents(order.outstandingAmount) + toCents(payment.amount))}.`}</StructuredListCell>
                </StructuredListRow>
              </StructuredListBody>
            </StructuredListWrapper>
          </>
        )}
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
