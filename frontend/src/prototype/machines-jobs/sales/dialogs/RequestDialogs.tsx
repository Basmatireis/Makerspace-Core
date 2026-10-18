import { useState, type ReactNode } from 'react';
import { InlineNotification, Modal, RadioTile, Stack, TextArea, TextInput, TileGroup } from '@carbon/react';
import { DateInput } from '../../../../app/DateInput';
import { dateInAppTimeZone } from '../../../../app/dateTime';
import { useStore } from '../../store';
import { formatEur, parseMoney } from '../format';
import { reconciliationLabels } from '../labels';
import { activeReceipts, type OrderView } from '../logic';
import { RECONCILIATION_KINDS } from '../engine';
import { useSalesMutation } from '../useSalesMutation';
import type { InvoiceRequest, ReconciliationKind } from '../types';

export type RequestDialogKind = 'ready' | 'submitted' | 'issued' | 'cancel' | 'request-cancellation' | 'confirm-cancellation' | 'correct-reference';

type ActionProps = {
  heading: string; request: InvoiceRequest; primary: string; secondary?: string; danger?: boolean; disabled?: boolean; success: { title: string; subtitle?: string };
  run: () => unknown; onClose: () => void; children: ReactNode;
};

/** One shape for every wiRef step: explain, collect the facts, run the engine transition, show a rule violation inline. */
function ActionModal({ heading, request, primary, secondary = 'Cancel', danger, disabled, success, run, onClose, children }: ActionProps) {
  const store = useStore();
  const { mutate, pending, error } = useSalesMutation(run);
  const submit = async () => {
    const result = await mutate();
    if (!result.ok) return;
    store.notify({ kind: 'success', ...success });
    onClose();
  };
  return (
    <Modal open size="sm" danger={danger} modalHeading={heading} modalLabel={request.reference} primaryButtonText={pending ? 'Saving…' : primary} secondaryButtonText={secondary} primaryButtonDisabled={disabled || pending}
      preventCloseOnClickOutside onRequestClose={() => { if (!pending) onClose(); }} onRequestSubmit={() => { void submit(); }}>
      <Stack gap={5}>
        {children}
        {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Nothing was saved" subtitle={error} />}
      </Stack>
    </Modal>
  );
}

const today = () => dateInAppTimeZone(new Date());

export function RequestDialog({ kind, request, order, onClose }: { kind: RequestDialogKind; request: InvoiceRequest; order: OrderView | null; onClose: () => void }) {
  const store = useStore();
  const [reference, setReference] = useState('');
  const [date, setDate] = useState(today);
  const [amount, setAmount] = useState(() => String(request.requestedAmount).replace('.', ','));
  const [reason, setReason] = useState('');
  const [procedure, setProcedure] = useState<ReconciliationKind>('cancellation');
  const parsedAmount = parseMoney(amount);
  const externalPaid = order ? activeReceipts(store.payments, store.allocations, order.id).some((payment) => payment.method === 'external') : false;

  if (kind === 'ready') {
    return (
      <ActionModal heading="Mark as ready to submit" request={request} primary="Mark as ready" onClose={onClose} run={() => store.markRequestReady(request.id)} success={{ title: `${request.reference} is ready`, subtitle: 'Send it to wiRef, then mark it as submitted.' }}>
        <p>The recipient details are complete. Once the request is ready they are frozen, and the purchase order requirement of the customer is checked and kept as it is now.</p>
        <p className="mj-secondary">To change something afterwards, cancel this request and prepare a new one.</p>
      </ActionModal>
    );
  }
  if (kind === 'submitted') {
    return (
      <ActionModal heading="Mark as submitted" request={request} primary="Mark as submitted" onClose={onClose} run={() => store.markRequestSubmitted(request.id)} success={{ title: `${request.reference} submitted`, subtitle: 'Wait for wiRef to issue the invoice, then record it here.' }}>
        <p>Confirm that you sent {request.reference} for <strong>{formatEur(request.requestedAmount)}</strong> to wiRef. Makerspace Core does not send anything itself; this records that you did.</p>
      </ActionModal>
    );
  }
  if (kind === 'issued') {
    const valid = reference.trim() !== '' && !!date && parsedAmount === request.requestedAmount;
    return (
      <ActionModal heading="Record the issued invoice" request={request} primary="Record invoice" disabled={!valid} onClose={onClose}
        run={() => store.recordRequestIssued(request.id, { externalReference: reference, effectiveOn: date, amount: parsedAmount ?? 0 })}
        success={{ title: 'Invoice recorded', subtitle: 'The payment can be recorded once wiRef confirms it.' }}>
        <p>wiRef issued the invoice. Enter what it says. This is not a payment; the payment is recorded separately when it arrives.</p>
        <TextInput id="issued-reference" labelText="Invoice number from wiRef" value={reference} onChange={(event) => setReference(event.target.value)} />
        <DateInput id="issued-date" labelText="Invoice date" value={date} onChange={setDate} required />
        <TextInput id="issued-amount" labelText="Invoice amount (€)" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)}
          invalid={amount !== '' && parsedAmount !== request.requestedAmount} invalidText={`Must equal the requested ${formatEur(request.requestedAmount)}`} helperText="The invoice has to match the request." />
      </ActionModal>
    );
  }
  if (kind === 'cancel') {
    return (
      <ActionModal heading="Cancel this request" request={request} primary="Cancel request" secondary="Keep request" danger onClose={onClose} run={() => store.cancelRequest(request.id, reason)}
        success={{ title: `${request.reference} cancelled`, subtitle: 'wiRef never saw it. Cash and card are available again, or you can prepare a new request.' }}>
        <p>{request.state === 'draft' ? 'This request was never submitted.' : 'This request was marked ready, but not yet submitted.'} Cancelling it only affects Makerspace Core; nothing has to be undone in wiRef.</p>
        <TextArea id="cancel-reason" labelText="Reason (optional)" rows={2} maxCount={500} enableCounter value={reason} onChange={(event) => setReason(event.target.value)} />
      </ActionModal>
    );
  }
  if (kind === 'request-cancellation') {
    return (
      <ActionModal heading="Request cancellation" request={request} primary="Request cancellation" danger disabled={reason.trim() === ''} onClose={onClose} run={() => store.requestCancellation(request.id, reason)}
        success={{ title: 'Cancellation requested', subtitle: 'Once wiRef cancelled or corrected the invoice, confirm it here.' }}>
        <p>{request.state === 'issued' ? 'The invoice was issued, so wiRef has to cancel or correct it.' : 'The request was submitted, so wiRef has to withdraw it.'} Do that in your normal accounting process; then come back and confirm.</p>
        <p className="mj-secondary">Cash and card stay switched off for the order until the cancellation is confirmed.</p>
        {externalPaid && <InlineNotification kind="warning" lowContrast hideCloseButton title="A wiRef payment is recorded" subtitle="After the cancellation is confirmed you also have to correct that payment before the order can be reversed or replaced." />}
        <TextArea id="cancellation-reason" labelText="Why does it have to be cancelled?" rows={3} maxCount={500} enableCounter value={reason} onChange={(event) => setReason(event.target.value)} />
      </ActionModal>
    );
  }
  if (kind === 'confirm-cancellation') {
    const valid = reference.trim() !== '' && !!date;
    return (
      <ActionModal heading="Confirm the cancellation" request={request} primary="Confirm cancellation" disabled={!valid} onClose={onClose}
        run={() => store.confirmRequestCancellation(request.id, { reconciliationKind: procedure, externalReference: reference, effectiveOn: date })}
        success={{ title: `${request.reference} cancelled`, subtitle: 'The order is free again. Correct a wiRef payment, or prepare a new request.' }}>
        <p>How did wiRef settle the invoice? Record the evidence so the accounting can be followed later.</p>
        <TileGroup legend="What did wiRef do?" name="reconciliation-kind" valueSelected={procedure} onChange={(value) => setProcedure(value as ReconciliationKind)}>
          {RECONCILIATION_KINDS.map((item) => (
            <RadioTile key={item} id={`reconciliation-${item}`} value={item}><span className="mj-cell-stack"><strong>{reconciliationLabels[item].label}</strong><span className="mj-secondary">{reconciliationLabels[item].help}</span></span></RadioTile>
          ))}
        </TileGroup>
        <TextInput id="cancellation-reference" labelText="Reference from wiRef" helperText="Credit note number, cancellation number or similar." value={reference} onChange={(event) => setReference(event.target.value)} />
        <DateInput id="cancellation-date" labelText="Effective on" value={date} onChange={setDate} required />
      </ActionModal>
    );
  }
  const valid = reference.trim() !== '' && reason.trim() !== '' && !!date;
  return (
    <ActionModal heading="Correct the invoice reference" request={request} primary="Save correction" disabled={!valid} onClose={onClose}
      run={() => store.correctRequestReference(request.id, { externalReference: reference, reason, effectiveOn: date })} success={{ title: 'Reference corrected', subtitle: 'The earlier reference stays in the history.' }}>
      <p>wiRef changed the invoice number, or it was entered wrongly. The old reference is kept in the history.</p>
      <TextInput id="correct-reference" labelText="Correct invoice number" value={reference} onChange={(event) => setReference(event.target.value)} />
      <DateInput id="correct-date" labelText="Effective on" value={date} onChange={setDate} required />
      <TextArea id="correct-reference-reason" labelText="Reason" rows={2} maxCount={500} enableCounter value={reason} onChange={(event) => setReason(event.target.value)} />
    </ActionModal>
  );
}

