import { useMemo, useState, type ComponentProps, type ComponentType, type ReactNode } from 'react';
import { Button, ClickableTile as CarbonClickableTile, SkeletonText, Tag } from '@carbon/react';
import { Add, ArrowRight, Calculator } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { Order } from '../../api/generated/models';
import { CardList, StackCard } from '../../app/components/CardList';
import { PageShell } from '../../app/PageShell';
import { ErrorState } from '../../app/PageState';
import { formatDateTime } from '../../app/dateTime';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { requestStateLabel } from './labels';
import { PriceLookupModal } from './PriceLookupModal';
import {
  acceptsCashAndCard,
  customerLabel,
  invoiceKey,
  isAwaitingPayment,
  isStaleDraft,
  periodRange,
  readyToBillGroups,
  readyTotals,
  takings,
} from './logic';
import { formatCents, sumCents, toCents } from './money';
import { allOrdersQuery, cashRegisterQuery, periodPaymentsQuery, readyToBillQuery } from './queries';
import { RecordPaymentModal } from './RecordPaymentModal';
import { OrderStatusTag } from './status';
import './sales.scss';

type Attention = {
  key: string;
  title: string;
  detail: string;
  to: string;
  tag: { label: string; type: 'warm-gray' | 'blue' | 'green' | 'purple' | 'red' };
  /** The one action at the end of the row; without one the row offers "Open". */
  action?: ReactNode;
};
type Kpi = { key: string; label: string; value: string; detail: string; to: string; loading: boolean; warn?: boolean };
type RouterClickableTileProps = Omit<ComponentProps<typeof CarbonClickableTile>, 'href'> & {
  as: typeof Link;
  to: string;
};
// Carbon's ClickableTile forwards polymorphic Link props at runtime, but its public type omits them.
const ClickableTile = CarbonClickableTile as ComponentType<RouterClickableTileProps>;
const daysOld = (iso: string) => Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
const ordersOf = (count: number) => `${count} ${count === 1 ? 'order' : 'orders'}`;

export function SalesOverviewPage() {
  const user = useCurrentUser();
  const can = (permission: PermissionId) => hasPermission(user, permission);
  const [lookupOpen, setLookupOpen] = useState(false);
  const [paying, setPaying] = useState<Order | null>(null);
  const canOrders = can(PermissionId.ordersread);
  const canPayments = can(PermissionId.paymentsread);
  const canRecord = canPayments && can(PermissionId.paymentsrecord);
  const canRegister = canPayments && can(PermissionId.cash_movementsread);
  const canApprove = can(PermissionId.external_invoice_requestsapprove) && canOrders;
  const canReadJobs = can(PermissionId.machine_jobsread) && canOrders;
  // Fixed for the lifetime of the page so the payments query key does not change at midnight.
  const today = useMemo(() => periodRange('today'), []);
  const orders = useQuery({ ...allOrdersQuery(), enabled: canOrders });
  const payments = useQuery({
    ...periodPaymentsQuery(new Date(today.from).toISOString(), new Date(today.to).toISOString()),
    enabled: canPayments,
  });
  const register = useQuery({ ...cashRegisterQuery(), enabled: canRegister });
  const jobs = useQuery({ ...readyToBillQuery(), enabled: canReadJobs });

  const list = orders.data ?? [];
  const groups = readyToBillGroups(jobs.data ?? []);
  const ready = readyTotals(groups);
  const awaiting = list.filter(isAwaitingPayment);
  const toApprove = list.filter((order) => order.status === 'finalized' && invoiceKey(order) === 'submitted');
  const net = takings(payments.data ?? []);
  const recent = [...list]
    .filter((order) => order.status !== 'draft' && order.status !== 'cancelled')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 8);
  const open = (to: string) => (
    <Button as={Link} to={to} kind="ghost" size="sm">
      Open
    </Button>
  );

  const attention: Attention[] = [
    ...(canApprove
      ? toApprove.slice(0, 4).map((order): Attention => ({
          key: `approve-${order.id}`,
          title: `${order.activeExternalRequestReference} · ${customerLabel(order)}`,
          detail: `${formatCents(toCents(order.netCharge))} · ${order.reference}. Check the data, then approve and forward it to wiRef or return it.`,
          to: `/orders/${order.id}`,
          tag: { label: 'To approve', type: 'purple' },
          action: (
            <Button as={Link} to={`/orders/${order.id}`} kind="ghost" size="sm">
              Review
            </Button>
          ),
        }))
      : []),
    ...awaiting
      .filter((order) => !order.activeExternalRequestId)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(0, 3)
      .map((order): Attention => ({
        key: `await-${order.id}`,
        title: `${order.reference} · ${customerLabel(order)}`,
        detail: `${formatCents(toCents(order.outstandingAmount))} outstanding of ${formatCents(toCents(order.netCharge))}`,
        to: `/orders/${order.id}`,
        tag: {
          label: order.settlementState === 'partially_paid' ? 'Partially paid' : 'Awaiting payment',
          type: 'blue',
        },
        action:
          canRecord && acceptsCashAndCard(order) ? (
            <Button kind="ghost" size="sm" onClick={() => setPaying(order)}>
              Take payment
            </Button>
          ) : undefined,
      })),
    ...list
      .filter((order) => isStaleDraft(order))
      .map((order): Attention => ({
        key: `old-${order.id}`,
        title: `${order.reference} · ${customerLabel(order)}`,
        detail: `Draft untouched for ${daysOld(order.updatedAt)} days · ${formatCents(toCents(order.totalAmount))}. Finalize or cancel it.`,
        to: `/orders/${order.id}`,
        tag: { label: 'Old draft', type: 'warm-gray' },
      })),
    ...groups
      .filter((group) => group.ready.length > 0)
      .slice(0, 3)
      .map((group): Attention => ({
        key: `ready-${group.key}`,
        title: group.customer?.displayName ?? 'No customer',
        detail: `${group.ready.length} finished ${group.ready.length === 1 ? 'job' : 'jobs'} not on an order · ${formatCents(group.total)}`,
        to: '/orders?review=1',
        tag: { label: 'Ready to bill', type: 'green' },
        action: (
          <Button as={Link} to="/orders?review=1" kind="ghost" size="sm">
            Review jobs
          </Button>
        ),
      })),
    ...list
      .filter(
        (order) =>
          order.status === 'finalized' &&
          order.activeExternalRequestId &&
          !(canApprove && invoiceKey(order) === 'submitted') &&
          !(invoiceKey(order) === 'issued' && !isAwaitingPayment(order)),
      )
      .slice(0, 4)
      .map((order): Attention => ({
        key: `invoice-${order.id}`,
        title: `${order.activeExternalRequestReference} · ${order.reference} · ${customerLabel(order)}`,
        detail: requestStateLabel[order.activeExternalRequestState as keyof typeof requestStateLabel] ?? '',
        to: `/orders/${order.id}`,
        tag: { label: 'Invoice', type: 'purple' },
      })),
  ];

  const loadingOrders = canOrders && orders.isPending;
  const tiles: Kpi[] = [
    ...(canRegister
      ? [
          {
            key: 'register',
            label: 'Cash in register (expected)',
            value: formatCents(toCents(register.data?.expected)),
            detail: 'Cash receipts − refunds − withdrawals + deposits',
            to: '/payments',
            loading: register.isPending,
          },
        ]
      : []),
    ...(canPayments
      ? [
          {
            key: 'today',
            label: 'Takings today',
            value: formatCents(net.total),
            detail: [
              `Cash ${formatCents(net.cash)}`,
              `Card ${formatCents(net.card)}`,
              ...(net.external ? [`Invoice ${formatCents(net.external)}`] : []),
            ].join(' · '),
            to: '/payments',
            loading: payments.isPending,
          },
        ]
      : []),
    ...(canOrders
      ? [
          {
            key: 'awaiting',
            label: 'Awaiting payment',
            value: formatCents(sumCents(awaiting.map((order) => order.outstandingAmount))),
            detail: awaiting.length ? `${ordersOf(awaiting.length)} open` : 'Everything is paid',
            to: '/orders?status=awaiting',
            loading: loadingOrders,
            warn: awaiting.length > 0,
          },
        ]
      : []),
    ...(canApprove
      ? [
          {
            key: 'approve',
            label: 'Invoices to approve',
            value: String(toApprove.length),
            detail: toApprove.length
              ? `${formatCents(sumCents(toApprove.map((order) => order.netCharge)))} awaiting approval`
              : 'Nothing awaits approval',
            to: '/orders?invoice=submitted',
            loading: loadingOrders,
            warn: toApprove.length > 0,
          },
        ]
      : []),
    ...(canReadJobs
      ? [
          {
            key: 'ready',
            label: 'Jobs ready to bill',
            value: String(ready.jobs),
            detail: ready.jobs
              ? `${formatCents(ready.total)} · ${ready.customers} ${ready.customers === 1 ? 'customer' : 'customers'}`
              : 'No finished job waits',
            to: '/orders?review=1',
            loading: jobs.isPending,
          },
        ]
      : []),
  ];
  const failed = orders.isError || payments.isError || register.isError || jobs.isError;
  const attentionLoading = canOrders && (orders.isPending || (canReadJobs && jobs.isPending));

  return (
    <PageShell
      className="sales-page"
      title="Sales overview"
      width="wide"
      breadcrumbs={[{ label: 'Sales & payments' }]}
      description="What is in the register, what is open and what needs you."
      actions={
        can(PermissionId.pricingread) || can(PermissionId.orderswrite) ? (
          <>
            {can(PermissionId.pricingread) && (
              <Button kind="secondary" renderIcon={Calculator} onClick={() => setLookupOpen(true)}>
                Price lookup
              </Button>
            )}
            {can(PermissionId.orderswrite) && (
              <Button as={Link} to="/orders" kind="primary" renderIcon={Add}>
                New order
              </Button>
            )}
          </>
        ) : undefined
      }
    >
      {failed ? (
        <ErrorState
          message="The sales overview could not be loaded."
          onRetry={() => {
            void Promise.all([orders.refetch(), payments.refetch(), register.refetch(), jobs.refetch()]);
          }}
        />
      ) : (
        <div className="sales-stack">
          <section aria-label="Key figures" className="sales-kpis">
            {tiles.map((tile) => (
              <ClickableTile
                key={tile.key}
                as={Link}
                to={tile.to}
                renderIcon={ArrowRight}
                className={`sales-kpi${tile.warn ? ' sales-kpi--warn' : ''}`}
              >
                <span className="sales-kpi__label">{tile.label}</span>
                {tile.loading ? (
                  <SkeletonText heading width="5rem" />
                ) : (
                  <span className="sales-kpi__value">{tile.value}</span>
                )}
                <span className="sales-secondary">{tile.loading ? '' : tile.detail}</span>
              </ClickableTile>
            ))}
          </section>
          {canOrders && (
            <div className="sales-two-col">
              {attentionLoading ? (
                <StackCard title="Needs attention">
                  <SkeletonText paragraph lineCount={4} />
                </StackCard>
              ) : (
                <CardList
                  title="Needs attention"
                  count={attention.length}
                  emptyText="Nothing needs attention right now."
                  items={attention.map((item) => ({
                    id: item.key,
                    title: item.title,
                    description: item.detail,
                    aside: (
                      <>
                        <Tag type={item.tag.type} size="sm">
                          {item.tag.label}
                        </Tag>
                        {item.action ?? open(item.to)}
                      </>
                    ),
                  }))}
                />
              )}
              {orders.isPending ? (
                <StackCard title="Recent orders">
                  <SkeletonText paragraph lineCount={4} />
                </StackCard>
              ) : (
                <CardList
                  title="Recent orders"
                  emptyText="No orders yet."
                  action={
                    <Button as={Link} to="/orders" kind="ghost" size="sm" renderIcon={ArrowRight}>
                      All orders
                    </Button>
                  }
                  items={recent.map((order) => ({
                    id: order.id,
                    to: `/orders/${order.id}`,
                    title: `${order.reference} · ${customerLabel(order)}`,
                    description: `${formatCents(toCents(order.totalAmount))} · ${formatDateTime(order.updatedAt)}`,
                    aside: <OrderStatusTag order={order} size="sm" />,
                  }))}
                />
              )}
            </div>
          )}
        </div>
      )}
      {lookupOpen && <PriceLookupModal onClose={() => setLookupOpen(false)} />}
      {paying && <RecordPaymentModal order={paying} mode="record" onClose={() => setPaying(null)} />}
    </PageShell>
  );
}
