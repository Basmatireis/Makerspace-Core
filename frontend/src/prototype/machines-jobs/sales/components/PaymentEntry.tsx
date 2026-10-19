/* eslint-disable react-refresh/only-export-components -- the entry form and its pure validation belong together */
import { useState } from 'react';
import { Button, IconButton, Select, SelectItem, Stack, Tag, TextInput, Tile, TileGroup, RadioTile } from '@carbon/react';
import { Add, Currency, Document, TrashCan, Wallet, Edit } from '@carbon/icons-react';
import { DateTimeInput } from '../../../../app/DateInput';
import { instantToZonedDateTimeValue, isZonedDateTimeValue, zonedDateTimeValueToISO } from '../../../../app/dateTime';
import { formatEur, moneyText, parseMoney, round2 } from '../format';
import { methodLabel, terminals } from '../labels';
import { sum } from '../logic';
import type { Payment, PaymentInput, PaymentMethod } from '../types';

// Shared by the Record payment modal, "Finalize and take payment", the refund correction and the replacement commit:
// cash with change calculator, card with terminal reference, split payments and an editable payment time.

export type PaymentRow = { key: string; method: PaymentMethod; amount: string; tendered: string; terminal: string; reference: string };
/** `invoice`: nothing is paid now; the order is invoiced via wiRef and paid by bank transfer later. */
export type PaymentPreset = 'cash' | 'card' | 'split' | 'invoice';
export type PaymentEntryState = { preset: PaymentPreset; rows: PaymentRow[]; time: string };

let counter = 0;
const row = (method: PaymentMethod, amount: number | string = ''): PaymentRow => ({
  key: `row-${++counter}`, method, amount: typeof amount === 'number' ? (amount > 0 ? moneyText(amount) : '') : amount, tendered: '', terminal: method === 'card' ? terminals[0] : '', reference: '',
});

export function newPaymentEntry(due: number, methods: PaymentMethod[] = ['cash', 'card']): PaymentEntryState {
  const first = methods[0];
  return { preset: first === 'card' ? 'card' : 'cash', rows: [row(first, due)], time: instantToZonedDateTimeValue(new Date()) };
}

export function presetEntry(entry: PaymentEntryState, preset: PaymentPreset, due: number): PaymentEntryState {
  if (preset === 'split') return { ...entry, preset, rows: [row('cash', ''), row('card', due)] };
  if (preset === 'invoice') return { ...entry, preset, rows: [] };
  return { ...entry, preset, rows: [row(preset, due)] };
}

type RowErrors = { amount?: string; terminal?: string; reference?: string; tendered?: string };
export type EntryCheck = { rowErrors: Record<string, RowErrors>; covered: number; remaining: number; error: string | null; timeError: string | null; ok: boolean };

/** `existingReferences` maps already recorded card transaction references to the payment that holds them. */
export function checkEntry(entry: PaymentEntryState, due: number, requireFull: boolean, existingReferences: Map<string, string>): EntryCheck {
  const rowErrors: Record<string, RowErrors> = {};
  const seen = new Set<string>();
  let covered = 0;
  for (const item of entry.rows) {
    const errors: RowErrors = {};
    const amount = parseMoney(item.amount);
    if (amount === null || amount <= 0) errors.amount = item.amount.trim() ? 'Enter an amount greater than zero, e.g. 12,50' : 'Enter the amount';
    else covered = round2(covered + amount);
    if (item.method === 'card') {
      if (!item.terminal) errors.terminal = 'Choose the terminal';
      const reference = item.reference.trim();
      if (!reference) errors.reference = 'Enter the reference from the terminal slip';
      else if (existingReferences.has(reference)) errors.reference = `Already recorded as ${existingReferences.get(reference)}`;
      else if (seen.has(reference)) errors.reference = 'Each card payment needs its own reference';
      seen.add(reference);
    }
    if (item.method === 'external' && !item.reference.trim()) errors.reference = 'Enter the wiRef confirmation reference';
    if (item.method === 'cash' && item.tendered.trim()) {
      const tendered = parseMoney(item.tendered);
      if (tendered === null) errors.tendered = 'Enter the amount handed over, e.g. 20';
      else if (amount !== null && tendered < amount) errors.tendered = `${formatEur(round2(amount - tendered))} short`;
    }
    if (Object.keys(errors).length) rowErrors[item.key] = errors;
  }
  const remaining = round2(due - covered);
  const timeError = isZonedDateTimeValue(entry.time) ? null : 'Enter a valid date and time';
  const error = covered > due ? `This is ${formatEur(round2(covered - due))} more than the ${formatEur(due)} due.`
    : requireFull && remaining > 0 ? `${formatEur(remaining)} of ${formatEur(due)} is not covered yet.` : null;
  return { rowErrors, covered, remaining, error, timeError, ok: Object.keys(rowErrors).length === 0 && !error && !timeError && covered > 0 };
}

export function toPaymentInputs(entry: PaymentEntryState): PaymentInput[] {
  const occurredAt = zonedDateTimeValueToISO(entry.time);
  return entry.rows.map((item) => ({ method: item.method, amount: parseMoney(item.amount) ?? 0, occurredAt, terminal: item.method === 'card' ? item.terminal : item.method === 'external' ? 'wiRef' : '', transactionReference: item.reference.trim() }));
}

export function existingReferences(payments: Payment[]) {
  const reversed = new Set(payments.filter((payment) => payment.entryKind === 'reversal').map((payment) => payment.reversesPaymentId));
  return new Map(payments.filter((payment) => payment.entryKind === 'receipt' && payment.method === 'card' && !reversed.has(payment.id)).map((payment) => [payment.transactionReference, payment.reference]));
}

/** Banknotes that cover an amount, as quick buttons for the change calculator. */
const notes = (amount: number) => [...new Set([round2(amount), ...[5, 10, 20, 50, 100, 200].filter((note) => note >= amount).slice(0, 3)])].slice(0, 4);

function RowFields({ item, check, idPrefix, disabled, onChange }: { item: PaymentRow; check: EntryCheck; idPrefix: string; disabled: boolean; onChange: (patch: Partial<PaymentRow>) => void }) {
  const errors = check.rowErrors[item.key] ?? {};
  const amount = parseMoney(item.amount);
  const tendered = parseMoney(item.tendered);
  const change = item.method === 'cash' && amount !== null && tendered !== null && tendered >= amount ? round2(tendered - amount) : null;
  return (
    <>
      {item.method === 'cash' && (
        <>
          <TextInput
            id={`${idPrefix}-${item.key}-tendered`} labelText="Handed over by the customer" placeholder="e.g. 20" inputMode="decimal" value={item.tendered} disabled={disabled}
            invalid={!!errors.tendered} invalidText={errors.tendered} helperText="Optional. Shows the change to give back." onChange={(event) => onChange({ tendered: event.target.value })}
          />
          {amount !== null && amount > 0 && (
            <div className="sales-tender-buttons" role="group" aria-label="Quick amounts handed over">
              {notes(amount).map((note, index) => <Button key={note} kind="tertiary" size="sm" disabled={disabled} onClick={() => onChange({ tendered: moneyText(note) })}>{index === 0 ? 'Exact' : formatEur(note)}</Button>)}
            </div>
          )}
          {change !== null && <Tile className="sales-change"><span className="mj-secondary">Change to give back</span><strong className="sales-change__amount">{formatEur(change)}</strong></Tile>}
        </>
      )}
      {item.method === 'card' && (
        <>
          <Select id={`${idPrefix}-${item.key}-terminal`} labelText="Terminal" value={item.terminal} disabled={disabled} invalid={!!errors.terminal} invalidText={errors.terminal} onChange={(event) => onChange({ terminal: event.target.value })}>
            {terminals.map((terminal) => <SelectItem key={terminal} value={terminal} text={terminal} />)}
          </Select>
          <TextInput
            id={`${idPrefix}-${item.key}-reference`} labelText="Terminal transaction reference" value={item.reference} disabled={disabled} invalid={!!errors.reference} invalidText={errors.reference}
            helperText="From the slip. Record only a payment the terminal has already confirmed." onChange={(event) => onChange({ reference: event.target.value })}
          />
        </>
      )}
      {item.method === 'external' && (
        <TextInput id={`${idPrefix}-${item.key}-reference`} labelText="wiRef payment confirmation reference" value={item.reference} disabled={disabled} invalid={!!errors.reference} invalidText={errors.reference} onChange={(event) => onChange({ reference: event.target.value })} />
      )}
    </>
  );
}

export function PaymentEntryForm({ idPrefix, entry, onChange, due, requireFull, payments, methods = ['cash', 'card'], disabled = false, allowInvoice = false }: {
  idPrefix: string; entry: PaymentEntryState; onChange: (entry: PaymentEntryState) => void; due: number; requireFull: boolean; payments: Payment[]; methods?: PaymentMethod[]; disabled?: boolean;
  /** Offers "Invoice": finalize without a payment and request an invoice from wiRef instead. */
  allowInvoice?: boolean;
}) {
  const [editTime, setEditTime] = useState(false);
  const check = checkEntry(entry, due, requireFull, existingReferences(payments));
  const patchRow = (key: string, patch: Partial<PaymentRow>) => onChange({ ...entry, rows: entry.rows.map((item) => item.key === key ? { ...item, ...patch } : item) });
  const external = methods.length === 1 && methods[0] === 'external';
  const split = entry.preset === 'split';
  const fillRemaining = (key: string) => patchRow(key, { amount: moneyText(Math.max(0, round2(due - sum(entry.rows.filter((item) => item.key !== key).map((item) => parseMoney(item.amount) ?? 0))))) });

  return (
    <Stack gap={5}>
      {!external && (
        <TileGroup legend="Payment method" name={`${idPrefix}-preset`} valueSelected={entry.preset} disabled={disabled} onChange={(value) => onChange(presetEntry(entry, value as PaymentPreset, due))} className="sales-method-tiles">
          <RadioTile id={`${idPrefix}-cash`} value="cash"><span className="sales-method-tile"><Currency size={20} />Cash</span></RadioTile>
          <RadioTile id={`${idPrefix}-card`} value="card"><span className="sales-method-tile"><Wallet size={20} />Card</span></RadioTile>
          <RadioTile id={`${idPrefix}-split`} value="split"><span className="sales-method-tile"><Add size={20} />Split</span></RadioTile>
          {allowInvoice && <RadioTile id={`${idPrefix}-invoice`} value="invoice"><span className="sales-method-tile"><Document size={20} />Invoice</span></RadioTile>}
        </TileGroup>
      )}
      {entry.preset === 'invoice' && (
        <Tile className="sales-invoice-choice">
          <p><strong>No payment now.</strong> The order is finalized and an invoice is requested from wiRef for {formatEur(due)}.</p>
          <p className="mj-secondary">The customer pays by bank transfer to the HTU account once the invoice is issued. You check the recipient details in the next step.</p>
        </Tile>
      )}
      {entry.preset !== 'invoice' && <>
      {entry.rows.map((item, index) => {
        const errors = check.rowErrors[item.key] ?? {};
        return (
          <div key={item.key} className={split ? 'sales-payment-row sales-payment-row--split' : 'sales-payment-row'}>
            {split && (
              <div className="sales-payment-row__head">
                <Select id={`${idPrefix}-${item.key}-method`} labelText={`Payment ${index + 1}`} value={item.method} disabled={disabled} onChange={(event) => patchRow(item.key, { method: event.target.value as PaymentMethod, terminal: event.target.value === 'card' ? terminals[0] : '', reference: '', tendered: '' })}>
                  {methods.map((method) => <SelectItem key={method} value={method} text={methodLabel(method)} />)}
                </Select>
                {entry.rows.length > 2 && <IconButton label="Remove this payment" kind="ghost" size="md" disabled={disabled} onClick={() => onChange({ ...entry, rows: entry.rows.filter((other) => other.key !== item.key) })}><TrashCan /></IconButton>}
              </div>
            )}
            <div className="sales-amount-line">
              <TextInput id={`${idPrefix}-${item.key}-amount`} labelText={split ? `Amount of payment ${index + 1} (€)` : 'Amount (€)'} inputMode="decimal" value={item.amount} disabled={disabled} invalid={!!errors.amount} invalidText={errors.amount} onChange={(event) => patchRow(item.key, { amount: event.target.value })} />
              {split && <Button kind="ghost" size="md" disabled={disabled} onClick={() => fillRemaining(item.key)}>Fill remaining</Button>}
            </div>
            <RowFields item={item} check={check} idPrefix={idPrefix} disabled={disabled} onChange={(patch) => patchRow(item.key, patch)} />
          </div>
        );
      })}
      {split && <Button kind="ghost" size="sm" renderIcon={Add} disabled={disabled} onClick={() => onChange({ ...entry, rows: [...entry.rows, row('cash', '')] })}>Add another payment</Button>}
      <div className="sales-cover" aria-live="polite">
        <span className="mj-secondary">Covered</span>
        <strong>{formatEur(check.covered)} of {formatEur(due)}</strong>
        {check.remaining === 0 && check.covered > 0 && <Tag type="green" size="sm">Complete</Tag>}
        {check.remaining > 0 && <Tag type={requireFull ? 'red' : 'gray'} size="sm">{formatEur(check.remaining)} left</Tag>}
        {check.remaining < 0 && <Tag type="red" size="sm">{formatEur(-check.remaining)} too much</Tag>}
      </div>
      {check.error && check.covered > 0 && check.remaining < 0 && <p className="sales-field-error">{check.error}</p>}
      <div>
        {editTime ? (
          <DateTimeInput id={`${idPrefix}-time`} labelText="Payment" value={entry.time} onChange={(time) => onChange({ ...entry, time })} required />
        ) : (
          <div className="mj-inline"><span className="mj-secondary">Paid just now</span><Button kind="ghost" size="sm" renderIcon={Edit} disabled={disabled} onClick={() => setEditTime(true)}>Change time</Button></div>
        )}
        {check.timeError && <p className="sales-field-error">{check.timeError}</p>}
      </div>
      </>}
    </Stack>
  );
}
