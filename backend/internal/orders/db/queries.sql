-- name: NextOrderReference :one
SELECT nextval('order_reference_sequence')::bigint;
-- name: NextPaymentReference :one
SELECT nextval('payment_reference_sequence')::bigint;
-- name: NextAdjustmentReference :one
SELECT nextval('order_adjustment_reference_sequence')::bigint;
-- name: NextRequestReference :one
SELECT nextval('external_invoice_request_reference_sequence')::bigint;
-- name: LockOperation :exec
SELECT pg_advisory_xact_lock(hashtextextended(sqlc.arg(operation_key)::text,0));
-- name: GetOperation :one
SELECT * FROM order_operations WHERE operation_key=$1;
-- name: SaveOperation :exec
INSERT INTO order_operations(id,operation_key,kind,request_fingerprint,actor_account_id,order_id,payment_id,request_id)
VALUES($1,$2,$3,$4,$5,$6,$7,$8);
-- name: CreateOrder :one
INSERT INTO orders(id,reference,customer_kind,customer_person_id,customer_organization_id,created_by_account_id,replaces_order_id,replaces_order_reference)
VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *;
-- name: GetOrder :one
SELECT * FROM orders WHERE id=$1;
-- name: LockOrder :one
SELECT * FROM orders WHERE id=$1 FOR UPDATE;
-- name: UpdateDraft :one
UPDATE orders SET customer_kind=$2,customer_person_id=$3,customer_organization_id=$4,version=version+1,updated_at=now() WHERE id=$1 RETURNING *;
-- name: BumpOrder :exec
UPDATE orders SET version=version+1,updated_at=now() WHERE id=$1;
-- name: TransitionOrder :exec
UPDATE orders SET status=$2,total_amount=$3,version=version+1,updated_at=now(),
finalized_at=CASE WHEN $2::text='finalized' THEN now() ELSE finalized_at END,
cancelled_at=CASE WHEN $2::text='cancelled' THEN now() ELSE cancelled_at END,
reversed_at=CASE WHEN $2::text='reversed' THEN now() ELSE reversed_at END WHERE id=$1;
-- name: ListOrders :many
SELECT o.* FROM orders o LEFT JOIN order_customer_snapshots cs ON cs.order_id=o.id
WHERE (sqlc.arg(search)::text='' OR o.reference ILIKE '%'||sqlc.arg(search)||'%' OR COALESCE(cs.display_name,'') ILIKE '%'||sqlc.arg(search)||'%' OR COALESCE(o.replaces_order_reference,'') ILIKE '%'||sqlc.arg(search)||'%') AND (sqlc.arg(status)::text='' OR o.status=sqlc.arg(status)) ORDER BY o.created_at DESC,o.id DESC LIMIT sqlc.arg(page_limit) OFFSET sqlc.arg(page_offset);
-- name: CountOrders :one
SELECT count(*) FROM orders o LEFT JOIN order_customer_snapshots cs ON cs.order_id=o.id
WHERE (sqlc.arg(search)::text='' OR o.reference ILIKE '%'||sqlc.arg(search)||'%' OR COALESCE(cs.display_name,'') ILIKE '%'||sqlc.arg(search)||'%' OR COALESCE(o.replaces_order_reference,'') ILIKE '%'||sqlc.arg(search)||'%') AND (sqlc.arg(status)::text='' OR o.status=sqlc.arg(status));
-- name: GetCustomerName :one
SELECT COALESCE(s.display_name,p.first_name || ' ' || p.last_name,g.name)::text AS display_name
FROM orders o LEFT JOIN order_customer_snapshots s ON s.order_id=o.id
LEFT JOIN people p ON p.id=o.customer_person_id LEFT JOIN organizations g ON g.id=o.customer_organization_id
WHERE o.id=$1 AND COALESCE(s.display_name,p.first_name || ' ' || p.last_name,g.name) IS NOT NULL;
-- name: CaptureCustomer :exec
INSERT INTO order_customer_snapshots(order_id,display_name,organization_kind) VALUES($1,$2,$3);
-- name: GetPerson :one
SELECT id,(first_name||' '||last_name)::text AS display_name FROM people WHERE id=$1;
-- name: GetOrganization :one
SELECT id,name,kind,active FROM organizations WHERE id=$1;
-- name: ListItems :many
SELECT i.*,j.version AS current_job_version FROM order_items i LEFT JOIN machine_jobs j ON j.id=i.source_machine_job_id WHERE i.order_id=$1 ORDER BY i.position;
-- name: GetItem :one
SELECT * FROM order_items WHERE id=$1 AND order_id=$2;
-- name: InsertItem :one
INSERT INTO order_items(id,order_id,position,kind,description,quantity,unit,unit_price,amount,source_machine_job_id,source_job_version,machine_job_snapshot,created_by_account_id,source_material_id)
VALUES($1,$2,(SELECT COALESCE(max(position),0)+1 FROM order_items WHERE order_id=$2),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *;
-- name: RemoveItem :exec
UPDATE order_items SET removed_at=now(),removed_by_account_id=$2 WHERE id=$1;
-- name: ClaimJob :exec
INSERT INTO order_job_claims(machine_job_id,order_item_id) VALUES($1,$2);
-- name: ReleaseItemClaim :exec
DELETE FROM order_job_claims WHERE order_item_id=$1;
-- name: ReleaseOrderClaims :exec
DELETE FROM order_job_claims WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id=$1);
-- name: GetJobClaim :one
SELECT o.id AS order_id,i.id AS order_item_id,o.reference,i.source_job_version,j.version AS current_job_version FROM order_job_claims c JOIN order_items i ON i.id=c.order_item_id JOIN orders o ON o.id=i.order_id JOIN machine_jobs j ON j.id=c.machine_job_id WHERE c.machine_job_id=$1;
-- name: InsertAdjustment :exec
INSERT INTO order_adjustments(id,reference,order_id,order_reference,kind,currency,amount,reason,actor_account_id) VALUES($1,$2,$3,$4,'full_reversal','EUR',$5,$6,$7);
-- name: InsertAdjustmentItems :exec
INSERT INTO order_adjustment_items(id,adjustment_id,original_order_item_id,original_item_position,amount) VALUES($1,$2,$3,$4,$5);
-- name: ListAdjustments :many
SELECT * FROM order_adjustments WHERE order_id=$1 ORDER BY created_at;
-- name: SumAllocations :one
SELECT COALESCE(sum(amount),0)::numeric AS amount FROM payment_allocations WHERE order_id=$1;
-- name: ListAllocations :many
SELECT * FROM payment_allocations WHERE order_id=$1 ORDER BY created_at,id;
-- name: PaymentAllocations :many
SELECT * FROM payment_allocations WHERE payment_id=$1 ORDER BY created_at,id;
-- name: ActiveReceipts :many
SELECT p.* FROM payments p JOIN payment_allocations a ON a.payment_id=p.id WHERE a.order_id=$1 GROUP BY p.id HAVING sum(a.amount)>0 ORDER BY p.id;
-- name: InsertPayment :one
INSERT INTO payments(id,reference,entry_kind,method,amount,currency,occurred_at,actor_account_id,reverses_payment_id,reversed_payment_reference,reversal_reason_kind,reason,external_source,external_reference,external_invoice_request_id,split_part)
VALUES($1,$2,$3,$4,$5,'EUR',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *;
-- name: GetPayment :one
SELECT * FROM payments WHERE id=$1;
-- name: LockPayment :one
SELECT * FROM payments WHERE id=$1 FOR UPDATE;
-- name: PaymentReversalExists :one
SELECT EXISTS(SELECT 1 FROM payments WHERE reverses_payment_id=$1) AS reversed;
-- name: AllocatedOrderID :one
SELECT order_id FROM payment_allocations WHERE payment_id=$1 GROUP BY order_id HAVING sum(amount)>0;
-- name: InsertAllocation :exec
INSERT INTO payment_allocations(id,payment_id,payment_reference,order_id,order_reference,amount,currency,operation_id,actor_account_id)
VALUES($1,$2,$3,$4,$5,$6,'EUR',$7,$8);
-- name: ListPayments :many
SELECT * FROM payments WHERE (sqlc.arg(method)::text='' OR method=sqlc.arg(method)) AND (sqlc.narg(from_time)::timestamptz IS NULL OR occurred_at>=sqlc.narg(from_time)) AND (sqlc.narg(to_time)::timestamptz IS NULL OR occurred_at<sqlc.narg(to_time)) ORDER BY occurred_at DESC,id DESC LIMIT sqlc.arg(page_limit) OFFSET sqlc.arg(page_offset);
-- name: CountPayments :one
SELECT count(*) FROM payments WHERE (sqlc.arg(method)::text='' OR method=sqlc.arg(method)) AND (sqlc.narg(from_time)::timestamptz IS NULL OR occurred_at>=sqlc.narg(from_time)) AND (sqlc.narg(to_time)::timestamptz IS NULL OR occurred_at<sqlc.narg(to_time));
-- name: ReconciliationTotals :many
SELECT method,COALESCE(sum(CASE WHEN entry_kind='receipt' THEN amount ELSE -amount END),0)::numeric AS amount FROM payments WHERE (sqlc.narg(from_time)::timestamptz IS NULL OR occurred_at>=sqlc.narg(from_time)) AND (sqlc.narg(to_time)::timestamptz IS NULL OR occurred_at<sqlc.narg(to_time)) GROUP BY method;
-- name: ActiveRequest :one
SELECT * FROM external_invoice_requests WHERE order_id=$1 AND state<>'cancelled';
-- name: LatestRequest :one
SELECT * FROM external_invoice_requests WHERE order_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1;
-- name: GetRequirements :one
SELECT * FROM organization_invoicing_requirements WHERE organization_id=$1;
-- name: SaveRequirements :one
INSERT INTO organization_invoicing_requirements(organization_id,require_purchase_order_reference,updated_by_account_id) VALUES($1,$2,$3)
ON CONFLICT(organization_id) DO UPDATE SET require_purchase_order_reference=excluded.require_purchase_order_reference,version=organization_invoicing_requirements.version+1,updated_at=now(),updated_by_account_id=excluded.updated_by_account_id RETURNING *;
-- name: CreateRequest :one
INSERT INTO external_invoice_requests(id,reference,order_id,order_reference,currency,requested_amount,supersedes_request_id) VALUES($1,$2,$3,$4,'EUR',$5,$6) RETURNING *;
-- name: CreateRequestDetails :exec
INSERT INTO external_invoice_request_details(request_id,recipient_kind,recipient_person_id,recipient_organization_id,item_summary) VALUES($1,$2,$3,$4,$5);
-- name: UpdateRequestDetails :exec
UPDATE external_invoice_request_details SET recipient_name=$2,address_line1=$3,address_line2=$4,postal_code=$5,locality=$6,region=$7,country_code=$8,contact_person_id=$9,contact_name=$10,contact_channel=$11,service_starts_on=$12,service_ends_on=$13,service_description=$14,purchase_order_reference=$15,requirements_version=$16,require_purchase_order_reference=$17 WHERE request_id=$1;
-- name: GetRequest :one
SELECT * FROM external_invoice_requests WHERE id=$1;
-- name: LockRequest :one
SELECT * FROM external_invoice_requests WHERE id=$1 FOR UPDATE;
-- name: GetRequestDetails :one
SELECT * FROM external_invoice_request_details WHERE request_id=$1;
-- name: TransitionRequest :exec
UPDATE external_invoice_requests SET state=$2,version=version+1 WHERE id=$1;
-- name: InsertRequestEvent :exec
INSERT INTO external_invoice_request_events(id,request_id,kind,external_reference,reconciliation_kind,reason,effective_at,actor_account_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8);
-- name: RequestEvents :many
SELECT e.id,e.request_id,e.kind,e.external_reference,e.reconciliation_kind,e.reason,e.effective_at,e.recorded_at,
 pe.id AS actor_person_id,btrim(pe.first_name||' '||pe.last_name)::text AS actor_name
FROM external_invoice_request_events e LEFT JOIN accounts a ON a.id=e.actor_account_id LEFT JOIN people pe ON pe.id=a.person_id
WHERE e.request_id=$1 ORDER BY e.recorded_at,e.id;
-- name: RequestHasReference :one
SELECT EXISTS(SELECT 1 FROM external_invoice_request_events WHERE request_id=$1 AND kind IN ('reference_added','reference_corrected')) AS has_reference;
-- name: ListRequests :many
SELECT * FROM external_invoice_requests WHERE (sqlc.arg(search)::text='' OR reference ILIKE '%'||sqlc.arg(search)||'%' OR order_reference ILIKE '%'||sqlc.arg(search)||'%') AND (sqlc.arg(status)::text='' OR state=sqlc.arg(status)) AND (sqlc.narg(order_id)::uuid IS NULL OR order_id=sqlc.narg(order_id)) ORDER BY created_at DESC,id DESC LIMIT sqlc.arg(page_limit) OFFSET sqlc.arg(page_offset);
-- name: CountRequests :one
SELECT count(*) FROM external_invoice_requests WHERE (sqlc.arg(search)::text='' OR reference ILIKE '%'||sqlc.arg(search)||'%' OR order_reference ILIKE '%'||sqlc.arg(search)||'%') AND (sqlc.arg(status)::text='' OR state=sqlc.arg(status)) AND (sqlc.narg(order_id)::uuid IS NULL OR order_id=sqlc.narg(order_id));

-- name: LockOrganizationRequirements :exec
SELECT id FROM organizations WHERE id=$1 FOR UPDATE;

-- name: CommittedReplacement :one
SELECT id,reference FROM orders WHERE replaces_order_id=$1 AND status IN ('finalized','reversed');

-- name: GetActor :one
SELECT pe.id,btrim(pe.first_name||' '||pe.last_name)::text AS display_name FROM accounts a JOIN people pe ON pe.id=a.person_id WHERE a.id=$1;
-- name: SumCashCardAllocations :one
SELECT COALESCE(sum(a.amount),0)::numeric AS amount FROM payment_allocations a JOIN payments p ON p.id=a.payment_id WHERE a.order_id=$1 AND p.method IN ('cash','card');
-- name: SetRequestAlreadyPaid :exec
UPDATE external_invoice_request_details SET already_paid=$2 WHERE request_id=$1;
-- name: ActiveRequestReceipts :many
SELECT p.* FROM payments p JOIN payment_allocations a ON a.payment_id=p.id
WHERE a.order_id=$1 AND p.method='external' AND p.external_invoice_request_id=$2 AND p.entry_kind='receipt'
GROUP BY p.id HAVING sum(a.amount)>0 ORDER BY p.id;

-- name: LockCashRegister :exec
SELECT pg_advisory_xact_lock(hashtextextended('cash_register',0));
-- name: GetCashMovementByKey :one
SELECT * FROM cash_movements WHERE operation_key=$1;
-- name: NextCashMovementReference :one
SELECT nextval('cash_movement_reference_sequence')::bigint;
-- name: InsertCashMovement :one
INSERT INTO cash_movements(id,reference,operation_key,kind,amount,reason,note,occurred_at,recorded_by_person_id,cash_count_id)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *;
-- name: ListCashMovements :many
SELECT * FROM cash_movements WHERE (sqlc.arg(kind)::text='' OR kind=sqlc.arg(kind)) AND (sqlc.narg(from_time)::timestamptz IS NULL OR occurred_at>=sqlc.narg(from_time)) AND (sqlc.narg(to_time)::timestamptz IS NULL OR occurred_at<sqlc.narg(to_time))
ORDER BY occurred_at DESC,id DESC LIMIT sqlc.arg(page_limit) OFFSET sqlc.arg(page_offset);
-- name: CountCashMovements :one
SELECT count(*) FROM cash_movements WHERE (sqlc.arg(kind)::text='' OR kind=sqlc.arg(kind)) AND (sqlc.narg(from_time)::timestamptz IS NULL OR occurred_at>=sqlc.narg(from_time)) AND (sqlc.narg(to_time)::timestamptz IS NULL OR occurred_at<sqlc.narg(to_time));
-- name: CashPaymentFigures :one
-- Refunds are reversals that gave cash back; every other reversal reason is a correction of a recorded payment.
SELECT COALESCE(sum(amount) FILTER (WHERE entry_kind='receipt'),0)::numeric AS receipts,
COALESCE(sum(amount) FILTER (WHERE entry_kind='reversal' AND reversal_reason_kind='refund'),0)::numeric AS refunds,
COALESCE(sum(amount) FILTER (WHERE entry_kind='reversal' AND reversal_reason_kind IS DISTINCT FROM 'refund'),0)::numeric AS payment_corrections
FROM payments WHERE method='cash' AND (sqlc.narg(to_time)::timestamptz IS NULL OR occurred_at<sqlc.narg(to_time));
-- name: CashMovementFigures :one
-- Corrections are signed: what they added to the register. Surpluses are the positive ones, shortfalls the negative ones.
SELECT COALESCE(sum(amount) FILTER (WHERE kind='withdrawal'),0)::numeric AS withdrawals,COALESCE(sum(amount) FILTER (WHERE kind='deposit'),0)::numeric AS deposits,
COALESCE(sum(amount) FILTER (WHERE kind='correction'),0)::numeric AS corrections,
COALESCE(sum(amount) FILTER (WHERE kind='correction' AND amount>0),0)::numeric AS count_surpluses,
COALESCE(-sum(amount) FILTER (WHERE kind='correction' AND amount<0),0)::numeric AS count_shortfalls
FROM cash_movements WHERE (sqlc.narg(to_time)::timestamptz IS NULL OR occurred_at<sqlc.narg(to_time));
-- name: GetCashCountReference :one
SELECT reference FROM cash_counts WHERE id=$1;
-- name: NextCashCountReference :one
SELECT nextval('cash_count_reference_sequence')::bigint;
-- name: GetCashCountByKey :one
SELECT * FROM cash_counts WHERE operation_key=$1;
-- name: LatestCashCountTime :one
SELECT counted_at FROM cash_counts ORDER BY counted_at DESC LIMIT 1;
-- name: InsertCashCount :one
INSERT INTO cash_counts(id,reference,operation_key,counted_amount,expected_amount,difference,reason,note,counted_at,recorded_by_person_id)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *;
-- name: ListCashCountIDs :many
SELECT id FROM cash_counts WHERE (sqlc.narg(from_time)::timestamptz IS NULL OR counted_at>=sqlc.narg(from_time)) AND (sqlc.narg(to_time)::timestamptz IS NULL OR counted_at<sqlc.narg(to_time))
ORDER BY counted_at DESC,id DESC LIMIT sqlc.arg(page_limit) OFFSET sqlc.arg(page_offset);
-- name: CountCashCounts :one
SELECT count(*) FROM cash_counts WHERE (sqlc.narg(from_time)::timestamptz IS NULL OR counted_at>=sqlc.narg(from_time)) AND (sqlc.narg(to_time)::timestamptz IS NULL OR counted_at<sqlc.narg(to_time));
-- name: GetCashCountDetails :one
-- A count with its correction movement and the name of the person who counted.
SELECT c.id,c.reference,c.counted_amount,c.expected_amount,c.difference,c.reason,c.note,c.counted_at,c.created_at,c.recorded_by_person_id,
 c.version,c.updated_at,
 COALESCE(btrim(pe.first_name||' '||pe.last_name),'')::text AS recorded_by_name,m.id AS correction_id,m.reference AS correction_reference
FROM cash_counts c LEFT JOIN people pe ON pe.id=c.recorded_by_person_id LEFT JOIN cash_movements m ON m.cash_count_id=c.id
WHERE c.id=$1;
-- name: LatestCashCountID :one
SELECT id FROM cash_counts WHERE (sqlc.narg(to_time)::timestamptz IS NULL OR counted_at<sqlc.narg(to_time)) ORDER BY counted_at DESC,id DESC LIMIT 1;
-- name: GetCashMovementForUpdate :one
SELECT * FROM cash_movements WHERE id=$1 FOR UPDATE;
-- name: GetCashCountCorrection :one
SELECT * FROM cash_movements WHERE cash_count_id=$1;
-- name: UpdateCashMovement :one
UPDATE cash_movements SET amount=sqlc.arg(amount),reason=sqlc.arg(reason),note=sqlc.arg(note),occurred_at=sqlc.arg(occurred_at),
 version=version+1,updated_at=now()
WHERE id=sqlc.arg(id) RETURNING *;
-- name: DeleteCashMovement :exec
DELETE FROM cash_movements WHERE id=$1;
-- name: GetCashCountForUpdate :one
SELECT * FROM cash_counts WHERE id=$1 FOR UPDATE;
-- name: UpdateCashCount :one
UPDATE cash_counts SET counted_amount=sqlc.arg(counted_amount),expected_amount=sqlc.arg(expected_amount),
 difference=sqlc.arg(difference),reason=sqlc.narg(reason),note=sqlc.arg(note),counted_at=sqlc.arg(counted_at),
 version=version+1,updated_at=now()
WHERE id=sqlc.arg(id) RETURNING *;
-- name: DeleteCashCount :exec
DELETE FROM cash_counts WHERE id=$1;
-- name: PreviousCashCountTime :one
SELECT counted_at FROM cash_counts WHERE counted_at<$1 ORDER BY counted_at DESC LIMIT 1;
-- name: NextCashCountTime :one
SELECT counted_at FROM cash_counts WHERE counted_at>$1 ORDER BY counted_at LIMIT 1;
-- name: ListCashCountsFrom :many
-- Counts at or after from_time, oldest first, for recalculating them after an edit.
SELECT * FROM cash_counts WHERE counted_at>=sqlc.arg(from_time) ORDER BY counted_at,id;
-- name: LowestCashBalanceFrom :one
-- The lowest running balance after any register entry at or after from_time, in journal order; null without one.
SELECT min(l.balance)::numeric AS lowest FROM (
    SELECT e.occurred_at, sum(e.effect) OVER (ORDER BY e.occurred_at, e.sort_rank, e.id ROWS UNBOUNDED PRECEDING) AS balance
    FROM cash_register_entries e
) l WHERE l.occurred_at>=sqlc.arg(from_time)::timestamptz;
-- name: ListOwnPayableOrderIDs :many
-- The person's finalized orders with an outstanding amount that no active external invoice request covers.
SELECT o.id FROM orders o
WHERE o.customer_person_id = sqlc.arg(person_id) AND o.status = 'finalized'
  AND NOT EXISTS (SELECT 1 FROM external_invoice_requests r WHERE r.order_id = o.id AND r.state <> 'cancelled')
  AND o.total_amount - COALESCE((SELECT sum(a.amount) FROM order_adjustments a WHERE a.order_id = o.id), 0)
      - COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.order_id = o.id), 0) > 0
ORDER BY o.created_at DESC, o.id DESC;
-- name: ListOwnRecentOrderIDs :many
SELECT id FROM orders WHERE customer_person_id = sqlc.arg(person_id) AND status IN ('finalized', 'reversed')
ORDER BY created_at DESC, id DESC LIMIT sqlc.arg(page_limit);
-- name: LockOwnPayableJobs :many
-- Locks those of the given jobs that the person owes as customer: priced completely, with a price and on no order.
-- Ascending id order, as finalization locks jobs.
SELECT j.id, j.version FROM machine_jobs j
WHERE j.id = ANY(sqlc.arg(job_ids)::uuid[]) AND j.customer_person_id = sqlc.arg(person_id) AND j.deleted_at IS NULL
  AND j.pricing_status = 'complete' AND j.active_pricing_snapshot_id IS NOT NULL AND j.effective_price > 0
  AND NOT EXISTS (SELECT 1 FROM order_job_claims c WHERE c.machine_job_id = j.id)
ORDER BY j.id
FOR UPDATE OF j;
-- name: OperationAllocations :many
-- What one payment operation allocated, per order.
SELECT order_id, order_reference, sum(amount)::numeric AS amount FROM payment_allocations
WHERE operation_id = sqlc.arg(operation_id) AND order_id IS NOT NULL
GROUP BY order_id, order_reference ORDER BY order_reference;
-- name: SetRequestWiRefDelivery :exec
INSERT INTO external_invoice_request_deliveries(request_id,status,attempted_at,failure_code) VALUES($1,$2,$3,$4)
ON CONFLICT (request_id) DO UPDATE SET status=EXCLUDED.status,attempted_at=EXCLUDED.attempted_at,failure_code=EXCLUDED.failure_code;
-- name: GetRequestWiRefDelivery :one
SELECT status,attempted_at,failure_code FROM external_invoice_request_deliveries WHERE request_id=$1;

-- name: InvoicePayments :many
SELECT p.reference,p.method,p.occurred_at,sum(a.amount)::numeric AS amount FROM payments p JOIN payment_allocations a ON a.payment_id=p.id
WHERE a.order_id=$1 AND p.entry_kind='receipt'
GROUP BY p.id HAVING sum(a.amount)>0 ORDER BY p.occurred_at,p.reference;

-- name: ListCashJournal :many
-- The register's entries with the running balance after each. The balance counts every entry from the beginning,
-- whatever the filters; seq is the position in time (ties: count before its correction, then id). Customer names
-- are searched only for callers who may see them. A reversal belongs to the order of the receipt it reverses.
WITH ledger AS (
    SELECT e.id, e.source, e.kind, e.occurred_at, e.effect::numeric AS effect, e.reference,
        row_number() OVER w AS seq, (sum(e.effect) OVER w)::numeric AS balance
    FROM cash_register_entries e
    WHERE sqlc.narg(to_time)::timestamptz IS NULL OR e.occurred_at < sqlc.narg(to_time)::timestamptz
    WINDOW w AS (ORDER BY e.occurred_at, e.sort_rank, e.id ROWS UNBOUNDED PRECEDING)
), detailed AS (
    SELECT l.id, l.source, l.kind, l.occurred_at, l.effect, l.reference, l.seq, l.balance,
        al.order_id, COALESCE(al.order_reference, '')::text AS order_reference,
        COALESCE(cs.display_name, NULLIF(btrim(cp.first_name || ' ' || cp.last_name), ''), og.name, '')::text AS customer_name,
        COALESCE(p.reason, '')::text AS payment_reason,
        COALESCE(p.reversed_payment_reference, '')::text AS reversed_payment_reference,
        COALESCE(m.reason, '')::text AS movement_reason,
        (CASE WHEN m.id IS NOT NULL AND m.kind <> 'correction' THEN m.note ELSE COALESCE(c.note, '') END)::text AS note,
        c.id AS count_id, COALESCE(c.reference, '')::text AS count_reference,
        c.counted_amount, c.expected_amount, c.difference, c.reason AS count_reason,
        rb.id AS recorded_by_id, COALESCE(btrim(rb.first_name || ' ' || rb.last_name), '')::text AS recorded_by_name,
        m.version AS movement_version, m.updated_at AS movement_updated_at,
        c.version AS count_version, c.updated_at AS count_updated_at
    FROM ledger l
    LEFT JOIN payments p ON l.source = 'payment' AND p.id = l.id
    LEFT JOIN LATERAL (
        SELECT a.order_id, a.order_reference FROM payment_allocations a
        WHERE a.payment_id = COALESCE(p.reverses_payment_id, p.id) ORDER BY a.created_at, a.id LIMIT 1
    ) al ON true
    LEFT JOIN orders o ON o.id = al.order_id
    LEFT JOIN order_customer_snapshots cs ON cs.order_id = o.id
    LEFT JOIN people cp ON cp.id = o.customer_person_id
    LEFT JOIN organizations og ON og.id = o.customer_organization_id
    LEFT JOIN accounts pa ON pa.id = p.actor_account_id
    LEFT JOIN cash_movements m ON l.source = 'movement' AND m.id = l.id
    LEFT JOIN cash_counts c ON c.id = CASE WHEN l.source = 'count' THEN l.id ELSE m.cash_count_id END
    LEFT JOIN people rb ON rb.id = COALESCE(pa.person_id, m.recorded_by_person_id, c.recorded_by_person_id)
    WHERE (sqlc.narg(from_time)::timestamptz IS NULL OR l.occurred_at >= sqlc.narg(from_time)::timestamptz)
      AND (cardinality(sqlc.arg(kinds)::text[]) = 0 OR l.kind = ANY(sqlc.arg(kinds)::text[]))
)
SELECT d.id, d.source, d.kind, d.occurred_at, d.effect, d.reference, d.balance, d.order_id, d.order_reference,
    d.customer_name, d.payment_reason, d.reversed_payment_reference, d.movement_reason, d.note, d.count_id,
    d.count_reference, d.counted_amount, d.expected_amount, d.difference, d.count_reason, d.recorded_by_id,
    d.recorded_by_name, d.movement_version, d.movement_updated_at, d.count_version, d.count_updated_at,
    count(*) OVER () AS total
FROM detailed d
WHERE sqlc.arg(search)::text = ''
    OR d.reference ILIKE '%' || sqlc.arg(search)::text || '%'
    OR d.order_reference ILIKE '%' || sqlc.arg(search)::text || '%'
    OR (sqlc.arg(with_customer)::bool AND d.customer_name ILIKE '%' || sqlc.arg(search)::text || '%')
    OR d.payment_reason ILIKE '%' || sqlc.arg(search)::text || '%'
    OR d.note ILIKE '%' || sqlc.arg(search)::text || '%'
    OR d.count_reference ILIKE '%' || sqlc.arg(search)::text || '%'
ORDER BY CASE WHEN sqlc.arg(newest_first)::bool THEN -d.seq ELSE d.seq END
LIMIT sqlc.arg(page_limit) OFFSET sqlc.arg(page_offset);

-- name: CashJournalDayTotals :many
-- Cash in and out per day in the makerspace time zone, for days within [from_time, to_time).
SELECT to_char(e.occurred_at AT TIME ZONE sqlc.arg(time_zone)::text, 'YYYY-MM-DD')::text AS day,
    COALESCE(sum(e.effect) FILTER (WHERE e.effect > 0), 0)::numeric AS cash_in,
    COALESCE(-sum(e.effect) FILTER (WHERE e.effect < 0), 0)::numeric AS cash_out
FROM cash_register_entries e
WHERE e.occurred_at >= sqlc.arg(from_time)::timestamptz AND e.occurred_at < sqlc.arg(to_time)::timestamptz
GROUP BY 1 ORDER BY 1;

-- name: CashJournalFacts :one
-- What happened in the register within [from_time, to_time); both ends are optional.
SELECT COALESCE(sum(e.effect) FILTER (WHERE e.effect > 0), 0)::numeric AS cash_in,
    count(*) FILTER (WHERE e.effect > 0) AS cash_in_entries,
    count(*) FILTER (WHERE e.kind = 'receipt') AS receipts,
    count(*) FILTER (WHERE e.kind = 'deposit') AS deposits,
    COALESCE(-sum(e.effect) FILTER (WHERE e.effect < 0), 0)::numeric AS cash_out,
    count(*) FILTER (WHERE e.effect < 0) AS cash_out_entries,
    count(*) FILTER (WHERE e.kind = 'refund') AS refunds,
    count(*) FILTER (WHERE e.kind = 'correction') AS corrections,
    count(*) FILTER (WHERE e.kind = 'withdrawal') AS withdrawals,
    count(*) FILTER (WHERE e.kind = 'count') AS counts
FROM cash_register_entries e
WHERE (sqlc.narg(from_time)::timestamptz IS NULL OR e.occurred_at >= sqlc.narg(from_time)::timestamptz)
  AND (sqlc.narg(to_time)::timestamptz IS NULL OR e.occurred_at < sqlc.narg(to_time)::timestamptz);

-- name: ListCashbookEntries :many
-- Payments and cash movements within [from_time, to_time) in register order, for the cashbook export. With cash_only
-- only cash payments count (the cash register); otherwise card and external payments are included. Counts move no
-- money and are left out; their corrections are not. A reversal belongs to the order of the receipt it reverses.
WITH entries AS (
    SELECT p.id, 'payment'::text AS source,
        (CASE WHEN p.entry_kind = 'receipt' THEN 'receipt' WHEN p.reversal_reason_kind = 'refund' THEN 'refund' ELSE 'correction' END)::text AS kind,
        p.method, p.occurred_at, 0 AS sort_rank,
        (CASE WHEN p.entry_kind = 'receipt' THEN p.amount ELSE -p.amount END)::numeric AS effect,
        p.reference, p.reason AS payment_reason, ''::text AS movement_reason, ''::text AS note, NULL::uuid AS count_id,
        p.actor_account_id, NULL::uuid AS person_id, COALESCE(p.reverses_payment_id, p.id) AS allocated_payment_id
    FROM payments p
    WHERE (NOT sqlc.arg(cash_only)::bool OR p.method = 'cash')
      AND p.occurred_at >= sqlc.arg(from_time)::timestamptz AND p.occurred_at < sqlc.arg(to_time)::timestamptz
    UNION ALL
    SELECT m.id, 'movement'::text, m.kind, 'cash'::text, m.occurred_at, CASE WHEN m.kind = 'correction' THEN 2 ELSE 0 END,
        (CASE WHEN m.kind = 'withdrawal' THEN -m.amount ELSE m.amount END)::numeric,
        m.reference, ''::text, m.reason, m.note, m.cash_count_id, NULL::uuid, m.recorded_by_person_id, NULL::uuid
    FROM cash_movements m
    WHERE m.occurred_at >= sqlc.arg(from_time)::timestamptz AND m.occurred_at < sqlc.arg(to_time)::timestamptz
)
SELECT e.id, e.source, e.kind, e.method::text AS method, e.occurred_at, e.effect, e.reference,
    COALESCE(al.order_reference, '')::text AS order_reference,
    COALESCE(cs.display_name, NULLIF(btrim(cp.first_name || ' ' || cp.last_name), ''), og.name, '')::text AS customer_name,
    e.payment_reason::text AS payment_reason, e.movement_reason::text AS movement_reason,
    (CASE WHEN e.count_id IS NULL THEN e.note ELSE COALESCE(c.note, '') END)::text AS note,
    COALESCE(c.reference, '')::text AS count_reference, c.reason AS count_reason,
    COALESCE(btrim(rb.first_name || ' ' || rb.last_name), '')::text AS recorded_by_name
FROM entries e
LEFT JOIN LATERAL (
    SELECT a.order_reference, a.order_id FROM payment_allocations a
    WHERE a.payment_id = e.allocated_payment_id ORDER BY a.created_at, a.id LIMIT 1
) al ON true
LEFT JOIN orders o ON o.id = al.order_id
LEFT JOIN order_customer_snapshots cs ON cs.order_id = o.id
LEFT JOIN people cp ON cp.id = o.customer_person_id
LEFT JOIN organizations og ON og.id = o.customer_organization_id
LEFT JOIN cash_counts c ON c.id = e.count_id
LEFT JOIN accounts pa ON pa.id = e.actor_account_id
LEFT JOIN people rb ON rb.id = COALESCE(pa.person_id, e.person_id)
ORDER BY e.occurred_at, e.sort_rank, e.id
LIMIT sqlc.arg(row_limit);
