-- +goose Up
CREATE UNIQUE INDEX orders_committed_replacement_idx ON orders(replaces_order_id) WHERE status IN ('finalized','reversed');
-- Deferred checks allow checkout/replacement transactions to pass through temporary
-- intermediate states, but forbid committing anonymous debts or unallocated money.
-- +goose StatementBegin
CREATE FUNCTION check_order_financial_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; o orders%ROWTYPE; allocated numeric; adjusted numeric; items_total numeric;
BEGIN
 IF TG_TABLE_NAME='orders' THEN target:=NEW.id; ELSE target:=NEW.order_id; END IF;
 IF target IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO o FROM orders WHERE id=target;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT COALESCE(sum(amount),0) INTO allocated FROM payment_allocations WHERE order_id=target;
 SELECT COALESCE(sum(amount),0) INTO adjusted FROM order_adjustments WHERE order_id=target;
 IF allocated<0 OR allocated>o.total_amount-adjusted THEN
 RAISE EXCEPTION 'invalid order allocation balance' USING ERRCODE='23514'; END IF;
 IF o.status IN ('draft','cancelled') AND allocated<>0 THEN
 RAISE EXCEPTION 'unfinalized order cannot have payments' USING ERRCODE='23514'; END IF;
 IF o.status='finalized' THEN
 SELECT COALESCE(sum(amount),0) INTO items_total FROM order_items WHERE order_id=target AND removed_at IS NULL;
 IF items_total<>o.total_amount OR NOT EXISTS(SELECT 1 FROM order_items WHERE order_id=target AND removed_at IS NULL) THEN
 RAISE EXCEPTION 'order total must match immutable items' USING ERRCODE='23514'; END IF;
 IF o.customer_kind='anonymous' AND (o.fulfillment_mode<>'immediate' OR allocated<>o.total_amount) THEN
 RAISE EXCEPTION 'anonymous order must be immediately fully settled' USING ERRCODE='23514'; END IF;
 END IF;
 IF o.status='reversed' AND (adjusted<>o.total_amount OR allocated<>0) THEN
 RAISE EXCEPTION 'full reversal must negate charge and release payments' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION check_payment_financial_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; p payments%ROWTYPE; allocated numeric; reversed numeric; allocated_orders integer;
BEGIN
 IF TG_TABLE_NAME='payments' THEN target:=COALESCE(NEW.reverses_payment_id,NEW.id); ELSE target:=NEW.payment_id; END IF;
 IF target IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO p FROM payments WHERE id=target;
 IF TG_TABLE_NAME='payments' THEN
 IF NEW.entry_kind='reversal' AND (p.id IS NULL OR p.entry_kind<>'receipt' OR
 NEW.reverses_payment_id IS NULL OR NEW.amount<>p.amount OR NEW.method<>p.method OR
 NEW.currency<>p.currency OR NEW.reversed_payment_reference<>p.reference) THEN
 RAISE EXCEPTION 'reversal must match one original receipt' USING ERRCODE='23514'; END IF;
 END IF;
 IF p.id IS NULL OR p.entry_kind<>'receipt' THEN RETURN NULL; END IF;
 SELECT COALESCE(sum(amount),0) INTO allocated FROM payment_allocations WHERE payment_id=target;
 SELECT COALESCE(sum(amount),0) INTO reversed FROM payments WHERE reverses_payment_id=target;
 IF reversed NOT IN (0,p.amount) OR allocated<>p.amount-reversed THEN
 RAISE EXCEPTION 'receipt must be fully allocated or fully reversed' USING ERRCODE='23514'; END IF;
 SELECT count(*) INTO allocated_orders FROM (SELECT order_reference FROM payment_allocations WHERE payment_id=target GROUP BY order_reference HAVING sum(amount)>0) a;
 IF allocated_orders>1 THEN RAISE EXCEPTION 'v1 receipts settle one order at a time' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION check_anonymous_job_completion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.review_state='confirmed' AND NEW.customer_person_id IS NULL AND NEW.customer_organization_id IS NULL AND
 (TG_OP='INSERT' OR OLD.review_state='needs_review') AND NOT EXISTS(
 SELECT 1 FROM order_job_claims c JOIN order_items i ON i.id=c.order_item_id JOIN orders o ON o.id=i.order_id
 WHERE c.machine_job_id=NEW.id AND o.status='finalized' AND o.customer_kind='anonymous'
 AND o.fulfillment_mode='immediate' AND o.total_amount=(SELECT COALESCE(sum(amount),0) FROM payment_allocations WHERE order_id=o.id)) THEN
 RAISE EXCEPTION 'anonymous job confirmation requires atomic counter sale' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION request_header_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-ARRAY['state','version','order_id','supersedes_request_id']) IS DISTINCT FROM
 (to_jsonb(OLD)-ARRAY['state','version','order_id','supersedes_request_id']) THEN
 RAISE EXCEPTION 'external invoice request header is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION financial_reference_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE field text;
BEGIN
 FOREACH field IN ARRAY TG_ARGV LOOP
 IF TG_TABLE_NAME='orders' AND to_jsonb(OLD)->>'status'='draft' AND field IN ('customer_person_id','customer_organization_id') THEN CONTINUE; END IF;
 IF TG_TABLE_NAME='external_invoice_request_details' AND (SELECT state FROM external_invoice_requests WHERE id=(to_jsonb(OLD)->>'request_id')::uuid)='draft' THEN CONTINUE; END IF;
 IF (to_jsonb(NEW)->field) IS DISTINCT FROM (to_jsonb(OLD)->field) AND (to_jsonb(NEW)->field)<>'null'::jsonb THEN
 RAISE EXCEPTION 'immutable references may only be detached' USING ERRCODE='23514'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
-- +goose StatementEnd
CREATE CONSTRAINT TRIGGER orders_balanced AFTER INSERT OR UPDATE ON orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_order_financial_integrity();
CREATE CONSTRAINT TRIGGER allocations_order_balanced AFTER INSERT OR UPDATE ON payment_allocations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_order_financial_integrity();
CREATE CONSTRAINT TRIGGER adjustments_order_balanced AFTER INSERT OR UPDATE ON order_adjustments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_order_financial_integrity();
CREATE CONSTRAINT TRIGGER payments_allocated AFTER INSERT ON payments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_payment_financial_integrity();
CREATE CONSTRAINT TRIGGER allocations_payment_balanced AFTER INSERT ON payment_allocations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_payment_financial_integrity();
CREATE CONSTRAINT TRIGGER anonymous_job_completed AFTER INSERT OR UPDATE ON machine_jobs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_anonymous_job_completion();
CREATE TRIGGER requests_frozen BEFORE UPDATE ON external_invoice_requests FOR EACH ROW EXECUTE FUNCTION request_header_guard();
CREATE TRIGGER customer_snapshot_frozen BEFORE UPDATE ON order_customer_snapshots FOR EACH ROW EXECUTE FUNCTION financial_entry_guard();
CREATE TRIGGER orders_references_frozen BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION financial_reference_guard('customer_person_id','customer_organization_id','created_by_account_id','replaces_order_id');
CREATE TRIGGER order_items_references_frozen BEFORE UPDATE ON order_items FOR EACH ROW EXECUTE FUNCTION financial_reference_guard('source_machine_job_id','created_by_account_id');
CREATE TRIGGER payments_references_frozen BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION financial_reference_guard('actor_account_id','reverses_payment_id','external_invoice_request_id');
CREATE TRIGGER payment_allocations_references_frozen BEFORE UPDATE ON payment_allocations FOR EACH ROW EXECUTE FUNCTION financial_reference_guard('actor_account_id','order_id','payment_id','reverses_allocation_id');
CREATE TRIGGER order_adjustments_references_frozen BEFORE UPDATE ON order_adjustments FOR EACH ROW EXECUTE FUNCTION financial_reference_guard('actor_account_id','order_id');
CREATE TRIGGER order_adjustment_items_references_frozen BEFORE UPDATE ON order_adjustment_items FOR EACH ROW EXECUTE FUNCTION financial_reference_guard('original_order_item_id');
CREATE TRIGGER external_invoice_requests_references_frozen BEFORE UPDATE ON external_invoice_requests FOR EACH ROW EXECUTE FUNCTION financial_reference_guard('order_id','supersedes_request_id');
CREATE TRIGGER external_invoice_request_events_references_frozen BEFORE UPDATE ON external_invoice_request_events FOR EACH ROW EXECUTE FUNCTION financial_reference_guard('actor_account_id');
CREATE TRIGGER external_invoice_request_details_references_frozen BEFORE UPDATE ON external_invoice_request_details FOR EACH ROW EXECUTE FUNCTION financial_reference_guard('recipient_person_id','recipient_organization_id','contact_person_id');
CREATE TRIGGER order_customer_snapshots_references_frozen BEFORE UPDATE ON order_customer_snapshots FOR EACH ROW EXECUTE FUNCTION financial_reference_guard('order_id');
-- +goose Down
DROP TRIGGER IF EXISTS orders_references_frozen ON orders;
DROP TRIGGER IF EXISTS order_items_references_frozen ON order_items;
DROP TRIGGER IF EXISTS payments_references_frozen ON payments;
DROP TRIGGER IF EXISTS payment_allocations_references_frozen ON payment_allocations;
DROP TRIGGER IF EXISTS order_adjustments_references_frozen ON order_adjustments;
DROP TRIGGER IF EXISTS order_adjustment_items_references_frozen ON order_adjustment_items;
DROP TRIGGER IF EXISTS external_invoice_requests_references_frozen ON external_invoice_requests;
DROP TRIGGER IF EXISTS external_invoice_request_events_references_frozen ON external_invoice_request_events;
DROP TRIGGER IF EXISTS external_invoice_request_details_references_frozen ON external_invoice_request_details;
DROP TRIGGER IF EXISTS order_customer_snapshots_references_frozen ON order_customer_snapshots;
DROP FUNCTION IF EXISTS financial_reference_guard();
DROP INDEX IF EXISTS orders_committed_replacement_idx;
DROP TRIGGER IF EXISTS customer_snapshot_frozen ON order_customer_snapshots;
DROP TRIGGER IF EXISTS requests_frozen ON external_invoice_requests;
DROP TRIGGER IF EXISTS anonymous_job_completed ON machine_jobs;
DROP TRIGGER IF EXISTS allocations_payment_balanced ON payment_allocations;
DROP TRIGGER IF EXISTS payments_allocated ON payments;
DROP TRIGGER IF EXISTS adjustments_order_balanced ON order_adjustments;
DROP TRIGGER IF EXISTS allocations_order_balanced ON payment_allocations;
DROP TRIGGER IF EXISTS orders_balanced ON orders;
DROP FUNCTION IF EXISTS check_order_financial_integrity(),check_payment_financial_integrity(),check_anonymous_job_completion(),request_header_guard();
