-- +goose Up
-- Orders are no longer split into "handed over now" and "picked up later". Anonymous
-- orders (counter sales) must still be fully settled when finalized; the two guards
-- keep that invariant without the column.
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION check_order_financial_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
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
 IF o.customer_kind='anonymous' AND allocated<>o.total_amount THEN
 RAISE EXCEPTION 'anonymous order must be immediately fully settled' USING ERRCODE='23514'; END IF;
 END IF;
 IF o.status='reversed' AND (adjusted<>o.total_amount OR allocated<>0) THEN
 RAISE EXCEPTION 'full reversal must negate charge and release payments' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION check_anonymous_job_completion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.customer_person_id IS NULL AND NEW.customer_organization_id IS NULL AND TG_OP='INSERT' AND NOT EXISTS(
 SELECT 1 FROM order_job_claims c JOIN order_items i ON i.id=c.order_item_id JOIN orders o ON o.id=i.order_id
 WHERE c.machine_job_id=NEW.id AND o.status='finalized' AND o.customer_kind='anonymous'
 AND o.total_amount=(SELECT COALESCE(sum(amount),0) FROM payment_allocations WHERE order_id=o.id)) THEN
 RAISE EXCEPTION 'anonymous job requires atomic counter sale' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
-- +goose StatementEnd

ALTER TABLE orders DROP COLUMN fulfillment_mode;

-- A job is "outdated" on an order when something it is billed for changed, not on every edit. The
-- billing revision advances only with such changes; the version stays the optimistic-lock counter.
-- Existing jobs and items start in step with their version, so what is outdated today stays outdated.
ALTER TABLE machine_jobs ADD COLUMN billing_revision bigint NOT NULL DEFAULT 1 CHECK (billing_revision > 0);
UPDATE machine_jobs SET billing_revision = version;
ALTER TABLE order_items ADD COLUMN source_billing_revision bigint CHECK (source_billing_revision IS NULL OR source_billing_revision > 0);
-- Booked items are immutable; the guard is off only for this backfill of the new column, inside the
-- migration's transaction.
ALTER TABLE order_items DISABLE TRIGGER order_items_frozen;
UPDATE order_items SET source_billing_revision = source_job_version WHERE source_job_version IS NOT NULL;
ALTER TABLE order_items ENABLE TRIGGER order_items_frozen;

-- +goose Down
ALTER TABLE order_items DROP COLUMN source_billing_revision;
ALTER TABLE machine_jobs DROP COLUMN billing_revision;

-- Restores the column with every existing order as handed over immediately.
ALTER TABLE orders ADD COLUMN fulfillment_mode text NOT NULL DEFAULT 'immediate' CHECK (fulfillment_mode IN ('immediate', 'deferred'));

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION check_order_financial_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
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
-- +goose StatementEnd
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION check_anonymous_job_completion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.customer_person_id IS NULL AND NEW.customer_organization_id IS NULL AND TG_OP='INSERT' AND NOT EXISTS(
 SELECT 1 FROM order_job_claims c JOIN order_items i ON i.id=c.order_item_id JOIN orders o ON o.id=i.order_id
 WHERE c.machine_job_id=NEW.id AND o.status='finalized' AND o.customer_kind='anonymous'
 AND o.fulfillment_mode='immediate' AND o.total_amount=(SELECT COALESCE(sum(amount),0) FROM payment_allocations WHERE order_id=o.id)) THEN
 RAISE EXCEPTION 'anonymous job requires atomic counter sale' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
-- +goose StatementEnd
