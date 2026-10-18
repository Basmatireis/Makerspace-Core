/* eslint-disable react-refresh/only-export-components -- one shared status vocabulary: helpers and the tags that render them */
import { Tag } from '@carbon/react';
import {
  Add, CheckmarkFilled, CircleDash, Currency, Document, Edit, InProgress, Locked, Misuse, Receipt, Renew, Time, TrashCan, Undo, WarningAltFilled, Copy,
} from '@carbon/icons-react';
import type { ComponentType } from 'react';
import { movementKind, paymentKind, requestStateLabel, requestStateTag } from './labels';
import type { OrderView } from './logic';
import type { CashMovement, InvoiceRequest, OrderEventKind, Payment } from './types';

export type TagColor = 'green' | 'blue' | 'purple' | 'red' | 'magenta' | 'gray' | 'cool-gray' | 'warm-gray' | 'teal' | 'cyan' | 'outline';
export type OrderStatusKey = 'draft' | 'awaiting_payment' | 'partially_paid' | 'paid' | 'no_payment_due' | 'reversed' | 'cancelled';
type IconType = ComponentType<{ size?: number | string }>;

const statusMeta: Record<OrderStatusKey, { label: string; type: TagColor; icon: IconType }> = {
  draft: { label: 'Draft', type: 'cool-gray', icon: Edit },
  awaiting_payment: { label: 'Awaiting payment', type: 'blue', icon: Time },
  partially_paid: { label: 'Partially paid', type: 'teal', icon: InProgress },
  paid: { label: 'Paid', type: 'green', icon: CheckmarkFilled },
  no_payment_due: { label: 'No payment due', type: 'gray', icon: CircleDash },
  reversed: { label: 'Reversed', type: 'magenta', icon: Undo },
  cancelled: { label: 'Cancelled', type: 'warm-gray', icon: Misuse },
};

/** The one combined order status used by every list, header and tile: lifecycle first, then settlement. The invoice request is a separate column and section. */
export function orderStatus(order: Pick<OrderView, 'status' | 'settlement'>): { key: OrderStatusKey; label: string; type: TagColor; icon: IconType } {
  const key: OrderStatusKey = order.status === 'draft' ? 'draft' : order.status === 'cancelled' ? 'cancelled' : order.status === 'reversed' ? 'reversed'
    : order.settlement === 'paid' ? 'paid' : order.settlement === 'no_payment_due' ? 'no_payment_due' : order.settlement === 'partially_paid' ? 'partially_paid' : 'awaiting_payment';
  return { key, ...statusMeta[key] };
}

export const orderStatusOptions = (Object.keys(statusMeta) as OrderStatusKey[]).map((id) => ({ id, label: statusMeta[id].label }));

export function OrderStatusTag({ order, size = 'md' }: { order: Pick<OrderView, 'status' | 'settlement'>; size?: 'sm' | 'md' }) {
  const meta = orderStatus(order);
  return <Tag type={meta.type} size={size} renderIcon={meta.icon}>{meta.label}</Tag>;
}

export function PaymentKindTag({ payment, size = 'sm' }: { payment: Payment; size?: 'sm' | 'md' }) {
  const kind = paymentKind(payment);
  return <Tag type={kind.type} size={size}>{kind.label}</Tag>;
}

export function MovementKindTag({ movement, size = 'sm' }: { movement: CashMovement; size?: 'sm' | 'md' }) {
  const kind = movementKind(movement);
  return <Tag type={kind.type} size={size}>{kind.label}</Tag>;
}

export function RequestStateTag({ request, size = 'sm' }: { request: Pick<InvoiceRequest, 'state'>; size?: 'sm' | 'md' }) {
  return <Tag type={requestStateTag[request.state]} size={size}>{requestStateLabel[request.state]}</Tag>;
}

/** [proposed] marker: the element needs a backend capability that does not exist yet (listed in SALES_DESIGN.md). */
export function ProposedTag({ hint }: { hint?: string }) {
  return <Tag type="outline" size="sm" title={hint ?? 'Needs a new backend capability'}>Proposed</Tag>;
}

export const eventIcons: Record<OrderEventKind, IconType> = {
  created: Document, item_added: Add, item_removed: TrashCan, item_refreshed: Renew, edited: Edit, finalized: Locked, paid: Currency, refund: Undo,
  correction: WarningAltFilled, reversed: Undo, replacement_started: Copy, replaced: Copy, cancelled: Misuse, invoicing: Receipt,
};
