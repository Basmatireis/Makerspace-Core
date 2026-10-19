import { useState } from 'react';
import { Button, ContainedList, ContainedListItem, InlineNotification, Link as CarbonLink, Tag, Tile } from '@carbon/react';
import { Undo } from '@carbon/icons-react';
import { Link, useParams } from 'react-router-dom';
import { PageShell } from '../../../../app/PageShell';
import { EmptyState } from '../../../../app/PageState';
import { QueryBoundary } from '../../components/QueryBoundary';
import { LinkifiedText, RefLink } from '../../components/RefLink';
import { useStore } from '../../store';
import { LinkNotification } from '../components/LinkNotification';
import { RequirePermission } from '../components/RequirePermission';
import { RefundOrCorrectModal } from '../dialogs/RefundOrCorrectModal';
import { formatDateTime, formatEur, formatSignedEur } from '../format';
import { methodLabel, reasonKindLabel } from '../labels';
import { paymentHistory, paymentOrderId, reversalOptions, type OrderView } from '../logic';
import { PaymentKindTag } from '../status';
import { useSalesData } from '../useSalesData';
import '../sales.scss';

const crumbs = [{ label: 'Sales & payments', to: '/sales' }, { label: 'Payments', to: '/sales/payments' }];

function PaymentDetail({ paymentId, views }: { paymentId: string; views: OrderView[] }) {
  const store = useStore();
  const [dialog, setDialog] = useState(false);
  const payment = store.payments.find((item) => item.id === paymentId)!;
  const order = views.find((item) => item.id === paymentOrderId(payment, store.allocations, store.payments)) ?? null;
  const options = reversalOptions(payment, order, store);
  const original = payment.reversesPaymentId ? store.payments.find((item) => item.id === payment.reversesPaymentId) : undefined;
  const reversedBy = store.payments.find((item) => item.reversesPaymentId === payment.id);
  const history = paymentHistory(payment, { payments: store.payments, allocations: store.allocations, orders: store.orders });
  const signed = payment.entryKind === 'reversal' ? -payment.amount : payment.amount;
  const canReverse = store.can('payments.reverse') && store.can('payments.read');
  const actionable = options.kinds.length > 0 && options.blocker === null;

  return (
    <PageShell
      title={payment.reference} width="wide" breadcrumbs={crumbs}
      titleAdornment={<span className="mj-inline"><PaymentKindTag payment={payment} size="md" />{reversedBy && <Tag type="warm-gray" size="md">Reversed</Tag>}</span>}
      description={`${methodLabel(payment.method)} · ${formatSignedEur(signed)} · ${formatDateTime(payment.occurredAt)}`}
      actions={actionable && canReverse ? <Button kind="danger--tertiary" renderIcon={Undo} onClick={() => setDialog(true)}>Refund or correct</Button> : undefined}
    >
      <div className="mj-stack">
        {payment.entryKind === 'receipt' && !actionable && options.blocker && <InlineNotification kind="info" lowContrast hideCloseButton title="Nothing left to do with this payment" subtitle={options.blocker} />}
        {actionable && !canReverse && <InlineNotification kind="info" lowContrast hideCloseButton title="Refunds and corrections need the permission to reverse payments" subtitle="Ask someone with that permission, or switch the role in the prototype controls." />}
        {original && <LinkNotification title="This line undoes another payment" subtitle={<><RefLink reference={original.reference} id={original.id} />. {reasonKindLabel(payment.reasonKind!)}: {payment.reason}</>} label={`Open ${original.reference}`} to={`/sales/payments/${original.id}`} />}
        {reversedBy && <LinkNotification kind="warning" title="This payment was reversed" subtitle={<><RefLink reference={reversedBy.reference} id={reversedBy.id} />. {reasonKindLabel(reversedBy.reasonKind!)}: {reversedBy.reason}</>} label={`Open ${reversedBy.reference}`} to={`/sales/payments/${reversedBy.id}`} />}

        <div className="mj-detail-layout">
          <div className="mj-stack">
            <ContainedList label="What happened to this payment" kind="on-page">
              {history.map((line, index) => <ContainedListItem key={`${line.at}-${index}`}><span className="mj-cell-stack"><span><LinkifiedText text={line.text} /></span><span className="mj-secondary">{formatDateTime(line.at)}</span></span></ContainedListItem>)}
            </ContainedList>
          </div>
          <Tile>
            <h2 className="mj-section-title">Details</h2>
            <dl className="mj-facts sales-facts">
              <div><dt>Amount</dt><dd>{payment.entryKind === 'reversal' ? formatSignedEur(signed) : formatEur(signed)}</dd></div>
              <div><dt>Method</dt><dd>{methodLabel(payment.method)}</dd></div>
              <div><dt>{payment.entryKind === 'reversal' ? 'Booked at' : 'Paid'}</dt><dd>{formatDateTime(payment.occurredAt)}</dd></div>
              <div><dt>Recorded</dt><dd>{formatDateTime(payment.recordedAt)} by {payment.recordedBy}</dd></div>
              {payment.method === 'card' && <div><dt>Terminal</dt><dd>{payment.terminal}</dd></div>}
              {payment.transactionReference && <div><dt>{payment.method === 'external' ? 'Settled invoice' : 'Terminal reference'}</dt><dd>{payment.transactionReference}</dd></div>}
              <div><dt>Order</dt><dd>{order ? <RefLink reference={order.reference} id={order.id} /> : '—'}</dd></div>
              <div><dt>Customer</dt><dd>{order ? <CarbonLink as={Link} to={`/sales/orders?customer=${order.customer.id}`}>{order.customerLabel}</CarbonLink> : '—'}</dd></div>
            </dl>
          </Tile>
        </div>
      </div>
      {dialog && order && <RefundOrCorrectModal payment={payment} order={order} onClose={() => setDialog(false)} />}
    </PageShell>
  );
}

export function PaymentDetailPage() {
  const { paymentId = '' } = useParams();
  const store = useStore();
  const { query, views } = useSalesData();
  const found = store.payments.some((item) => item.id === paymentId);
  return (
    <RequirePermission permission="payments.read" title="Payment" crumbs={crumbs}>
      {query.status === 'success' && found ? <PaymentDetail paymentId={paymentId} views={views} /> : (
        <PageShell title={query.status === 'success' ? 'Payment not found' : 'Payment'} breadcrumbs={crumbs} width="wide">
          <QueryBoundary query={query} errorMessage="The payment could not be loaded.">
            <EmptyState title="This payment does not exist" description="The link may be incorrect." action={<Button kind="tertiary" as={Link} to="/sales/payments">Back to payments</Button>} />
          </QueryBoundary>
        </PageShell>
      )}
    </RequirePermission>
  );
}
