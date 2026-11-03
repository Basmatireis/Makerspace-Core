import type {
  CashCountReason,
  CashJournalDay,
  CashJournalEntry,
  CashJournalKind,
  CashRegister,
} from '../../api/generated/models';
import { APP_LOCALE, isZonedDateTimeValue, zonedDateTimeValueToISO } from '../../app/dateTime';
import { cashMovementReasonLabel } from './labels';
import { formatCents, formatSignedCents, parseMoneyInput, toCents } from './money';

// Pure helpers of the cash register tab: wording of journal entries, the derivation of the expected cash, day heads
// and the checks of the count dialog.

export const journalKindLabel: Record<CashJournalKind, string> = {
  receipt: 'Receipt',
  refund: 'Refund',
  correction: 'Correction',
  withdrawal: 'Withdrawal',
  deposit: 'Deposit',
  count: 'Count',
};
export const journalKindOptions = (Object.keys(journalKindLabel) as CashJournalKind[]).map((id) => ({
  id,
  label: journalKindLabel[id],
}));
export const isJournalKind = (value: string): value is CashJournalKind => value in journalKindLabel;

export const countReasonLabel: Record<CashCountReason, string> = {
  counting_error: 'Counting error',
  change_given_wrong: 'Change given wrong',
  receipt_not_recorded: 'Receipt not recorded',
  unknown: 'Unknown',
  other: 'Other',
};
export const countReasons = (Object.keys(countReasonLabel) as CashCountReason[]).map((id) => ({
  id,
  label: countReasonLabel[id],
}));
/** Reasons that only make sense with a note saying what was found. */
export const countReasonNeedsNote = (reason: CashCountReason) => reason === 'unknown' || reason === 'other';

/** "Matches expected", "−€2.50 short" or "+€1.00 over" for a count's difference in cents. */
export const differenceText = (difference: number) =>
  difference === 0 ? 'Matches expected' : `${formatSignedCents(difference)} ${difference > 0 ? 'over' : 'short'}`;

export type DerivationLine = { label: string; cents: number; helper?: string; total?: boolean };

/**
 * The lines of "Expected in the register": what came in (receipts, deposits), what went out (refunds and payment
 * corrections, withdrawals) and, when counts found more or less cash than expected, their net difference.
 */
export function registerDerivation(register: CashRegister): DerivationLine[] {
  const surpluses = toCents(register.countSurpluses);
  const shortfalls = toCents(register.countShortfalls);
  return [
    { label: 'Cash receipts', cents: toCents(register.receipts) },
    { label: '+ Deposits', cents: toCents(register.deposits), helper: 'Change floats and other cash put in' },
    ...(surpluses > 0
      ? [{ label: '+ Count surpluses', cents: surpluses, helper: 'Counts found more cash than expected' }]
      : []),
    { label: '− Refunds', cents: toCents(register.refunds), helper: 'Cash given back to customers' },
    {
      label: '− Payment corrections',
      cents: toCents(register.paymentCorrections),
      helper: 'Receipts reversed because they were recorded wrongly',
    },
    { label: '− Withdrawals', cents: toCents(register.withdrawals), helper: 'Bank deposits and cash taken out' },
    ...(shortfalls > 0
      ? [{ label: '− Count shortfalls', cents: shortfalls, helper: 'Counts found less cash than expected' }]
      : []),
    { label: '= Expected', cents: toCents(register.expected), total: true },
  ];
}

const dayHeading = new Intl.DateTimeFormat(APP_LOCALE, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
});
/** "Saturday 31 October" for a day of the journal (YYYY-MM-DD). */
export const journalDayText = (day: string) => dayHeading.format(new Date(`${day}T12:00:00Z`));

/** The opening and closing balance of each day on the page, by date. */
export const daysByDate = (days: CashJournalDay[]) => new Map(days.map((day) => [day.date, day]));

/** The second line of an entry in the journal: the order and customer, the reason and note, or what a count found. */
export function journalEntryText(entry: CashJournalEntry): string {
  if (entry.count) {
    const counted = `Counted ${formatCents(toCents(entry.count.countedAmount))} · expected ${formatCents(
      toCents(entry.count.expectedAmount),
    )}`;
    return entry.count.reason ? `${counted} · ${countReasonLabel[entry.count.reason]}` : counted;
  }
  if (entry.source === 'payment') {
    const order = entry.order
      ? [entry.order.reference, entry.order.customerName].filter(Boolean).join(' · ')
      : 'Not tied to an order';
    return [order, entry.kind === 'receipt' ? '' : entry.paymentReason].filter(Boolean).join(' · ');
  }
  return [entry.movementReason ? cashMovementReasonLabel[entry.movementReason] : '', entry.note]
    .filter(Boolean)
    .join(' · ');
}

/** Cents that entered (positive) or left (negative) the register with this entry; zero for a count. */
export const entryEffect = (entry: Pick<CashJournalEntry, 'amountIn' | 'amountOut'>) =>
  toCents(entry.amountIn) - toCents(entry.amountOut);

export type CountValues = { amount: string; time: string; reason: CashCountReason | ''; note: string };
export type CountErrors = Partial<Record<keyof CountValues, string>>;

/**
 * Checks the count dialog. `expected` is what the register should have held at the chosen time (cents), or null while
 * it is unknown; a reason, and for Unknown and Other a note, is only needed when the count differs from it.
 */
export function checkCount(values: CountValues, expected: number | null, now = new Date()): CountErrors {
  const errors: CountErrors = {};
  const counted = parseMoneyInput(values.amount);
  if (counted === null || counted < 0) errors.amount = 'Enter the cash you counted, e.g. 85,70';
  if (!isZonedDateTimeValue(values.time)) errors.time = 'Enter a valid date and time';
  else if (new Date(zonedDateTimeValueToISO(values.time)).getTime() > now.getTime())
    errors.time = 'The count cannot be in the future';
  if (counted !== null && expected !== null && counted !== expected) {
    if (!values.reason) errors.reason = 'Say why the count differs';
    else if (countReasonNeedsNote(values.reason) && !values.note.trim()) errors.note = 'Say what you found';
  }
  if (values.note.length > 500) errors.note = 'Use at most 500 characters';
  return errors;
}

/** The instant just after a counting time, so the register figures include everything up to and including it. */
export const justAfter = (iso: string) => `${iso.replace(/Z$/, '').replace(/(\.\d{3})?$/, (ms) => ms || '.000')}001Z`;

/** Withdrawals, deposits and counts can be edited and deleted; payments and count corrections cannot. */
export const isEditableEntry = (entry: CashJournalEntry) =>
  entry.version != null && (entry.kind === 'withdrawal' || entry.kind === 'deposit' || entry.kind === 'count');
