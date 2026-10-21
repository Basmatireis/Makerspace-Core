import { Fragment, useMemo, useState, type ComponentProps, type ComponentType, type ReactNode } from 'react';
import {
  Button,
  ClickableTile as CarbonClickableTile,
  ContainedList,
  ContainedListItem,
  SkeletonText,
  Tag,
} from '@carbon/react';
import { ArrowRight, Calculator } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { PageShell } from '../../app/PageShell';
import { ErrorState } from '../../app/PageState';
import { RefLink } from '../../app/RefLink';
import { formatDateTime } from '../../app/dateTime';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { requestStateLabel } from './labels';
import { PriceLookupModal } from './PriceLookupModal';
import {
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
import { OrderStatusTag } from './status';
import './sales.scss';
import '../machinelogbook/shared/shared.scss';
import '../machinelogbook/styles/overview.scss';

type Attention = {
  key: string;
  title: ReactNode;
  detail: string;
  to: string;
  tag: { label: string; type: 'warm-gray' | 'blue' | 'green' | 'purple' | 'red' };
};
type RouterClickableTileProps = Omit<ComponentProps<typeof CarbonClickableTile>, 'href'> & {
  as: typeof Link;
  to: string;
};
// Carbon's ClickableTile forwards polymorphic Link props at runtime, but its public type omits them.
const ClickableTile = CarbonClickableTile as ComponentType<RouterClickableTileProps>;
const daysOld = (iso: string) => Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);

export function SalesOverviewPage() {
  const user = useCurrentUser();
  const navigate = useNavigate();
  const can = (permission: PermissionId) => hasPermission(user, permission);
  const [lookupOpen, setLookupOpen] = useState(false);
  const canOrders = can(PermissionId.ordersread);
  const canPayments = can(PermissionId.paymentsread);
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

  const attention: Attention[] = [
    ...(canApprove
      ? toApprove.slice(0, 4).map((order): Attention => ({
          key: `approve-${order.id}`,
          title: (
            <>
              {order.activeExternalRequestReference} ·{' '}
              <RefLink reference={order.reference} id={order.id} kind="order" /> · {customerLabel(order)}
            </>
          ),
          detail: `${formatCents(toCents(order.netCharge))}. Check the data, then approve and forward it to wiRef or return it.`,
          to: `/orders/${order.id}`,
          tag: { label: 'To approve', type: 'purple' },
        }))
      : []),
    ...list
      .filter((order) => isStaleDraft(order))
      .map((order): Attention => ({
        key: `old-${order.id}`,
        title: (
          <>
            <RefLink reference={order.reference} id={order.id} kind="order" /> · {customerLabel(order)}
          </>
        ),
        detail: `Draft untouched for ${daysOld(order.updatedAt)} days. Finalize or cancel it.`,
        to: `/orders/${order.id}`,
        tag: { label: 'Old draft', type: 'warm-gray' },
      })),
    ...awaiting
      .filter((order) => !order.activeExternalRequestId)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(0, 3)
      .map((order): Attention => ({
        key: `await-${order.id}`,
        title: (
          <>
            <RefLink reference={order.reference} id={order.id} kind="order" /> · {customerLabel(order)}
          </>
        ),
        detail: `${formatCents(toCents(order.outstandingAmount))} outstanding of ${formatCents(toCents(order.netCharge))}`,
        to: `/orders/${order.id}`,
        tag: {
          label: order.settlementState === 'partially_paid' ? 'Partially paid' : 'Awaiting payment',
          type: 'blue',
        },
      })),
    ...groups
      .filter((group) => group.ready.length > 0)
      .slice(0, 3)
      .map((group): Attention => ({
        key: `ready-${group.key}`,
        title: group.customer?.displayName ?? 'No customer',
        detail: `${group.ready.length} ${group.ready.length === 1 ? 'job' : 'jobs'} ready to bill · ${formatCents(group.total)}`,
        to: '/orders?review=1',
        tag: { label: 'Ready to bill', type: 'green' },
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
        title: (
          <>
            {order.activeExternalRequestReference} · <RefLink reference={order.reference} id={order.id} kind="order" />{' '}
            · {customerLabel(order)}
          </>
        ),
        detail: requestStateLabel[order.activeExternalRequestState as keyof typeof requestStateLabel] ?? '',
        to: `/orders/${order.id}`,
        tag: { label: 'Invoice', type: 'purple' },
      })),
  ];

  const loadingOrders = canOrders && orders.isPending;
  const tiles: { key: string; label: string; value: string; detail: string; to: string; loading: boolean }[] = [
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
            value: String(awaiting.length),
            detail: awaiting.length
              ? `${formatCents(sumCents(awaiting.map((order) => order.outstandingAmount)))} outstanding`
              : 'Everything is paid',
            to: '/orders?status=awaiting',
            loading: loadingOrders,
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
              <Button kind="tertiary" renderIcon={Calculator} onClick={() => setLookupOpen(true)}>
                Price lookup
              </Button>
            )}
            {can(PermissionId.orderswrite) && (
              <Button as={Link} to="/orders" kind="primary">
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
        <div className="mj-overview">
          <section aria-label="Key figures" className="mj-overview__metrics">
            {tiles.map((tile) => (
              <ClickableTile key={tile.key} as={Link} to={tile.to} renderIcon={ArrowRight} className="mj-metric">
                <span className="mj-metric__label">{tile.label}</span>
                {tile.loading ? (
                  <SkeletonText heading width="5rem" />
                ) : (
                  <span className="mj-metric__value">{tile.value}</span>
                )}
                <span className="mj-secondary">{tile.loading ? '' : tile.detail}</span>
              </ClickableTile>
            ))}
          </section>
          {canOrders && (
            <div className="mj-overview__panels">
              <ContainedList
                label="Needs attention"
                kind="on-page"
                className="mj-overview__panel"
                action={
                  <Button as={Link} to="/orders" kind="ghost" size="sm" renderIcon={ArrowRight}>
                    All orders
                  </Button>
                }
              >
                {attentionLoading && (
                  <ContainedListItem>
                    <SkeletonText paragraph lineCount={3} />
                  </ContainedListItem>
                )}
                {!attentionLoading && attention.length === 0 && (
                  <ContainedListItem>Nothing needs attention right now.</ContainedListItem>
                )}
                {!attentionLoading &&
                  attention.map((item) => (
                    <Fragment key={item.key}>
                      <ContainedListItem
                        onClick={() => navigate(item.to)}
                        action={
                          <Tag type={item.tag.type} size="sm">
                            {item.tag.label}
                          </Tag>
                        }
                      >
                        <span className="mj-cell-stack">
                          <strong>{item.title}</strong>
                          <span className="mj-secondary">{item.detail}</span>
                        </span>
                      </ContainedListItem>
                    </Fragment>
                  ))}
              </ContainedList>
              <ContainedList label="Recent orders" kind="on-page" className="mj-overview__panel">
                {orders.isPending && (
                  <ContainedListItem>
                    <SkeletonText paragraph lineCount={3} />
                  </ContainedListItem>
                )}
                {!orders.isPending && recent.length === 0 && <ContainedListItem>No orders yet.</ContainedListItem>}
                {!orders.isPending &&
                  recent.map((order) => (
                    <ContainedListItem
                      key={order.id}
                      onClick={() => navigate(`/orders/${order.id}`)}
                      action={<OrderStatusTag order={order} size="sm" />}
                    >
                      <span className="mj-cell-stack">
                        <strong>
                          <RefLink reference={order.reference} id={order.id} /> ·{' '}
                          {formatCents(toCents(order.totalAmount))}
                        </strong>
                        <span className="mj-secondary">
                          {customerLabel(order)} · {formatDateTime(order.updatedAt)}
                        </span>
                      </span>
                    </ContainedListItem>
                  ))}
              </ContainedList>
            </div>
          )}
        </div>
      )}
      {lookupOpen && <PriceLookupModal onClose={() => setLookupOpen(false)} />}
    </PageShell>
  );
}
