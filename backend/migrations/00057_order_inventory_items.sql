-- +goose Up
-- Orders can sell stock: an order item of kind inventory_item snapshots the
-- article name and unit in its description/unit columns and keeps a detachable
-- reference to the article. Finalization books an order_sale ledger row,
-- reversal books an order_sale_reversal row.

-- 1. Order items.
ALTER TABLE order_items
    ADD COLUMN source_material_id uuid REFERENCES materials(id) ON DELETE SET NULL;
CREATE INDEX order_items_source_material_idx ON order_items (source_material_id) WHERE source_material_id IS NOT NULL;
ALTER TABLE order_items
    DROP CONSTRAINT order_items_kind_check,
    DROP CONSTRAINT order_items_check,
    ADD CONSTRAINT order_items_kind_check CHECK (kind IN ('manual', 'machine_job', 'inventory_item')),
    ADD CONSTRAINT order_items_check CHECK (
        (kind IN ('manual', 'inventory_item') AND machine_job_snapshot IS NULL AND source_job_version IS NULL)
        OR (kind = 'machine_job' AND jsonb_typeof(machine_job_snapshot) = 'object' AND source_job_version > 0)),
    ADD CONSTRAINT order_items_source_material_kind CHECK (kind = 'inventory_item' OR source_material_id IS NULL);

-- The article reference may be detached (article deletion) but never changed.
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION order_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
 IF (SELECT status FROM orders WHERE id=NEW.order_id)<>'draft' THEN RAISE EXCEPTION 'order is not draft' USING ERRCODE='23514'; END IF;
 ELSE
 IF (to_jsonb(NEW)-ARRAY['removed_at','removed_by_account_id','source_machine_job_id','source_material_id','created_by_account_id']) IS DISTINCT FROM
 (to_jsonb(OLD)-ARRAY['removed_at','removed_by_account_id','source_machine_job_id','source_material_id','created_by_account_id']) THEN
 RAISE EXCEPTION 'order item content is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.removed_at IS DISTINCT FROM OLD.removed_at AND (SELECT status FROM orders WHERE id=OLD.order_id)<>'draft' THEN
 RAISE EXCEPTION 'order is not draft' USING ERRCODE='23514'; END IF;
 END IF; RETURN NEW;
END $$;
-- +goose StatementEnd
DROP TRIGGER order_items_references_frozen ON order_items;
CREATE TRIGGER order_items_references_frozen BEFORE UPDATE ON order_items FOR EACH ROW EXECUTE FUNCTION financial_reference_guard('source_machine_job_id','source_material_id','created_by_account_id');

-- 2. Ledger.
ALTER TABLE inventory_transactions
    ADD COLUMN order_item_id uuid REFERENCES order_items(id) ON DELETE SET NULL,
    DROP CONSTRAINT inventory_transactions_kind_check,
    DROP CONSTRAINT inventory_transactions_consumption_sign,
    ADD CONSTRAINT inventory_transactions_kind_check CHECK (kind IN ('purchase', 'machine_run_consumption', 'manual_consumption', 'adjustment', 'disposal', 'spool_transfer', 'order_sale', 'order_sale_reversal')),
    ADD CONSTRAINT inventory_transactions_consumption_sign CHECK ((kind IN ('machine_run_consumption', 'manual_consumption', 'disposal', 'order_sale') AND quantity_delta < 0) OR kind NOT IN ('machine_run_consumption', 'manual_consumption', 'disposal', 'order_sale')),
    ADD CONSTRAINT inventory_transactions_order_sale_reversal_sign CHECK (kind <> 'order_sale_reversal' OR quantity_delta > 0),
    -- NULL once the order item was deleted; the application always sets it.
    ADD CONSTRAINT inventory_transactions_order_item_kind CHECK (order_item_id IS NULL OR kind IN ('order_sale', 'order_sale_reversal'));
CREATE UNIQUE INDEX inventory_transactions_order_sale_idx ON inventory_transactions (order_item_id) WHERE kind = 'order_sale' AND order_item_id IS NOT NULL;
CREATE UNIQUE INDEX inventory_transactions_order_sale_reversal_idx ON inventory_transactions (order_item_id) WHERE kind = 'order_sale_reversal' AND order_item_id IS NOT NULL;

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION guard_inventory_transaction_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'inventory transaction history is immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.material_id IS DISTINCT FROM OLD.material_id
       OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.quantity_delta IS DISTINCT FROM OLD.quantity_delta
       OR NEW.unit_acquisition_cost IS DISTINCT FROM OLD.unit_acquisition_cost
       OR NEW.inventory_value_delta IS DISTINCT FROM OLD.inventory_value_delta
       OR NEW.total_purchase_price IS DISTINCT FROM OLD.total_purchase_price
       OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
       OR NEW.supplier IS DISTINCT FROM OLD.supplier
       OR NEW.note IS DISTINCT FROM OLD.note
       OR NEW.adjustment_reason IS DISTINCT FROM OLD.adjustment_reason
       OR NEW.purchase_reference IS DISTINCT FROM OLD.purchase_reference
       OR NEW.run_usage_id IS DISTINCT FROM OLD.run_usage_id
       OR (NEW.actor_account_id IS DISTINCT FROM OLD.actor_account_id AND NOT (OLD.actor_account_id IS NOT NULL AND NEW.actor_account_id IS NULL))
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR (NEW.order_item_id IS DISTINCT FROM OLD.order_item_id AND NEW.order_item_id IS NOT NULL)
       OR (NEW.spool_id IS DISTINCT FROM OLD.spool_id AND NEW.spool_id IS NOT NULL)
       OR (NEW.from_spool_id IS DISTINCT FROM OLD.from_spool_id AND NEW.from_spool_id IS NOT NULL)
       OR (NEW.to_spool_id IS DISTINCT FROM OLD.to_spool_id AND NEW.to_spool_id IS NOT NULL)
       OR (NEW.fill_id IS DISTINCT FROM OLD.fill_id AND NEW.fill_id IS NOT NULL)
       OR (NEW.from_fill_id IS DISTINCT FROM OLD.from_fill_id AND NEW.from_fill_id IS NOT NULL)
       OR (NEW.to_fill_id IS DISTINCT FROM OLD.to_fill_id AND NEW.to_fill_id IS NOT NULL)
       OR NEW.transfer_quantity IS DISTINCT FROM OLD.transfer_quantity
       OR NEW.spool_display_id IS DISTINCT FROM OLD.spool_display_id
       OR NEW.fill_number IS DISTINCT FROM OLD.fill_number
       OR NEW.from_spool_display_id IS DISTINCT FROM OLD.from_spool_display_id
       OR NEW.from_fill_number IS DISTINCT FROM OLD.from_fill_number
       OR NEW.to_spool_display_id IS DISTINCT FROM OLD.to_spool_display_id
       OR NEW.to_fill_number IS DISTINCT FROM OLD.to_fill_number THEN
        RAISE EXCEPTION 'inventory transaction history is immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END $$;
-- +goose StatementEnd

-- +goose Down
-- Sold stock cannot be represented without the new kinds and is never dropped silently.
-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM order_items WHERE kind = 'inventory_item')
       OR EXISTS (SELECT 1 FROM inventory_transactions WHERE kind IN ('order_sale', 'order_sale_reversal')) THEN
        RAISE EXCEPTION 'orders with inventory items and order sale ledger rows cannot be downgraded; remove them first';
    END IF;
END $$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION guard_inventory_transaction_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'inventory transaction history is immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.material_id IS DISTINCT FROM OLD.material_id
       OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.quantity_delta IS DISTINCT FROM OLD.quantity_delta
       OR NEW.unit_acquisition_cost IS DISTINCT FROM OLD.unit_acquisition_cost
       OR NEW.inventory_value_delta IS DISTINCT FROM OLD.inventory_value_delta
       OR NEW.total_purchase_price IS DISTINCT FROM OLD.total_purchase_price
       OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
       OR NEW.supplier IS DISTINCT FROM OLD.supplier
       OR NEW.note IS DISTINCT FROM OLD.note
       OR NEW.adjustment_reason IS DISTINCT FROM OLD.adjustment_reason
       OR NEW.purchase_reference IS DISTINCT FROM OLD.purchase_reference
       OR NEW.run_usage_id IS DISTINCT FROM OLD.run_usage_id
       OR (NEW.actor_account_id IS DISTINCT FROM OLD.actor_account_id AND NOT (OLD.actor_account_id IS NOT NULL AND NEW.actor_account_id IS NULL))
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR (NEW.spool_id IS DISTINCT FROM OLD.spool_id AND NEW.spool_id IS NOT NULL)
       OR (NEW.from_spool_id IS DISTINCT FROM OLD.from_spool_id AND NEW.from_spool_id IS NOT NULL)
       OR (NEW.to_spool_id IS DISTINCT FROM OLD.to_spool_id AND NEW.to_spool_id IS NOT NULL)
       OR (NEW.fill_id IS DISTINCT FROM OLD.fill_id AND NEW.fill_id IS NOT NULL)
       OR (NEW.from_fill_id IS DISTINCT FROM OLD.from_fill_id AND NEW.from_fill_id IS NOT NULL)
       OR (NEW.to_fill_id IS DISTINCT FROM OLD.to_fill_id AND NEW.to_fill_id IS NOT NULL)
       OR NEW.transfer_quantity IS DISTINCT FROM OLD.transfer_quantity
       OR NEW.spool_display_id IS DISTINCT FROM OLD.spool_display_id
       OR NEW.fill_number IS DISTINCT FROM OLD.fill_number
       OR NEW.from_spool_display_id IS DISTINCT FROM OLD.from_spool_display_id
       OR NEW.from_fill_number IS DISTINCT FROM OLD.from_fill_number
       OR NEW.to_spool_display_id IS DISTINCT FROM OLD.to_spool_display_id
       OR NEW.to_fill_number IS DISTINCT FROM OLD.to_fill_number THEN
        RAISE EXCEPTION 'inventory transaction history is immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END $$;
-- +goose StatementEnd

DROP INDEX inventory_transactions_order_sale_reversal_idx;
DROP INDEX inventory_transactions_order_sale_idx;
ALTER TABLE inventory_transactions
    DROP CONSTRAINT inventory_transactions_order_item_kind,
    DROP CONSTRAINT inventory_transactions_order_sale_reversal_sign,
    DROP CONSTRAINT inventory_transactions_consumption_sign,
    DROP CONSTRAINT inventory_transactions_kind_check,
    ADD CONSTRAINT inventory_transactions_kind_check CHECK (kind IN ('purchase', 'machine_run_consumption', 'manual_consumption', 'adjustment', 'disposal', 'spool_transfer')),
    ADD CONSTRAINT inventory_transactions_consumption_sign CHECK ((kind IN ('machine_run_consumption', 'manual_consumption', 'disposal') AND quantity_delta < 0) OR kind NOT IN ('machine_run_consumption', 'manual_consumption', 'disposal')),
    DROP COLUMN order_item_id;

DROP TRIGGER order_items_references_frozen ON order_items;
CREATE TRIGGER order_items_references_frozen BEFORE UPDATE ON order_items FOR EACH ROW EXECUTE FUNCTION financial_reference_guard('source_machine_job_id','created_by_account_id');
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION order_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
 IF (SELECT status FROM orders WHERE id=NEW.order_id)<>'draft' THEN RAISE EXCEPTION 'order is not draft' USING ERRCODE='23514'; END IF;
 ELSE
 IF (to_jsonb(NEW)-ARRAY['removed_at','removed_by_account_id','source_machine_job_id','created_by_account_id']) IS DISTINCT FROM
 (to_jsonb(OLD)-ARRAY['removed_at','removed_by_account_id','source_machine_job_id','created_by_account_id']) THEN
 RAISE EXCEPTION 'order item content is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.removed_at IS DISTINCT FROM OLD.removed_at AND (SELECT status FROM orders WHERE id=OLD.order_id)<>'draft' THEN
 RAISE EXCEPTION 'order is not draft' USING ERRCODE='23514'; END IF;
 END IF; RETURN NEW;
END $$;
-- +goose StatementEnd
ALTER TABLE order_items
    DROP CONSTRAINT order_items_source_material_kind,
    DROP CONSTRAINT order_items_check,
    DROP CONSTRAINT order_items_kind_check,
    ADD CONSTRAINT order_items_kind_check CHECK (kind IN ('manual', 'machine_job')),
    ADD CONSTRAINT order_items_check CHECK (
        (kind = 'manual' AND machine_job_snapshot IS NULL AND source_job_version IS NULL)
        OR (kind = 'machine_job' AND jsonb_typeof(machine_job_snapshot) = 'object' AND source_job_version > 0));
DROP INDEX order_items_source_material_idx;
ALTER TABLE order_items DROP COLUMN source_material_id;
