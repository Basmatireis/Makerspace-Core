import { useState } from 'react';
import { Checkbox, InlineNotification, Modal, RadioButton, RadioButtonGroup, Select, SelectItem, Stack, TextArea, TextInput } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { replaceOrder, reverseOrder } from '../../api/generated/orders/orders';
import type { Order, PaymentReversalInput } from '../../api/generated/models';
import { useNotify } from '../machinelogbook/shared/toasts';
import { reasonKindHelp } from './labels';
import { formatCents, toCents } from './money';
import { useOperationKeys } from './operations';
import { checkEntry, newPaymentEntry, PaymentEntryForm, toPaymentInputs } from './PaymentEntry';
import { allOrdersQuery, useFinanceMutation } from './queries';

/**
 * Corrects a finalized order: reverse all charges, or commit a linked replacement draft that takes over the remaining payments.
 * Whole receipts can be reversed in the same operation; nothing becomes customer credit.
 */
export function CorrectOrderModal({ order, canReversePayments, canCarry, initialReplacementId = '', onClose }: { order: Order; canReversePayments: boolean; canCarry: boolean; initialReplacementId?: string; onClose: () => void }) {
  const notify = useNotify();
  const key = useOperationKeys();
  const [mode, setMode] = useState<'reverse' | 'replace'>(canCarry && order.status === 'finalized' ? 'replace' : 'reverse');
  const [reason, setReason] = useState('');
  const [replacementId, setReplacementId] = useState(initialReplacementId);
  const [reverseIds, setReverseIds] = useState<string[]>([]);
  const [kind, setKind] = useState<PaymentReversalInput['reasonKind']>('refund');
  const [reference, setReference] = useState('');
  const [addPayment, setAddPayment] = useState(false);
  const [occurredAt] = useState(() => new Date().toISOString());
  const candidates = useQuery({ ...allOrdersQuery(), enabled: canCarry });
  const drafts = (candidates.data ?? []).filter((item) => item.status === 'draft' && item.replacesOrderId === order.id);
  const replacement = drafts.find((item) => item.id === replacementId);
  const [entry, setEntry] = useState(() => newPaymentEntry(0));
  const receipts = [...new Map(order.allocations.filter((entryItem) => entryItem.paymentId).map((entryItem) => [entryItem.paymentId!, entryItem.paymentReference])).entries()]
    .filter(([id]) => order.allocations.filter((entryItem) => entryItem.paymentId === id).reduce((total, entryItem) => total + toCents(entryItem.amount), 0) > 0);
  const reversals = (): PaymentReversalInput[] => reverseIds.map((paymentId) => ({ paymentId, reasonKind: kind, reason: reason.trim(), occurredAt, externalReference: reference.trim() || undefined }));
  const paymentDue = replacement ? toCents(replacement.totalAmount) : 0;
  const extra = checkEntry(entry, paymentDue, false);

  const mutation = useFinanceMutation(() => {
    if (mode === 'reverse') {
      const input = { expectedVersion: order.version, reason: reason.trim(), reversals: reversals() };
      return reverseOrder(order.id, { ...input, operationKey: key('reverse', input) });
    }
    const input = { expectedVersion: order.version, replacementOrderId: replacementId, expectedReplacementVersion: replacement!.version, reason: reason.trim(), reversals: reversals(), payments: addPayment ? toPaymentInputs(entry) : [] };
    return replaceOrder(order.id, { ...input, operationKey: key('replace', input) });
  }, (result) => {
    notify({ kind: 'success', title: mode === 'reverse' ? `${order.reference} reversed` : `${order.reference} replaced`, subtitle: mode === 'replace' ? `${result.reference} is charged now.` : undefined });
    onClose();
  });
  const ready = reason.trim() !== '' && (mode === 'reverse' || (!!replacement && (!addPayment || extra.ok)));
  const canReverse = order.status === 'finalized';
  const pending = mutation.isPending;

  return (
    <Modal
      open size="md" danger={mode === 'reverse'} modalHeading="Correct order" modalLabel={order.reference} primaryButtonText={pending ? 'Saving…' : mode === 'reverse' ? 'Reverse all charges' : 'Commit replacement'} secondaryButtonText="Cancel"
      primaryButtonDisabled={!ready || pending} preventCloseOnClickOutside onRequestClose={() => { if (!pending) onClose(); }} onRequestSubmit={() => mutation.mutate()}
    >
      <Stack gap={5}>
        <p>A finalized order is never edited. Reverse its charges, or replace it with a corrected order: the original is reversed at that moment and its remaining payments move over. No customer credit is created.</p>
        {canCarry && canReverse && (
          <RadioButtonGroup legendText="What do you want to do?" name="correct-mode" orientation="vertical" valueSelected={mode} onChange={(value) => setMode(value as 'reverse' | 'replace')}>
            <RadioButton id="correct-replace" value="replace" labelText="Commit a replacement draft" />
            <RadioButton id="correct-reverse" value="reverse" labelText="Reverse all charges" />
          </RadioButtonGroup>
        )}
        <TextArea id="order-reversal-reason" labelText="Reason" rows={2} maxCount={500} enableCounter value={reason} onChange={(event) => setReason(event.target.value)} />
        {mode === 'replace' && (
          <Select id="replacement-id" labelText="Replacement draft" value={replacementId} onChange={(event) => setReplacementId(event.target.value)}
            helperText={drafts.length === 0 ? 'Create a replacement draft first, edit it, then come back.' : undefined}>
            <SelectItem value="" text="Choose a replacement draft" />
            {drafts.map((item) => <SelectItem key={item.id} value={item.id} text={`${item.reference} · ${formatCents(toCents(item.totalAmount))}`} />)}
          </Select>
        )}
        {canReversePayments && receipts.length > 0 && (
          <>
            <p className="mj-secondary">Reverse whole receipts only for payments that were actually refunded or corrected. Other receipts stay with the order.</p>
            {receipts.map(([id, ref]) => (
              <Checkbox key={id} id={`reverse-${id}`} labelText={`Reverse ${ref} in the same operation`} checked={reverseIds.includes(id)}
                onChange={(_event, { checked }) => setReverseIds(checked ? [...reverseIds, id] : reverseIds.filter((item) => item !== id))} />
            ))}
            {reverseIds.length > 0 && (
              <>
                <Select id="correction-kind" labelText="Payment correction" value={kind} onChange={(event) => setKind(event.target.value as PaymentReversalInput['reasonKind'])} helperText={reasonKindHelp[kind].help}>
                  <SelectItem value="refund" text="Actual refund" />
                  <SelectItem value="recording_error" text="Recorded by mistake" />
                </Select>
                <TextInput id="correction-reference" labelText="Card correction reference" helperText="Required for card payments." value={reference} onChange={(event) => setReference(event.target.value)} />
              </>
            )}
          </>
        )}
        {mode === 'replace' && replacement && canCarry && (
          <>
            <Checkbox id="replacement-payment" labelText="Record an additional confirmed payment with the replacement" checked={addPayment} onChange={(_event, { checked }) => setAddPayment(checked)} />
            {addPayment && <PaymentEntryForm idPrefix="replace-pay" entry={entry.rows.length ? entry : newPaymentEntry(paymentDue)} onChange={setEntry} due={paymentDue} requireFull={false} disabled={pending} />}
          </>
        )}
        {mutation.error && <InlineNotification kind="error" lowContrast hideCloseButton title="Nothing was saved" subtitle={mutation.error.message} />}
      </Stack>
    </Modal>
  );
}
