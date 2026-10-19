import { useState, type ReactNode } from 'react';
import { CodeSnippet, InlineNotification, Modal, RadioTile, Stack, TextArea, TextInput, TileGroup } from '@carbon/react';
import {
  cancelExternalInvoiceRequest, confirmExternalInvoiceCancellation, correctExternalInvoiceReference, forwardExternalInvoiceRequest, requestExternalInvoiceCancellation,
  returnExternalInvoiceRequest, submitExternalInvoiceRequest,
} from '../../api/generated/external-invoicing/external-invoicing';
import type { ExternalInvoiceRequest, InvoiceRequestCommandReconciliationKind } from '../../api/generated/models';
import { DateInput } from '../../app/DateInput';
import { dateInAppTimeZone } from '../../app/dateTime';
import { useNotify } from '../machinelogbook/shared/toasts';
import { reconciliationKinds, reconciliationLabels } from './labels';
import { invoiceNumberOf, requestReadiness, wiRefCopyText } from './logic';
import { formatCents, toCents } from './money';
import { useOperationKeys } from './operations';
import { useFinanceMutation } from './queries';

export type RequestDialogKind = 'submit' | 'return' | 'forward' | 'cancel' | 'request-cancellation' | 'confirm-cancellation' | 'reference';

type ActionProps = {
  heading: string; size?: 'sm' | 'md'; request: ExternalInvoiceRequest; primary: string; secondary?: string; danger?: boolean; disabled?: boolean; success: { title: string; subtitle?: string };
  run: () => Promise<unknown>; onClose: () => void; children: ReactNode;
};

/** One shape for every wiRef step: explain, collect the facts, run the transition, show a rule violation inline. */
function ActionModal({ heading, size = 'sm', request, primary, secondary = 'Cancel', danger, disabled, success, run, onClose, children }: ActionProps) {
  const notify = useNotify();
  const mutation = useFinanceMutation(run, () => { notify({ kind: 'success', ...success }); onClose(); });
  const pending = mutation.isPending;
  return (
    <Modal open size={size} danger={danger} modalHeading={heading} modalLabel={request.reference} primaryButtonText={pending ? 'Saving…' : primary} secondaryButtonText={secondary} primaryButtonDisabled={disabled || pending}
      preventCloseOnClickOutside onRequestClose={() => { if (!pending) onClose(); }} onRequestSubmit={() => mutation.mutate()}>
      <Stack gap={5}>
        {children}
        {mutation.error && <InlineNotification kind="error" lowContrast hideCloseButton title="Nothing was saved" subtitle={mutation.error.message} />}
      </Stack>
    </Modal>
  );
}

const today = () => dateInAppTimeZone(new Date());
const noonOf = (day: string) => `${day}T12:00:00Z`;

export function RequestDialog({ kind, request, customerKind, requirePurchaseOrder, externalPaid, onClose }: {
  kind: RequestDialogKind; request: ExternalInvoiceRequest; customerKind: string; requirePurchaseOrder: boolean; externalPaid: boolean; onClose: () => void;
}) {
  const key = useOperationKeys();
  const [reference, setReference] = useState('');
  const [date, setDate] = useState(today);
  const [reason, setReason] = useState('');
  const [procedure, setProcedure] = useState<InvoiceRequestCommandReconciliationKind>('cancellation');
  const base = { expectedVersion: request.version };
  const command = <T extends object>(action: string, extra: T) => { const input = { ...base, ...extra }; return { ...input, operationKey: key(action, input) }; };

  if (kind === 'submit') {
    return (
      <ActionModal heading="Submit for approval" request={request} primary="Submit for approval" onClose={onClose} run={() => submitExternalInvoiceRequest(request.id, command('submit', {}))}
        success={{ title: `${request.reference} submitted for approval`, subtitle: 'An approver checks the data and forwards it to wiRef.' }}>
        <p>The recipient details are complete. An approver now checks them, copies the data to wiRef and marks the request as forwarded. The purchase order requirement of the organization is checked now.</p>
        <p className="mj-secondary">While the request awaits approval only an approver can change it or send it back to you. The amount already paid ({formatCents(toCents(request.alreadyPaid))}) is frozen, so cash and card can no longer be added.</p>
      </ActionModal>
    );
  }
  if (kind === 'return') {
    return (
      <ActionModal heading="Return for correction" request={request} primary="Return for correction" disabled={reason.trim() === ''} onClose={onClose} run={() => returnExternalInvoiceRequest(request.id, command('return', { reason: reason.trim() }))}
        success={{ title: `${request.reference} returned`, subtitle: 'It is a draft again and shows your comment until it is submitted again.' }}>
        <p>The request goes back to the draft. Tell the person who prepared it what has to be corrected; they see your comment on the invoice.</p>
        <TextArea id="return-comment" labelText="What has to be corrected?" rows={3} maxCount={500} enableCounter value={reason} onChange={(event) => setReason(event.target.value)} />
      </ActionModal>
    );
  }
  if (kind === 'forward') {
    const complete = requestReadiness(request.details, customerKind, requirePurchaseOrder).every((item) => item.ok);
    return (
      <ActionModal heading="Approve and forward to wiRef" request={request} size="md" primary="Mark as forwarded to wiRef" secondary="Close" disabled={!complete} onClose={onClose} run={() => forwardExternalInvoiceRequest(request.id, command('forward', {}))}
        success={{ title: `${request.reference} issued`, subtitle: 'The order is paid: the invoice settles the open balance. The wiRef invoice number can be added later.' }}>
        <p>Copy the data below into wiRef. Makerspace Core does not send anything itself; marking the request as forwarded records that you did, approves it and settles the open balance of the order: the order becomes paid.</p>
        <CodeSnippet type="multi" feedback="Copied" copyButtonDescription="Copy the invoice data" wrapText maxCollapsedNumberOfRows={40}>{wiRefCopyText(request)}</CodeSnippet>
      </ActionModal>
    );
  }
  if (kind === 'cancel') {
    return (
      <ActionModal heading="Cancel this request" request={request} primary="Cancel request" secondary="Keep request" danger onClose={onClose} run={() => cancelExternalInvoiceRequest(request.id, command('cancel', { reason: reason.trim() }))}
        success={{ title: `${request.reference} cancelled`, subtitle: 'wiRef never saw it. You can request the invoice again.' }}>
        <p>{request.state === 'draft' ? 'This request was never submitted for approval.' : 'This request awaits approval and was not forwarded to wiRef.'} Cancelling it only affects Makerspace Core; nothing has to be undone in wiRef.</p>
        <TextArea id="cancel-reason" labelText="Reason (optional)" rows={2} maxCount={500} enableCounter value={reason} onChange={(event) => setReason(event.target.value)} />
      </ActionModal>
    );
  }
  if (kind === 'request-cancellation') {
    return (
      <ActionModal heading="Request cancellation" request={request} primary="Request cancellation" danger disabled={reason.trim() === ''} onClose={onClose} run={() => requestExternalInvoiceCancellation(request.id, command('request-cancellation', { reason: reason.trim() }))}
        success={{ title: 'Cancellation requested', subtitle: 'Once wiRef cancelled or corrected the invoice, confirm it here.' }}>
        <p>The request was forwarded to wiRef, so wiRef has to cancel or correct the invoice. Do that in your normal accounting process; then come back and confirm.</p>
        <p className="mj-secondary">Cash and card stay switched off for the order until the cancellation is confirmed.</p>
        {externalPaid && <InlineNotification kind="warning" lowContrast hideCloseButton title="The invoice settled the order as paid" subtitle="Confirming the cancellation reverses that payment and reopens the balance." />}
        <TextArea id="cancellation-reason" labelText="Why does it have to be cancelled?" rows={3} maxCount={500} enableCounter value={reason} onChange={(event) => setReason(event.target.value)} />
      </ActionModal>
    );
  }
  if (kind === 'confirm-cancellation') {
    const valid = reference.trim() !== '' && !!date;
    return (
      <ActionModal heading="Confirm the cancellation" request={request} primary="Confirm cancellation" disabled={!valid} onClose={onClose}
        run={() => confirmExternalInvoiceCancellation(request.id, command('confirm-cancellation', { reconciliationKind: procedure, externalReference: reference.trim(), effectiveAt: noonOf(date), reason: reason.trim() || undefined }))}
        success={{ title: `${request.reference} cancelled`, subtitle: 'The invoice payment was reversed and the order is open again. Request a new invoice or take a cash or card payment.' }}>
        <p>How did wiRef settle the invoice? Record the evidence so the accounting can be followed later. Confirming reverses the payment that the invoice made.</p>
        <TileGroup legend="What did wiRef do?" name="reconciliation-kind" valueSelected={procedure} onChange={(value) => setProcedure(value as InvoiceRequestCommandReconciliationKind)}>
          {reconciliationKinds.map((item) => (
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
      run={() => correctExternalInvoiceReference(request.id, command('reference', { externalReference: reference.trim(), reason: reason.trim() || undefined, effectiveAt: noonOf(date) }))}
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
