import { useState } from 'react';
import { InlineNotification, Modal, Select, SelectItem, Stack, TextArea, TextInput } from '@carbon/react';
import { DateTimeInput } from '../../../../app/DateInput';
import { instantToZonedDateTimeValue, isZonedDateTimeValue, zonedDateTimeValueToISO } from '../../../../app/dateTime';
import { useStore } from '../../store';
import { formatEur, parseMoney } from '../format';
import { cashMovementKindLabel, cashMovementReasons, CURRENT_ACTOR } from '../labels';
import { cashInRegister } from '../logic';
import { ProposedTag } from '../status';
import { useSalesMutation } from '../useSalesMutation';
import type { CashMovementKind, CashMovementReason } from '../types';

/** [proposed] Money taken out of the register (a withdrawal) or added to it (a deposit, for example a change float). Not tied to an order. */
export function CashMovementModal({ kind, onClose }: { kind: CashMovementKind; onClose: () => void }) {
  const store = useStore();
  const [amount, setAmount] = useState('');
  const [time, setTime] = useState(() => instantToZonedDateTimeValue(new Date()));
  const [reason, setReason] = useState<CashMovementReason>(kind === 'withdrawal' ? 'bank_deposit' : 'float');
  const [note, setNote] = useState('');
  const parsed = parseMoney(amount);
  const timeOk = isZonedDateTimeValue(time);
  const held = cashInRegister(store.payments, store.cashMovements).expected;
  const tooMuch = kind === 'withdrawal' && parsed !== null && parsed > held;
  const noteMissing = reason === 'other' && note.trim() === '';
  const valid = parsed !== null && parsed > 0 && timeOk && !tooMuch && !noteMissing && note.trim().length <= 500;
  const { mutate, pending, error } = useSalesMutation(() => store.recordCashMovement({ kind, amount: parsed ?? 0, occurredAt: zonedDateTimeValueToISO(time), reason, note }));
  const submit = async () => {
    const result = await mutate();
    if (!result.ok) return;
    store.notify({ kind: 'success', title: kind === 'withdrawal' ? 'Cash withdrawal recorded' : 'Cash deposit recorded', subtitle: `${formatEur(parsed)} ${kind === 'withdrawal' ? 'taken out of' : 'added to'} the register.` });
    onClose();
  };
  return (
    <Modal open size="sm" modalHeading={kind === 'withdrawal' ? 'Record cash withdrawal' : 'Record cash deposit'} modalLabel="Cash register" primaryButtonText={pending ? 'Saving…' : 'Record'} secondaryButtonText="Cancel" primaryButtonDisabled={!valid || pending}
      preventCloseOnClickOutside onRequestClose={() => { if (!pending) onClose(); }} onRequestSubmit={() => { void submit(); }}>
      <Stack gap={5}>
        <p className="mj-inline">{kind === 'withdrawal' ? 'Money taken out of the register, for example to bring it to the bank.' : 'Money added to the register, for example a change float.'} <ProposedTag hint="Needs cash movements on the backend" /></p>
        <TextInput id="movement-amount" labelText="Amount (€)" inputMode="decimal" value={amount} disabled={pending} invalid={(amount !== '' && (parsed === null || parsed <= 0)) || tooMuch}
          invalidText={tooMuch ? `The register should only hold ${formatEur(held)}` : 'Enter an amount greater than zero, e.g. 50'} helperText={kind === 'withdrawal' ? `The register should hold ${formatEur(held)} now.` : undefined} onChange={(event) => setAmount(event.target.value)} />
        <DateTimeInput id="movement-time" labelText={kind === 'withdrawal' ? 'Taken out' : 'Added'} value={time} onChange={setTime} required />
        {!timeOk && <p className="sales-field-error">Enter a valid date and time</p>}
        <Select id="movement-reason" labelText="Reason" value={reason} disabled={pending} onChange={(event) => setReason(event.target.value as CashMovementReason)}>
          {cashMovementReasons.map((item) => <SelectItem key={item.id} value={item.id} text={item.label} />)}
        </Select>
        <TextArea id="movement-note" labelText={reason === 'other' ? 'Note (required)' : 'Note (optional)'} rows={2} maxCount={500} enableCounter value={note} disabled={pending} invalid={noteMissing && note !== ''} invalidText="Say what the money was for"
          helperText="Shown in the cashbook. Do not add personal data." onChange={(event) => setNote(event.target.value)} />
        <p className="mj-secondary">Recorded by {CURRENT_ACTOR} as a {cashMovementKindLabel(kind).toLowerCase()}.</p>
        {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Nothing was saved" subtitle={error} />}
      </Stack>
    </Modal>
  );
}
