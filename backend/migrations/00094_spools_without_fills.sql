-- +goose Up
-- A spool is one filament unit: one material, one initial net weight and a remaining quantity derived from the
-- ledger. Spool holders, fills and the reusable/single-use kind go away. Each spool with an open fill keeps that
-- fill's material and weight; spools without an open fill are finished and archived; spools that never held a fill
-- are removed. The fill history itself is dropped. Ledger entries and job usages keep their spool display IDs.

DELETE FROM filament_spools s WHERE NOT EXISTS (SELECT 1 FROM filament_spool_fills f WHERE f.spool_id = s.id);

ALTER TABLE filament_spools
    ADD COLUMN material_id uuid,
    ADD COLUMN initial_net_weight_g numeric(20,6),
    ADD COLUMN retired_outcome text,
    ADD COLUMN retired_quantity numeric(20,6),
    ADD COLUMN retired_by uuid REFERENCES accounts(id) ON DELETE SET NULL;

UPDATE filament_spools s SET material_id = f.material_id, initial_net_weight_g = f.initial_net_weight_g
FROM (
    SELECT DISTINCT ON (spool_id) spool_id, material_id, initial_net_weight_g
    FROM filament_spool_fills
    ORDER BY spool_id, (closed_at IS NULL) DESC, fill_number DESC
) f
WHERE f.spool_id = s.id;

UPDATE filament_spools s SET lifecycle = 'archived',
    archived_at = COALESCE(s.archived_at, (SELECT max(f.closed_at) FROM filament_spool_fills f WHERE f.spool_id = s.id), now()),
    version = version + 1, updated_at = now()
WHERE s.lifecycle = 'active'
  AND NOT EXISTS (SELECT 1 FROM filament_spool_fills f WHERE f.spool_id = s.id AND f.closed_at IS NULL);

UPDATE printer_spool_assignments a SET unmounted_at = GREATEST(now(), a.mounted_at + interval '1 microsecond')
FROM filament_spools s
WHERE s.id = a.spool_id AND s.lifecycle = 'archived' AND a.unmounted_at IS NULL;

UPDATE filament_spool_identifiers i SET retired_at = COALESCE(s.archived_at, now())
FROM filament_spools s
WHERE s.id = i.spool_id AND s.lifecycle = 'archived' AND i.retired_at IS NULL;

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

ALTER TABLE inventory_transactions
    DROP CONSTRAINT inventory_transactions_spool_snapshot,
    DROP CONSTRAINT inventory_transactions_from_snapshot,
    DROP CONSTRAINT inventory_transactions_to_snapshot,
    DROP COLUMN fill_id,
    DROP COLUMN from_fill_id,
    DROP COLUMN to_fill_id,
    DROP COLUMN fill_number,
    DROP COLUMN from_fill_number,
    DROP COLUMN to_fill_number,
    ADD CONSTRAINT inventory_transactions_spool_snapshot CHECK (spool_id IS NULL OR spool_display_id IS NOT NULL),
    ADD CONSTRAINT inventory_transactions_from_snapshot CHECK (from_spool_id IS NULL OR from_spool_display_id IS NOT NULL),
    ADD CONSTRAINT inventory_transactions_to_snapshot CHECK (to_spool_id IS NULL OR to_spool_display_id IS NOT NULL);

ALTER TABLE machine_run_usages
    DROP CONSTRAINT machine_job_usages_spool_snapshot,
    DROP COLUMN fill_id,
    DROP COLUMN fill_number,
    ADD CONSTRAINT machine_job_usages_spool_snapshot CHECK (spool_id IS NULL OR spool_display_id IS NOT NULL);

ALTER TABLE filament_spool_identifiers DROP COLUMN fill_id;

DROP TABLE filament_spool_fills;

ALTER TABLE filament_spools
    DROP CONSTRAINT filament_spools_display_id_check,
    DROP CONSTRAINT filament_spools_display_id_key,
    DROP COLUMN kind,
    DROP COLUMN label,
    ALTER COLUMN material_id SET NOT NULL,
    ALTER COLUMN initial_net_weight_g SET NOT NULL,
    ADD CONSTRAINT filament_spools_material_id_fkey FOREIGN KEY (material_id) REFERENCES materials(id) ON DELETE CASCADE,
    ADD CONSTRAINT filament_spools_initial_net_weight_g_check CHECK (initial_net_weight_g > 0),
    -- Labels are S-<TYPECODE>-<VARIANT>-<COLOUR>-<NN>; spools registered before keep S-<YEAR>-<NNNNNN>.
    ADD CONSTRAINT filament_spools_display_id_check CHECK (
        length(display_id) <= 240 AND (display_id ~ '^S-[0-9]{4}-[0-9]{6,}$' OR display_id ~ '^S-[^-[:space:]].*-[0-9]{2,}$')),
    ADD CONSTRAINT filament_spools_retired_outcome_check CHECK (retired_outcome IS NULL OR retired_outcome IN ('empty', 'discarded')),
    ADD CONSTRAINT filament_spools_retired_shape CHECK (
        (retired_outcome IS NULL OR lifecycle = 'archived')
        AND (retired_outcome IS NULL) = (retired_quantity IS NULL)
        AND (retired_quantity IS NULL OR retired_quantity >= 0)
        AND (retired_by IS NULL OR retired_outcome IS NOT NULL));

-- Labels are unique among active spools only: retiring a spool frees its number.
CREATE UNIQUE INDEX filament_spools_active_display_id_idx ON filament_spools (display_id) WHERE lifecycle = 'active';
CREATE INDEX filament_spools_material_idx ON filament_spools (material_id, lifecycle);
CREATE INDEX filament_spools_archived_idx ON filament_spools (archived_at DESC) WHERE archived_at IS NOT NULL;

DROP SEQUENCE filament_spool_display_sequence;

-- +goose StatementBegin
CREATE FUNCTION filament_spool_remaining(spool uuid) RETURNS numeric LANGUAGE sql STABLE AS $$
    SELECT COALESCE(sum(CASE WHEN t.spool_id = spool THEN t.quantity_delta ELSE 0 END), 0)
         + COALESCE(sum(CASE WHEN t.to_spool_id = spool THEN t.transfer_quantity ELSE 0 END), 0)
         - COALESCE(sum(CASE WHEN t.from_spool_id = spool THEN t.transfer_quantity ELSE 0 END), 0)
    FROM inventory_transactions t
    WHERE t.spool_id = spool OR t.from_spool_id = spool OR t.to_spool_id = spool
$$;
-- +goose StatementEnd

-- +goose Down
DROP FUNCTION filament_spool_remaining(uuid);

CREATE SEQUENCE filament_spool_display_sequence;

DROP INDEX filament_spools_archived_idx;
DROP INDEX filament_spools_material_idx;
DROP INDEX filament_spools_active_display_id_idx;

ALTER TABLE filament_spools
    DROP CONSTRAINT filament_spools_display_id_check,
    DROP CONSTRAINT filament_spools_retired_shape,
    DROP CONSTRAINT filament_spools_retired_outcome_check,
    ADD COLUMN kind text NOT NULL DEFAULT 'single_use' CHECK (kind IN ('reusable', 'single_use')),
    ADD COLUMN label text CHECK (label IS NULL OR (label = btrim(label) AND label <> '' AND length(label) <= 120));
ALTER TABLE filament_spools ALTER COLUMN kind DROP DEFAULT;

UPDATE filament_spools SET display_id = 'S-' || to_char(created_at AT TIME ZONE 'UTC', 'YYYY') || '-'
    || lpad(nextval('filament_spool_display_sequence')::text, 6, '0')
WHERE display_id !~ '^S-[0-9]{4}-[0-9]{6,}$';

ALTER TABLE filament_spools
    ADD CONSTRAINT filament_spools_display_id_check CHECK (display_id ~ '^S-[0-9]{4}-[0-9]{6,}$'),
    ADD CONSTRAINT filament_spools_display_id_key UNIQUE (display_id);
CREATE INDEX filament_spools_archived_idx ON filament_spools (kind, archived_at) WHERE archived_at IS NOT NULL;

CREATE TABLE filament_spool_fills (
    id uuid PRIMARY KEY,
    spool_id uuid NOT NULL REFERENCES filament_spools(id) ON DELETE CASCADE,
    fill_number integer NOT NULL CHECK (fill_number > 0),
    material_id uuid NOT NULL REFERENCES materials(id) ON DELETE RESTRICT,
    manufacturer text CHECK (manufacturer IS NULL OR (manufacturer = btrim(manufacturer) AND manufacturer <> '' AND length(manufacturer) <= 150)),
    product_name text CHECK (product_name IS NULL OR (product_name = btrim(product_name) AND product_name <> '' AND length(product_name) <= 200)),
    initial_net_weight_g numeric(20,6) NOT NULL CHECK (initial_net_weight_g > 0),
    filled_at timestamptz NOT NULL,
    closed_at timestamptz,
    leftover_g numeric(20,6) CHECK (leftover_g IS NULL OR leftover_g >= 0),
    leftover_outcome text CHECK (leftover_outcome IS NULL OR leftover_outcome IN ('used_up', 'returned_to_stock', 'disposed')),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (spool_id, fill_number),
    UNIQUE (id, material_id),
    CHECK (closed_at IS NULL OR closed_at >= filled_at),
    CHECK ((closed_at IS NULL AND leftover_g IS NULL AND leftover_outcome IS NULL)
        OR (closed_at IS NOT NULL AND leftover_g IS NOT NULL AND leftover_outcome IS NOT NULL)),
    CHECK (leftover_outcome IS NULL OR (leftover_outcome = 'used_up') = (leftover_g = 0))
);
CREATE UNIQUE INDEX filament_spool_fills_open_idx ON filament_spool_fills (spool_id) WHERE closed_at IS NULL;
CREATE INDEX filament_spool_fills_material_idx ON filament_spool_fills (material_id) WHERE closed_at IS NULL;

-- Every spool becomes fill 1 of itself; archived spools hold a closed, used-up fill. The spool id is reused as the
-- fill id so the ledger can be linked back without a lookup table.
INSERT INTO filament_spool_fills (id, spool_id, fill_number, material_id, manufacturer, initial_net_weight_g, filled_at,
    closed_at, leftover_g, leftover_outcome)
SELECT s.id, s.id, 1, s.material_id, m.manufacturer, s.initial_net_weight_g, s.created_at,
    CASE WHEN s.lifecycle = 'archived' THEN GREATEST(COALESCE(s.archived_at, now()), s.created_at) END,
    CASE WHEN s.lifecycle = 'archived' THEN 0 END,
    CASE WHEN s.lifecycle = 'archived' THEN 'used_up' END
FROM filament_spools s JOIN materials m ON m.id = s.material_id;

ALTER TABLE filament_spool_identifiers ADD COLUMN fill_id uuid REFERENCES filament_spool_fills(id) ON DELETE CASCADE;
UPDATE filament_spool_identifiers SET fill_id = spool_id;
ALTER TABLE filament_spool_identifiers ALTER COLUMN fill_id SET NOT NULL;
CREATE INDEX filament_spool_identifiers_fill_idx ON filament_spool_identifiers (fill_id);

ALTER TABLE machine_run_usages
    DROP CONSTRAINT machine_job_usages_spool_snapshot,
    ADD COLUMN fill_id uuid,
    ADD COLUMN fill_number integer;
UPDATE machine_run_usages u SET fill_id = f.id FROM filament_spool_fills f WHERE f.spool_id = u.spool_id AND f.material_id = u.material_id;
UPDATE machine_run_usages SET fill_number = 1 WHERE spool_display_id IS NOT NULL;
ALTER TABLE machine_run_usages
    ADD CONSTRAINT machine_job_usages_fill_fk FOREIGN KEY (fill_id, material_id) REFERENCES filament_spool_fills(id, material_id) ON DELETE SET NULL (fill_id),
    ADD CONSTRAINT machine_job_usages_spool_snapshot CHECK ((spool_display_id IS NULL) = (fill_number IS NULL) AND (spool_id IS NULL OR spool_display_id IS NOT NULL));

ALTER TABLE inventory_transactions
    DROP CONSTRAINT inventory_transactions_spool_snapshot,
    DROP CONSTRAINT inventory_transactions_from_snapshot,
    DROP CONSTRAINT inventory_transactions_to_snapshot,
    ADD COLUMN fill_id uuid,
    ADD COLUMN from_fill_id uuid,
    ADD COLUMN to_fill_id uuid,
    ADD COLUMN fill_number integer,
    ADD COLUMN from_fill_number integer,
    ADD COLUMN to_fill_number integer;
UPDATE inventory_transactions t SET
    fill_id = (SELECT f.id FROM filament_spool_fills f WHERE f.id = t.spool_id AND f.material_id = t.material_id),
    from_fill_id = (SELECT f.id FROM filament_spool_fills f WHERE f.id = t.from_spool_id AND f.material_id = t.material_id),
    to_fill_id = (SELECT f.id FROM filament_spool_fills f WHERE f.id = t.to_spool_id AND f.material_id = t.material_id),
    fill_number = CASE WHEN t.spool_display_id IS NOT NULL THEN 1 END,
    from_fill_number = CASE WHEN t.from_spool_display_id IS NOT NULL THEN 1 END,
    to_fill_number = CASE WHEN t.to_spool_display_id IS NOT NULL THEN 1 END;
ALTER TABLE inventory_transactions
    ADD CONSTRAINT inventory_transactions_fill_fk FOREIGN KEY (fill_id, material_id) REFERENCES filament_spool_fills(id, material_id) ON DELETE SET NULL (fill_id),
    ADD CONSTRAINT inventory_transactions_from_fill_fk FOREIGN KEY (from_fill_id, material_id) REFERENCES filament_spool_fills(id, material_id) ON DELETE SET NULL (from_fill_id),
    ADD CONSTRAINT inventory_transactions_to_fill_fk FOREIGN KEY (to_fill_id, material_id) REFERENCES filament_spool_fills(id, material_id) ON DELETE SET NULL (to_fill_id),
    ADD CONSTRAINT inventory_transactions_spool_snapshot CHECK ((spool_display_id IS NULL) = (fill_number IS NULL) AND (spool_id IS NULL OR spool_display_id IS NOT NULL)),
    ADD CONSTRAINT inventory_transactions_from_snapshot CHECK ((from_spool_display_id IS NULL) = (from_fill_number IS NULL) AND (from_spool_id IS NULL OR from_spool_display_id IS NOT NULL)),
    ADD CONSTRAINT inventory_transactions_to_snapshot CHECK ((to_spool_display_id IS NULL) = (to_fill_number IS NULL) AND (to_spool_id IS NULL OR to_spool_display_id IS NOT NULL));
CREATE INDEX inventory_transactions_fill_idx ON inventory_transactions (fill_id) WHERE fill_id IS NOT NULL;
CREATE INDEX inventory_transactions_from_fill_idx ON inventory_transactions (from_fill_id) WHERE from_fill_id IS NOT NULL;
CREATE INDEX inventory_transactions_to_fill_idx ON inventory_transactions (to_fill_id) WHERE to_fill_id IS NOT NULL;

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

ALTER TABLE filament_spools
    DROP CONSTRAINT filament_spools_initial_net_weight_g_check,
    DROP CONSTRAINT filament_spools_material_id_fkey,
    DROP COLUMN retired_by,
    DROP COLUMN retired_quantity,
    DROP COLUMN retired_outcome,
    DROP COLUMN initial_net_weight_g,
    DROP COLUMN material_id;
