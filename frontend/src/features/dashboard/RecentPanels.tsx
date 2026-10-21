import {
  Button,
  ContainedList,
  ContainedListItem,
  Link as CarbonLink,
  OverflowMenu,
  OverflowMenuItem,
  Tag,
} from '@carbon/react';
import { ArrowRight } from '@carbon/icons-react';
import { Link } from 'react-router-dom';
import type { PersonalOrder, PersonalRecentJob } from '../../api/generated/models';
import { formatDate } from '../../app/dateTime';
import { formatMoney } from '../orders/formatting';
import { toCents } from '../orders/money';
import { JobRowStatusTag } from '../machinelogbook/shared/status';
import { machineLogbookPaths } from '../machinelogbook/shared/paths';

function EmptyRow({ children }: { children: string }) {
  return (
    <ContainedListItem>
      <span className="db-panel__empty">{children}</span>
    </ContainedListItem>
  );
}

/** The last five jobs: the person's own and the ones they ran for someone else. */
export function RecentJobsPanel({ jobs }: { jobs: PersonalRecentJob[] }) {
  return (
    <ContainedList
      label="Recent jobs"
      kind="on-page"
      className="db-panel db-panel--tags"
      action={
        <Button as={Link} to={machineLogbookPaths.jobs()} kind="ghost" size="sm" renderIcon={ArrowRight}>
          All jobs
        </Button>
      }
    >
      {jobs.length === 0 ? (
        <EmptyRow>No jobs yet. Your own jobs and the ones you run for others show up here.</EmptyRow>
      ) : (
        jobs.map((job) => {
          const facts = [
            job.own ? null : 'Run for someone else',
            job.machineName,
            formatDate(job.endedAt ?? job.startedAt ?? ''),
            job.own && job.price !== null ? formatMoney(job.price) : null,
            job.own && job.orderReference ? `on ${job.orderReference}` : null,
            job.own && job.billingState === 'not_on_order' ? 'not on an order yet' : null,
          ]
            .filter(Boolean)
            .join(' · ');
          return (
            <ContainedListItem key={job.id} action={<JobRowStatusTag status={job.status} size="sm" />}>
              <div className="db-item">
                <span className="db-item__title">
                  <CarbonLink as={Link} to={machineLogbookPaths.job(job.id)}>
                    {job.title || job.displayId}
                  </CarbonLink>{' '}
                  <span className="db-item__meta">{job.displayId}</span>
                </span>
                <span className="db-item__meta">{facts}</span>
              </div>
            </ContainedListItem>
          );
        })
      )}
    </ContainedList>
  );
}

function OrderTag({ order }: { order: PersonalOrder }) {
  if (order.status === 'reversed')
    return (
      <Tag type="gray" size="sm">
        Reversed
      </Tag>
    );
  if (order.invoiced)
    return (
      <Tag type="teal" size="sm">
        Invoiced
      </Tag>
    );
  switch (order.settlementState) {
    case 'unpaid':
      return (
        <Tag type="red" size="sm">
          Unpaid
        </Tag>
      );
    case 'partially_paid':
      return (
        <Tag type="magenta" size="sm">
          Partly paid
        </Tag>
      );
    case 'paid':
      return (
        <Tag type="green" size="sm">
          Paid
        </Tag>
      );
    default:
      return (
        <Tag type="gray" size="sm">
          Free
        </Tag>
      );
  }
}

type OrdersProps = {
  orders: PersonalOrder[];
  /** Ids of orders that can be paid from the dashboard right now. */
  payableIds: ReadonlySet<string>;
  onPay: (order: PersonalOrder) => void;
};

/** The last five orders; an unpaid one can be paid on its own from its menu. */
export function RecentOrdersPanel({ orders, payableIds, onPay }: OrdersProps) {
  return (
    <ContainedList
      label="Recent orders"
      kind="on-page"
      className="db-panel db-panel--tags"
      action={
        <Button as={Link} to="/orders" kind="ghost" size="sm" renderIcon={ArrowRight}>
          All orders
        </Button>
      }
    >
      {orders.length === 0 ? (
        <EmptyRow>No orders yet.</EmptyRow>
      ) : (
        orders.map((order) => {
          const open = toCents(order.outstandingAmount);
          const partly = open > 0 && open < toCents(order.netCharge);
          return (
            <ContainedListItem
              key={order.id}
              action={
                <div className="db-panel__actions">
                  <OrderTag order={order} />
                  {order.payable && payableIds.has(order.id) && (
                    <OverflowMenu iconDescription={`Actions for ${order.reference}`} size="sm" flipped>
                      <OverflowMenuItem
                        itemText={`Pay ${formatMoney(order.outstandingAmount)}`}
                        onClick={() => onPay(order)}
                      />
                    </OverflowMenu>
                  )}
                </div>
              }
            >
              <div className="db-item">
                <span className="db-item__title">
                  <CarbonLink as={Link} to={`/orders/${order.id}`}>
                    {order.reference}
                  </CarbonLink>{' '}
                  <span className="db-item__meta">{order.itemSummary}</span>
                </span>
                <span className="db-item__meta">
                  {formatDate(order.createdAt)} · {formatMoney(order.netCharge)}
                  {partly ? ` · ${formatMoney(order.outstandingAmount)} open` : ''}
                </span>
              </div>
            </ContainedListItem>
          );
        })
      )}
    </ContainedList>
  );
}
