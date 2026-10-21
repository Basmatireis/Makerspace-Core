-- +goose Up
-- Inventory articles (docs/plans/inventory-redesign.md). Materials become
-- articles of a kind (filament, consumable, part) that comes from their
-- material type; variant, manufacturer, sale price, package size, storage
-- location and notes move onto the article. The filament product catalog is
-- folded into the article and dropped. Purchases get an optional reference.

-- 1. Kind of a material type. Gram types that serve FDM printing are filament
-- (they may serve other processes as well); every other existing type is a
-- consumable (it has at least one process, see 00047). Parts are new and have
-- no processes.
ALTER TABLE material_types ADD COLUMN kind text;
UPDATE material_types t SET kind = CASE
    WHEN t.unit = 'g'
         AND EXISTS (SELECT 1 FROM material_type_processes p WHERE p.material_type_id = t.id AND p.process = 'fdm_printing')
    THEN 'filament' ELSE 'consumable' END;
ALTER TABLE material_types
    ALTER COLUMN kind SET NOT NULL,
    ADD CONSTRAINT material_types_kind_check CHECK (kind IN ('filament', 'consumable', 'part')),
    ADD CONSTRAINT material_types_filament_unit_check CHECK (kind <> 'filament' OR unit = 'g');

-- Every filament article has a diameter; the usual 1.75 mm fills the gaps.
INSERT INTO material_filament_properties (material_id, diameter_mm)
SELECT m.id, 1.75 FROM materials m JOIN material_types t ON t.id = m.material_type_id
WHERE t.kind = 'filament'
ON CONFLICT (material_id) DO NOTHING;

-- 2. Article fields.
ALTER TABLE materials
    ADD COLUMN variant text CHECK (variant IS NULL OR (variant = btrim(variant) AND variant <> '' AND length(variant) <= 80)),
    ADD COLUMN manufacturer text CHECK (manufacturer IS NULL OR (manufacturer = btrim(manufacturer) AND manufacturer <> '' AND length(manufacturer) <= 150)),
    ADD COLUMN sale_price numeric(20, 6) CHECK (sale_price IS NULL OR sale_price >= 0),
    ADD COLUMN package_size numeric(20, 6) CHECK (package_size IS NULL OR package_size > 0),
    ADD COLUMN storage_location text CHECK (storage_location IS NULL OR (storage_location = btrim(storage_location) AND storage_location <> '' AND length(storage_location) <= 200)),
    ADD COLUMN notes text CHECK (notes IS NULL OR (notes = btrim(notes) AND notes <> '' AND length(notes) <= 2000));

-- 3. Fold the product catalog into the article where it is unambiguous: one
-- distinct manufacturer among the products (else among the fill snapshots)
-- and one distinct net weight.
UPDATE materials m SET manufacturer = x.manufacturer
FROM (
    SELECT material_id, min(manufacturer) AS manufacturer FROM filament_products
    GROUP BY material_id HAVING count(DISTINCT lower(manufacturer)) = 1
) x WHERE x.material_id = m.id;

UPDATE materials m SET manufacturer = x.manufacturer
FROM (
    SELECT material_id, min(manufacturer) AS manufacturer FROM filament_spool_fills
    WHERE manufacturer IS NOT NULL
    GROUP BY material_id HAVING count(DISTINCT lower(manufacturer)) = 1
) x WHERE x.material_id = m.id AND m.manufacturer IS NULL;

UPDATE materials m SET package_size = x.net_weight_g
FROM (
    SELECT material_id, min(net_weight_g) AS net_weight_g FROM filament_products
    GROUP BY material_id HAVING count(DISTINCT net_weight_g) = 1
) x WHERE x.material_id = m.id;

DROP INDEX filament_spool_fills_product_idx;
ALTER TABLE filament_spool_fills DROP COLUMN product_id;
DROP TABLE filament_products;

-- 4. Optional reference (order number, invoice number) of a purchase.
ALTER TABLE inventory_transactions
    ADD COLUMN purchase_reference text CHECK (purchase_reference IS NULL OR (
        kind = 'purchase' AND purchase_reference = btrim(purchase_reference) AND purchase_reference <> '' AND length(purchase_reference) <= 200));

-- The ledger stays immutable, including the new column.
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

-- +goose Down
-- Part types, variants, sale prices and purchase references have no place in
-- the previous schema and are never dropped silently.
-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM material_types WHERE kind = 'part')
       OR EXISTS (SELECT 1 FROM materials WHERE variant IS NOT NULL OR sale_price IS NOT NULL)
       OR EXISTS (SELECT 1 FROM inventory_transactions WHERE purchase_reference IS NOT NULL) THEN
        RAISE EXCEPTION 'part types, article variants, sale prices and purchase references cannot be downgraded; delete or clear them first';
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

ALTER TABLE inventory_transactions DROP COLUMN purchase_reference;

-- The product catalog comes back empty except for one product per article that
-- carries a manufacturer and a package size; open fills are not re-linked.
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
INSERT INTO filament_products (id, manufacturer, name, material_id, net_weight_g, packaging)
SELECT uuidv7(), m.manufacturer, left(m.name, 200), m.id, m.package_size, 'spool'
FROM materials m JOIN material_types t ON t.id = m.material_type_id
WHERE t.kind = 'filament' AND m.manufacturer IS NOT NULL AND m.package_size IS NOT NULL;

ALTER TABLE filament_spool_fills ADD COLUMN product_id uuid REFERENCES filament_products(id) ON DELETE SET NULL;
CREATE INDEX filament_spool_fills_product_idx ON filament_spool_fills (product_id) WHERE product_id IS NOT NULL;

ALTER TABLE materials
    DROP COLUMN notes,
    DROP COLUMN storage_location,
    DROP COLUMN package_size,
    DROP COLUMN sale_price,
    DROP COLUMN manufacturer,
    DROP COLUMN variant;

ALTER TABLE material_types
    DROP CONSTRAINT material_types_filament_unit_check,
    DROP CONSTRAINT material_types_kind_check,
    DROP COLUMN kind;
