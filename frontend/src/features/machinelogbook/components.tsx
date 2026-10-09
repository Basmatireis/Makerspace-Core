import { Tag } from '@carbon/react';
import type { MachineJobOutcome, MachineJobReviewState, StockState } from '../../api/generated/models';

export function OutcomeTag({ outcome }: { outcome: MachineJobOutcome }) {
  const type = outcome === 'successful' ? 'green' : outcome === 'failed' ? 'red' : outcome === 'partial_failure' ? 'warm-gray' : 'gray';
  return <Tag type={type}>{outcome.replace('_', ' ')}</Tag>;
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
