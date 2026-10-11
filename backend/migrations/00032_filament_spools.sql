-- +goose Up
CREATE TABLE material_filament_properties (
    material_id uuid PRIMARY KEY REFERENCES materials(id) ON DELETE CASCADE,
    diameter_mm numeric(8, 3) NOT NULL CHECK (diameter_mm > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE filament_spool_display_sequence;

CREATE TABLE filament_spools (
    id uuid PRIMARY KEY,
    display_id text NOT NULL UNIQUE CHECK (display_id ~ '^S-[0-9]{4}-[0-9]{6,}$'),
    material_id uuid NOT NULL REFERENCES materials(id) ON DELETE RESTRICT,
    manufacturer text CHECK (manufacturer IS NULL OR (manufacturer = btrim(manufacturer) AND manufacturer <> '' AND length(manufacturer) <= 150)),
    product_name text CHECK (product_name IS NULL OR (product_name = btrim(product_name) AND product_name <> '' AND length(product_name) <= 200)),
    initial_net_weight_g numeric(20, 6) NOT NULL CHECK (initial_net_weight_g > 0),
    tare_weight_g numeric(20, 6) CHECK (tare_weight_g IS NULL OR tare_weight_g >= 0),
    acquired_on date,
    acquisition_reference text CHECK (acquisition_reference IS NULL OR length(acquisition_reference) <= 200),
    storage_location text CHECK (storage_location IS NULL OR length(storage_location) <= 200),
    notes text CHECK (notes IS NULL OR length(notes) <= 2000),
    lifecycle text NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'retired')),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, material_id)
);

CREATE INDEX filament_spools_material_idx ON filament_spools (material_id, lifecycle, id);
CREATE INDEX filament_spools_location_idx ON filament_spools (lower(storage_location), id) WHERE storage_location IS NOT NULL;

CREATE TABLE filament_spool_identifiers (
    id uuid PRIMARY KEY,
    spool_id uuid NOT NULL REFERENCES filament_spools(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('barcode', 'qr', 'nfc')),
    value text NOT NULL CHECK (value = btrim(value) AND value <> '' AND length(value) <= 255),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX filament_spool_identifiers_kind_value_idx ON filament_spool_identifiers (kind, lower(value));
CREATE INDEX filament_spool_identifiers_spool_idx ON filament_spool_identifiers (spool_id, kind, id);

ALTER TABLE inventory_transactions
    DROP CONSTRAINT inventory_transactions_kind_check,
    DROP CONSTRAINT inventory_transactions_quantity_delta_check,
    ADD COLUMN spool_id uuid,
    ADD COLUMN from_spool_id uuid,
    ADD COLUMN to_spool_id uuid,
    ADD COLUMN transfer_quantity numeric(20, 6),
    ADD CONSTRAINT inventory_transactions_kind_check CHECK (kind IN ('purchase', 'machine_job_consumption', 'manual_consumption', 'adjustment', 'disposal', 'spool_transfer')),
    ADD CONSTRAINT inventory_transactions_quantity_delta_check CHECK (quantity_delta <> 0 OR kind = 'spool_transfer'),
    ADD CONSTRAINT inventory_transactions_spool_fk FOREIGN KEY (spool_id, material_id) REFERENCES filament_spools(id, material_id) ON DELETE RESTRICT,
    ADD CONSTRAINT inventory_transactions_from_spool_fk FOREIGN KEY (from_spool_id, material_id) REFERENCES filament_spools(id, material_id) ON DELETE RESTRICT,
    ADD CONSTRAINT inventory_transactions_to_spool_fk FOREIGN KEY (to_spool_id, material_id) REFERENCES filament_spools(id, material_id) ON DELETE RESTRICT,
    ADD CONSTRAINT inventory_transactions_transfer_shape CHECK (
        (kind = 'spool_transfer'
            AND quantity_delta = 0
            AND inventory_value_delta = 0
            AND unit_acquisition_cost = 0
            AND total_purchase_price IS NULL
            AND spool_id IS NULL
            AND transfer_quantity IS NOT NULL
            AND transfer_quantity > 0
            AND (from_spool_id IS NOT NULL OR to_spool_id IS NOT NULL)
            AND from_spool_id IS DISTINCT FROM to_spool_id)
        OR
        (kind <> 'spool_transfer'
            AND from_spool_id IS NULL
            AND to_spool_id IS NULL
            AND transfer_quantity IS NULL)
    );

CREATE INDEX inventory_transactions_spool_time_idx ON inventory_transactions (spool_id, occurred_at DESC, id DESC) WHERE spool_id IS NOT NULL;
CREATE INDEX inventory_transactions_from_spool_time_idx ON inventory_transactions (from_spool_id, occurred_at DESC, id DESC) WHERE from_spool_id IS NOT NULL;
CREATE INDEX inventory_transactions_to_spool_time_idx ON inventory_transactions (to_spool_id, occurred_at DESC, id DESC) WHERE to_spool_id IS NOT NULL;

ALTER TABLE machine_job_material_usages
    ADD COLUMN ownership text NOT NULL DEFAULT 'makerspace' CHECK (ownership IN ('makerspace', 'external')),
    ADD COLUMN spool_id uuid,
    ADD COLUMN external_material_name text,
    ADD COLUMN quantity_basis text NOT NULL DEFAULT 'actual' CHECK (quantity_basis IN ('estimated', 'actual')),
    ALTER COLUMN material_id DROP NOT NULL,
    ADD CONSTRAINT machine_job_usages_spool_material_fk FOREIGN KEY (spool_id, material_id) REFERENCES filament_spools(id, material_id) ON DELETE RESTRICT,
    ADD CONSTRAINT machine_job_usages_ownership_check CHECK (
        (ownership = 'makerspace' AND material_id IS NOT NULL AND external_material_name IS NULL)
        OR
        (ownership = 'external' AND spool_id IS NULL AND external_material_name IS NOT NULL
            AND external_material_name = btrim(external_material_name)
            AND external_material_name <> ''
            AND length(external_material_name) <= 200)
    );

DROP INDEX machine_job_material_usages_active_material_idx;
CREATE UNIQUE INDEX machine_job_usages_active_spool_idx
    ON machine_job_material_usages (machine_job_id, spool_id)
    WHERE active AND ownership = 'makerspace' AND spool_id IS NOT NULL;
CREATE UNIQUE INDEX machine_job_usages_active_unassigned_idx
    ON machine_job_material_usages (machine_job_id, material_id)
    WHERE active AND ownership = 'makerspace' AND spool_id IS NULL;
CREATE INDEX machine_job_usages_spool_idx ON machine_job_material_usages (spool_id, machine_job_id) WHERE spool_id IS NOT NULL;

ALTER TABLE order_items
    DROP CONSTRAINT order_items_snapshot_schema_version_check,
    ALTER COLUMN snapshot_schema_version SET DEFAULT 2,
    ADD CONSTRAINT order_items_snapshot_schema_version_check CHECK (snapshot_schema_version IN (1, 2));

ALTER TABLE external_invoice_request_details
    DROP CONSTRAINT external_invoice_request_details_snapshot_schema_version_check,
    ALTER COLUMN snapshot_schema_version SET DEFAULT 2,
    ADD CONSTRAINT external_invoice_request_details_snapshot_schema_version_check CHECK (snapshot_schema_version IN (1, 2));

-- +goose StatementBegin
CREATE FUNCTION guard_inventory_transaction_history() RETURNS trigger LANGUAGE plpgsql AS $$
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

CREATE TRIGGER inventory_transactions_immutable
BEFORE UPDATE OR DELETE ON inventory_transactions
FOR EACH ROW EXECUTE FUNCTION guard_inventory_transaction_history();

-- Existing balances and usages remain valid: all historical stock is unassigned,
-- and historical usage is makerspace-owned without a physical spool.

-- +goose Down
DROP TRIGGER inventory_transactions_immutable ON inventory_transactions;
DROP FUNCTION guard_inventory_transaction_history();
-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM filament_spools)
       OR EXISTS (SELECT 1 FROM machine_job_material_usages WHERE ownership <> 'makerspace' OR spool_id IS NOT NULL)
       OR EXISTS (SELECT 1 FROM order_items WHERE snapshot_schema_version=2)
       OR EXISTS (SELECT 1 FROM external_invoice_request_details WHERE snapshot_schema_version=2) THEN
        RAISE EXCEPTION 'cannot downgrade while filament spool history exists';
    END IF;
END $$;
-- +goose StatementEnd

ALTER TABLE external_invoice_request_details
    DROP CONSTRAINT external_invoice_request_details_snapshot_schema_version_check,
    ALTER COLUMN snapshot_schema_version SET DEFAULT 1,
    ADD CONSTRAINT external_invoice_request_details_snapshot_schema_version_check CHECK (snapshot_schema_version=1);
ALTER TABLE order_items
    DROP CONSTRAINT order_items_snapshot_schema_version_check,
    ALTER COLUMN snapshot_schema_version SET DEFAULT 1,
    ADD CONSTRAINT order_items_snapshot_schema_version_check CHECK (snapshot_schema_version=1);

DROP INDEX machine_job_usages_spool_idx;
DROP INDEX machine_job_usages_active_unassigned_idx;
DROP INDEX machine_job_usages_active_spool_idx;
ALTER TABLE machine_job_material_usages
    DROP CONSTRAINT machine_job_usages_ownership_check,
    DROP CONSTRAINT machine_job_usages_spool_material_fk,
    ALTER COLUMN material_id SET NOT NULL,
    DROP COLUMN quantity_basis,
    DROP COLUMN external_material_name,
    DROP COLUMN spool_id,
    DROP COLUMN ownership;
CREATE UNIQUE INDEX machine_job_material_usages_active_material_idx
    ON machine_job_material_usages (machine_job_id, material_id)
    WHERE active;

DROP INDEX inventory_transactions_to_spool_time_idx;
DROP INDEX inventory_transactions_from_spool_time_idx;
DROP INDEX inventory_transactions_spool_time_idx;
ALTER TABLE inventory_transactions
    DROP CONSTRAINT inventory_transactions_transfer_shape,
    DROP CONSTRAINT inventory_transactions_to_spool_fk,
    DROP CONSTRAINT inventory_transactions_from_spool_fk,
    DROP CONSTRAINT inventory_transactions_spool_fk,
    DROP CONSTRAINT inventory_transactions_quantity_delta_check,
    DROP CONSTRAINT inventory_transactions_kind_check,
    DROP COLUMN transfer_quantity,
    DROP COLUMN to_spool_id,
    DROP COLUMN from_spool_id,
    DROP COLUMN spool_id,
    ADD CONSTRAINT inventory_transactions_kind_check CHECK (kind IN ('purchase', 'machine_job_consumption', 'manual_consumption', 'adjustment', 'disposal')),
    ADD CONSTRAINT inventory_transactions_quantity_delta_check CHECK (quantity_delta <> 0);

DROP TABLE filament_spool_identifiers;
DROP TABLE filament_spools;
DROP SEQUENCE filament_spool_display_sequence;
DROP TABLE material_filament_properties;
