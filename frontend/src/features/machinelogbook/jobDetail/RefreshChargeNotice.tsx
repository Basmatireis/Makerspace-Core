import { useState } from 'react';
import { Button, InlineNotification } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { refreshOrderItem } from '../../../api/generated/orders/orders';
import type { JobOrderAssociation } from '../../../api/generated/models';
import { PermissionId } from '../../../api/generated/models';
import { financeKeys, useOperationKeys } from '../../orders/operations';
import { orderQuery } from '../../orders/queries';
import { machineLogbookKeys } from '../queries';
import { useCan } from '../shared/useCan';
import { useNotify } from '../shared/toasts';
import { errorText } from './jobDetailShared';

const KEPT = 'The order amount has not been updated; the charge keeps its price.';

/** Warning that a charged job changed, with the order page's "Refresh from job" for people allowed to edit the order. */
export function RefreshChargeNotice({ association }: { association: JobOrderAssociation }) {
  const can = useCan();
  const notify = useNotify();
  const client = useQueryClient();
  const key = useOperationKeys();
  const [error, setError] = useState<string | null>(null);
  const { orderId, orderItemId } = association;
  const canRefresh = can(PermissionId.orderswrite) && !!orderId && !!orderItemId;
  const order = useQuery({ ...orderQuery(orderId ?? ''), enabled: canRefresh });
  const mutation = useMutation({
    mutationFn: async () => {
      if (!orderId || !orderItemId || !order.data) return;
      const input = { expectedVersion: order.data.version };
      await refreshOrderItem(orderId, orderItemId, { ...input, operationKey: key(`refresh-${orderItemId}`, input) });
    },
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: machineLogbookKeys.all }),
        client.invalidateQueries({ queryKey: financeKeys }),
      ]);
      notify({ kind: 'success', title: 'Order charge refreshed', subtitle: 'The item has the job’s current price.' });
    },
    onError: (cause) => setError(errorText(cause, 'The order charge could not be refreshed.')),
  });

  return (
    <>
      <InlineNotification
        kind="warning"
        lowContrast
        hideCloseButton
        title="Changed after charge"
        subtitle={`This job changed after it was charged. ${KEPT}`}
      />
      {error && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Order charge not refreshed"
          subtitle={`${error} ${KEPT}`}
        />
      )}
      {canRefresh && (
        <div>
          <Button
            kind="tertiary"
            size="sm"
            disabled={!order.data || mutation.isPending}
            onClick={() => {
              setError(null);
              mutation.mutate();
            }}
          >
            {mutation.isPending ? 'Refreshing…' : 'Refresh order charge'}
          </Button>
        </div>
      )}
    </>
  );
}
