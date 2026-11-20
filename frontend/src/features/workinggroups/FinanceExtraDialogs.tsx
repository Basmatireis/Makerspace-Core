import { useState } from 'react';
import { Checkbox, Select, SelectItem, TextInput } from '@carbon/react';
import type { WorkingGroupPurchase, WorkingGroupSummary } from '../../api/generated/models';
import {
  createWorkingGroupBooking,
  redactWorkingGroupPurchase,
} from '../../api/generated/working-groups/working-groups';
import { DateInput } from '../../app/DateInput';
import { useNotify } from '../../app/toasts';
import { fromCents, parseMoneyInput } from '../orders/money';
import { Shell } from './PurchaseDialogs';
import { todayOn } from './taskModel';
import { taskErrorText, useWgMutation } from './useWgMutation';

/** A cost booked directly against a group's budget in a period. */
export function BookCostDialog({
  groups,
  initialGroupId,
  periodId,
  onClose,
}: {
  groups: readonly WorkingGroupSummary[];
  initialGroupId: string;
  periodId: string;
  onClose: () => void;
}) {
  const notify = useNotify();
  const [groupId, setGroupId] = useState(initialGroupId || groups[0]?.id || '');
  const [text, setText] = useState('');
  const [amount, setAmount] = useState('');
  const [bookedOn, setBookedOn] = useState(todayOn());
  const [touched, setTouched] = useState(false);
  const cents = parseMoneyInput(amount);
  const textError = text.trim() === '' ? 'Enter what it was for.' : undefined;
  const amountError = cents === null || cents <= 0 ? 'Enter an amount.' : undefined;
  const book = useWgMutation(() =>
    createWorkingGroupBooking({
      groupId,
      periodId,
      text: text.trim(),
      amount: fromCents(cents ?? 0),
      bookedOn,
    }),
  );
  return (
    <Shell
      heading="Book a cost"
      primary="Book"
      pending={book.isPending}
      error={book.isError ? taskErrorText(book.error, 'Check the fields and try again.') : undefined}
      onClose={onClose}
      onSubmit={() => {
        setTouched(true);
        if (textError || amountError || bookedOn === '') return;
        book.mutate(undefined, {
          onSuccess: () => {
            notify({ kind: 'success', title: 'Cost booked' });
            onClose();
          },
        });
      }}
    >
      <Select id="wg-book-group" labelText="Working group" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
        {groups.map((group) => (
          <SelectItem key={group.id} value={group.id} text={group.name} />
        ))}
      </Select>
      <TextInput
        id="wg-book-text"
        labelText="Text"
        value={text}
        invalid={touched && Boolean(textError)}
        invalidText={textError}
        onChange={(event) => setText(event.target.value)}
      />
      <TextInput
        id="wg-book-amount"
        labelText="Amount"
        inputMode="decimal"
        value={amount}
        invalid={touched && Boolean(amountError)}
        invalidText={amountError}
        onChange={(event) => setAmount(event.target.value)}
      />
      <DateInput id="wg-book-date" labelText="Date" value={bookedOn} onChange={setBookedOn} />
    </Shell>
  );
}

/** Finance managers remove the personal data of a purchase: its text and link, its files, or both. */
export function RedactPurchaseDialog({ purchase, onClose }: { purchase: WorkingGroupPurchase; onClose: () => void }) {
  const [text, setText] = useState(false);
  const [files, setFiles] = useState(false);
  const [touched, setTouched] = useState(false);
  const redact = useWgMutation(() =>
    redactWorkingGroupPurchase(purchase.id, { expectedVersion: purchase.version, text, files }),
  );
  return (
    <Shell
      heading="Remove personal data"
      primary="Remove"
      pending={redact.isPending}
      error={redact.isError ? taskErrorText(redact.error, 'It could not be removed.') : undefined}
      onClose={onClose}
      onSubmit={() => {
        setTouched(true);
        if (text || files) redact.mutate(undefined, { onSuccess: onClose });
      }}
    >
      <p>{purchase.item}</p>
      <Checkbox
        id="wg-redact-text"
        labelText="Item text and link"
        checked={text}
        onChange={(_, d) => setText(d.checked)}
      />
      <Checkbox
        id="wg-redact-files"
        labelText="Offer and receipt files"
        checked={files}
        onChange={(_, d) => setFiles(d.checked)}
      />
      {touched && !text && !files && <p className="wg-buyrow__error">Choose what to remove.</p>}
      <p className="wg-muted">This cannot be undone. No figure changes.</p>
    </Shell>
  );
}
