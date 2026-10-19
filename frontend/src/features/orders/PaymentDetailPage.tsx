import { useState } from 'react';
import { Button, ContainedList, ContainedListItem, Link as CarbonLink, Tag, Tile } from '@carbon/react';
import { Printer, Undo } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { OrderPayment } from '../../api/generated/models';
import { PageShell } from '../../app/PageShell';
import { ErrorState, FullPageLoading } from '../../app/PageState';
import { RefLink } from '../../app/RefLink';
import { RichNotification } from '../../app/RichNotification';
import { formatDateTime } from '../../app/dateTime';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { methodLabel, reasonKindLabel } from './labels';
import { allocatedOrder, canPrintReceipt, customerLabel, describePaymentHistory, reversalOptions } from './logic';
import { formatCents, formatSignedCents, toCents } from './money';
import { orderQuery, paymentQuery, paymentsSinceQuery } from './queries';
import { RefundOrCorrectModal } from './RefundOrCorrectModal';
import { PaymentKindTag } from './status';
import './sales.scss';
import '../machinelogbook/shared/shared.scss';

const crumbs = [{ label: 'Sales & payments', to: '/sales' }, { label: 'Payments', to: '/payments' }];

export function PaymentDetailPage() {
  const { paymentId = '' } = useParams();
  const query = useQuery(paymentQuery(paymentId));
  if (query.isPending) return <FullPageLoading label="Loading payment" />;
  if (query.isError) return <PageShell title="Payment" breadcrumbs={crumbs} width="wide"><ErrorState message="The payment could not be loaded." onRetry={() => query.refetch()} /></PageShell>;
  return <PaymentDetail key={query.data.id} payment={query.data} />;
}

function PaymentDetail({ payment }: { payment: OrderPayment }) {
  const user = useCurrentUser();
  const navigate = useNavigate();
  const [dialog, setDialog] = useState(false);
  const isReversal = payment.entryKind === 'reversal';
  const canOrders = hasPermission(user, PermissionId.ordersread);
  const canReverse = hasPermission(user, PermissionId.paymentsreverse);
  // A reversal's allocations belong to the receipt it undoes.
  const original = useQuery({ ...paymentQuery(payment.reversesPaymentId ?? ''), enabled: isReversal && !!payment.reversesPaymentId });
  const later = useQuery({ ...paymentsSinceQuery(payment.occurredAt), enabled: !isReversal });
  const reversedBy = isReversal ? undefined : (later.data ?? []).find((item) => item.reversesPaymentId === payment.id);
  const source = isReversal ? original.data : payment;
  const target = source ? allocatedOrder(source.allocations) : null;
  const order = useQuery({ ...orderQuery(target?.id ?? ''), enabled: !!target?.id && canOrders });
  // A receipt is for money received that still counts for a finalized order; the order itself needs orders.read.
  const canReceipt = !isReversal && !reversedBy && canOrders && !!order.data && canPrintReceipt(order.data) && order.data.allocations.some((entry) => entry.paymentId === payment.id && toCents(entry.amount) > 0);
  const options = reversalOptions(payment, reversedBy, order.data ?? null);
  const actionable = options.kinds.length > 0 && options.blocker === null;
  const signed = isReversal ? -toCents(payment.amount) : toCents(payment.amount);
  const history = describePaymentHistory(payment, original.data, reversedBy, formatDateTime);

  return (
    <PageShell
      className="sales-page" title={payment.reference} width="wide" breadcrumbs={crumbs}
      titleAdornment={<span className="mj-inline"><PaymentKindTag payment={payment} size="md" />{reversedBy && <Tag type="warm-gray" size="md">Reversed</Tag>}</span>}
      description={`${methodLabel(payment.method)} · ${formatSignedCents(signed)} · ${formatDateTime(payment.occurredAt)}`}
      actions={<>
        {canReceipt && order.data && <Button kind="tertiary" renderIcon={Printer} onClick={() => navigate(`/orders/${order.data.id}/receipt?payment=${payment.id}`)}>Print receipt</Button>}
        {actionable && canReverse && order.data && <Button kind="danger--tertiary" renderIcon={Undo} onClick={() => setDialog(true)}>Refund or correct</Button>}
      </>}
    >
      <div className="mj-stack">
        {payment.entryKind === 'receipt' && !actionable && options.blocker && order.data && <RichNotification kind="info" title="Nothing left to do with this payment">{options.blocker}</RichNotification>}
        {actionable && !canReverse && <RichNotification kind="info" title="Refunds and corrections need the permission to reverse payments">Ask someone who has it.</RichNotification>}
        {isReversal && payment.reversesPaymentId && <RichNotification kind="info" title="This line undoes another payment"><RefLink reference={payment.reversedPaymentReference ?? ''} id={payment.reversesPaymentId} kind="payment" />. {reasonKindLabel(payment.reasonKind)}: {payment.reason}</RichNotification>}
        {reversedBy && <RichNotification kind="warning" title="This payment was reversed"><RefLink reference={reversedBy.reference} id={reversedBy.id} kind="payment" />. {reasonKindLabel(reversedBy.reasonKind)}: {reversedBy.reason}</RichNotification>}
        <div className="mj-detail-layout">
          <div className="mj-stack">
            <ContainedList label="What happened to this payment" kind="on-page">
              {history.map((line, index) => <ContainedListItem key={`${line.at}-${index}`}><span className="mj-cell-stack"><span>{line.text}</span><span className="mj-secondary">{formatDateTime(line.at)}</span></span></ContainedListItem>)}
            </ContainedList>
          </div>
          <Tile>
            <h2 className="mj-section-title">Details</h2>
            <dl className="mj-facts sales-facts">
              <div><dt>Amount</dt><dd>{isReversal ? formatSignedCents(signed) : formatCents(signed)}</dd></div>
              <div><dt>Method</dt><dd>{methodLabel(payment.method)}</dd></div>
              <div><dt>{isReversal ? 'Booked at' : 'Paid'}</dt><dd>{formatDateTime(payment.occurredAt)}</dd></div>
              <div><dt>Recorded</dt><dd>{formatDateTime(payment.recordedAt)}{payment.recordedBy ? ` by ${payment.recordedBy.displayName}` : ''}</dd></div>
              {payment.method === 'card' && payment.externalSource && <div><dt>Terminal</dt><dd>{payment.externalSource}</dd></div>}
              {payment.externalReference && <div><dt>{payment.method === 'external' ? 'Settled invoice' : 'Terminal reference'}</dt><dd>{payment.externalReference}</dd></div>}
              <div><dt>Order</dt><dd>{target ? <RefLink reference={target.reference} id={target.id} kind="order" /> : '—'}</dd></div>
              {order.data?.customer && <div><dt>Customer</dt><dd><CarbonLink as={Link} to={`/orders?customer=${order.data.customer.id}`}>{customerLabel(order.data)}</CarbonLink></dd></div>}
            </dl>
          </Tile>
        </div>
      </div>
      {dialog && order.data && <RefundOrCorrectModal payment={payment} reversal={reversedBy} order={order.data} onClose={() => setDialog(false)} />}
    </PageShell>
  );
}
