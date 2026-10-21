import { parseDecimalText } from '../../app/decimalInput';
import { formatMoney } from './formatting';

// Money crosses the API as decimal strings with two places. Calculations here use integer cents so sums never drift.

export const toCents = (value: string | null | undefined): number => {
  if (!value) return 0;
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace('-', '').split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0').slice(0, 2));
  return negative ? -amount : amount;
};

export const fromCents = (value: number): string => {
  const absolute = Math.abs(Math.round(value));
  return `${value < 0 ? '-' : ''}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
};

export const sumCents = (values: Array<string | null | undefined>) => values.reduce<number>((total, value) => total + toCents(value), 0);

export const formatCents = (value: number) => formatMoney(fromCents(value));

/** "+€5.00" / "-€5.00" for a signed cashbook amount. */
export const formatSignedCents = (value: number) => value === 0 ? formatCents(0) : `${value > 0 ? '+' : '−'}${formatCents(Math.abs(value))}`;

/** Accepts "12,5" or "12.50" and returns cents; null when it is not a money amount with at most two decimals. Thousands separators are not supported. */
export function parseMoneyInput(text: string): number | null {
  const normalized = parseDecimalText(text, { places: 2 });
  return normalized === null ? null : toCents(normalized);
}

/** Cents as the text field shows them: decimal comma, no currency symbol. */
export const moneyInputText = (value: number) => fromCents(value).replace('.', ',');

/** Decimal quantity with up to six places, comma or dot. Returns the API decimal string, or null. */
export function parseDecimalInput(text: string, places = 6): string | null {
  return parseDecimalText(text, { places });
}

const scaled = (value: string): bigint => {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
};

/** Quantity times unit price (both API decimals, up to six places), rounded half up to cents like the server rounds manual items. */
export function lineAmountCents(quantity: string, unitPrice: string): number {
  const product = scaled(quantity) * scaled(unitPrice); // six + six decimal places
  return Number((product + 5_000_000_000n) / 10_000_000_000n);
}
