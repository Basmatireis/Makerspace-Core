import { Button, Tile } from '@carbon/react';
import { Currency } from '@carbon/icons-react';
import type { PersonalBalance } from '../../api/generated/models';
import { formatMoney } from '../orders/formatting';
import { toCents } from '../orders/money';
import { plural } from './format';

type Props = {
  balance: PersonalBalance;
  /** Payments are allowed (orders.read, payments.read and payments.record). */
  canPay: boolean;
  /** Jobs can be put on an order and paid (orders.write and orders.finalize on top). */
  canPayJobs: boolean;
  /** At least one order or job can be selected in the pay dialog. */
  hasPayable: boolean;
  onPay: () => void;
};

/** What the person owes: unpaid orders and own jobs that are on no order yet. Shown at 0.00 as well. */
export function BalanceTile({ balance, canPay, canPayJobs, hasPayable, onPay }: Props) {
  const total = toCents(balance.total);
  const orders = balance.unpaidOrders.length;
  const jobs = balance.unbilledJobs.length;
  const jobsBlocked = canPay && jobs > 0 && !canPayJobs;
  return (
    <Tile className="db-tile" aria-labelledby="db-balance-title">
      <span className="db-tile__eyebrow" id="db-balance-title">
        <Currency size={16} aria-hidden />
        Open balance
      </span>
      <p className="db-value">{formatMoney(balance.total)}</p>
      <dl className="db-balance__lines">
        <div>
          <dt>{orders === 0 ? 'Unpaid orders' : `Unpaid orders (${orders})`}</dt>
          <dd>{formatMoney(balance.unpaidOrdersTotal)}</dd>
        </div>
        <div>
          <dt>{jobs === 0 ? 'Jobs not on an order' : `${plural(jobs, 'job')} not on an order`}</dt>
          <dd>{formatMoney(balance.unbilledJobsTotal)}</dd>
        </div>
      </dl>
      {total === 0 && <p className="db-tile__meta">Nothing to pay. Thanks!</p>}
      {jobsBlocked && (
        <p className="db-tile__meta">
          Jobs without an order can only be paid by someone who may create and finalize orders.
        </p>
      )}
      {canPay && hasPayable && (
        <div className="db-tile__actions">
          <Button kind="primary" size="md" onClick={onPay}>
            Pay now
          </Button>
        </div>
      )}
    </Tile>
  );
}
