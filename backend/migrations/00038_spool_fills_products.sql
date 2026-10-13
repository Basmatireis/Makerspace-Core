-- +goose Up
-- A spool is the physical carrier; a fill is one filling of it with one
-- filament. Material, product and weight move from the spool to its fills so
-- reusable spools can be refilled with another material. Ledger entries and
-- job usages reference the fill and keep spool display ID and fill number
-- snapshots, so archived single-use spools can be hard-deleted while material
-- and job history stay readable. Purchasable filament products form a catalog.

CREATE TABLE filament_products (
    id uuid PRIMARY KEY,
    manufacturer text NOT NULL CHECK (manufacturer = btrim(manufacturer) AND manufacturer <> '' AND length(manufacturer) <= 150),
    name text NOT NULL CHECK (name = btrim(name) AND name <> '' AND length(name) <= 200),
    material_id uuid NOT NULL REFERENCES materials(id) ON DELETE RESTRICT,
    net_weight_g numeric(20, 6) NOT NULL CHECK (net_weight_g > 0),
    default_price numeric(20, 2) CHECK (default_price IS NULL OR default_price >= 0),
    packaging text NOT NULL CHECK (packaging IN ('refill', 'spool')),
    notes text CHECK (notes IS NULL OR length(notes) <= 2000),
    active boolean NOT NULL DEFAULT true,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX filament_products_name_ci_idx ON filament_products (lower(manufacturer), lower(name));
CREATE INDEX filament_products_material_idx ON filament_products (material_id);

CREATE TABLE filament_spool_fills (
    id uuid PRIMARY KEY,
    spool_id uuid NOT NULL REFERENCES filament_spools(id) ON DELETE CASCADE,
    fill_number integer NOT NULL CHECK (fill_number > 0),
    material_id uuid NOT NULL REFERENCES materials(id) ON DELETE RESTRICT,
    product_id uuid REFERENCES filament_products(id) ON DELETE SET NULL,
    manufacturer text CHECK (manufacturer IS NULL OR (manufacturer = btrim(manufacturer) AND manufacturer <> '' AND length(manufacturer) <= 150)),
    product_name text CHECK (product_name IS NULL OR (product_name = btrim(product_name) AND product_name <> '' AND length(product_name) <= 200)),
    initial_net_weight_g numeric(20, 6) NOT NULL CHECK (initial_net_weight_g > 0),
    filled_at timestamptz NOT NULL,
    closed_at timestamptz,
    leftover_g numeric(20, 6) CHECK (leftover_g IS NULL OR leftover_g >= 0),
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
CREATE INDEX filament_spool_fills_product_idx ON filament_spool_fills (product_id) WHERE product_id IS NOT NULL;

-- Every existing spool becomes fill 1. Retired spools keep an open fill so
-- their remaining stock stays attributed until someone finishes them.
INSERT INTO filament_spool_fills (id, spool_id, fill_number, material_id, manufacturer, product_name, initial_net_weight_g, filled_at, created_at)
SELECT uuidv7(), s.id, 1, s.material_id, s.manufacturer, s.product_name, s.initial_net_weight_g,
       COALESCE(s.acquired_on::timestamptz, s.created_at), s.created_at
FROM filament_spools s;

ALTER TABLE filament_spools
    ADD COLUMN kind text NOT NULL DEFAULT 'single_use' CHECK (kind IN ('reusable', 'single_use')),
    ADD COLUMN label text CHECK (label IS NULL OR (label = btrim(label) AND label <> '' AND length(label) <= 120)),
    ADD COLUMN archived_at timestamptz;
ALTER TABLE filament_spools ALTER COLUMN kind DROP DEFAULT;
UPDATE filament_spools SET archived_at = updated_at WHERE lifecycle = 'retired';
ALTER TABLE filament_spools DROP CONSTRAINT filament_spools_lifecycle_check;
UPDATE filament_spools SET lifecycle = 'archived' WHERE lifecycle = 'retired';
ALTER TABLE filament_spools
    ADD CONSTRAINT filament_spools_lifecycle_check CHECK (lifecycle IN ('active', 'archived')),
    ADD CONSTRAINT filament_spools_archived_shape CHECK ((lifecycle = 'archived') = (archived_at IS NOT NULL));
CREATE INDEX filament_spools_archived_idx ON filament_spools (kind, archived_at) WHERE archived_at IS NOT NULL;

-- Identifiers belong to a fill. Tags of closed fills are retired and stay in
-- the fill history; only unretired tags must be unique.
ALTER TABLE filament_spool_identifiers
    ADD COLUMN fill_id uuid REFERENCES filament_spool_fills(id) ON DELETE CASCADE,
    ADD COLUMN retired_at timestamptz;
UPDATE filament_spool_identifiers i SET fill_id = f.id FROM filament_spool_fills f WHERE f.spool_id = i.spool_id;
ALTER TABLE filament_spool_identifiers ALTER COLUMN fill_id SET NOT NULL;
DROP INDEX filament_spool_identifiers_kind_value_idx;
CREATE UNIQUE INDEX filament_spool_identifiers_active_value_idx ON filament_spool_identifiers (kind, lower(value)) WHERE retired_at IS NULL;
CREATE INDEX filament_spool_identifiers_fill_idx ON filament_spool_identifiers (fill_id);

-- Ledger: fill references with material integrity and snapshots that survive
-- spool deletion.
ALTER TABLE inventory_transactions
    DROP CONSTRAINT inventory_transactions_spool_fk,
    DROP CONSTRAINT inventory_transactions_from_spool_fk,
    DROP CONSTRAINT inventory_transactions_to_spool_fk,
    ADD COLUMN fill_id uuid,
    ADD COLUMN from_fill_id uuid,
    ADD COLUMN to_fill_id uuid,
    ADD COLUMN spool_display_id text,
    ADD COLUMN fill_number integer,
    ADD COLUMN from_spool_display_id text,
    ADD COLUMN from_fill_number integer,
    ADD COLUMN to_spool_display_id text,
    ADD COLUMN to_fill_number integer;

UPDATE inventory_transactions t
SET fill_id = f.id, spool_display_id = s.display_id, fill_number = f.fill_number
FROM filament_spool_fills f JOIN filament_spools s ON s.id = f.spool_id
WHERE f.spool_id = t.spool_id;
UPDATE inventory_transactions t
SET from_fill_id = f.id, from_spool_display_id = s.display_id, from_fill_number = f.fill_number
FROM filament_spool_fills f JOIN filament_spools s ON s.id = f.spool_id
WHERE f.spool_id = t.from_spool_id;
UPDATE inventory_transactions t
SET to_fill_id = f.id, to_spool_display_id = s.display_id, to_fill_number = f.fill_number
FROM filament_spool_fills f JOIN filament_spools s ON s.id = f.spool_id
WHERE f.spool_id = t.to_spool_id;

ALTER TABLE inventory_transactions
    ADD CONSTRAINT inventory_transactions_spool_fk FOREIGN KEY (spool_id) REFERENCES filament_spools(id) ON DELETE SET NULL,
    ADD CONSTRAINT inventory_transactions_from_spool_fk FOREIGN KEY (from_spool_id) REFERENCES filament_spools(id) ON DELETE SET NULL,
    ADD CONSTRAINT inventory_transactions_to_spool_fk FOREIGN KEY (to_spool_id) REFERENCES filament_spools(id) ON DELETE SET NULL,
    ADD CONSTRAINT inventory_transactions_fill_fk FOREIGN KEY (fill_id, material_id) REFERENCES filament_spool_fills(id, material_id) ON DELETE SET NULL (fill_id),
    ADD CONSTRAINT inventory_transactions_from_fill_fk FOREIGN KEY (from_fill_id, material_id) REFERENCES filament_spool_fills(id, material_id) ON DELETE SET NULL (from_fill_id),
    ADD CONSTRAINT inventory_transactions_to_fill_fk FOREIGN KEY (to_fill_id, material_id) REFERENCES filament_spool_fills(id, material_id) ON DELETE SET NULL (to_fill_id),
    ADD CONSTRAINT inventory_transactions_spool_snapshot CHECK ((spool_display_id IS NULL) = (fill_number IS NULL) AND (spool_id IS NULL OR spool_display_id IS NOT NULL)),
    ADD CONSTRAINT inventory_transactions_from_snapshot CHECK ((from_spool_display_id IS NULL) = (from_fill_number IS NULL) AND (from_spool_id IS NULL OR from_spool_display_id IS NOT NULL)),
    ADD CONSTRAINT inventory_transactions_to_snapshot CHECK ((to_spool_display_id IS NULL) = (to_fill_number IS NULL) AND (to_spool_id IS NULL OR to_spool_display_id IS NOT NULL));
CREATE INDEX inventory_transactions_fill_idx ON inventory_transactions (fill_id) WHERE fill_id IS NOT NULL;
CREATE INDEX inventory_transactions_from_fill_idx ON inventory_transactions (from_fill_id) WHERE from_fill_id IS NOT NULL;
CREATE INDEX inventory_transactions_to_fill_idx ON inventory_transactions (to_fill_id) WHERE to_fill_id IS NOT NULL;

-- The ledger stays immutable. Spool and fill references may only be cleared,
-- which happens when an archived spool is deleted; the snapshots stay.
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
       OR (NEW.machine_job_usage_id IS DISTINCT FROM OLD.machine_job_usage_id AND NOT (OLD.machine_job_usage_id IS NOT NULL AND NEW.machine_job_usage_id IS NULL))
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

-- Job usages: same fill reference and snapshots.
ALTER TABLE machine_job_material_usages
    DROP CONSTRAINT machine_job_usages_spool_material_fk,
    ADD COLUMN fill_id uuid,
    ADD COLUMN spool_display_id text,
    ADD COLUMN fill_number integer;
UPDATE machine_job_material_usages u
SET fill_id = f.id, spool_display_id = s.display_id, fill_number = f.fill_number
FROM filament_spool_fills f JOIN filament_spools s ON s.id = f.spool_id
WHERE f.spool_id = u.spool_id;
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE machine_job_material_usages
    ADD CONSTRAINT machine_job_usages_spool_fk FOREIGN KEY (spool_id) REFERENCES filament_spools(id) ON DELETE SET NULL,
    ADD CONSTRAINT machine_job_usages_fill_fk FOREIGN KEY (fill_id, material_id) REFERENCES filament_spool_fills(id, material_id) ON DELETE SET NULL (fill_id),
    ADD CONSTRAINT machine_job_usages_spool_snapshot CHECK ((spool_display_id IS NULL) = (fill_number IS NULL) AND (spool_id IS NULL OR spool_display_id IS NOT NULL));

-- Legacy print declarations and mount history do not block deletion.
ALTER TABLE print_filament_declarations
    DROP CONSTRAINT print_filament_declarations_spool_id_material_id_fkey,
    ADD CONSTRAINT print_filament_declarations_spool_fk FOREIGN KEY (spool_id) REFERENCES filament_spools(id) ON DELETE SET NULL;
ALTER TABLE printer_spool_assignments
    DROP CONSTRAINT printer_spool_assignments_spool_id_fkey,
    ADD CONSTRAINT printer_spool_assignments_spool_id_fkey FOREIGN KEY (spool_id) REFERENCES filament_spools(id) ON DELETE CASCADE;

ALTER TABLE filament_spools
    DROP CONSTRAINT filament_spools_id_material_id_key,
    DROP COLUMN material_id,
    DROP COLUMN manufacturer,
    DROP COLUMN product_name,
    DROP COLUMN initial_net_weight_g;

-- +goose Down
-- Restores the single-material spool model from each spool's latest fill.
-- Spools refilled with another material cannot be represented; their older
-- ledger rows keep a NOT VALID material reference.
ALTER TABLE filament_spools
    ADD COLUMN material_id uuid REFERENCES materials(id) ON DELETE RESTRICT,
    ADD COLUMN manufacturer text CHECK (manufacturer IS NULL OR (manufacturer = btrim(manufacturer) AND manufacturer <> '' AND length(manufacturer) <= 150)),
    ADD COLUMN product_name text CHECK (product_name IS NULL OR (product_name = btrim(product_name) AND product_name <> '' AND length(product_name) <= 200)),
    ADD COLUMN initial_net_weight_g numeric(20, 6) CHECK (initial_net_weight_g > 0);
UPDATE filament_spools s
SET material_id = f.material_id, manufacturer = f.manufacturer, product_name = f.product_name, initial_net_weight_g = f.initial_net_weight_g
FROM (SELECT DISTINCT ON (spool_id) * FROM filament_spool_fills ORDER BY spool_id, fill_number DESC) f
WHERE f.spool_id = s.id;
ALTER TABLE filament_spools
    ALTER COLUMN material_id SET NOT NULL,
    ALTER COLUMN initial_net_weight_g SET NOT NULL,
    ADD CONSTRAINT filament_spools_id_material_id_key UNIQUE (id, material_id);

ALTER TABLE printer_spool_assignments
    DROP CONSTRAINT printer_spool_assignments_spool_id_fkey,
    ADD CONSTRAINT printer_spool_assignments_spool_id_fkey FOREIGN KEY (spool_id) REFERENCES filament_spools(id) ON DELETE RESTRICT;
ALTER TABLE print_filament_declarations
    DROP CONSTRAINT print_filament_declarations_spool_fk,
    ADD CONSTRAINT print_filament_declarations_spool_id_material_id_fkey FOREIGN KEY (spool_id, material_id) REFERENCES filament_spools(id, material_id) ON DELETE RESTRICT NOT VALID;

ALTER TABLE machine_job_material_usages
    DROP CONSTRAINT machine_job_usages_spool_snapshot,
    DROP CONSTRAINT machine_job_usages_fill_fk,
    DROP CONSTRAINT machine_job_usages_spool_fk,
    DROP COLUMN fill_number,
    DROP COLUMN spool_display_id,
    DROP COLUMN fill_id,
    ADD CONSTRAINT machine_job_usages_spool_material_fk FOREIGN KEY (spool_id, material_id) REFERENCES filament_spools(id, material_id) ON DELETE RESTRICT NOT VALID;

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
       OR (NEW.machine_job_usage_id IS DISTINCT FROM OLD.machine_job_usage_id AND NOT (OLD.machine_job_usage_id IS NOT NULL AND NEW.machine_job_usage_id IS NULL))
       OR (NEW.actor_account_id IS DISTINCT FROM OLD.actor_account_id AND NOT (OLD.actor_account_id IS NOT NULL AND NEW.actor_account_id IS NULL))
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.spool_id IS DISTINCT FROM OLD.spool_id
       OR NEW.from_spool_id IS DISTINCT FROM OLD.from_spool_id
       OR NEW.to_spool_id IS DISTINCT FROM OLD.to_spool_id
       OR NEW.transfer_quantity IS DISTINCT FROM OLD.transfer_quantity THEN
        RAISE EXCEPTION 'inventory transaction history is immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END $$;
-- +goose StatementEnd

DROP INDEX inventory_transactions_to_fill_idx;
DROP INDEX inventory_transactions_from_fill_idx;
DROP INDEX inventory_transactions_fill_idx;
ALTER TABLE inventory_transactions
    DROP CONSTRAINT inventory_transactions_to_snapshot,
    DROP CONSTRAINT inventory_transactions_from_snapshot,
    DROP CONSTRAINT inventory_transactions_spool_snapshot,
    DROP CONSTRAINT inventory_transactions_to_fill_fk,
    DROP CONSTRAINT inventory_transactions_from_fill_fk,
    DROP CONSTRAINT inventory_transactions_fill_fk,
    DROP CONSTRAINT inventory_transactions_to_spool_fk,
    DROP CONSTRAINT inventory_transactions_from_spool_fk,
    DROP CONSTRAINT inventory_transactions_spool_fk,
    DROP COLUMN to_fill_number,
    DROP COLUMN to_spool_display_id,
    DROP COLUMN from_fill_number,
    DROP COLUMN from_spool_display_id,
    DROP COLUMN fill_number,
    DROP COLUMN spool_display_id,
    DROP COLUMN to_fill_id,
    DROP COLUMN from_fill_id,
    DROP COLUMN fill_id,
    ADD CONSTRAINT inventory_transactions_spool_fk FOREIGN KEY (spool_id, material_id) REFERENCES filament_spools(id, material_id) ON DELETE RESTRICT NOT VALID,
    ADD CONSTRAINT inventory_transactions_from_spool_fk FOREIGN KEY (from_spool_id, material_id) REFERENCES filament_spools(id, material_id) ON DELETE RESTRICT NOT VALID,
    ADD CONSTRAINT inventory_transactions_to_spool_fk FOREIGN KEY (to_spool_id, material_id) REFERENCES filament_spools(id, material_id) ON DELETE RESTRICT NOT VALID;

DROP INDEX filament_spool_identifiers_fill_idx;
DROP INDEX filament_spool_identifiers_active_value_idx;
-- Retired tags of earlier fills would collide with the global uniqueness.
DELETE FROM filament_spool_identifiers WHERE retired_at IS NOT NULL;
CREATE UNIQUE INDEX filament_spool_identifiers_kind_value_idx ON filament_spool_identifiers (kind, lower(value));
ALTER TABLE filament_spool_identifiers DROP COLUMN retired_at, DROP COLUMN fill_id;

DROP INDEX filament_spools_archived_idx;
ALTER TABLE filament_spools
    DROP CONSTRAINT filament_spools_archived_shape,
    DROP CONSTRAINT filament_spools_lifecycle_check;
UPDATE filament_spools SET lifecycle = 'retired' WHERE lifecycle = 'archived';
ALTER TABLE filament_spools
    ADD CONSTRAINT filament_spools_lifecycle_check CHECK (lifecycle IN ('active', 'retired')),
    DROP COLUMN archived_at,
    DROP COLUMN label,
    DROP COLUMN kind;

DROP TABLE filament_spool_fills;
DROP TABLE filament_products;
