-- +goose Up
-- Material types are the level a price attaches to (PLA, PETG, TPU ...). Each
-- material becomes a variant of one type and keeps its colour as name + hex.

CREATE TABLE material_types (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (name = btrim(name) AND name <> '' AND length(name) <= 120),
    unit text NOT NULL CHECK (unit IN ('g', 'm', 'ml', 'm2', 'piece')),
    active boolean NOT NULL DEFAULT true,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    -- Target of the composite foreign keys that keep a material's (and a pricing
    -- rule's) unit equal to the unit of its type.
    UNIQUE (id, unit)
);

CREATE UNIQUE INDEX material_types_name_ci_idx ON material_types (lower(name));

-- One type per distinct legacy (category, unit) of a material or a material
-- pricing rule. The type is named after the category: up to four characters
-- upper-cased ("pla" -> "PLA"), longer ones with initcap ("filament" ->
-- "Filament"). A category used with several units gets the unit appended
-- ("Sheet (m2)", "Sheet (piece)") so the names stay unique.
CREATE TEMPORARY TABLE legacy_material_types ON COMMIT DROP AS
WITH pairs AS (
    SELECT category, unit FROM materials
    UNION
    SELECT material_category, material_unit FROM pricing_rules WHERE kind = 'material'
), named AS (
    SELECT category, unit,
           CASE WHEN length(category) <= 4 THEN upper(category) ELSE initcap(category) END AS base,
           count(*) OVER (PARTITION BY category) AS units_for_category
    FROM pairs
)
SELECT uuidv7() AS id, category, unit,
       CASE WHEN units_for_category > 1 THEN base || ' (' || unit || ')' ELSE base END AS name
FROM named;

INSERT INTO material_types (id, name, unit) SELECT id, name, unit FROM legacy_material_types;

ALTER TABLE materials
    ADD COLUMN material_type_id uuid,
    ADD COLUMN color_name text CHECK (color_name IS NULL OR (color_name = btrim(color_name) AND color_name <> '' AND length(color_name) <= 80)),
    ADD COLUMN color_hex text CHECK (color_hex IS NULL OR color_hex ~ '^#[0-9A-F]{6}$');

UPDATE materials m SET material_type_id = t.id, color_name = m.color
FROM legacy_material_types t
WHERE t.category = m.category AND t.unit = m.unit;

ALTER TABLE materials
    ALTER COLUMN material_type_id SET NOT NULL,
    ADD CONSTRAINT materials_material_type_unit_fk FOREIGN KEY (material_type_id, unit)
        REFERENCES material_types (id, unit) ON DELETE RESTRICT,
    DROP COLUMN color,
    DROP COLUMN category;

CREATE INDEX materials_type_active_idx ON materials (material_type_id, active, id);

-- Material pricing rules point at a type; the unit stays on the rule and is
-- pinned to the type's unit.
ALTER TABLE pricing_rules ADD COLUMN material_type_id uuid;

UPDATE pricing_rules r SET material_type_id = t.id
FROM legacy_material_types t
WHERE r.kind = 'material' AND t.category = r.material_category AND t.unit = r.material_unit;

DROP INDEX pricing_rules_active_material_idx;
ALTER TABLE pricing_rules DROP COLUMN material_category;
ALTER TABLE pricing_rules
    ADD CONSTRAINT pricing_rules_kind_selector_check CHECK (
        (kind = 'machine_runtime' AND machine_type_id IS NOT NULL AND material_type_id IS NULL AND material_unit IS NULL)
        OR
        (kind = 'material' AND machine_type_id IS NULL AND material_type_id IS NOT NULL AND material_unit IS NOT NULL)
    ),
    ADD CONSTRAINT pricing_rules_material_type_unit_fk FOREIGN KEY (material_type_id, material_unit)
        REFERENCES material_types (id, unit) ON DELETE RESTRICT;
CREATE UNIQUE INDEX pricing_rules_active_material_idx
    ON pricing_rules (pricing_group_id, material_type_id)
    WHERE active AND kind = 'material';

-- Snapshot rules keep their label, selector (the legacy category text) and unit
-- as captured. Rows for material rules additionally point at the type so
-- pricing a job from its snapshot matches by type; old rows are backfilled.
ALTER TABLE machine_job_pricing_snapshot_rules
    ADD COLUMN material_type_id uuid REFERENCES material_types(id) ON DELETE SET NULL;

UPDATE machine_job_pricing_snapshot_rules r SET material_type_id = t.id
FROM legacy_material_types t
WHERE r.kind = 'material' AND t.category = r.selector AND t.unit = r.unit;

-- +goose Down
ALTER TABLE machine_job_pricing_snapshot_rules DROP COLUMN material_type_id;

DROP INDEX pricing_rules_active_material_idx;
ALTER TABLE pricing_rules
    DROP CONSTRAINT pricing_rules_kind_selector_check,
    DROP CONSTRAINT pricing_rules_material_type_unit_fk,
    ADD COLUMN material_category text CHECK (material_category IS NULL OR (material_category = lower(btrim(material_category)) AND material_category <> '' AND length(material_category) <= 100));
-- The category of a type is its lower-cased name without an appended unit.
UPDATE pricing_rules r
SET material_category = left(regexp_replace(lower(t.name), ' \((g|m|ml|m2|piece)\)$', ''), 100)
FROM material_types t WHERE t.id = r.material_type_id;
ALTER TABLE pricing_rules
    DROP COLUMN material_type_id,
    ADD CONSTRAINT pricing_rules_check CHECK (
        (kind = 'machine_runtime' AND machine_type_id IS NOT NULL AND material_category IS NULL AND material_unit IS NULL)
        OR
        (kind = 'material' AND machine_type_id IS NULL AND material_category IS NOT NULL AND material_unit IS NOT NULL)
    );
CREATE UNIQUE INDEX pricing_rules_active_material_idx
    ON pricing_rules (pricing_group_id, material_category, material_unit)
    WHERE active AND kind = 'material';

DROP INDEX materials_type_active_idx;
ALTER TABLE materials
    ADD COLUMN category text,
    ADD COLUMN color text CHECK (color IS NULL OR (color = btrim(color) AND color <> '' AND length(color) <= 80));
UPDATE materials m
SET category = left(regexp_replace(lower(t.name), ' \((g|m|ml|m2|piece)\)$', ''), 100), color = m.color_name
FROM material_types t WHERE t.id = m.material_type_id;
ALTER TABLE materials
    ALTER COLUMN category SET NOT NULL,
    ADD CONSTRAINT materials_category_check CHECK (category = lower(btrim(category)) AND category <> '' AND length(category) <= 100),
    DROP CONSTRAINT materials_material_type_unit_fk,
    DROP COLUMN material_type_id,
    DROP COLUMN color_name,
    DROP COLUMN color_hex;
CREATE INDEX materials_category_active_idx ON materials (category, active, id);

DROP TABLE material_types;
