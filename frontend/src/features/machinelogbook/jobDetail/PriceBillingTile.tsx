import { RefLink } from '../../../app/RefLink';
import { Accordion, AccordionItem, InlineNotification, Tag, Tile } from '@carbon/react';
import type { JobOrderAssociation, MachineJob, MaterialUnit } from '../../../api/generated/models';
import { unitText } from '../processConfig';
import { formatDateTime, formatMoney } from '../shared/format';
import { adjustmentSummary, BillingTag } from '../shared/status';
import { jobBilling } from './jobDetailShared';

export function PriceBillingTile({
  job,
  price,
  calculated,
  adjustmentDifference,
  association,
  canReadOrders,
}: {
  job: MachineJob;
  price: number | null;
  calculated: number | null;
  adjustmentDifference: number | null;
  association: { isError: boolean; data: JobOrderAssociation | undefined };
  canReadOrders: boolean;
}) {
  return (
    <Tile>
      <h3 className="mj-section-title">Price &amp; billing</h3>
      <div className="mj-price">{formatMoney(price)}</div>
      <div className="mj-inline">
        <BillingTag billing={jobBilling(job, association.data)} />
        {job.pricingStatus === 'pending' && <span className="mj-secondary">Price pending</span>}
      </div>
      <dl className="mj-price-details">
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
        <Accordion size="md">
          <AccordionItem title="How this was calculated">
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
      {canReadOrders && (
        <div className="mj-stack">
          <h4 className="mj-section-title">Order</h4>
          {association.isError ? (
            <p className="mj-secondary">The order could not be loaded.</p>
          ) : association.data?.orderId ? (
            <>
              <p>
                <RefLink kind="order" reference={association.data.orderReference ?? ''} id={association.data.orderId} />
              </p>
              {association.data.sourceChanged && (
                <InlineNotification
                  kind="warning"
                  lowContrast
                  hideCloseButton
                  title="Changed after charge"
                  subtitle="This job changed after it was charged. The order amount has not been updated."
                />
              )}
            </>
          ) : association.data ? (
            <p className="mj-secondary">Not on an order.</p>
          ) : null}
        </div>
      )}
    </Tile>
  );
}
