-- +goose Up
-- Flexible material units. A material type keeps its unit as the reference unit of its rates and statistics; its
-- dimension (mass, length, area, volume, count) follows from it. An article counts in any unit of its type's
-- dimension (materials.unit), so the composite foreign key that pinned it to the type's unit goes. Rates of material
-- pricing rules stay per reference unit: the foreign key now follows a changed type unit (the service converts the
-- rates in the same transaction). count_label names the piece of a piece article (sheet, pair, roll).

-- +goose StatementBegin
CREATE FUNCTION material_unit_dimension(unit text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT CASE unit
        WHEN 'g' THEN 'mass' WHEN 'kg' THEN 'mass'
        WHEN 'mm' THEN 'length' WHEN 'cm' THEN 'length' WHEN 'm' THEN 'length'
        WHEN 'cm2' THEN 'area' WHEN 'm2' THEN 'area'
        WHEN 'ml' THEN 'volume' WHEN 'l' THEN 'volume'
        WHEN 'piece' THEN 'count'
    END
$$;
-- +goose StatementEnd

-- Factor of a unit to the base unit of its dimension (g, mm, cm2, ml, piece).
-- +goose StatementBegin
CREATE FUNCTION material_unit_factor(unit text) RETURNS numeric LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT CASE unit
        WHEN 'g' THEN 1 WHEN 'kg' THEN 1000
        WHEN 'mm' THEN 1 WHEN 'cm' THEN 10 WHEN 'm' THEN 1000
        WHEN 'cm2' THEN 1 WHEN 'm2' THEN 10000
        WHEN 'ml' THEN 1 WHEN 'l' THEN 1000
        WHEN 'piece' THEN 1
    END::numeric
$$;
-- +goose StatementEnd

ALTER TABLE material_types DROP CONSTRAINT material_types_unit_check;
ALTER TABLE material_types ADD CONSTRAINT material_types_unit_check CHECK (unit IN ('g', 'kg', 'mm', 'cm', 'm', 'cm2', 'm2', 'ml', 'l', 'piece'));
ALTER TABLE materials DROP CONSTRAINT materials_unit_check;
ALTER TABLE materials ADD CONSTRAINT materials_unit_check CHECK (unit IN ('g', 'kg', 'mm', 'cm', 'm', 'cm2', 'm2', 'ml', 'l', 'piece'));
ALTER TABLE pricing_rules DROP CONSTRAINT pricing_rules_material_unit_check;
ALTER TABLE pricing_rules ADD CONSTRAINT pricing_rules_material_unit_check
    CHECK (material_unit IS NULL OR material_unit IN ('g', 'kg', 'mm', 'cm', 'm', 'cm2', 'm2', 'ml', 'l', 'piece'));
ALTER TABLE machine_run_usages DROP CONSTRAINT machine_run_usages_material_unit_check;
ALTER TABLE machine_run_usages ADD CONSTRAINT machine_run_usages_material_unit_check
    CHECK (material_unit IS NULL OR material_unit IN ('g', 'kg', 'mm', 'cm', 'm', 'cm2', 'm2', 'ml', 'l', 'piece'));

ALTER TABLE materials DROP CONSTRAINT materials_material_type_unit_fk;
ALTER TABLE pricing_rules
    DROP CONSTRAINT pricing_rules_material_type_unit_fk,
    ADD CONSTRAINT pricing_rules_material_type_unit_fk FOREIGN KEY (material_type_id, material_unit)
        REFERENCES material_types (id, unit) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE materials
    ADD COLUMN count_label text,
    ADD CONSTRAINT materials_count_label_check CHECK (
        count_label IS NULL OR (unit = 'piece' AND count_label = btrim(count_label) AND char_length(count_label) BETWEEN 1 AND 20));

-- A usage reads its own unit from now on, so a later unit change of the article cannot misread it.
UPDATE machine_run_usages u SET material_unit = m.unit
FROM materials m WHERE m.id = u.material_id AND u.material_unit IS NULL;
UPDATE machine_run_usages u SET material_unit = t.unit
FROM material_types t WHERE t.id = u.material_type_id AND u.material_id IS NULL AND u.material_unit IS NULL;

-- Converting an article's unit rewrites its ledger quantities and unit costs (the value stays); the guard allows
-- exactly these two columns to change while the transaction sets makerspace.inventory_unit_conversion.
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION guard_inventory_transaction_history() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    converting boolean := COALESCE(current_setting('makerspace.inventory_unit_conversion', true), '') = 'on';
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
       OR (NEW.quantity_delta IS DISTINCT FROM OLD.quantity_delta AND NOT converting)
       OR (NEW.unit_acquisition_cost IS DISTINCT FROM OLD.unit_acquisition_cost AND NOT converting)
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

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM material_types WHERE unit IN ('kg', 'mm', 'cm', 'l'))
       OR EXISTS (SELECT 1 FROM materials WHERE unit IN ('kg', 'mm', 'cm', 'l') OR count_label IS NOT NULL)
       OR EXISTS (SELECT 1 FROM materials m JOIN material_types t ON t.id = m.material_type_id WHERE m.unit <> t.unit)
       OR EXISTS (SELECT 1 FROM pricing_rules WHERE material_unit IN ('kg', 'mm', 'cm', 'l'))
       OR EXISTS (SELECT 1 FROM machine_run_usages WHERE material_unit IN ('kg', 'mm', 'cm', 'l')) THEN
        RAISE EXCEPTION 'cannot downgrade while material units, article units or count labels need the flexible units; convert or clear them first';
    END IF;
END $$;
-- +goose StatementEnd

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

ALTER TABLE materials
    DROP CONSTRAINT materials_count_label_check,
    DROP COLUMN count_label;

ALTER TABLE pricing_rules
    DROP CONSTRAINT pricing_rules_material_type_unit_fk,
    ADD CONSTRAINT pricing_rules_material_type_unit_fk FOREIGN KEY (material_type_id, material_unit)
        REFERENCES material_types (id, unit) ON DELETE RESTRICT;
ALTER TABLE materials ADD CONSTRAINT materials_material_type_unit_fk FOREIGN KEY (material_type_id, unit)
    REFERENCES material_types (id, unit) ON DELETE RESTRICT;

ALTER TABLE machine_run_usages DROP CONSTRAINT machine_run_usages_material_unit_check;
ALTER TABLE machine_run_usages ADD CONSTRAINT machine_run_usages_material_unit_check
    CHECK (material_unit IS NULL OR material_unit IN ('g', 'm', 'ml', 'm2', 'cm2', 'piece'));
ALTER TABLE pricing_rules DROP CONSTRAINT pricing_rules_material_unit_check;
ALTER TABLE pricing_rules ADD CONSTRAINT pricing_rules_material_unit_check
    CHECK (material_unit IS NULL OR material_unit IN ('g', 'm', 'ml', 'm2', 'cm2', 'piece'));
ALTER TABLE materials DROP CONSTRAINT materials_unit_check;
ALTER TABLE materials ADD CONSTRAINT materials_unit_check CHECK (unit IN ('g', 'm', 'ml', 'm2', 'cm2', 'piece'));
ALTER TABLE material_types DROP CONSTRAINT material_types_unit_check;
ALTER TABLE material_types ADD CONSTRAINT material_types_unit_check CHECK (unit IN ('g', 'm', 'ml', 'm2', 'cm2', 'piece'));

DROP FUNCTION material_unit_factor(text);
DROP FUNCTION material_unit_dimension(text);
