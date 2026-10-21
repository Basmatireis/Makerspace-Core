import type { PersonalBalance, PersonalOrder, PersonalUnbilledJob } from '../../api/generated/models';
import { toCents } from '../orders/money';

/** One Benchy (the 3D printing test boat) weighs about this much in filament. */
export const BENCHY_GRAMS = 15;

export const benchiesFor = (grams: number) => Math.floor(grams / BENCHY_GRAMS);

export type PayItem = {
  id: string;
  kind: 'order' | 'job';
  label: string;
  detail: string;
  cents: number;
};

const orderItem = (order: PersonalOrder): PayItem => ({
  id: order.id,
  kind: 'order',
  label: order.reference,
  detail: order.itemSummary,
  cents: toCents(order.outstandingAmount),
});

const jobItem = (job: PersonalUnbilledJob): PayItem => ({
  id: job.id,
  kind: 'job',
  label: job.displayId,
  detail: `${job.title} · ${job.machineName}`,
  cents: toCents(job.price),
});

/** Orders the person can still pay in full; non-payable ones (for example a running invoice request) are left out. */
export const payableOrders = (balance: PersonalBalance) => balance.unpaidOrders.filter((order) => order.payable);

export const orderItems = (balance: PersonalBalance) => payableOrders(balance).map(orderItem);
export const jobItems = (balance: PersonalBalance) => balance.unbilledJobs.map(jobItem);
