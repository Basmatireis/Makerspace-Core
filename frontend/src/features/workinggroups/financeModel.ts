import type {
  WorkingGroupBooking,
  WorkingGroupBudgetPeriod,
  WorkingGroupPurchase,
  WorkingGroupPurchaseStatus,
} from '../../api/generated/models';
import { toCents } from '../orders/money';

export type PurchaseBucket = 'wanted' | 'approved' | 'running' | 'finished';

export const PURCHASE_BUCKETS: { key: PurchaseBucket; label: string }[] = [
  { key: 'wanted', label: 'Waiting for approval' },
  { key: 'approved', label: 'Approved' },
  { key: 'running', label: 'Ordered or bought' },
  { key: 'finished', label: 'Finished' },
];

export function bucketOf(purchase: WorkingGroupPurchase): PurchaseBucket {
  switch (purchase.status) {
    case 'wanted':
      return 'wanted';
    case 'approved':
      return 'approved';
    case 'ordered':
    case 'bought':
      return 'running';
    default:
      return 'finished';
  }
}

export const PURCHASE_STATUS_LABEL: Record<WorkingGroupPurchaseStatus, string> = {
  wanted: 'Waiting for approval',
  approved: 'Approved',
  declined: 'Declined',
  ordered: 'Ordered',
  bought: 'Bought',
  received: 'Arrived',
  refunded: 'Money returned',
};

export const PURCHASE_STATUS_TAG: Record<WorkingGroupPurchaseStatus, 'blue' | 'teal' | 'gray' | 'purple' | 'green'> = {
  wanted: 'blue',
  approved: 'teal',
  declined: 'gray',
  ordered: 'purple',
  bought: 'purple',
  received: 'green',
  refunded: 'green',
};

export type CountsAs = 'spent' | 'reserved' | 'none';

/** Ordered, bought or booked counts as spent; approved but not paid yet as reserved. */
export function countsAs(purchase: WorkingGroupPurchase): CountsAs {
  switch (purchase.status) {
    case 'approved':
      return 'reserved';
    case 'ordered':
    case 'bought':
    case 'received':
    case 'refunded':
      return 'spent';
    default:
      return 'none';
  }
}

export const COUNTS_LABEL: Record<CountsAs, string> = {
  spent: 'Spent',
  reserved: 'Reserved',
  none: 'Not counted yet',
};

export const amountCents = (purchase: WorkingGroupPurchase) => toCents(purchase.actualTotal ?? purchase.estimatedTotal);

/** Something the caller has to do, taken from the flags the API sets. */
export type TurnKind = 'approve' | 'receipt' | 'arrived' | 'refund';

export function turnOf(purchase: WorkingGroupPurchase): TurnKind | null {
  if (purchase.canApprove && !purchase.needsProject) return 'approve';
  if (purchase.canHandInReceipt) return 'receipt';
  if (purchase.canMarkArrived) return 'arrived';
  if (purchase.canMarkRefunded) return 'refund';
  return null;
}

export interface PurchaseStage {
  steps: string[];
  index: number;
  label: string;
  declined: boolean;
}

export function stageOf(purchase: WorkingGroupPurchase): PurchaseStage {
  const steps =
    purchase.how === 'self'
      ? ['Requested', 'Approved', 'Bought', 'Money back']
      : ['Requested', 'Approved', 'Ordered', 'Arrived'];
  if (purchase.status === 'declined') return { steps, index: 0, label: 'Declined', declined: true };
  const index = { wanted: 0, approved: 1, ordered: 2, bought: 2, received: 3, refunded: 3, declined: 0 }[
    purchase.status
  ];
  return { steps, index, label: steps[index], declined: false };
}

export type FinanceRow =
  | { kind: 'purchase'; id: string; purchase: WorkingGroupPurchase }
  | { kind: 'booking'; id: string; booking: WorkingGroupBooking };

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const ACCEPTED_FILES = 'application/pdf,image/jpeg,image/png,image/gif,image/webp';

/** The headers that carry a raw file body, like the event files. */
export const fileHeaders = (file: File): Record<string, string> => ({
  'X-File-Name': file.name,
  'X-File-Content-Type': file.type || 'application/octet-stream',
});

/** Newest first. */
export const sortPeriods = (periods: readonly WorkingGroupBudgetPeriod[]) =>
  [...periods].sort((a, b) => b.startsOn.localeCompare(a.startsOn));
