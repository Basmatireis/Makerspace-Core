import type {
  MachineLogbookStatistics,
  StatisticOutcomeCountOutcome,
  StatisticPoint,
  StatisticTotals,
} from '../../../api/generated/models';
import { formatMoney } from '../shared/format';
import type { LabelledValue } from './chartSpec';

export const integer = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
export const oneDecimal = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const compactNumber = new Intl.NumberFormat('en-GB', { notation: 'compact', maximumFractionDigits: 1 });
const compactMoney = new Intl.NumberFormat('en-IE', {
  style: 'currency',
  currency: 'EUR',
  notation: 'compact',
  maximumFractionDigits: 1,
});

export const formatInteger = (value: number) => integer.format(value);
export const formatHoursValue = (value: number) => `${oneDecimal.format(value)} h`;
export const formatPercent = (value: number) => `${oneDecimal.format(value)} %`;
export const formatCompact = (value: number) => compactNumber.format(value);
export const formatCompactMoney = (value: number) => compactMoney.format(value);
export const formatCompactHours = (value: number) => `${compactNumber.format(value)} h`;
export const formatEuro = (value: number) => formatMoney(value);
/** "+€12.00" or "−€3.50": the sign carries the meaning, never colour. */
export const formatSignedMoney = (value: number) => `${value < 0 ? '−' : '+'}${formatMoney(Math.abs(value))}`;

export const round2 = (value: number) => Math.round(value * 100) / 100;

export type Totals = {
  jobs: number;
  runtimeHours: number;
  charges: number;
  materialCost: number;
  failureRate: number;
  notBilled: number;
  discounts: number;
  utilization: number;
  openDayUtilization: number;
};

export const toTotals = (totals: StatisticTotals): Totals => ({
  jobs: totals.jobs,
  runtimeHours: Number(totals.runtimeHours),
  charges: Number(totals.charges),
  materialCost: Number(totals.materialCost),
  failureRate: Number(totals.failureRate),
  notBilled: Number(totals.notBilled),
  discounts: Number(totals.discounts),
  utilization: Number(totals.utilization),
  openDayUtilization: Number(totals.openDayUtilization),
});

/** "+12 % vs previous period"; the sign and wording carry the meaning, never colour. */
export function comparison(current: number, previous: number, mode: 'percent' | 'points') {
  if (mode === 'points') {
    if (previous === 0 && current === 0) return 'No data in previous period';
    const delta = current - previous;
    if (Math.abs(delta) < 0.05) return 'No change vs previous period';
    return `${delta > 0 ? '+' : '−'}${oneDecimal.format(Math.abs(delta))} pp vs previous period`;
  }
  if (previous === 0) return 'No data in previous period';
  const delta = Math.round(((current - previous) / previous) * 100);
  if (delta === 0) return 'No change vs previous period';
  return `${delta > 0 ? '+' : '−'}${integer.format(Math.abs(delta))} % vs previous period`;
}

export type MachineRow = {
  id: string;
  name: string;
  processName: string;
  jobs: number;
  runtimeHours: number;
  failureRate: number;
  charges: number;
  runtimeShare: number;
  utilization: number;
  openDayUtilization: number;
};

export const machineRows = (stats: MachineLogbookStatistics): MachineRow[] =>
  stats.machines
    .map((row) => ({
      id: row.machineId,
      name: row.name,
      processName: row.processName,
      jobs: row.jobs,
      runtimeHours: Number(row.runtimeHours),
      failureRate: Number(row.failureRate),
      charges: Number(row.charges),
      runtimeShare: Number(row.runtimeShare),
      utilization: Number(row.utilization),
      openDayUtilization: Number(row.openDayUtilization),
    }))
    .sort((a, b) => b.runtimeHours - a.runtimeHours || a.name.localeCompare(b.name));

/** Sums a machine figure per process, largest first. */
export function byProcess(machines: MachineRow[], value: (row: MachineRow) => number): LabelledValue[] {
  const sums = new Map<string, number>();
  for (const row of machines) sums.set(row.processName, (sums.get(row.processName) ?? 0) + value(row));
  return [...sums].map(([label, sum]) => ({ label, value: round2(sum) })).sort((a, b) => b.value - a.value);
}

export const points = (list: StatisticPoint[]): LabelledValue[] =>
  list.map((point) => ({ label: point.label, value: Number(point.value) })).sort((a, b) => b.value - a.value);

export const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

export const OUTCOME_LABELS: Record<StatisticOutcomeCountOutcome, string> = {
  successful: 'Successful',
  partial_failure: 'Partial failure',
  failed: 'Failed',
  cancelled: 'Cancelled',
  unknown: 'Not recorded',
};

export type MaterialTypeRow = {
  id: string;
  name: string;
  quantity: number;
  unit: string | null;
  cost: number;
  charged: number;
  lost: number;
};

/** One row per material type that was consumed, charged or lost in the period, most expensive first. */
export function materialTypeRows(stats: MachineLogbookStatistics): MaterialTypeRow[] {
  const rows = new Map<string, MaterialTypeRow>();
  const row = (id: string, name: string) => {
    let current = rows.get(id);
    if (!current) {
      current = { id, name, quantity: 0, unit: null, cost: 0, charged: 0, lost: 0 };
      rows.set(id, current);
    }
    return current;
  };
  for (const month of stats.materialByMonth) {
    const current = row(month.materialTypeId, month.materialTypeName);
    current.quantity += Number(month.quantity);
    current.unit = month.unit;
  }
  for (const point of stats.materialCostByType) row(point.key, point.label).cost += Number(point.value);
  for (const point of stats.materialChargesByType) row(point.key, point.label).charged += Number(point.value);
  for (const point of stats.materialLossByType) row(point.key, point.label).lost += Number(point.value);
  return [...rows.values()].sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name));
}

/** ISO 8601 week number of a Monday ("YYYY-MM-DD"). */
export function isoWeek(monday: string) {
  const date = new Date(`${monday}T12:00:00Z`);
  const thursday = new Date(date.getTime() + 3 * 86_400_000);
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  return Math.floor((thursday.getTime() - yearStart) / (7 * 86_400_000)) + 1;
}

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const HOURS = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, '0')}:00`);
