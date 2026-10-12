// Deterministic mock statistics for the prototype Statistics screen.
// Real store jobs contribute where possible (average charge per machine, jobs inside the period);
// the rest is a seeded synthetic baseline derived from each machine's lifetime totals, so every
// period shows data and the same day always yields the same numbers.
import { effectivePrice } from './derived';
import type { Job, Machine, MachineType, Material } from './types';

export type DateRange = { from: string; to: string };

export type MachineStat = {
  id: string;
  name: string;
  typeId: string;
  typeName: string;
  jobs: number;
  runtimeHours: number;
  failureRate: number;
  charges: number;
  /** Percentage of the runtime of all machines in the period. */
  runtimeShare: number;
};

export type MonthPoint = { month: string; label: string; charges: number; materialCost: number; losses: number };
export type LabelledValue = { label: string; value: number };
/** Runtime hours per machine for one week or month of the period. */
export type RuntimeBucket = { key: string; label: string; hoursByMachine: Record<string, number> };
export type Granularity = 'week' | 'month';

export type Totals = { jobs: number; runtimeHours: number; charges: number; materialCost: number; failureRate: number };

export type PeriodStats = {
  totals: Totals;
  machines: MachineStat[];
  months: MonthPoint[];
  materialByCategory: LabelledValue[];
  granularity: Granularity;
  runtime: RuntimeBucket[];
};

export type Statistics = PeriodStats & { previous: Totals };

const DAY_MS = 86_400_000;
const parseDay = (value: string) => Date.parse(`${value}T12:00:00Z`);
const formatDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const addDays = (value: string, days: number) => formatDay(parseDay(value) + days * DAY_MS);
export const daysBetween = (from: string, to: string) => Math.round((parseDay(to) - parseDay(from)) / DAY_MS) + 1;

/** Same date `months` earlier (clamped by Date rollover like the production page). */
export function addMonths(value: string, months: number) {
  const date = new Date(parseDay(value));
  date.setUTCMonth(date.getUTCMonth() + months);
  return formatDay(date.getTime());
}

const weekStart = (day: string) => addDays(day, -((new Date(parseDay(day)).getUTCDay() + 6) % 7));
const weekLabel = (day: string) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(parseDay(day)));
/** Weeks for periods up to about three months, months beyond. */
export const granularityFor = (range: DateRange): Granularity => (daysBetween(range.from, range.to) <= 92 ? 'week' : 'month');
const monthLabel = (month: string) => new Intl.DateTimeFormat('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' }).format(new Date(`${month}-01T12:00:00Z`));

/** Stable pseudo-random number in [0, 1) for a string key. */
function seeded(key: string) {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) { hash ^= key.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  let t = (hash + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const between = (key: string, low: number, high: number) => low + seeded(key) * (high - low);

type Inputs = { machines: Machine[]; machineTypes: MachineType[]; jobs: Job[]; materials: Material[] };

const FALLBACK_CHARGE = 14;
const CATEGORY_FALLBACK = ['Filament', 'Resin', 'Sheet'];

function periodStats(range: DateRange, { machines, machineTypes, jobs, materials }: Inputs): PeriodStats {
  const typeName = (id: string) => machineTypes.find((type) => type.id === id)?.name ?? 'Unknown type';
  const categories = [...new Set(materials.map((material) => material.category))];
  const categoryList = categories.length ? categories : CATEGORY_FALLBACK;
  const categoryShare = categoryList.map((category) => ({ category, weight: between(`share-${category}`, 0.5, 1.5) }));
  const shareTotal = categoryShare.reduce((sum, item) => sum + item.weight, 0);

  const perMachine = machines.map((machine) => {
    const created = machine.createdAt.slice(0, 10);
    // A retired machine stops producing activity when it was last updated.
    const lastActive = machine.status === 'retired' ? machine.updatedAt.slice(0, 10) : '9999-12-31';
    const ageDays = Math.max(30, daysBetween(created, formatDay(Date.now())));
    const jobRate = machine.jobCount / ageDays;
    const runtimeRate = machine.runtimeSeconds / 3600 / ageDays;
    const real = jobs.filter((job) => job.machineId === machine.id);
    const priced = real.map(effectivePrice).filter((price): price is number => price != null);
    const averageCharge = priced.length ? priced.reduce((sum, price) => sum + price, 0) / priced.length : FALLBACK_CHARGE;
    return { machine, created, lastActive, jobRate, runtimeRate, averageCharge, jobsFloat: 0, hours: 0, charges: 0 };
  });

  const monthMap = new Map<string, MonthPoint>();
  const monthFor = (month: string) => {
    let point = monthMap.get(month);
    if (!point) { point = { month, label: monthLabel(month), charges: 0, materialCost: 0, losses: 0 }; monthMap.set(month, point); }
    return point;
  };

  const granularity = granularityFor(range);
  const runtimeMap = new Map<string, RuntimeBucket>();
  const addRuntime = (day: string, machineId: string, hours: number) => {
    const key = granularity === 'week' ? weekStart(day) : day.slice(0, 7);
    let bucket = runtimeMap.get(key);
    if (!bucket) { bucket = { key, label: granularity === 'week' ? `Week of ${weekLabel(key)}` : monthLabel(key), hoursByMachine: {} }; runtimeMap.set(key, bucket); }
    bucket.hoursByMachine[machineId] = (bucket.hoursByMachine[machineId] ?? 0) + hours;
  };

  const length = daysBetween(range.from, range.to);
  for (let offset = 0; offset < length; offset += 1) {
    const day = addDays(range.from, offset);
    const month = day.slice(0, 7);
    const weekday = new Date(parseDay(day)).getUTCDay();
    const dayFactor = (weekday === 0 || weekday === 6 ? 0.35 : 1.1) * between(`day-${day}`, 0.75, 1.25);
    const point = monthFor(month);
    let dayCharges = 0;
    for (const item of perMachine) {
      if (day < item.created || day > item.lastActive) continue;
      const factor = dayFactor * between(`${item.machine.id}-${day}`, 0.7, 1.3);
      const dayJobs = item.jobRate * factor;
      const charges = dayJobs * item.averageCharge;
      item.jobsFloat += dayJobs;
      item.hours += item.runtimeRate * factor;
      addRuntime(day, item.machine.id, item.runtimeRate * factor);
      item.charges += charges;
      dayCharges += charges;
    }
    point.charges += dayCharges;
    point.materialCost += dayCharges * between(`mat-${month}`, 0.22, 0.34);
    point.losses += dayCharges * between(`loss-${month}`, 0.02, 0.05);
  }

  // Real jobs that started inside the period count on top of the baseline.
  for (const job of jobs) {
    const day = job.startsAt.slice(0, 10);
    const item = perMachine.find((entry) => entry.machine.id === job.machineId);
    if (!item || day < range.from || day > range.to) continue;
    const price = effectivePrice(job) ?? 0;
    item.jobsFloat += 1;
    item.hours += job.durationSeconds / 3600;
    addRuntime(day, item.machine.id, job.durationSeconds / 3600);
    item.charges += price;
    const point = monthFor(day.slice(0, 7));
    point.charges += price;
    point.materialCost += price * 0.28;
  }

  const stats = perMachine
    .map<MachineStat>((item) => {
      const jobCount = Math.round(item.jobsFloat);
      return {
        id: item.machine.id, name: item.machine.name, typeId: item.machine.machineTypeId, typeName: typeName(item.machine.machineTypeId),
        jobs: jobCount, runtimeHours: item.hours,
        failureRate: jobCount ? Math.min(100, Math.max(0, item.machine.failureRate * between(`fail-${item.machine.id}-${range.from}-${range.to}`, 0.8, 1.2))) : 0,
        charges: item.charges, runtimeShare: 0,
      };
    })
    .filter((stat) => stat.jobs > 0);
  const totalHours = stats.reduce((sum, stat) => sum + stat.runtimeHours, 0);
  for (const stat of stats) stat.runtimeShare = totalHours ? (stat.runtimeHours / totalHours) * 100 : 0;

  const months = [...monthMap.values()].sort((a, b) => a.month.localeCompare(b.month));
  const materialCost = months.reduce((sum, point) => sum + point.materialCost, 0);
  const totalJobs = stats.reduce((sum, stat) => sum + stat.jobs, 0);
  return {
    machines: stats,
    months: totalJobs ? months : [],
    granularity,
    runtime: totalJobs ? [...runtimeMap.values()].sort((a, b) => a.key.localeCompare(b.key)) : [],
    materialByCategory: totalJobs ? categoryShare.map(({ category, weight }) => ({ label: category, value: (materialCost * weight) / shareTotal })) : [],
    totals: {
      jobs: totalJobs,
      runtimeHours: totalHours,
      charges: stats.reduce((sum, stat) => sum + stat.charges, 0),
      materialCost: totalJobs ? materialCost : 0,
      failureRate: totalJobs ? stats.reduce((sum, stat) => sum + stat.failureRate * stat.jobs, 0) / totalJobs : 0,
    },
  };
}

/** Statistics for a range plus the totals of the previous range of equal length. */
export function buildStatistics(range: DateRange, inputs: Inputs): Statistics {
  const length = daysBetween(range.from, range.to);
  const current = periodStats(range, inputs);
  const previous = periodStats({ from: addDays(range.from, -length), to: addDays(range.from, -1) }, inputs);
  return { ...current, previous: previous.totals };
}
