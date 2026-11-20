import type {
  WorkingGroupProject,
  WorkingGroupProjectItem,
  WorkingGroupProjectStatus,
  WorkingGroupPurchase,
} from '../../api/generated/models';
import { formatCents, toCents } from '../orders/money';
import { amountCents } from './financeModel';
import { firstName } from './taskModel';

export const PROJECT_STEPS = ['Draft', 'Approval', 'WiRef', 'Running', 'Completed'];

export const PROJECT_STATUS_LABEL: Record<WorkingGroupProjectStatus, string> = {
  draft: 'Draft',
  submitted: 'Waiting for approval',
  returned: 'Changes asked for',
  declined: 'Declined',
  wiref: 'At the WiRef',
  running: 'Running',
  completed: 'Completed',
};

export const PROJECT_STATUS_TAG: Record<
  WorkingGroupProjectStatus,
  'gray' | 'blue' | 'magenta' | 'red' | 'purple' | 'teal' | 'green'
> = {
  draft: 'gray',
  submitted: 'blue',
  returned: 'magenta',
  declined: 'red',
  wiref: 'purple',
  running: 'teal',
  completed: 'green',
};

export type ProjectBucket = 'waiting' | 'drafts' | 'running' | 'finished';

export const PROJECT_BUCKETS: { key: ProjectBucket; label: string }[] = [
  { key: 'waiting', label: 'Waiting for approval' },
  { key: 'drafts', label: 'Drafts' },
  { key: 'running', label: 'Running' },
  { key: 'finished', label: 'Finished' },
];

export function projectBucket(project: WorkingGroupProject): ProjectBucket {
  switch (project.status) {
    case 'submitted':
    case 'wiref':
      return 'waiting';
    case 'draft':
    case 'returned':
      return 'drafts';
    case 'running':
      return 'running';
    default:
      return 'finished';
  }
}

export interface ProjectStage {
  index: number;
  label: string;
  declined: boolean;
}

export function projectStage(project: WorkingGroupProject): ProjectStage {
  const index = { draft: 0, returned: 0, declined: 0, submitted: 1, wiref: 2, running: 3, completed: 4 }[
    project.status
  ];
  return {
    index,
    label:
      project.status === 'returned' ? 'Returned' : project.status === 'declined' ? 'Declined' : PROJECT_STEPS[index],
    declined: project.status === 'declined',
  };
}

export const PAID_FROM_LABEL = { group: 'Group budget', external: 'External source' } as const;
export const paidFromLabel = (project: WorkingGroupProject) =>
  project.paidFrom ? PAID_FROM_LABEL[project.paidFrom] : 'Not decided yet';

/** The reason of the last return or decline, with who wrote it and when. */
export function lastReason(project: WorkingGroupProject) {
  if (project.status !== 'returned' && project.status !== 'declined') return null;
  const entry = [...project.history].reverse().find((e) => e.status === project.status && e.reason);
  return entry ? { title: project.status === 'returned' ? 'Changes asked for' : 'Reason', ...entry } : null;
}

export interface ItemStatus {
  label: string;
  tag: 'gray' | 'blue' | 'teal' | 'purple' | 'green' | 'magenta';
}

/** Computed from the item and its purchases; the API has no status of its own. */
export function itemStatus(item: WorkingGroupProjectItem, purchases: readonly WorkingGroupPurchase[]): ItemStatus {
  const active = purchases.filter((purchase) => purchase.status !== 'declined');
  if (active.length > 0) {
    const bought = active.filter((p) => ['ordered', 'bought', 'received', 'refunded'].includes(p.status));
    if (bought.length === 0) {
      return active.every((p) => p.status === 'planned')
        ? { label: 'Purchase planned', tag: 'blue' }
        : { label: 'In progress', tag: 'purple' };
    }
    const sum = bought.reduce((total, p) => total + amountCents(p), 0);
    return sum >= toCents(item.plannedAmount)
      ? { label: 'Complete', tag: 'green' }
      : { label: 'Partly bought', tag: 'teal' };
  }
  if (item.chosenOfferId) return { label: 'Offer chosen', tag: 'teal' };
  if (item.needsOffers)
    return { label: `${item.offers.length} of 3 offers`, tag: item.offers.length >= 3 ? 'teal' : 'magenta' };
  return { label: 'No purchase yet', tag: 'gray' };
}

export const itemCaption = (item: WorkingGroupProjectItem, offersThreshold?: string) =>
  item.needsOffers
    ? offersThreshold
      ? `${formatCents(toCents(offersThreshold))} or more: three offers`
      : 'Three offers needed'
    : '';

export interface ChecklistRow {
  key: string;
  label: string;
  done: boolean;
  /** The item a click selects. */
  itemId?: string;
}

/** The checklist of the API as rows: what is done and what is still open. */
export function checklistRows(project: WorkingGroupProject): ChecklistRow[] {
  const open = new Set(project.checklist.open);
  const rows: ChecklistRow[] = [
    { key: 'goal', label: 'What we want to do', done: !open.has('goal_missing') },
    { key: 'benefit', label: 'What it improves', done: !open.has('benefit_missing') },
    { key: 'items', label: 'At least one item in the cost plan', done: !open.has('items_missing') },
  ];
  for (const item of project.items) {
    if (item.needsOffers) {
      rows.push({
        key: `offers:${item.id}`,
        label: `Three offers: ${item.text}`,
        done: !open.has(`item_needs_offers:${item.id}`),
        itemId: item.id,
      });
    } else {
      rows.push({
        key: `purchase:${item.id}`,
        label: `A purchase with a link or PDF: ${item.text}`,
        done: !open.has(`item_needs_purchase:${item.id}`),
        itemId: item.id,
      });
    }
  }
  return rows;
}

export const isEndState = (project: WorkingGroupProject) =>
  project.status === 'completed' || project.status === 'declined';

export function dateRange(project: WorkingGroupProject, format: (d: string) => string): string {
  if (project.startsOn && project.endsOn) return `${format(project.startsOn)}–${format(project.endsOn)}`;
  return project.startsOn ? `from ${format(project.startsOn)}` : '';
}

/** What the mail to the WiRef carries: the chosen offers' files and the files of purchases. Derived, the API has no list. */
export function requestAttachments(project: WorkingGroupProject): string[] {
  const names: string[] = [];
  for (const item of project.items) {
    const chosen = item.offers.find((offer) => offer.id === item.chosenOfferId);
    const offers = chosen ? [chosen] : item.offers;
    for (const offer of offers) if (offer.hasFile) names.push(`Offer: ${offer.shop} (${item.text})`);
    for (const purchase of item.purchases) if (purchase.hasAttachment) names.push(`Purchase file: ${purchase.item}`);
  }
  return names;
}

export const who = (project: WorkingGroupProject) =>
  project.requester ? firstName(project.requester) : 'Former member';
