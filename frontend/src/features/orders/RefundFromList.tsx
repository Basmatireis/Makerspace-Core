import { InlineLoading, Modal } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { allocatedOrder } from './logic';
import { orderQuery, paymentQuery, paymentsSinceQuery } from './queries';
import { RefundOrCorrectModal } from './RefundOrCorrectModal';

/**
 * "Refund or correct…" from a list row: loads the payment, any later reversal of it and its order (for the current
 * version), then opens the same dialog as the payment page.
 */
export function RefundFromList({ paymentId, onClose }: { paymentId: string; onClose: () => void }) {
  const payment = useQuery(paymentQuery(paymentId));
  const later = useQuery({ ...paymentsSinceQuery(payment.data?.occurredAt ?? ''), enabled: !!payment.data });
  const target = payment.data ? allocatedOrder(payment.data.allocations) : null;
  const order = useQuery({ ...orderQuery(target?.id ?? ''), enabled: !!target?.id });
  const failed = payment.isError || later.isError || order.isError || (payment.data && !target);
  if (payment.data && later.data && order.data)
    return (
      <RefundOrCorrectModal
        payment={payment.data}
        reversal={later.data.find((item) => item.reversesPaymentId === paymentId)}
        order={order.data}
        onClose={onClose}
      />
    );
  return (
    <Modal open passiveModal size="sm" modalHeading="Refund or correct" onRequestClose={onClose}>
      {failed ? (
        <p>The payment or its order could not be loaded. Open the payment page to refund or correct it.</p>
      ) : (
        <InlineLoading description="Loading the payment" />
      )}
    </Modal>
  );
}
