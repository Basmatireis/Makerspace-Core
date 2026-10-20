import { formatDateTime, formatTime } from '../../../app/dateTime';

// Same conventions as features/machinelogbook/formatting.ts (whose formatDecimal stays the
// reference for plain decimals). The API sends money and quantities as decimal strings.

export { formatDateTime, formatTime };

export const formatMoney = (value: string | number | null | undefined) =>
  value == null || value === ''
    ? '—'
    : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(Number(value));

/** "12.5" for "12.500": trailing zeros of API decimals are not shown. */
export const formatQuantity = (value: string | number, maximumFractionDigits = 2) =>
  new Intl.NumberFormat('en-GB', { maximumFractionDigits }).format(Number(value));

export const formatDuration = (seconds: number) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
};

export const formatHours = (seconds: number) =>
  `${new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 }).format(seconds / 3600)} h`;

export function formatRelative(value: string) {
  const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} h ago`;
  return formatDateTime(value);
}
