/* eslint-disable react-refresh/only-export-components -- the order actions hook and their menu belong together */
import { useState } from 'react';
import { OverflowMenu, OverflowMenuItem } from '@carbon/react';
import { useNavigate } from 'react-router-dom';
import { cancelOrder, createReplacementOrder } from '../../api/generated/orders/orders';
import type { Order } from '../../api/generated/models';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { useNotify } from '../machinelogbook/shared/toasts';
import { CorrectOrderModal } from './CorrectOrderModal';
import { useOperationKeys } from './operations';
import { EditOrderModal } from './OrderDialogs';
import { useFinanceMutation } from './queries';

export type OrderActionId = 'edit' | 'replacement' | 'correct' | 'cancel';
export type OrderAction = { id: OrderActionId; label: string; danger?: boolean };

/**
 * The secondary order actions the Orders list offers in each row's overflow menu and in the detail panel: edit
 * customer and hand-over, create a replacement draft, correct the order and cancel a draft. The caller renders
 * `dialogs` once, outside the table, so a dialog never sits inside a clickable row.
 */
export function useOrderActions() {
  const user = useCurrentUser();
  const navigate = useNavigate();
  const notify = useNotify();
  const key = useOperationKeys();
  const [open, setOpen] = useState<{ order: Order; id: Exclude<OrderActionId, 'replacement'> } | null>(null);
  const can = (permission: PermissionId) => hasPermission(user, permission);
  const canWrite = can(PermissionId.orderswrite);
  const canReverse = can(PermissionId.ordersreverse);
  const canReadPayments = can(PermissionId.paymentsread);
  const canCarry = can(PermissionId.ordersfinalize) && can(PermissionId.paymentsrecord) && canReadPayments;
  const close = () => setOpen(null);
  const mutation = useFinanceMutation(
    async (run: () => Promise<unknown>) => run(),
    () => close(),
  );
  const command = (order: Order, action: string) => {
    const input = { expectedVersion: order.version };
    return { ...input, operationKey: key(`${order.id}-${action}`, input) };
  };

  const actionsFor = (order: Order): OrderAction[] => {
    const draft = order.status === 'draft';
    const charged = (order.status === 'finalized' || order.status === 'reversed') && !order.replacedByOrderId;
    const actions: (OrderAction | false)[] = [
      draft && canWrite && { id: 'edit', label: 'Edit customer and hand-over' },
      charged && canWrite && { id: 'replacement', label: 'Create replacement draft' },
      charged && canReverse && { id: 'correct', label: 'Correct order…' },
      draft && canWrite && { id: 'cancel', label: 'Cancel draft', danger: true },
    ];
    return actions.filter((action): action is OrderAction => !!action);
  };

  const run = (order: Order, id: OrderActionId) => {
    mutation.reset();
    if (id !== 'replacement') {
      setOpen({ order, id });
      return;
    }
    mutation.mutate(
      async () => {
        const next = await createReplacementOrder(order.id, command(order, 'replacement'));
        navigate(`/orders/${next.id}`);
      },
      {
        onError: (error) =>
          notify({ kind: 'error', title: 'The replacement draft could not be created', subtitle: error.message }),
      },
    );
  };

  const dialogs = (
    <>
      {open?.id === 'edit' && <EditOrderModal order={open.order} onClose={close} onSaved={() => undefined} />}
      {open?.id === 'correct' && (
        <CorrectOrderModal
          order={open.order}
          canReversePayments={can(PermissionId.paymentsreverse) && canReadPayments}
          canCarry={canCarry}
          onClose={close}
        />
      )}
      <DestructiveActionDialog
        open={open?.id === 'cancel'}
        title="Cancel this draft?"
        fate="none"
        confirmLabel="Cancel draft"
        cancelLabel="Keep draft"
        pending={mutation.isPending}
        error={mutation.error?.message}
        onClose={close}
        onConfirm={() => {
          const order = open!.order;
          mutation.mutate(async () => {
            await cancelOrder(order.id, command(order, 'cancel'));
            notify({
              kind: 'success',
              title: 'Draft cancelled',
              subtitle: `${order.reference} was never charged; its jobs are free again.`,
            });
          });
        }}
      >
        <p>
          {open?.order.reference} was never finalized, so nothing was charged. The draft is kept as cancelled and its
          jobs can go on another order.
        </p>
      </DestructiveActionDialog>
    </>
  );

  return { actionsFor, run, dialogs, busy: mutation.isPending };
}

/** The overflow menu of one order; renders nothing when the person may do none of the actions. */
export function OrderActionsMenu({
  order,
  actions,
  onAction,
  disabled,
}: {
  order: Order;
  actions: OrderAction[];
  onAction: (order: Order, id: OrderActionId) => void;
  disabled?: boolean;
}) {
  if (actions.length === 0) return null;
  const label = `Actions for ${order.reference}`;
  return (
    <OverflowMenu size="sm" aria-label={label} iconDescription={label} flipped disabled={disabled}>
      {actions.map((action) => (
        <OverflowMenuItem
          key={action.id}
          itemText={action.label}
          isDelete={action.danger}
          hasDivider={action.danger}
          onClick={() => onAction(order, action.id)}
        />
      ))}
    </OverflowMenu>
  );
}
