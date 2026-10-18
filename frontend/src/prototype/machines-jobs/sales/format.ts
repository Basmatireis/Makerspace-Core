import { formatDateTime, formatTime } from '../derived';
import { dateInAppTimeZone, formatDate } from '../../../app/dateTime';

export { formatDate, formatDateTime, formatTime, dateInAppTimeZone };

// Austrian formats for money; dates come from app/dateTime (Europe/Vienna, DD.MM.YYYY).
const euro = new Intl.NumberFormat('de-AT', { style: 'currency', currency: 'EUR' });
const plain = new Intl.NumberFormat('de-AT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const number = new Intl.NumberFormat('de-AT', { maximumFractionDigits: 3 });

export const formatEur = (value: number | null | undefined) => value == null ? '—' : euro.format(value);
/** "+€ 5,00" / "−€ 5,00". */
export const formatSignedEur = (value: number) => value === 0 ? formatEur(0) : `${value > 0 ? '+' : '−'}${euro.format(Math.abs(value))}`;
export const formatAmount = (value: number) => plain.format(value);
export const formatQuantity = (value: number) => number.format(value);

export const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100 + 1e-9) / 100;

/** Accepts "12,5", "12.50" or "1.234,50" style input; null when it is not a money amount with at most two decimals. */
export function parseMoney(text: string): number | null {
  const value = text.trim().replace(/\s/g, '');
  if (!value) return null;
  const normalized = /,\d{0,2}$/.test(value) ? value.replace(/\./g, '').replace(',', '.') : /^\d{1,3}(\.\d{3})+$/.test(value) ? value.replace(/\./g, '') : value;
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  return Number(normalized);
}

/** Decimal quantity with up to three places, comma or dot. */
export function parseQuantity(text: string): number | null {
  const value = text.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,3})?$/.test(value)) return null;
  return Number(value);
}

export const moneyText = (value: number) => plain.format(value);

export function formatDay(value: string) {
  const day = dateInAppTimeZone(value);
  const today = dateInAppTimeZone(new Date());
  const yesterday = dateInAppTimeZone(new Date(Date.now() - 86_400_000));
  return day === today ? 'Today' : day === yesterday ? 'Yesterday' : formatDate(value);
}
