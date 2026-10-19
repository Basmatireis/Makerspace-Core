/* eslint-disable react-refresh/only-export-components -- one shared status vocabulary: helpers and the tags that render them */
import { Tag } from '@carbon/react';
import { CheckmarkFilled, CircleDash, Edit, InProgress, Misuse, Time, Undo } from '@carbon/icons-react';
import type { ComponentType } from 'react';
import type { CashMovement, ExternalInvoiceRequestState, Order, OrderPayment } from '../../api/generated/models';
import { movementTagType, paymentKind, cashMovementKindLabel, requestStateLabel, requestStateTag } from './labels';
import { orderStatusKey, type OrderStatusKey } from './logic';

export type TagColor = 'green' | 'blue' | 'purple' | 'red' | 'magenta' | 'gray' | 'cool-gray' | 'warm-gray' | 'teal' | 'cyan';
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

export const orderStatusLabel = (order: Pick<Order, 'status' | 'settlementState'>) => statusMeta[orderStatusKey(order)].label;

export function OrderStatusTag({ order, size = 'md' }: { order: Pick<Order, 'status' | 'settlementState'>; size?: 'sm' | 'md' }) {
  const meta = statusMeta[orderStatusKey(order)];
  return <Tag type={meta.type} size={size} renderIcon={meta.icon}>{meta.label}</Tag>;
}

export function PaymentKindTag({ payment, size = 'sm' }: { payment: Pick<OrderPayment, 'entryKind' | 'reasonKind'>; size?: 'sm' | 'md' }) {
  const kind = paymentKind(payment);
  return <Tag type={kind.type} size={size}>{kind.label}</Tag>;
}

export function MovementKindTag({ movement, size = 'sm' }: { movement: Pick<CashMovement, 'kind'>; size?: 'sm' | 'md' }) {
  return <Tag type={movementTagType(movement.kind)} size={size}>{cashMovementKindLabel(movement.kind)}</Tag>;
}

export function RequestStateTag({ state, size = 'sm' }: { state: ExternalInvoiceRequestState | string; size?: 'sm' | 'md' }) {
  const known = state in requestStateLabel;
  return <Tag type={known ? requestStateTag[state as ExternalInvoiceRequestState] : 'gray'} size={size}>{known ? requestStateLabel[state as ExternalInvoiceRequestState] : state}</Tag>;
}
