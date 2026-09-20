import { Tag } from '@carbon/react';
import type { BillingStatus, MachineJobOutcome, MachineJobReviewState, StockState } from '../../api/generated/models';

export function OutcomeTag({ outcome }: { outcome: MachineJobOutcome }) {
  const type = outcome === 'successful' ? 'green' : outcome === 'failed' ? 'red' : outcome === 'partial_failure' ? 'warm-gray' : 'gray';
  return <Tag type={type}>{outcome.replace('_', ' ')}</Tag>;
}

export function BillingTag({ status }: { status: BillingStatus }) {
  return <Tag type={status === 'billed' ? 'green' : status === 'waived' ? 'purple' : 'blue'}>{status}</Tag>;
}

export function ReviewTag({ state }: { state: MachineJobReviewState }) {
  return state === 'needs_review' ? <Tag type="warm-gray">Needs review</Tag> : null;
}

export function StockTag({ state }: { state: StockState }) {
  return <Tag type={state === 'in_stock' ? 'green' : state === 'empty' ? 'red' : 'warm-gray'}>{state.replace('_', ' ')}</Tag>;
}

export function EmptyState({ title, description }: { title: string; description: string }) {
  return <div className="empty-state"><h2>{title}</h2><p>{description}</p></div>;
}
