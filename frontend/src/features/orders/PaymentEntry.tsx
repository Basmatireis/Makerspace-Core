/* eslint-disable react-refresh/only-export-components -- the entry form and its pure validation belong together */
import { useState } from 'react';
import {
  Button,
  IconButton,
  RadioTile,
  Select,
  SelectItem,
  Stack,
  Tag,
  TextInput,
  Tile,
  TileGroup,
} from '@carbon/react';
import { Add, Currency, Document, Edit, TrashCan, Wallet } from '@carbon/icons-react';
import type { PaymentInput } from '../../api/generated/models';
import { DateTimeInput } from '../../app/DateInput';
import { instantToZonedDateTimeValue, isZonedDateTimeValue, zonedDateTimeValueToISO } from '../../app/dateTime';
import { methodLabel } from './labels';
import { formatCents, fromCents, moneyInputText, parseMoneyInput } from './money';

// Shared by the Record payment modal, "Finalize and take payment" and the replacement commit: cash with a change calculator, card with the terminal
// reference, split payments and an editable payment time. The money is only recorded; the card terminal has already confirmed the card payment.

export type EntryMethod = 'cash' | 'card';
export type PaymentRow = {
  key: string;
  method: EntryMethod;
  amount: string;
  tendered: string;
  terminal: string;
  reference: string;
};
/** `invoice`: nothing is paid now; the order is invoiced via wiRef and counts as paid once the invoice is issued. */
export type PaymentPreset = 'cash' | 'card' | 'split' | 'invoice';
export type PaymentEntryState = { preset: PaymentPreset; rows: PaymentRow[]; time: string };

let counter = 0;
const row = (method: EntryMethod, amount: number | string = ''): PaymentRow => ({
  key: `row-${++counter}`,
  method,
  amount: typeof amount === 'number' ? (amount > 0 ? moneyInputText(amount) : '') : amount,
  tendered: '',
  terminal: '',
  reference: '',
});

export function newPaymentEntry(due: number): PaymentEntryState {
  return { preset: 'cash', rows: [row('cash', due)], time: instantToZonedDateTimeValue(new Date()) };
}

export function presetEntry(entry: PaymentEntryState, preset: PaymentPreset, due: number): PaymentEntryState {
  if (preset === 'split') return { ...entry, preset, rows: [row('cash', ''), row('card', due)] };
  if (preset === 'invoice') return { ...entry, preset, rows: [] };
  return { ...entry, preset, rows: [row(preset, due)] };
}

type RowErrors = { amount?: string; terminal?: string; reference?: string; tendered?: string };
export type EntryCheck = {
  rowErrors: Record<string, RowErrors>;
  covered: number;
  remaining: number;
  error: string | null;
  timeError: string | null;
  ok: boolean;
};

/** Validates the entry against what is due (in cents). `requireFull` demands that the whole amount is covered. */
export function checkEntry(entry: PaymentEntryState, due: number, requireFull: boolean): EntryCheck {
  const rowErrors: Record<string, RowErrors> = {};
  const seen = new Set<string>();
  let covered = 0;
  for (const item of entry.rows) {
    const errors: RowErrors = {};
    const amount = parseMoneyInput(item.amount);
    if (amount === null || amount <= 0)
      errors.amount = item.amount.trim() ? 'Enter an amount greater than zero, e.g. 12,50' : 'Enter the amount';
    else covered += amount;
    if (item.method === 'card') {
      if (!item.terminal.trim()) errors.terminal = 'Enter the terminal or provider';
      const reference = item.reference.trim();
      if (!reference) errors.reference = 'Enter the reference from the terminal slip';
      else if (seen.has(reference)) errors.reference = 'Each card payment needs its own reference';
      seen.add(reference);
    }
    if (item.method === 'cash' && item.tendered.trim()) {
      const tendered = parseMoneyInput(item.tendered);
      if (tendered === null) errors.tendered = 'Enter the amount handed over, e.g. 20';
      else if (amount !== null && tendered < amount) errors.tendered = `${formatCents(amount - tendered)} short`;
    }
    if (Object.keys(errors).length) rowErrors[item.key] = errors;
  }
  const remaining = due - covered;
  const timeError = isZonedDateTimeValue(entry.time) ? null : 'Enter a valid date and time';
  const error =
    covered > due
      ? `This is ${formatCents(covered - due)} more than the ${formatCents(due)} due.`
      : requireFull && remaining > 0
        ? `${formatCents(remaining)} of ${formatCents(due)} is not covered yet.`
        : null;
  return {
    rowErrors,
    covered,
    remaining,
    error,
    timeError,
    ok: Object.keys(rowErrors).length === 0 && !error && !timeError && covered > 0,
  };
}

export function toPaymentInputs(entry: PaymentEntryState): PaymentInput[] {
  const occurredAt = zonedDateTimeValueToISO(entry.time);
  return entry.rows.map((item) => ({
    method: item.method,
    amount: fromCents(parseMoneyInput(item.amount) ?? 0),
    occurredAt,
    ...(item.method === 'card'
      ? { externalSource: item.terminal.trim(), externalReference: item.reference.trim() }
      : {}),
  }));
}

/** Banknotes that cover an amount, as quick buttons for the change calculator. */
const notes = (amount: number) =>
  [...new Set([amount, ...[500, 1000, 2000, 5000, 10000, 20000].filter((note) => note >= amount).slice(0, 3)])].slice(
    0,
    4,
  );

function RowFields({
  item,
  idPrefix,
  errors,
  disabled,
  onChange,
}: {
  item: PaymentRow;
  idPrefix: string;
  errors: RowErrors;
  disabled: boolean;
  onChange: (patch: Partial<PaymentRow>) => void;
}) {
  const amount = parseMoneyInput(item.amount);
  const tendered = parseMoneyInput(item.tendered);
  const change =
    item.method === 'cash' && amount !== null && tendered !== null && tendered >= amount ? tendered - amount : null;
  return (
    <>
      {item.method === 'cash' && (
        <>
          <TextInput
            id={`${idPrefix}-${item.key}-tendered`}
            labelText="Handed over by the customer"
            placeholder="e.g. 20"
            inputMode="decimal"
            value={item.tendered}
            disabled={disabled}
            invalid={!!errors.tendered}
            invalidText={errors.tendered}
            helperText="Optional. Shows the change to give back."
            onChange={(event) => onChange({ tendered: event.target.value })}
          />
          {amount !== null && amount > 0 && (
            <div className="sales-tender-buttons" role="group" aria-label="Quick amounts handed over">
              {notes(amount).map((note, index) => (
                <Button
                  key={note}
                  kind="tertiary"
                  size="sm"
                  disabled={disabled}
                  onClick={() => onChange({ tendered: moneyInputText(note) })}
                >
                  {index === 0 ? 'Exact' : formatCents(note)}
                </Button>
              ))}
            </div>
          )}
          {change !== null && (
            <Tile className="sales-change">
              <span className="mj-secondary">Change to give back</span>
              <strong className="sales-change__amount">{formatCents(change)}</strong>
            </Tile>
          )}
        </>
      )}
      {item.method === 'card' && (
        <>
          <TextInput
            id={`${idPrefix}-${item.key}-terminal`}
            labelText="Terminal or provider"
            value={item.terminal}
            disabled={disabled}
            invalid={!!errors.terminal}
            invalidText={errors.terminal}
            onChange={(event) => onChange({ terminal: event.target.value })}
          />
          <TextInput
            id={`${idPrefix}-${item.key}-reference`}
            labelText="Terminal transaction reference"
            value={item.reference}
            disabled={disabled}
            invalid={!!errors.reference}
            invalidText={errors.reference}
            helperText="From the slip. Record only a payment the terminal has already confirmed."
            onChange={(event) => onChange({ reference: event.target.value })}
          />
        </>
      )}
    </>
  );
}

export function PaymentEntryForm({
  idPrefix,
  entry,
  onChange,
  due,
  requireFull,
  disabled = false,
  allowInvoice = false,
}: {
  idPrefix: string;
  entry: PaymentEntryState;
  onChange: (entry: PaymentEntryState) => void;
  due: number;
  requireFull: boolean;
  disabled?: boolean;
  /** Offers "Invoice": no payment now, an invoice is requested from wiRef instead. */
  allowInvoice?: boolean;
}) {
  const [editTime, setEditTime] = useState(false);
  const check = checkEntry(entry, due, requireFull);
  const patchRow = (key: string, patch: Partial<PaymentRow>) =>
    onChange({ ...entry, rows: entry.rows.map((item) => (item.key === key ? { ...item, ...patch } : item)) });
  const split = entry.preset === 'split';
  const fillRemaining = (key: string) =>
    patchRow(key, {
      amount: moneyInputText(
        Math.max(
          0,
          due -
            entry.rows
              .filter((item) => item.key !== key)
              .reduce((total, item) => total + (parseMoneyInput(item.amount) ?? 0), 0),
        ),
      ),
    });

  return (
    <Stack gap={5}>
      <TileGroup
        legend="Payment method"
        name={`${idPrefix}-preset`}
        valueSelected={entry.preset}
        disabled={disabled}
        onChange={(value) => onChange(presetEntry(entry, value as PaymentPreset, due))}
        className="sales-method-tiles"
      >
        <RadioTile id={`${idPrefix}-cash`} value="cash">
          <span className="sales-method-tile">
            <Currency size={20} />
            Cash
          </span>
        </RadioTile>
        <RadioTile id={`${idPrefix}-card`} value="card">
          <span className="sales-method-tile">
            <Wallet size={20} />
            Card
          </span>
        </RadioTile>
        <RadioTile id={`${idPrefix}-split`} value="split">
          <span className="sales-method-tile">
            <Add size={20} />
            Split
          </span>
        </RadioTile>
        {allowInvoice && (
          <RadioTile id={`${idPrefix}-invoice`} value="invoice">
            <span className="sales-method-tile">
              <Document size={20} />
              Invoice
            </span>
          </RadioTile>
        )}
      </TileGroup>
      {entry.preset === 'invoice' && (
        <Tile className="sales-invoice-choice">
          <p>
            <strong>No payment now.</strong> An invoice is requested from wiRef for {formatCents(due)}.
          </p>
          <p className="mj-secondary">
            Once the invoice is approved and forwarded, it settles the order as paid. You check the recipient details in
            the next step.
          </p>
        </Tile>
      )}
      {entry.preset !== 'invoice' && (
        <>
          {entry.rows.map((item, index) => {
            const errors = check.rowErrors[item.key] ?? {};
            return (
              <div
                key={item.key}
                className={split ? 'sales-payment-row sales-payment-row--split' : 'sales-payment-row'}
              >
                {split && (
                  <div className="sales-payment-row__head">
                    <Select
                      id={`${idPrefix}-${item.key}-method`}
                      labelText={`Payment ${index + 1}`}
                      value={item.method}
                      disabled={disabled}
                      onChange={(event) =>
                        patchRow(item.key, { method: event.target.value as EntryMethod, reference: '', tendered: '' })
                      }
                    >
                      {(['cash', 'card'] as EntryMethod[]).map((method) => (
                        <SelectItem key={method} value={method} text={methodLabel(method)} />
                      ))}
                    </Select>
                    {entry.rows.length > 2 && (
                      <IconButton
                        label="Remove this payment"
                        kind="ghost"
                        size="md"
                        disabled={disabled}
                        onClick={() =>
                          onChange({ ...entry, rows: entry.rows.filter((other) => other.key !== item.key) })
                        }
                      >
                        <TrashCan />
                      </IconButton>
                    )}
                  </div>
                )}
                <div className="sales-amount-line">
                  <TextInput
                    id={`${idPrefix}-${item.key}-amount`}
                    labelText={split ? `Amount of payment ${index + 1} (€)` : 'Amount (€)'}
                    inputMode="decimal"
                    value={item.amount}
                    disabled={disabled}
                    invalid={!!errors.amount}
                    invalidText={errors.amount}
                    onChange={(event) => patchRow(item.key, { amount: event.target.value })}
                  />
                  {split && (
                    <Button kind="ghost" size="md" disabled={disabled} onClick={() => fillRemaining(item.key)}>
                      Fill remaining
                    </Button>
                  )}
                </div>
                <RowFields
                  item={item}
                  idPrefix={idPrefix}
                  errors={errors}
                  disabled={disabled}
                  onChange={(patch) => patchRow(item.key, patch)}
                />
              </div>
            );
          })}
          {split && (
            <Button
              kind="ghost"
              size="sm"
              renderIcon={Add}
              disabled={disabled}
              onClick={() => onChange({ ...entry, rows: [...entry.rows, row('cash', '')] })}
            >
              Add another payment
            </Button>
          )}
          <div className="sales-cover" aria-live="polite">
            <span className="mj-secondary">Covered</span>
            <strong>
              {formatCents(check.covered)} of {formatCents(due)}
            </strong>
            {check.remaining === 0 && check.covered > 0 && (
              <Tag type="green" size="sm">
                Complete
              </Tag>
            )}
            {check.remaining > 0 && (
              <Tag type={requireFull ? 'red' : 'gray'} size="sm">
                {formatCents(check.remaining)} left
              </Tag>
            )}
            {check.remaining < 0 && (
              <Tag type="red" size="sm">
                {formatCents(-check.remaining)} too much
              </Tag>
            )}
          </div>
          {check.error && check.covered > 0 && check.remaining < 0 && (
            <p className="sales-field-error">{check.error}</p>
          )}
          <div>
            {editTime ? (
              <DateTimeInput
                id={`${idPrefix}-time`}
                labelText="Payment"
                value={entry.time}
                onChange={(time) => onChange({ ...entry, time })}
                required
              />
            ) : (
              <div className="mj-inline">
                <span className="mj-secondary">Paid just now</span>
                <Button kind="ghost" size="sm" renderIcon={Edit} disabled={disabled} onClick={() => setEditTime(true)}>
                  Change time
                </Button>
              </div>
            )}
            {check.timeError && <p className="sales-field-error">{check.timeError}</p>}
          </div>
        </>
      )}
    </Stack>
  );
}
