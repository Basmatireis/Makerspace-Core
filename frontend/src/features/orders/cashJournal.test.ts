import { describe, expect, it } from 'vitest';
import type { CashJournalEntry, CashRegister } from '../../api/generated/models';
import {
  checkCount,
  differenceText,
  journalDayText,
  journalEntryText,
  justAfter,
  registerDerivation,
} from './cashJournal';
import { cashbookExport, exportRangeError } from './ExportCashbookModal';
import { dayRangeText, periodInstants, resolvePeriod } from './period';

describe('period', () => {
  const now = new Date('2026-11-03T10:00:00Z');
  it('resolves today, the week from Monday and the month as whole days', () => {
    expect(resolvePeriod('today', '', '', now)).toMatchObject({
      from: '2026-11-03',
      to: '2026-11-03',
      note: '3 Nov 2026',
    });
    expect(resolvePeriod('week', '', '', now)).toMatchObject({ from: '2026-11-02', to: '2026-11-03' });
    expect(resolvePeriod('month', '', '', now)).toMatchObject({ label: 'This month', note: '1 – 3 Nov 2026' });
  });
  it('treats all time as unbounded and an invalid custom range as all time', () => {
    expect(resolvePeriod('all', '', '', now)).toMatchObject({ from: null, to: null, note: 'up to now' });
    expect(resolvePeriod('custom', '2026-11-05', '2026-11-01', now).preset).toBe('all');
    expect(resolvePeriod('custom', '2026-10-28', '2026-11-02', now)).toMatchObject({
      label: 'Custom range',
      note: '28 Oct – 2 Nov 2026',
    });
  });
  it('names ranges across years and turns days into Vienna instants', () => {
    expect(dayRangeText('2025-12-28', '2026-01-03')).toBe('28 Dec 2025 – 3 Jan 2026');
    expect(periodInstants({ from: '2026-11-01', to: '2026-11-03' })).toEqual({
      from: '2026-10-31T23:00:00.000Z',
      to: '2026-11-03T23:00:00.000Z',
    });
    expect(periodInstants({ from: null, to: null })).toEqual({});
  });
});

describe('register panel', () => {
  it('derives the expected cash from receipts, refunds and corrections, withdrawals and deposits', () => {
    const register = {
      receipts: '115.70',
      refunds: '0.00',
      corrections: '2.50',
      refundsAndCorrections: '2.50',
      withdrawals: '80.00',
      deposits: '50.00',
      expected: '83.20',
      to: null,
      lastCount: null,
    } as CashRegister;
    expect(registerDerivation(register).map(({ label, cents, total }) => ({ label, cents, total }))).toEqual([
      { label: 'Cash receipts', cents: 11570, total: undefined },
      { label: '+ Deposits', cents: 5000, total: undefined },
      { label: '− Refunds and payment corrections', cents: 0, total: undefined },
      { label: '− Withdrawals', cents: 8000, total: undefined },
      { label: '− Count differences', cents: 250, total: undefined },
      { label: '= Expected', cents: 8320, total: true },
    ]);
    // A net surplus adds to the register; no difference means no line.
    expect(registerDerivation({ ...register, corrections: '-4.00' }).map((line) => line.label)).toContain(
      '+ Count differences',
    );
    expect(registerDerivation({ ...register, corrections: '0.00' }).map((line) => line.label)).not.toContain(
      '− Count differences',
    );
  });
  it('words a count difference', () => {
    expect(differenceText(0)).toBe('Matches expected');
    expect(differenceText(-250)).toBe('−€2.50 short');
    expect(differenceText(100)).toBe('+€1.00 over');
  });
});

describe('journal', () => {
  const entry = (extra: Partial<CashJournalEntry>) =>
    ({
      source: 'payment',
      kind: 'receipt',
      order: null,
      paymentReason: '',
      movementReason: null,
      note: '',
      count: null,
      ...extra,
    }) as CashJournalEntry;
  it('heads a day with its weekday and describes entries', () => {
    expect(journalDayText('2026-10-31')).toBe('Saturday 31 October');
    expect(
      journalEntryText(entry({ order: { id: 'o', reference: 'O-2026-000103', customerName: 'Sara Novak' } })),
    ).toBe('O-2026-000103 · Sara Novak');
    expect(
      journalEntryText(
        entry({ source: 'movement', kind: 'withdrawal', movementReason: 'bank_deposit', note: 'Slip 7' }),
      ),
    ).toBe('Bank deposit · Slip 7');
    expect(
      journalEntryText(
        entry({
          source: 'count',
          kind: 'count',
          count: {
            id: 'k',
            reference: 'K-2026-0001',
            countedAmount: '83.20',
            expectedAmount: '85.70',
            difference: '-2.50',
            reason: 'counting_error',
          },
        }),
      ),
    ).toBe('Counted €83.20 · expected €85.70 · Counting error');
  });
});

describe('count dialog checks', () => {
  const now = new Date('2026-11-03T10:00:00Z');
  const values = { amount: '85,70', time: '2026-11-03T10:30', reason: '' as const, note: '' };
  it('needs an amount and a time that is not in the future', () => {
    expect(checkCount({ ...values, amount: 'x' }, 8570, now).amount).toBeTruthy();
    expect(checkCount({ ...values, time: '2026-11-03T11:30' }, 8570, now).time).toBe(
      'The count cannot be in the future',
    );
    expect(checkCount(values, 8570, now)).toEqual({});
  });
  it('asks for a reason when the count differs and a note for unknown and other', () => {
    expect(checkCount({ ...values, amount: '83,20' }, 8570, now).reason).toBe('Say why the count differs');
    expect(checkCount({ ...values, amount: '83,20', reason: 'unknown' }, 8570, now).note).toBe('Say what you found');
    expect(checkCount({ ...values, amount: '83,20', reason: 'counting_error' }, 8570, now)).toEqual({});
  });
  it('asks the register for the instant just after the counting time', () => {
    expect(justAfter('2026-11-03T09:30:00.000Z')).toBe('2026-11-03T09:30:00.000001Z');
  });
});

describe('cashbook export request', () => {
  it('sends whole days, contents and format and names the file like the server', () => {
    expect(cashbookExport({ from: '2026-10-01', to: '2026-10-31', contents: 'all_payments', format: 'csv' })).toEqual({
      params: { from: '2026-10-01', to: '2026-10-31', contents: 'all_payments', format: 'csv' },
      filename: 'cashbook-all-payments-2026-10-01-2026-10-31.csv',
    });
    expect(exportRangeError('2026-11-02', '2026-11-01')).toEqual({ from: 'From must not be after Through' });
    expect(exportRangeError('', '2026-11-01')).toEqual({ from: 'Choose the first day' });
    expect(exportRangeError('2026-11-01', '2026-11-01')).toBeNull();
  });
});
