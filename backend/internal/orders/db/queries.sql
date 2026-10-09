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
INSERT INTO orders(id,reference,customer_kind,customer_person_id,customer_organization_id,fulfillment_mode,created_by_account_id,replaces_order_id,replaces_order_reference)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *;
-- name: GetOrder :one
SELECT * FROM orders WHERE id=$1;
-- name: LockOrder :one
SELECT * FROM orders WHERE id=$1 FOR UPDATE;
-- name: UpdateDraft :one
UPDATE orders SET customer_kind=$2,customer_person_id=$3,customer_organization_id=$4,fulfillment_mode=$5,version=version+1,updated_at=now() WHERE id=$1 RETURNING *;
-- name: BumpOrder :exec
UPDATE orders SET version=version+1,updated_at=now() WHERE id=$1;
-- name: TransitionOrder :exec
UPDATE orders SET status=$2,total_amount=$3,version=version+1,updated_at=now(),
finalized_at=CASE WHEN $2::text='finalized' THEN now() ELSE finalized_at END,
cancelled_at=CASE WHEN $2::text='cancelled' THEN now() ELSE cancelled_at END,
reversed_at=CASE WHEN $2::text='reversed' THEN now() ELSE reversed_at END WHERE id=$1;
-- name: ListOrders :many
SELECT * FROM orders WHERE (sqlc.arg(search)::text='' OR reference ILIKE '%'||sqlc.arg(search)||'%') AND (sqlc.arg(status)::text='' OR status=sqlc.arg(status)) ORDER BY created_at DESC,id DESC LIMIT sqlc.arg(page_limit) OFFSET sqlc.arg(page_offset);
-- name: CountOrders :one
SELECT count(*) FROM orders WHERE (sqlc.arg(search)::text='' OR reference ILIKE '%'||sqlc.arg(search)||'%') AND (sqlc.arg(status)::text='' OR status=sqlc.arg(status));
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
INSERT INTO order_items(id,order_id,position,kind,description,quantity,unit,unit_price,amount,source_machine_job_id,source_job_version,machine_job_snapshot,created_by_account_id)
VALUES($1,$2,(SELECT COALESCE(max(position),0)+1 FROM order_items WHERE order_id=$2),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *;
-- name: RemoveItem :exec
UPDATE order_items SET removed_at=now(),removed_by_account_id=$2 WHERE id=$1;
-- name: ClaimJob :exec
INSERT INTO order_job_claims(machine_job_id,order_item_id) VALUES($1,$2);
-- name: ReleaseItemClaim :exec
DELETE FROM order_job_claims WHERE order_item_id=$1;
-- name: ReleaseOrderClaims :exec
DELETE FROM order_job_claims WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id=$1);
-- name: GetJobClaim :one
SELECT o.id AS order_id,o.reference,i.source_job_version,j.version AS current_job_version FROM order_job_claims c JOIN order_items i ON i.id=c.order_item_id JOIN orders o ON o.id=i.order_id JOIN machine_jobs j ON j.id=c.machine_job_id WHERE c.machine_job_id=$1;
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
INSERT INTO payments(id,reference,entry_kind,method,amount,currency,occurred_at,actor_account_id,reverses_payment_id,reversed_payment_reference,reversal_reason_kind,reason,external_source,external_reference,external_invoice_request_id)
VALUES($1,$2,$3,$4,$5,'EUR',$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *;
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
SELECT * FROM external_invoice_request_events WHERE request_id=$1 ORDER BY recorded_at,id;
-- name: ListRequests :many
SELECT * FROM external_invoice_requests WHERE (sqlc.arg(search)::text='' OR reference ILIKE '%'||sqlc.arg(search)||'%') AND (sqlc.arg(status)::text='' OR state=sqlc.arg(status)) ORDER BY created_at DESC,id DESC LIMIT sqlc.arg(page_limit) OFFSET sqlc.arg(page_offset);
-- name: CountRequests :one
SELECT count(*) FROM external_invoice_requests WHERE (sqlc.arg(search)::text='' OR reference ILIKE '%'||sqlc.arg(search)||'%') AND (sqlc.arg(status)::text='' OR state=sqlc.arg(status));

-- name: LockOrganizationRequirements :exec
SELECT id FROM organizations WHERE id=$1 FOR UPDATE;

-- name: CommittedReplacement :one
SELECT id,reference FROM orders WHERE replaces_order_id=$1 AND status IN ('finalized','reversed');
