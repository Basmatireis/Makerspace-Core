-- +goose Up
-- Inventory recycle bin: articles and ledger entries are soft-deleted (deleted_at, deleted_by) and can be restored
-- or purged. Balances and spool remainders exclude deleted ledger entries. Purging is a genuine hard delete: an
-- article takes its balance, spools, pricing rules and ledger entries with it, while run usages and order items keep
-- their names and lose the link. The ledger stays immutable otherwise; only a purge (session setting
-- makerspace.inventory_purge = on) may delete its rows.

ALTER TABLE materials
    ADD COLUMN deleted_at timestamptz,
    ADD COLUMN deleted_by uuid REFERENCES accounts(id) ON DELETE SET NULL,
    ADD CONSTRAINT materials_deleted_check CHECK (deleted_at IS NOT NULL OR deleted_by IS NULL);
CREATE INDEX materials_deleted_idx ON materials (deleted_at DESC) WHERE deleted_at IS NOT NULL;

ALTER TABLE inventory_transactions
    ADD COLUMN deleted_at timestamptz,
    ADD COLUMN deleted_by uuid REFERENCES accounts(id) ON DELETE SET NULL,
    ADD CONSTRAINT inventory_transactions_deleted_check CHECK (deleted_at IS NOT NULL OR deleted_by IS NULL),
    DROP CONSTRAINT inventory_transactions_material_id_fkey,
    ADD CONSTRAINT inventory_transactions_material_id_fkey FOREIGN KEY (material_id) REFERENCES materials(id) ON DELETE CASCADE;
CREATE INDEX inventory_transactions_deleted_idx ON inventory_transactions (deleted_at DESC) WHERE deleted_at IS NOT NULL;

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION guard_inventory_transaction_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF current_setting('makerspace.inventory_purge', true) = 'on' THEN
            RETURN OLD;
        END IF;
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
       OR NEW.transfer_quantity IS DISTINCT FROM OLD.transfer_quantity
       OR NEW.spool_display_id IS DISTINCT FROM OLD.spool_display_id
       OR NEW.from_spool_display_id IS DISTINCT FROM OLD.from_spool_display_id
       OR NEW.to_spool_display_id IS DISTINCT FROM OLD.to_spool_display_id
       OR (NEW.deleted_by IS DISTINCT FROM OLD.deleted_by AND NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at
           AND NEW.deleted_by IS NOT NULL) THEN
        RAISE EXCEPTION 'inventory transaction history is immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END $$;
-- +goose StatementEnd

DROP TRIGGER inventory_transactions_people_merge ON inventory_transactions;
CREATE TRIGGER inventory_transactions_people_merge BEFORE DELETE OR UPDATE ON inventory_transactions FOR EACH ROW
    WHEN (current_setting('makerspace.people_merge', true) = 'on')
    EXECUTE FUNCTION people_merge_reference_guard('actor_account_id', 'deleted_by');

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION filament_spool_remaining(spool uuid) RETURNS numeric LANGUAGE sql STABLE AS $$
    SELECT COALESCE(sum(CASE WHEN t.spool_id = spool THEN t.quantity_delta ELSE 0 END), 0)
         + COALESCE(sum(CASE WHEN t.to_spool_id = spool THEN t.transfer_quantity ELSE 0 END), 0)
         - COALESCE(sum(CASE WHEN t.from_spool_id = spool THEN t.transfer_quantity ELSE 0 END), 0)
    FROM inventory_transactions t
    WHERE (t.spool_id = spool OR t.from_spool_id = spool OR t.to_spool_id = spool) AND t.deleted_at IS NULL
$$;
-- +goose StatementEnd

-- A run usage keeps the article name and unit once the article is purged.
ALTER TABLE machine_run_usages
    ADD COLUMN material_name text CHECK (material_name IS NULL OR (material_name = btrim(material_name) AND material_name <> '' AND length(material_name) <= 150)),
    ADD COLUMN material_unit text CHECK (material_unit IS NULL OR material_unit IN ('g', 'm', 'ml', 'm2', 'cm2', 'piece')),
    DROP CONSTRAINT machine_job_usages_ownership_check,
    ADD CONSTRAINT machine_job_usages_ownership_check CHECK (
        (ownership = 'makerspace' AND (material_id IS NOT NULL OR material_name IS NOT NULL) AND external_material_name IS NULL)
        OR (ownership = 'external' AND spool_id IS NULL AND external_material_name IS NOT NULL
            AND external_material_name = btrim(external_material_name) AND external_material_name <> ''
            AND length(external_material_name) <= 200)),
    DROP CONSTRAINT machine_job_material_usages_material_id_fkey,
    ADD CONSTRAINT machine_job_material_usages_material_id_fkey FOREIGN KEY (material_id) REFERENCES materials(id) ON DELETE SET NULL;

ALTER TABLE machine_run_reported_usage_items
    DROP CONSTRAINT machine_run_reported_usage_items_material_id_fkey,
    ADD CONSTRAINT machine_run_reported_usage_items_material_id_fkey FOREIGN KEY (material_id) REFERENCES materials(id) ON DELETE SET NULL;

-- +goose Down
-- Purged articles cannot come back; their usages lose the name snapshot only when an article still exists.
ALTER TABLE machine_run_reported_usage_items
    DROP CONSTRAINT machine_run_reported_usage_items_material_id_fkey,
    ADD CONSTRAINT machine_run_reported_usage_items_material_id_fkey FOREIGN KEY (material_id) REFERENCES materials(id) ON DELETE RESTRICT;

DELETE FROM machine_run_usages WHERE ownership = 'makerspace' AND material_id IS NULL;
ALTER TABLE machine_run_usages
    DROP CONSTRAINT machine_job_material_usages_material_id_fkey,
    ADD CONSTRAINT machine_job_material_usages_material_id_fkey FOREIGN KEY (material_id) REFERENCES materials(id) ON DELETE RESTRICT,
    DROP CONSTRAINT machine_job_usages_ownership_check,
    ADD CONSTRAINT machine_job_usages_ownership_check CHECK (
        (ownership = 'makerspace' AND material_id IS NOT NULL AND external_material_name IS NULL)
        OR (ownership = 'external' AND spool_id IS NULL AND external_material_name IS NOT NULL
            AND external_material_name = btrim(external_material_name) AND external_material_name <> ''
            AND length(external_material_name) <= 200)),
    DROP COLUMN material_unit,
    DROP COLUMN material_name;

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION filament_spool_remaining(spool uuid) RETURNS numeric LANGUAGE sql STABLE AS $$
    SELECT COALESCE(sum(CASE WHEN t.spool_id = spool THEN t.quantity_delta ELSE 0 END), 0)
         + COALESCE(sum(CASE WHEN t.to_spool_id = spool THEN t.transfer_quantity ELSE 0 END), 0)
         - COALESCE(sum(CASE WHEN t.from_spool_id = spool THEN t.transfer_quantity ELSE 0 END), 0)
    FROM inventory_transactions t
    WHERE t.spool_id = spool OR t.from_spool_id = spool OR t.to_spool_id = spool
$$;
-- +goose StatementEnd

DROP TRIGGER inventory_transactions_people_merge ON inventory_transactions;
CREATE TRIGGER inventory_transactions_people_merge BEFORE DELETE OR UPDATE ON inventory_transactions FOR EACH ROW
    WHEN (current_setting('makerspace.people_merge', true) = 'on')
    EXECUTE FUNCTION people_merge_reference_guard('actor_account_id');

-- Deleted ledger entries become live again: the balances are rebuilt from the ledger below.
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
       OR NEW.transfer_quantity IS DISTINCT FROM OLD.transfer_quantity
       OR NEW.spool_display_id IS DISTINCT FROM OLD.spool_display_id
       OR NEW.from_spool_display_id IS DISTINCT FROM OLD.from_spool_display_id
       OR NEW.to_spool_display_id IS DISTINCT FROM OLD.to_spool_display_id THEN
        RAISE EXCEPTION 'inventory transaction history is immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END $$;
-- +goose StatementEnd

UPDATE material_balances b SET
    quantity = GREATEST(COALESCE((SELECT sum(t.quantity_delta) FROM inventory_transactions t WHERE t.material_id = b.material_id), 0), 0),
    inventory_value = GREATEST(COALESCE((SELECT sum(t.inventory_value_delta) FROM inventory_transactions t WHERE t.material_id = b.material_id), 0), 0),
    version = version + 1, updated_at = now()
WHERE EXISTS (SELECT 1 FROM inventory_transactions t WHERE t.material_id = b.material_id AND t.deleted_at IS NOT NULL);

DROP INDEX inventory_transactions_deleted_idx;
ALTER TABLE inventory_transactions
    DROP CONSTRAINT inventory_transactions_material_id_fkey,
    ADD CONSTRAINT inventory_transactions_material_id_fkey FOREIGN KEY (material_id) REFERENCES materials(id) ON DELETE RESTRICT,
    DROP CONSTRAINT inventory_transactions_deleted_check,
    DROP COLUMN deleted_by,
    DROP COLUMN deleted_at;

DROP INDEX materials_deleted_idx;
ALTER TABLE materials
    DROP CONSTRAINT materials_deleted_check,
    DROP COLUMN deleted_by,
    DROP COLUMN deleted_at;
