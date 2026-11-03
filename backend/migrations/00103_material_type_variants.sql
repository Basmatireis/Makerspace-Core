-- +goose Up
-- Material types get a list of variants (PLA: Basic, Matte, Silk ...). An article picks its variant from the list of
-- its type, and a material pricing rule may price one variant instead of the whole type. materials.variant stays as
-- the denormalised name of the article's variant; the service writes both and keeps the name in step on a rename.
-- The backfill creates one variant per type and distinct free-text variant (ignoring case) of the existing articles,
-- deleted ones included, named like the earliest article of that pair. Parts take no variants: the variant text of
-- part articles, which the application never offered, is cleared. Like other backfills, these migration-created rows
-- get PostgreSQL's uuidv7() ids.
CREATE TABLE material_type_variants (
    id uuid PRIMARY KEY,
    material_type_id uuid NOT NULL REFERENCES material_types(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (name = btrim(name) AND name <> '' AND length(name) <= 80),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, material_type_id)
);
CREATE UNIQUE INDEX material_type_variants_name_ci_idx ON material_type_variants (material_type_id, lower(name));
CREATE INDEX material_type_variants_type_idx ON material_type_variants (material_type_id);

UPDATE materials m SET variant = NULL
FROM material_types t
WHERE t.id = m.material_type_id AND t.kind = 'part' AND m.variant IS NOT NULL;

INSERT INTO material_type_variants (id, material_type_id, name, created_at, updated_at)
SELECT uuidv7(), x.material_type_id, x.variant, x.created_at, x.created_at
FROM (
    SELECT DISTINCT ON (m.material_type_id, lower(m.variant)) m.material_type_id, m.variant, m.created_at
    FROM materials m
    WHERE m.variant IS NOT NULL
    ORDER BY m.material_type_id, lower(m.variant), m.created_at, m.id
) x
ORDER BY x.created_at, x.material_type_id, lower(x.variant);

ALTER TABLE materials ADD COLUMN variant_id uuid;
UPDATE materials m SET variant_id = v.id
FROM material_type_variants v
WHERE v.material_type_id = m.material_type_id AND lower(v.name) = lower(m.variant);
-- The article name of a variant follows the variant's name.
UPDATE materials m SET variant = v.name
FROM material_type_variants v
WHERE v.id = m.variant_id AND m.variant IS DISTINCT FROM v.name;
ALTER TABLE materials
    ADD CONSTRAINT materials_variant_fk FOREIGN KEY (variant_id, material_type_id)
        REFERENCES material_type_variants (id, material_type_id) ON DELETE RESTRICT,
    ADD CONSTRAINT materials_variant_link_check CHECK ((variant_id IS NULL) = (variant IS NULL));
CREATE INDEX materials_variant_idx ON materials (variant_id) WHERE variant_id IS NOT NULL;

ALTER TABLE pricing_rules
    ADD COLUMN material_type_variant_id uuid,
    ADD CONSTRAINT pricing_rules_material_type_variant_fk FOREIGN KEY (material_type_variant_id, material_type_id)
        REFERENCES material_type_variants (id, material_type_id) ON DELETE RESTRICT,
    DROP CONSTRAINT pricing_rules_kind_selector_check,
    ADD CONSTRAINT pricing_rules_kind_selector_check CHECK (
        (kind = 'machine_runtime' AND process_id IS NOT NULL AND material_type_id IS NULL AND material_unit IS NULL
            AND measure IS NULL AND block_size IS NULL AND material_id IS NULL AND material_type_variant_id IS NULL)
        OR (kind = 'material' AND process_id IS NULL AND material_type_id IS NOT NULL AND material_unit IS NOT NULL
            AND measure IS NULL AND block_size IS NULL AND material_id IS NULL)
        OR (kind = 'machine_measure' AND process_id IS NOT NULL AND material_type_id IS NULL AND material_unit IS NULL
            AND measure IS NOT NULL AND block_size IS NOT NULL AND material_id IS NULL AND material_type_variant_id IS NULL)
        OR (kind = 'stock_article' AND process_id IS NULL AND material_type_id IS NULL AND material_unit IS NULL
            AND measure IS NULL AND block_size IS NULL AND material_id IS NOT NULL AND material_type_variant_id IS NULL));
DROP INDEX pricing_rules_active_material_idx;
CREATE UNIQUE INDEX pricing_rules_active_material_type_idx ON pricing_rules (pricing_group_id, material_type_id)
    WHERE active AND kind = 'material' AND material_type_variant_id IS NULL;
CREATE UNIQUE INDEX pricing_rules_active_material_variant_idx
    ON pricing_rules (pricing_group_id, material_type_id, material_type_variant_id)
    WHERE active AND kind = 'material' AND material_type_variant_id IS NOT NULL;
CREATE INDEX pricing_rules_material_type_variant_idx ON pricing_rules (material_type_variant_id)
    WHERE material_type_variant_id IS NOT NULL;

-- A job's material is priced by the article's stock_article rule, else its variant's rule, else its type's rule. Snapshot
-- entries record which: material_id for an article's own rate, material_type_variant_id for a variant rate. Both are
-- historical copies without foreign keys, so a later purge or deletion never turns an entry into a broader one.
ALTER TABLE machine_job_pricing_snapshot_rules
    ADD COLUMN material_id uuid,
    ADD COLUMN material_type_variant_id uuid,
    DROP CONSTRAINT machine_job_pricing_snapshot_rules_kind_check,
    ADD CONSTRAINT machine_job_pricing_snapshot_rules_kind_check
        CHECK (kind IN ('machine_runtime', 'material', 'machine_measure', 'stock_article')),
    ADD CONSTRAINT machine_job_pricing_snapshot_rules_material_shape_check
        CHECK ((kind = 'stock_article') = (material_id IS NOT NULL)
            AND (material_type_variant_id IS NULL OR kind = 'material'));

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pricing_rules WHERE material_type_variant_id IS NOT NULL)
        OR EXISTS (SELECT 1 FROM machine_job_pricing_snapshot_rules
                   WHERE material_type_variant_id IS NOT NULL OR kind = 'stock_article') THEN
        RAISE EXCEPTION 'cannot downgrade while pricing rules or job pricing snapshots use variant or article rates';
    END IF;
END $$;
-- +goose StatementEnd
ALTER TABLE machine_job_pricing_snapshot_rules
    DROP CONSTRAINT machine_job_pricing_snapshot_rules_material_shape_check,
    DROP CONSTRAINT machine_job_pricing_snapshot_rules_kind_check,
    DROP COLUMN material_type_variant_id,
    DROP COLUMN material_id,
    ADD CONSTRAINT machine_job_pricing_snapshot_rules_kind_check
        CHECK (kind IN ('machine_runtime', 'material', 'machine_measure'));

DROP INDEX pricing_rules_material_type_variant_idx;
DROP INDEX pricing_rules_active_material_variant_idx;
DROP INDEX pricing_rules_active_material_type_idx;
CREATE UNIQUE INDEX pricing_rules_active_material_idx ON pricing_rules (pricing_group_id, material_type_id)
    WHERE active AND kind = 'material';
ALTER TABLE pricing_rules
    DROP CONSTRAINT pricing_rules_kind_selector_check,
    DROP CONSTRAINT pricing_rules_material_type_variant_fk,
    DROP COLUMN material_type_variant_id,
    ADD CONSTRAINT pricing_rules_kind_selector_check CHECK (
        (kind = 'machine_runtime' AND process_id IS NOT NULL AND material_type_id IS NULL AND material_unit IS NULL
            AND measure IS NULL AND block_size IS NULL AND material_id IS NULL)
        OR (kind = 'material' AND process_id IS NULL AND material_type_id IS NOT NULL AND material_unit IS NOT NULL
            AND measure IS NULL AND block_size IS NULL AND material_id IS NULL)
        OR (kind = 'machine_measure' AND process_id IS NOT NULL AND material_type_id IS NULL AND material_unit IS NULL
            AND measure IS NOT NULL AND block_size IS NOT NULL AND material_id IS NULL)
        OR (kind = 'stock_article' AND process_id IS NULL AND material_type_id IS NULL AND material_unit IS NULL
            AND measure IS NULL AND block_size IS NULL AND material_id IS NOT NULL));

DROP INDEX materials_variant_idx;
ALTER TABLE materials
    DROP CONSTRAINT materials_variant_link_check,
    DROP CONSTRAINT materials_variant_fk,
    DROP COLUMN variant_id;

DROP TABLE material_type_variants;
