import { RefLink } from '../../../app/RefLink';
import { Accordion, AccordionItem, Button, Tag } from '@carbon/react';
import { Add, Renew } from '@carbon/icons-react';
import type { JobOrderAssociation, MachineJob, MaterialUnit } from '../../../api/generated/models';
import { StackCard } from '../../../app/components/CardList';
import { unitText } from '../processConfig';
import { formatDateTime, formatMoney } from '../shared/format';
import { adjustmentSummary } from '../shared/status';
import { RefreshChargeNotice } from './RefreshChargeNotice';

/**
 * Price & billing of a job: the price, where it is billed (or "Add to order" once the job has finished), the
 * calculated price with any adjustment, how it was calculated, and "Adjust price" at the bottom.
 */
export function PriceBillingTile({
  job,
  price,
  calculated,
  adjustmentDifference,
  association,
  canReadOrders,
  finished,
  onReprice,
  onAddToOrder,
  onAdjust,
}: {
  job: MachineJob;
  price: number | null;
  calculated: number | null;
  adjustmentDifference: number | null;
  association: { isError: boolean; data: JobOrderAssociation | undefined };
  canReadOrders: boolean;
  /** The job's runs have ended, so it can be billed. */
  finished: boolean;
  /** Set for people who may edit the job; opens the recalculation dialog. */
  onReprice?: () => void;
  /** Set for people who may write orders while the job has a recipient. */
  onAddToOrder?: () => void;
  /** Set for people who may override prices. */
  onAdjust?: () => void;
}) {
  const order = association.data;
  const billing = !canReadOrders ? null : association.isError ? (
    <span className="mj-secondary">The order could not be loaded.</span>
  ) : order?.orderId ? (
    <span className="mj-secondary">
      On order <RefLink kind="order" reference={order.orderReference ?? 'Order'} id={order.orderId} />
      {order.sourceChanged && ' · the job changed after it was charged'}
    </span>
  ) : !finished ? (
    <span className="mj-secondary">Billable once the job has finished</span>
  ) : job.pricingStatus === 'incomplete' ? (
    <span className="jobs-error-text">Price incomplete</span>
  ) : onAddToOrder && order ? (
    <Button kind="ghost" size="sm" renderIcon={Add} className="jobs-price__order" onClick={onAddToOrder}>
      Add to order
    </Button>
  ) : order ? (
    <span className="mj-secondary">Not on an order</span>
  ) : null;
  return (
    <StackCard
      title="Price & billing"
      className="jobs-price"
      action={
        onReprice && (
          <Button kind="ghost" size="sm" renderIcon={Renew} onClick={onReprice}>
            Recalculate price
          </Button>
        )
      }
    >
      <div className="jobs-price__hero">
        {job.pricingStatus === 'incomplete' && price == null ? (
          <span className="mj-secondary">Incomplete</span>
        ) : (
          formatMoney(price)
        )}
      </div>
      {billing && <div className="jobs-price__line">{billing}</div>}
      {order?.orderId && order.sourceChanged && <RefreshChargeNotice association={order} />}
      {job.pricingStatus === 'pending' && <p className="mj-secondary">Price pending until the runs end.</p>}
      <dl className="mj-price-details jobs-price__rows">
        <div>
          <dt>Calculated</dt>
          <dd>{formatMoney(calculated)}</dd>
        </div>
        {job.priceAdjustment && (
          <>
            <div>
              <dt>{adjustmentSummary(job.priceAdjustment)}</dt>
              <dd>
                {adjustmentDifference == null
                  ? '—'
                  : `${adjustmentDifference > 0 ? '+' : adjustmentDifference < 0 ? '−' : '±'}${formatMoney(Math.abs(adjustmentDifference))}`}
              </dd>
            </div>
            <div>
              <dt>Final</dt>
              <dd>
                <strong>{formatMoney(price)}</strong>
              </dd>
            </div>
            <div>
              <dt>Reason</dt>
              <dd>{job.priceAdjustment.reason}</dd>
            </div>
          </>
        )}
      </dl>
      {job.pricingSnapshot && (
        <Accordion size="md" className="jobs-price__how">
          <AccordionItem title="How this was calculated" open>
            <dl className="mj-price-details">
              <div>
                <dt>Pricing group</dt>
                <dd>{job.pricingSnapshot.pricingGroupName}</dd>
              </div>
              <div>
                <dt>Revision</dt>
                <dd>{job.pricingSnapshot.revision}</dd>
              </div>
              <div>
                <dt>Captured</dt>
                <dd>{formatDateTime(job.pricingSnapshot.capturedAt)}</dd>
              </div>
            </dl>
            <ul className="mj-rule-list">
              {job.pricingSnapshot.rules.map((rule) => (
                <li key={`${rule.kind}-${rule.selector}-${rule.label}`}>
                  <span>{rule.label}</span>
                  {rule.missing ? (
                    <Tag type="red" size="sm">
                      No rate
                    </Tag>
                  ) : (
                    <span>
                      {formatMoney(rule.rate)} /{' '}
                      {rule.kind === 'machine_measure'
                        ? `${rule.blockSize ?? 1000} ${rule.measure ?? rule.unit}`
                        : unitText(rule.unit as MaterialUnit)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </AccordionItem>
        </Accordion>
      )}
      {onAdjust && (
        <div className="jobs-price__foot">
          <Button kind="ghost" size="md" onClick={onAdjust}>
            {job.priceAdjustment ? 'Change adjustment' : 'Adjust price'}
          </Button>
        </div>
      )}
    </StackCard>
  );
}
