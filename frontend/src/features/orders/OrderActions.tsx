/* eslint-disable react-refresh/only-export-components -- the order actions hook and their menu belong together */
import { useState } from 'react';
import { OverflowMenu, OverflowMenuItem } from '@carbon/react';
import { useNavigate } from 'react-router-dom';
import { cancelOrder, createReplacementOrder, discardReplacementOrder } from '../../api/generated/orders/orders';
import type { Order } from '../../api/generated/models';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { useNotify } from '../machinelogbook/shared/toasts';
import { CorrectOrderModal } from './CorrectOrderModal';
import { useOperationKeys } from './operations';
import { EditOrderModal } from './OrderDialogs';
import { useFinanceMutation } from './queries';

export type OrderActionId = 'edit' | 'replacement' | 'continue' | 'correct' | 'cancel' | 'discard';
export type OrderAction = { id: OrderActionId; label: string; danger?: boolean };

/**
 * The secondary order actions the Orders list offers in each row's overflow menu and in the detail panel: edit
 * customer, replace the order (or continue its replacement in progress), correct the order, cancel a draft and discard
 * a replacement draft. The caller renders `dialogs` once, outside the table, so a dialog never sits inside a clickable
 * row.
 */
export function useOrderActions() {
  const user = useCurrentUser();
  const navigate = useNavigate();
  const notify = useNotify();
  const key = useOperationKeys();
  const [open, setOpen] = useState<{ order: Order; id: Exclude<OrderActionId, 'replacement' | 'continue'> } | null>(
    null,
  );
  const startReplacement = useStartReplacement();
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
    const pending = order.pendingReplacementOrderId;
    const actions: (OrderAction | false)[] = [
      draft && canWrite && { id: 'edit', label: 'Edit customer' },
      charged && canWrite && !pending && { id: 'replacement', label: 'Replace' },
      charged &&
        canWrite &&
        !!pending && { id: 'continue', label: `Continue replacement ${order.pendingReplacementOrderReference}` },
      charged && canReverse && { id: 'correct', label: 'Correct order…' },
      draft && canWrite && !order.replacesOrderId && { id: 'cancel', label: 'Cancel draft', danger: true },
      draft && canWrite && !!order.replacesOrderId && { id: 'discard', label: 'Discard replacement', danger: true },
    ];
    return actions.filter((action): action is OrderAction => !!action);
  };

  const run = (order: Order, id: OrderActionId) => {
    mutation.reset();
    if (id === 'continue') void navigate(`/orders/${order.pendingReplacementOrderId}`);
    else if (id === 'replacement') startReplacement.start(order);
    else setOpen({ order, id });
  };

  const dialogs = (
    <>
      <DiscardReplacementDialog draft={open?.id === 'discard' ? open.order : null} onClose={close} />
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

  return { actionsFor, run, dialogs, busy: mutation.isPending || startReplacement.busy };
}

/**
 * Replace starts the replacement draft of a finalized or reversed order: already linked to it and prefilled with its
 * customer and items. It opens the draft, or the one already in progress.
 */
export function useStartReplacement() {
  const navigate = useNavigate();
  const notify = useNotify();
  const key = useOperationKeys();
  const mutation = useFinanceMutation((order: Order) => {
    const input = { expectedVersion: order.version };
    return createReplacementOrder(order.id, { ...input, operationKey: key(`${order.id}-replacement`, input) });
  });
  const start = (order: Order) =>
    mutation.mutate(order, {
      onSuccess: (next) => void navigate(`/orders/${next.id}`),
      onError: (error) =>
        notify({ kind: 'error', title: 'The replacement could not be started', subtitle: error.message }),
    });
  return { start, busy: mutation.isPending };
}

/**
 * Deletes a replacement draft (the dialog is open while `draft` is set); it was never charged. `leave` opens the
 * original afterwards, for callers that show the deleted draft itself.
 */
export function DiscardReplacementDialog({
  draft,
  leave = false,
  onClose,
}: {
  draft: Order | null;
  leave?: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const notify = useNotify();
  const key = useOperationKeys();
  const mutation = useFinanceMutation(async (target: Order) => {
    const input = { expectedVersion: target.version };
    const original = await discardReplacementOrder(target.id, {
      ...input,
      operationKey: key(`${target.id}-discard`, input),
    });
    notify({
      kind: 'success',
      title: 'Replacement discarded',
      subtitle: `${target.reference} was deleted. ${original.reference} is unchanged.`,
    });
    // Leave the deleted draft before the order queries refresh, so its query is inactive and not refetched (a 404).
    if (leave) void navigate(`/orders/${original.id}`);
    return original;
  });
  return (
    <DestructiveActionDialog
      open={!!draft}
      title="Discard this replacement?"
      fate="permanent"
      confirmLabel="Discard replacement"
      cancelLabel="Keep replacement"
      pending={mutation.isPending}
      error={mutation.error?.message}
      onClose={() => {
        mutation.reset();
        onClose();
      }}
      onConfirm={() => draft && mutation.mutate(draft, { onSuccess: onClose })}
    >
      <p>
        {draft?.reference} and its items are deleted. It was never charged, and {draft?.replacesOrderReference} stays as
        it is.
      </p>
    </DestructiveActionDialog>
  );
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
