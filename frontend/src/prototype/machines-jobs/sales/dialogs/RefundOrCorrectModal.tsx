import { LinkifiedText, NotificationBody, RefLink } from '../../components/RefLink';
import { useState } from 'react';
import { InlineNotification, Modal, RadioButton, RadioButtonGroup, Stack, StructuredListBody, StructuredListCell, StructuredListRow, StructuredListWrapper, TextArea, TextInput } from '@carbon/react';
import { DateTimeInput } from '../../../../app/DateInput';
import { instantToZonedDateTimeValue, isZonedDateTimeValue, zonedDateTimeValueToISO } from '../../../../app/dateTime';
import { useStore } from '../../store';
import { LinkNotification } from '../components/LinkNotification';
import { formatDateTime, formatEur } from '../format';
import { methodLabel, reasonKindHelp } from '../labels';
import { reversalOptions, type OrderView } from '../logic';
import { useSalesMutation } from '../useSalesMutation';
import type { Payment, ReversalReasonKind } from '../types';

/**
 * Undoes one receipt, in the words of the cashbook: give the money back, fix an entry made by mistake, or record an accounting correction from wiRef.
 * Only the reasons the rules allow for this payment are offered, and what would block the others is said up front.
 */
export function RefundOrCorrectModal({ payment, order, onClose }: { payment: Payment; order: OrderView; onClose: () => void }) {
  const store = useStore();
  const options = reversalOptions(payment, order, store);
  const available = options.kinds;
  const [kind, setKind] = useState<ReversalReasonKind>(available[0] ?? 'refund');
  const [time, setTime] = useState(() => instantToZonedDateTimeValue(new Date()));
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const bookedAtOriginal = kind === 'recording_error';
  const timeOk = bookedAtOriginal || isZonedDateTimeValue(time);
  const referenceOk = !(payment.method === 'card' || payment.method === 'external') || reference.trim() !== '';
  const reasonOk = reason.trim().length > 0 && reason.trim().length <= 500;
  const ok = options.blocker === null && !options.prerequisite && available.includes(kind) && timeOk && referenceOk && reasonOk;

  const { mutate, pending, error } = useSalesMutation(() => store.reverseOrderPayment(
    { paymentId: payment.id, reasonKind: kind, reason: reason.trim(), occurredAt: bookedAtOriginal ? payment.occurredAt : zonedDateTimeValueToISO(time), transactionReference: reference.trim() },
  ));
  const submit = async () => {
    const result = await mutate();
    if (!result.ok) return;
    store.notify({ kind: 'success', title: kind === 'refund' ? `${payment.reference} refunded` : `${payment.reference} corrected`, subtitle: `${formatEur(payment.amount)} no longer counts towards ${order.reference}.` });
    onClose();
  };

  const kindWord = kind === 'refund' ? 'Refunded' : kind === 'recording_error' ? 'Corrected (recorded by mistake)' : 'Corrected from wiRef';
  return (
    <Modal
      open size="md" danger modalHeading="Refund or correct" modalLabel={`${payment.reference} · ${methodLabel(payment.method)} ${formatEur(payment.amount)}`}
      primaryButtonText={pending ? 'Saving…' : kind === 'refund' ? 'Refund payment' : 'Correct payment'} secondaryButtonText="Cancel" primaryButtonDisabled={!ok || pending}
      preventCloseOnClickOutside onRequestClose={() => { if (!pending) onClose(); }} onRequestSubmit={() => { void submit(); }}
    >
      <Stack gap={6}>
        <p>Receipts are never edited or deleted. This adds a new line that undoes <RefLink reference={payment.reference} id={payment.id} onNavigate={onClose} /> on <RefLink reference={order.reference} id={order.id} onNavigate={onClose} />; both stay on the record.</p>
        {options.blocker && <InlineNotification kind="error" lowContrast hideCloseButton title="This payment cannot be refunded or corrected"><NotificationBody><LinkifiedText text={options.blocker} onNavigate={onClose} /></NotificationBody></InlineNotification>}
        {options.prerequisite && (
          <LinkNotification kind="warning" title="Cancel the wiRef request first" subtitle={<><LinkifiedText text={options.prerequisite.text} onNavigate={onClose} /> Core records what happened in wiRef; it does not change the accounting itself.</>} label="Open the request" to={options.prerequisite.to} onFollow={onClose} />
        )}
        {!options.blocker && (
          <>
            <RadioButtonGroup legendText="What happened?" name="reversal-kind" orientation="vertical" valueSelected={kind} onChange={(value) => setKind(value as ReversalReasonKind)}>
              {options.kinds.map((item) => (
                <RadioButton key={item} id={`reversal-${item}`} value={item} labelText={reasonKindHelp[item].title} />
              ))}
            </RadioButtonGroup>
            <p className="mj-secondary">{reasonKindHelp[kind].help}</p>

            {kind === 'refund' && <DateTimeInput id="reversal-time" labelText="Money given back" value={time} onChange={setTime} required />}
            {kind === 'external_correction' && <DateTimeInput id="reversal-time" labelText="Correction effective" value={time} onChange={setTime} required />}
            {kind === 'recording_error' && <p className="mj-secondary">It is booked at the original time, {formatDateTime(payment.occurredAt)}.</p>}
            {!timeOk && <p className="sales-field-error">Enter a valid date and time</p>}

            {(payment.method === 'card' || payment.method === 'external') && (
              <TextInput id="reversal-reference" labelText={payment.method === 'external' ? 'Reference of the accounting correction' : 'Terminal reference of the refund or correction'} value={reference} onChange={(event) => setReference(event.target.value)}
                invalid={reference !== '' && reference.trim() === ''} invalidText="Enter the reference" helperText={payment.method === 'card' ? 'From the terminal slip of the refund or the voided payment.' : 'Credit note, corrected invoice or other evidence from wiRef.'} />
            )}
            <TextArea id="reversal-reason" labelText="Reason" rows={3} maxCount={500} enableCounter value={reason} onChange={(event) => setReason(event.target.value)}
              helperText="Shown on the payment and the order. Do not add personal data." invalid={reason.length > 0 && !reasonOk} invalidText="Give a reason of up to 500 characters" />

            <StructuredListWrapper isCondensed aria-label="What will change">
              <StructuredListBody>
                <StructuredListRow><StructuredListCell noWrap><RefLink reference={payment.reference} id={payment.id} onNavigate={onClose} /></StructuredListCell><StructuredListCell>{formatEur(payment.amount)} {methodLabel(payment.method).toLowerCase()} stays on the record and stops counting towards <RefLink reference={order.reference} id={order.id} onNavigate={onClose} />.</StructuredListCell></StructuredListRow>
                <StructuredListRow><StructuredListCell noWrap>New line</StructuredListCell><StructuredListCell>{kindWord}, −{formatEur(payment.amount)}{bookedAtOriginal ? ` at ${formatDateTime(payment.occurredAt)}` : ''}.</StructuredListCell></StructuredListRow>
                <StructuredListRow><StructuredListCell noWrap>Order</StructuredListCell><StructuredListCell>{`${formatEur(order.outstanding)} outstanding becomes ${formatEur(order.outstanding + payment.amount)}.`}</StructuredListCell></StructuredListRow>
              </StructuredListBody>
            </StructuredListWrapper>
          </>
        )}
        {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Nothing was saved" subtitle={error} />}
      </Stack>
    </Modal>
  );
}
