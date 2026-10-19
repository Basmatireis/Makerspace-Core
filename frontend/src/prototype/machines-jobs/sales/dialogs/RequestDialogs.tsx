import { useState, type ReactNode } from 'react';
import { CodeSnippet, InlineNotification, Modal, RadioTile, Stack, TextArea, TextInput, TileGroup } from '@carbon/react';
import { DateInput } from '../../../../app/DateInput';
import { dateInAppTimeZone } from '../../../../app/dateTime';
import { useStore } from '../../store';
import { formatEur } from '../format';
import { reconciliationLabels } from '../labels';
import { activeReceipts, invoiceNumberOf, requestReadiness, wiRefCopyText, type OrderView } from '../logic';
import { RECONCILIATION_KINDS } from '../engine';
import { useSalesMutation } from '../useSalesMutation';
import type { InvoiceRequest, ReconciliationKind } from '../types';

export type RequestDialogKind = 'submit' | 'return' | 'forward' | 'cancel' | 'request-cancellation' | 'confirm-cancellation' | 'reference';

type ActionProps = {
  heading: string; size?: 'sm' | 'md'; request: InvoiceRequest; primary: string; secondary?: string; danger?: boolean; disabled?: boolean; success: { title: string; subtitle?: string };
  run: () => unknown; onClose: () => void; children: ReactNode;
};

/** One shape for every wiRef step: explain, collect the facts, run the engine transition, show a rule violation inline. */
function ActionModal({ heading, size = 'sm', request, primary, secondary = 'Cancel', danger, disabled, success, run, onClose, children }: ActionProps) {
  const store = useStore();
  const { mutate, pending, error } = useSalesMutation(run);
  const submit = async () => {
    const result = await mutate();
    if (!result.ok) return;
    store.notify({ kind: 'success', ...success });
    onClose();
  };
  return (
    <Modal open size={size} danger={danger} modalHeading={heading} modalLabel={request.reference} primaryButtonText={pending ? 'Saving…' : primary} secondaryButtonText={secondary} primaryButtonDisabled={disabled || pending}
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
  const [reason, setReason] = useState('');
  const [procedure, setProcedure] = useState<ReconciliationKind>('cancellation');
  const externalPaid = order ? activeReceipts(store.payments, store.allocations, order.id).some((payment) => payment.method === 'external') : false;

  if (kind === 'submit') {
    return (
      <ActionModal heading="Submit for approval" request={request} primary="Submit for approval" onClose={onClose} run={() => store.submitRequestForApproval(request.id)}
        success={{ title: `${request.reference} submitted for approval`, subtitle: 'Management checks the data and forwards it to wiRef.' }}>
        <p>The recipient details are complete. Management now checks them, copies the data to wiRef and marks the request as forwarded. The purchase order requirement of the organization is checked now.</p>
        <p className="mj-secondary">While the request awaits approval only management can change it or send it back to you. The amount already paid ({formatEur(request.alreadyPaid)}) is frozen, so cash and card can no longer be added.</p>
      </ActionModal>
    );
  }
  if (kind === 'return') {
    return (
      <ActionModal heading="Return for correction" request={request} primary="Return for correction" disabled={reason.trim() === ''} onClose={onClose} run={() => store.returnRequestForCorrection(request.id, reason)}
        success={{ title: `${request.reference} returned`, subtitle: 'It is a draft again and shows your comment until it is submitted again.' }}>
        <p>The request goes back to the draft. Tell the person who prepared it what has to be corrected; they see your comment on the invoice.</p>
        <TextArea id="return-comment" labelText="What has to be corrected?" rows={3} maxCount={500} enableCounter value={reason} onChange={(event) => setReason(event.target.value)} />
      </ActionModal>
    );
  }
  if (kind === 'forward') {
    const customer = order?.customer;
    const complete = requestReadiness(request, customer, store.organizations.find((item) => item.id === customer?.id)).every((item) => item.ok);
    return (
      <ActionModal heading="Approve and forward to wiRef" request={request} size="md" primary="Mark as forwarded to wiRef" secondary="Close" disabled={!order || !complete} onClose={onClose} run={() => store.forwardRequestToWiRef(request.id)}
        success={{ title: `${request.reference} issued`, subtitle: 'The order is paid: the invoice settles the open balance. The wiRef invoice number can be added later.' }}>
        <p>Copy the data below into wiRef. Makerspace Core does not send anything itself; marking the request as forwarded records that you did, approves it and settles the open balance of the order: the order becomes paid.</p>
        {order && <CodeSnippet type="multi" feedback="Copied" copyButtonDescription="Copy the invoice data" wrapText maxCollapsedNumberOfRows={40}>{wiRefCopyText(request, order)}</CodeSnippet>}
      </ActionModal>
    );
  }
  if (kind === 'cancel') {
    return (
      <ActionModal heading="Cancel this request" request={request} primary="Cancel request" secondary="Keep request" danger onClose={onClose} run={() => store.cancelRequest(request.id, reason)}
        success={{ title: `${request.reference} cancelled`, subtitle: 'wiRef never saw it. You can request the invoice again.' }}>
        <p>{request.state === 'draft' ? 'This request was never submitted for approval.' : 'This request awaits approval and was not forwarded to wiRef.'} Cancelling it only affects Makerspace Core; nothing has to be undone in wiRef.</p>
        <TextArea id="cancel-reason" labelText="Reason (optional)" rows={2} maxCount={500} enableCounter value={reason} onChange={(event) => setReason(event.target.value)} />
      </ActionModal>
    );
  }
  if (kind === 'request-cancellation') {
    return (
      <ActionModal heading="Request cancellation" request={request} primary="Request cancellation" danger disabled={reason.trim() === ''} onClose={onClose} run={() => store.requestCancellation(request.id, reason)}
        success={{ title: 'Cancellation requested', subtitle: 'Once wiRef cancelled or corrected the invoice, confirm it here.' }}>
        <p>The request was forwarded to wiRef, so wiRef has to cancel or correct the invoice. Do that in your normal accounting process; then come back and confirm.</p>
        <p className="mj-secondary">Cash and card stay switched off for the order until the cancellation is confirmed.</p>
        {externalPaid && <InlineNotification kind="warning" lowContrast hideCloseButton title="The invoice settled the order as paid" subtitle="After the cancellation is confirmed you also have to correct that payment before the order can be reversed or replaced." />}
        <TextArea id="cancellation-reason" labelText="Why does it have to be cancelled?" rows={3} maxCount={500} enableCounter value={reason} onChange={(event) => setReason(event.target.value)} />
      </ActionModal>
    );
  }
  if (kind === 'confirm-cancellation') {
    const valid = reference.trim() !== '' && !!date;
    return (
      <ActionModal heading="Confirm the cancellation" request={request} primary="Confirm cancellation" disabled={!valid} onClose={onClose}
        run={() => store.confirmRequestCancellation(request.id, { reconciliationKind: procedure, externalReference: reference, effectiveOn: date })}
        success={{ title: `${request.reference} cancelled`, subtitle: 'The order is free again. Correct the invoice payment on the order, or request a new invoice.' }}>
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
  const existing = invoiceNumberOf(request);
  const valid = reference.trim() !== '' && (existing === null || reason.trim() !== '') && !!date;
  return (
    <ActionModal heading={existing ? 'Correct the invoice number' : 'Add wiRef invoice number'} request={request} primary={existing ? 'Save correction' : 'Add invoice number'} disabled={!valid} onClose={onClose}
      run={() => store.recordRequestReference(request.id, { externalReference: reference, reason, effectiveOn: date })}
      success={existing ? { title: 'Invoice number corrected', subtitle: 'The earlier number stays in the history.' } : { title: 'Invoice number added' }}>
      {existing
        ? <p>wiRef changed the invoice number, or it was entered wrongly. The old number is kept in the history.</p>
        : <p>Optional: once wiRef has created the invoice, record its number here. This does not change any amount.</p>}
      <TextInput id="reference-number" labelText={existing ? 'Correct invoice number' : 'Invoice number from wiRef'} value={reference} onChange={(event) => setReference(event.target.value)} />
      <DateInput id="reference-date" labelText={existing ? 'Effective on' : 'Invoice date'} value={date} onChange={setDate} required />
      {existing && <TextArea id="reference-reason" labelText="Reason" rows={2} maxCount={500} enableCounter value={reason} onChange={(event) => setReason(event.target.value)} />}
    </ActionModal>
  );
}
