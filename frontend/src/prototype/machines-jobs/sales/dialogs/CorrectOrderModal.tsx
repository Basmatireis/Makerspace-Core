import { useMemo, useState } from 'react';
import { Button, InlineNotification, Modal, ProgressIndicator, ProgressStep, RadioButton, RadioButtonGroup, RadioTile, Stack, StructuredListBody, StructuredListCell, StructuredListRow, StructuredListWrapper, TextArea, TextInput, TileGroup } from '@carbon/react';
import { Link } from 'react-router-dom';
import { DateTimeInput } from '../../../../app/DateInput';
import { instantToZonedDateTimeValue, isZonedDateTimeValue, zonedDateTimeValueToISO } from '../../../../app/dateTime';
import { useStore } from '../../store';
import { checkEntry, existingReferences, newPaymentEntry, PaymentEntryForm, toPaymentInputs } from '../components/PaymentEntry';
import { formatDateTime, formatEur, round2 } from '../format';
import { methodLabel, requestStateLabel } from '../labels';
import { activeReceipts, sum, type OrderView } from '../logic';
import { useSalesMutation } from '../useSalesMutation';
import type { Payment, ReversalInput } from '../types';

type Intent = 'replace' | 'cancel';
type Step = 'intent' | 'payments' | 'review';
type Option = 'carry' | 'refund' | 'error';
type Choice = { option: Option; time: string; reference: string };

const STEPS: Step[] = ['intent', 'payments', 'review'];
const STEP_LABELS = ['What to correct', 'Payments', 'Reason and review'];

/**
 * Guided correction, replacing the old correction panel. From a finalized order it asks what to correct; from a replacement draft
 * (`replacement` set) it starts at the payments step, because the new total is known by then. Only options the rules allow are offered.
 */
export function CorrectOrderModal({ order, replacement, onClose }: { order: OrderView; replacement?: OrderView; onClose: () => void }) {
  const store = useStore();
  const committing = !!replacement;
  const original = order;
  const receipts = useMemo(() => activeReceipts(store.payments, store.allocations, original.id), [store.payments, store.allocations, original.id]);
  const [intent, setIntent] = useState<Intent>('replace');
  const [step, setStep] = useState<Step>(committing ? (receipts.length > 0 || (replacement?.total ?? 0) > 0 ? 'payments' : 'review') : 'intent');
  const [reason, setReason] = useState('');
  const newTotal = replacement?.total ?? 0;
  const walkIn = !original.customer;
  const externalReceipt = receipts.find((payment) => payment.method === 'external');

  const optionsFor = (payment: Payment): Option[] => committing && payment.amount <= newTotal && payment.method !== 'external' ? ['carry', 'refund', 'error'] : ['refund', 'error'];
  const [choices, setChoices] = useState<Record<string, Choice>>(() => Object.fromEntries(receipts.map((payment) => [payment.id, {
    option: committing && payment.amount <= newTotal && payment.method !== 'external' ? 'carry' : 'refund', time: instantToZonedDateTimeValue(new Date()), reference: '',
  }])));
  const choice = (payment: Payment) => choices[payment.id] ?? { option: 'refund' as Option, time: instantToZonedDateTimeValue(new Date()), reference: '' };
  const patch = (id: string, change: Partial<Choice>) => setChoices((current) => ({ ...current, [id]: { ...(current[id] ?? { option: 'refund' as Option, time: instantToZonedDateTimeValue(new Date()), reference: '' }), ...change } }));

  const carried = round2(sum(receipts.filter((payment) => choice(payment).option === 'carry').map((payment) => payment.amount)));
  const toPay = committing ? round2(Math.max(0, newTotal - carried)) : 0;
  const [entry, setEntry] = useState(() => newPaymentEntry(toPay));
  // The amount to collect follows the carry-over choices; rebuild the form when it changes (state adjusted during render, not in an effect).
  const [entryDue, setEntryDue] = useState(toPay);
  if (entryDue !== toPay) { setEntryDue(toPay); setEntry(newPaymentEntry(toPay)); }
  const [payNow, setPayNow] = useState(false);
  const mustPayNow = committing && walkIn && toPay > 0;
  const payCheck = checkEntry(entry, toPay, walkIn, existingReferences(store.payments));
  const payingNow = (payNow || mustPayNow) && toPay > 0;

  const receiptErrors = receipts.map((payment) => {
    const current = choice(payment);
    if (current.option === 'carry') return null;
    if (payment.method === 'external' && current.option !== 'error') return 'Payments confirmed by wiRef need an accounting correction in Invoicing.';
    if (current.option === 'refund' && !isZonedDateTimeValue(current.time)) return 'Enter a valid refund time';
    if (payment.method === 'card' && !current.reference.trim()) return 'Enter the terminal reference of the refund or correction';
    return null;
  });
  const overCarried = committing && carried > newTotal;
  const paymentsOk = !externalReceipt && receiptErrors.every((error) => error === null) && !overCarried;
  const reasonOk = reason.trim().length > 0 && reason.trim().length <= 500;
  const payOk = !payingNow || payCheck.ok;
  const blockedRequest = original.latestRequest && original.latestRequest.state !== 'cancelled' ? original.latestRequest : null;

  const reversals: ReversalInput[] = receipts.filter((payment) => choice(payment).option !== 'carry').map((payment) => {
    const current = choice(payment);
    return {
      paymentId: payment.id, reasonKind: current.option === 'refund' ? 'refund' : 'recording_error', reason: reason.trim(), occurredAt: current.option === 'refund' ? zonedDateTimeValueToISO(current.time) : payment.occurredAt,
      transactionReference: current.reference.trim(),
    };
  });
  const { mutate, pending, error } = useSalesMutation(() => committing
    ? store.commitReplacement(original.id, replacement.id, { reason: reason.trim(), reversals, payments: payingNow ? toPaymentInputs(entry) : [] })
    : intent === 'cancel' ? store.reverseOrder(original.id, { reason: reason.trim(), reversals }) : store.startReplacement(original.id));

  const index = STEPS.indexOf(step);
  const startReplacement = async () => {
    const result = await mutate();
    if (!result.ok) return;
    const id = (result.value as { orderId: string }).orderId;
    store.notify({ kind: 'info', title: 'Replacement draft created', subtitle: 'Change the items, then commit it to replace the original.', action: { label: 'Open draft', to: `/sales/orders/${id}` } });
    onClose();
  };
  const finish = async () => {
    const result = await mutate();
    if (!result.ok) return;
    store.notify(committing
      ? { kind: 'success', title: `${replacement.reference} replaces ${original.reference}`, subtitle: carried > 0 ? `${formatEur(carried)} of payments moved over.` : 'The original order is reversed.', action: { label: 'Open order', to: `/sales/orders/${replacement.id}` } }
      : { kind: 'success', title: `${original.reference} reversed`, subtitle: 'Nothing is charged for this order any more.' });
    onClose();
  };

  const next = () => {
    if (step === 'intent') {
      if (intent === 'replace') { void startReplacement(); return; }
      setStep(receipts.length ? 'payments' : 'review');
    } else if (step === 'payments') setStep('review');
    else void finish();
  };
  const hasPaymentsStep = receipts.length > 0 || (committing && toPay > 0);
  const canGoBack = step === 'review' ? hasPaymentsStep || !committing : step === 'payments' && !committing;
  const back = () => {
    if (step === 'review') setStep(hasPaymentsStep ? 'payments' : 'intent');
    else if (step === 'payments') setStep('intent');
    else onClose();
  };

  const blockers = (
    <Stack gap={4}>
      {order.replacedBy && <InlineNotification kind="info" lowContrast hideCloseButton title={`Already replaced by ${order.replacedBy.reference}`} subtitle="Correct the replacement instead; a replaced order cannot be changed again." />}
      {blockedRequest && (
        <InlineNotification kind="warning" lowContrast hideCloseButton title={`${blockedRequest.reference} is ${requestStateLabel[blockedRequest.state].toLowerCase()}`}
          subtitle="Cancel or reconcile the wiRef request in Invoicing first. Core records what happened in wiRef; it does not change the accounting itself." />
      )}
      {blockedRequest && <Button as={Link} to="/sales/invoicing" kind="tertiary" size="sm" onClick={onClose}>Open Invoicing</Button>}
    </Stack>
  );
  const blocked = !committing && (!!order.replacedBy || !!blockedRequest);

  const primaryLabel = pending ? 'Working…' : step === 'intent' ? (intent === 'replace' ? 'Create replacement draft' : 'Next') : step === 'payments' ? 'Next'
    : committing ? 'Commit replacement' : 'Reverse order';
  const primaryDisabled = pending || blocked || (step === 'intent' && order.status === 'reversed' && intent === 'cancel') || (step === 'payments' && (!paymentsOk || !payOk)) || (step === 'review' && (!reasonOk || !paymentsOk || !payOk));

  return (
    <Modal
      open size="md" danger={step === 'review' && !committing} modalHeading={committing ? `Commit replacement for ${original.reference}` : 'Correct order'} modalLabel={committing ? replacement.reference : original.reference}
      primaryButtonText={primaryLabel} secondaryButtonText={canGoBack ? 'Back' : 'Cancel'} primaryButtonDisabled={primaryDisabled}
      preventCloseOnClickOutside onRequestClose={() => { if (!pending) onClose(); }} onSecondarySubmit={() => { if (!pending) { if (canGoBack) back(); else onClose(); } }} onRequestSubmit={next}
    >
      <Stack gap={6}>
        {!committing && (
          <ProgressIndicator currentIndex={index} spaceEqually>
            {STEP_LABELS.map((label) => <ProgressStep key={label} label={label} />)}
          </ProgressIndicator>
        )}

        {step === 'intent' && (
          <Stack gap={5}>
            {blockers}
            <TileGroup legend="What do you want to do?" name="correct-intent" valueSelected={intent} onChange={(value) => setIntent(value as Intent)} disabled={blocked}>
              <RadioTile id="correct-replace" value="replace">
                <span className="mj-cell-stack"><strong>Change the charges</strong><span className="mj-secondary">Wrong price, item or customer? A new draft copies the items. You change it, then commit it: the original is reversed and its payments move over to the new order.</span></span>
              </RadioTile>
              <RadioTile id="correct-cancel" value="cancel" disabled={order.status === 'reversed'}>
                <span className="mj-cell-stack"><strong>Cancel the whole order</strong><span className="mj-secondary">Nothing is charged at all. Every payment has to be refunded or marked as recorded by mistake first.</span></span>
              </RadioTile>
            </TileGroup>
            {order.status === 'reversed' && <p className="mj-secondary">This order is already reversed. You can still replace it with a corrected order.</p>}
            {receipts.length > 0 && <p className="mj-secondary">This order has {receipts.length} {receipts.length === 1 ? 'payment' : 'payments'} ({formatEur(sum(receipts.map((payment) => payment.amount)))}). You decide what happens to them in the next step.</p>}
          </Stack>
        )}

        {step === 'payments' && (
          <Stack gap={6}>
            {committing && <InlineNotification kind="info" lowContrast hideCloseButton title={`New total ${formatEur(newTotal)}`} subtitle={`${original.reference} was ${formatEur(sum(receipts.map((payment) => payment.amount)))} paid. Choose what happens to each payment.`} />}
            {externalReceipt && <InlineNotification kind="error" lowContrast hideCloseButton title="A payment was confirmed by wiRef" subtitle="It cannot be moved or refunded here. Record the external accounting correction in Invoicing first." />}
            {receipts.map((payment, position) => {
              const current = choice(payment);
              const options = optionsFor(payment);
              return (
                <Stack key={payment.id} gap={4} className="sales-receipt-choice">
                  <RadioButtonGroup
                    legendText={`${payment.reference} · ${methodLabel(payment.method)} ${formatEur(payment.amount)} · ${formatDateTime(payment.occurredAt)}`} name={`receipt-${payment.id}`} orientation="vertical"
                    valueSelected={current.option} onChange={(value) => patch(payment.id, { option: value as Option })}
                  >
                    {options.includes('carry') && <RadioButton id={`rc-${payment.id}-carry`} value="carry" labelText="Carry over to the new order (no money moves)" />}
                    <RadioButton id={`rc-${payment.id}-refund`} value="refund" labelText="Give the money back (refund)" />
                    <RadioButton id={`rc-${payment.id}-error`} value="error" labelText="It was recorded by mistake (correction)" />
                  </RadioButtonGroup>
                  {committing && !options.includes('carry') && payment.method !== 'external' && <p className="mj-secondary">Carrying over is not offered: this payment is more than the new total.</p>}
                  {current.option === 'refund' && <DateTimeInput id={`rc-${payment.id}-time`} labelText="Refund" value={current.time} onChange={(time) => patch(payment.id, { time })} required />}
                  {current.option === 'error' && <p className="mj-secondary">A correction is booked at the original time, {formatDateTime(payment.occurredAt)}.</p>}
                  {current.option !== 'carry' && payment.method === 'card' && (
                    <TextInput id={`rc-${payment.id}-ref`} labelText="Terminal reference of the refund or correction" value={current.reference} onChange={(event) => patch(payment.id, { reference: event.target.value })} invalid={current.reference.trim() === '' && position >= 0} invalidText="Required for card payments" />
                  )}
                  {receiptErrors[position] && <p className="sales-field-error">{receiptErrors[position]}</p>}
                </Stack>
              );
            })}
            {overCarried && <InlineNotification kind="error" lowContrast hideCloseButton title="Too much carried over" subtitle={`The new total is ${formatEur(newTotal)}. Refund or correct at least ${formatEur(round2(carried - newTotal))} more.`} />}
            {committing && toPay > 0 && (
              <Stack gap={4}>
                <h3 className="mj-section-title">Still to pay: {formatEur(toPay)}</h3>
                {mustPayNow
                  ? <p className="mj-secondary">A walk-in order has to stay fully paid, so collect the difference now.</p>
                  : <RadioButtonGroup legendText="Collect the difference" name="collect-now" valueSelected={payNow ? 'now' : 'later'} onChange={(value) => setPayNow(value === 'now')}>
                    <RadioButton id="collect-later" value="later" labelText="Leave it outstanding" /><RadioButton id="collect-now" value="now" labelText="Record a payment now" />
                  </RadioButtonGroup>}
                {payingNow && <PaymentEntryForm idPrefix="commit-pay" entry={entry} onChange={setEntry} due={toPay} requireFull={walkIn} payments={store.payments} disabled={pending} />}
              </Stack>
            )}
          </Stack>
        )}

        {step === 'review' && (
          <Stack gap={5}>
            <TextArea id="correct-reason" labelText="Reason" rows={3} maxCount={500} value={reason} onChange={(event) => setReason(event.target.value)} enableCounter
              helperText="Kept with the order and shown in its timeline. Do not add personal data." invalid={reason.length > 0 && !reasonOk} invalidText="Give a reason of up to 500 characters" />
            <StructuredListWrapper isCondensed aria-label="Result of the correction">
              <StructuredListBody>
                <StructuredListRow><StructuredListCell noWrap>Original order</StructuredListCell><StructuredListCell>{original.reference} · {formatEur(original.total)} → {order.status === 'reversed' ? 'stays reversed' : 'reversed (nothing charged)'}</StructuredListCell></StructuredListRow>
                {committing && <StructuredListRow><StructuredListCell noWrap>New order</StructuredListCell><StructuredListCell>{replacement.reference} · {formatEur(newTotal)}</StructuredListCell></StructuredListRow>}
                {receipts.map((payment) => (
                  <StructuredListRow key={payment.id}>
                    <StructuredListCell noWrap>{payment.reference}</StructuredListCell>
                    <StructuredListCell>{formatEur(payment.amount)} {methodLabel(payment.method).toLowerCase()}: {{ carry: 'carried over to the new order', refund: 'refunded', error: 'corrected (recorded by mistake)' }[choice(payment).option]}</StructuredListCell>
                  </StructuredListRow>
                ))}
                {committing && <StructuredListRow><StructuredListCell noWrap>Result</StructuredListCell><StructuredListCell>{toPay === 0 ? 'The new order is paid in full.' : payingNow ? `Paid ${formatEur(payCheck.covered)} now, ${formatEur(round2(toPay - payCheck.covered))} outstanding.` : `${formatEur(toPay)} stays outstanding on the new order.`}</StructuredListCell></StructuredListRow>}
              </StructuredListBody>
            </StructuredListWrapper>
            {!hasPaymentsStep && <p className="mj-secondary">This order has no payments, so nothing has to be refunded.</p>}
          </Stack>
        )}
        {error && <InlineNotification kind="error" lowContrast hideCloseButton title="The correction was not saved" subtitle={error} />}
      </Stack>
    </Modal>
  );
}
