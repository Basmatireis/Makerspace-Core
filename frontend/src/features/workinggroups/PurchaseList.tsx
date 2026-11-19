import type { WorkingGroupBooking, WorkingGroupPurchase } from '../../api/generated/models';
import { formatCents, toCents } from '../orders/money';
import {
  COUNTS_LABEL,
  PURCHASE_BUCKETS,
  amountCents,
  bucketOf,
  countsAs,
  stageOf,
  type FinanceRow,
  type PurchaseBucket,
} from './financeModel';
import { firstName, formatDateOnly } from './taskModel';

interface Props {
  rows: readonly FinanceRow[];
  showGroup: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

const BUCKET_CLASS: Record<PurchaseBucket, string> = {
  wanted: 'wg-bk-inbox',
  approved: 'wg-bk-week',
  running: '',
  finished: 'wg-bk-done',
};

const bucketOfRow = (row: FinanceRow): PurchaseBucket =>
  row.kind === 'purchase' ? bucketOf(row.purchase) : 'finished';

const sortKey = (row: FinanceRow) => (row.kind === 'purchase' ? row.purchase.createdAt : row.booking.bookedOn);

/** Rows grouped under Waiting for approval … Finished; fixed columns, no buttons in the rows. */
export function PurchaseList({ rows, showGroup, selectedId, onSelect }: Props) {
  const sections = PURCHASE_BUCKETS.map((bucket) => ({
    ...bucket,
    items: rows.filter((row) => bucketOfRow(row) === bucket.key).sort((a, b) => sortKey(b).localeCompare(sortKey(a))),
  })).filter((section) => section.items.length > 0);

  if (sections.length === 0) return <p className="wg-empty">Nothing matches.</p>;
  const modifier = showGroup ? ' wg-prow--group' : '';
  return (
    <div className="wg-list">
      <div className={`wg-lrow wg-prow wg-lrow--head${modifier}`} aria-hidden="true">
        <span>Amount</span>
        <span>What</span>
        {showGroup && <span>Group</span>}
        <span>Stage</span>
      </div>
      {sections.map((section) => (
        <section key={section.key} aria-labelledby={`wg-pgroup-${section.key}`}>
          <h3 id={`wg-pgroup-${section.key}`} className={`wg-lweek ${BUCKET_CLASS[section.key]}`}>
            {section.label} <small>{section.items.length}</small>
          </h3>
          <ul className="wg-llist">
            {section.items.map((row) => (
              <li key={row.id}>
                {row.kind === 'purchase' ? (
                  <PurchaseRow
                    purchase={row.purchase}
                    bucket={section.key}
                    showGroup={showGroup}
                    selected={row.id === selectedId}
                    onSelect={onSelect}
                  />
                ) : (
                  <BookingRow booking={row.booking} showGroup={showGroup} />
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function PurchaseRow({
  purchase,
  bucket,
  showGroup,
  selected,
  onSelect,
}: {
  purchase: WorkingGroupPurchase;
  bucket: PurchaseBucket;
  showGroup: boolean;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const stage = stageOf(purchase);
  const counts = countsAs(purchase);
  const who = purchase.requester ? firstName(purchase.requester) : 'Former member';
  const how = purchase.how === 'self' ? 'buys it, gets the money back' : 'collective order';
  return (
    <button
      type="button"
      className={`wg-lrow wg-prow${showGroup ? ' wg-prow--group' : ''} ${BUCKET_CLASS[bucket]}${selected ? ' is-selected' : ''}`}
      aria-pressed={selected}
      onClick={() => onSelect(purchase.id)}
    >
      <span className="wg-pamount">
        <strong>{formatCents(amountCents(purchase))}</strong>
        <small>{COUNTS_LABEL[counts]}</small>
      </span>
      <span className="wg-lwhat">
        <span className="wg-lwhat__title">{purchase.item}</span>
        <small>
          {purchase.quantity} × · {who} · {how}
          {purchase.hasReceipt ? ' · receipt attached' : ''}
        </small>
      </span>
      {showGroup && <span className="wg-lfrom">{purchase.groupName}</span>}
      <span
        className={`wg-track${stage.declined ? ' is-declined' : ''}${stage.index === stage.steps.length - 1 && !stage.declined ? ' is-done' : ''}`}
        role="img"
        aria-label={`Stage: ${stage.label}, step ${stage.index + 1} of ${stage.steps.length}`}
      >
        <span className="wg-track__bar" aria-hidden="true">
          {stage.steps.map((step, index) => (
            <i key={step} className={index < stage.index ? 'is-past' : index === stage.index ? 'is-now' : ''} />
          ))}
        </span>
        <span className="wg-track__l" aria-hidden="true">
          {stage.label}
        </span>
      </span>
    </button>
  );
}

function BookingRow({ booking, showGroup }: { booking: WorkingGroupBooking; showGroup: boolean }) {
  return (
    <div className={`wg-lrow wg-prow wg-prow--static${showGroup ? ' wg-prow--group' : ''} wg-bk-done`}>
      <span className="wg-pamount">
        <strong>{formatCents(toCents(booking.amount))}</strong>
        <small>{COUNTS_LABEL.spent}</small>
      </span>
      <span className="wg-lwhat">
        <span className="wg-lwhat__title">{booking.text}</span>
        <small>Booked directly · {formatDateOnly(booking.bookedOn)}</small>
      </span>
      {showGroup && <span className="wg-lfrom">{booking.groupName}</span>}
      <span className="wg-muted">–</span>
    </div>
  );
}
