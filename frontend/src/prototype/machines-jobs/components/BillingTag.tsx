import { Tag } from '@carbon/react';
import { billingState } from '../derived';
import type { Job } from '../types';
import { RefLink } from './RefLink';

export function BillingTag({ job }: { job: Job }) {
  const state = billingState(job);
  if (state === 'on_order') return <span className="mj-inline"><Tag type="cool-gray" size="sm">On order</Tag><RefLink reference={job.order!.orderReference} id={job.order!.orderId} /></span>;
  if (state === 'order_outdated') return <Tag type="red" size="sm">Order outdated</Tag>;
  if (state === 'price_incomplete') return <Tag type="red" size="sm">Price incomplete</Tag>;
  if (state === 'ready') return <Tag type="outline" size="sm">Not on order</Tag>;
  return null;
}
