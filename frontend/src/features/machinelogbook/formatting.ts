export const formatDecimal = (value: string, maximumFractionDigits = 2) => new Intl.NumberFormat('en-GB', { maximumFractionDigits }).format(Number(value));
export const formatMoney = (value: string | null | undefined) => value == null ? '—' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(Number(value));
export const formatDateTime = (value: string) => new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
export const formatDuration = (seconds: number) => `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
