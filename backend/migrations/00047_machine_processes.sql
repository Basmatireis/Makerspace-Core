-- +goose Up
-- Phase C of docs/plans/prototype-integration.md: every machine type has a
-- process that decides what a run records, which materials fit and what is
-- priced. FDM printing keeps everything that exists for printers today.

-- 1. Process per machine type replaces the printer flag. Types flagged as
-- printer, or that already own a machine with a printer profile, become FDM
-- printing; everything else is "other".
ALTER TABLE machine_types
    ADD COLUMN process text NOT NULL DEFAULT 'other'
        CHECK (process IN ('fdm_printing', 'embroidery', 'uv_printing', 'laser_cutting', 'vinyl_cutting', 'other'));

UPDATE machine_types t SET process = 'fdm_printing'
WHERE t.printer
   OR EXISTS (
       SELECT 1 FROM machines m JOIN printer_profiles p ON p.machine_id = m.id
       WHERE m.machine_type_id = t.id
   );

ALTER TABLE machine_types DROP COLUMN printer;

-- 2. cm2 joins the unit set. m2 stays for existing data.
ALTER TABLE material_types DROP CONSTRAINT material_types_unit_check;
ALTER TABLE material_types ADD CONSTRAINT material_types_unit_check CHECK (unit IN ('g', 'm', 'ml', 'm2', 'cm2', 'piece'));
ALTER TABLE materials DROP CONSTRAINT materials_unit_check;
ALTER TABLE materials ADD CONSTRAINT materials_unit_check CHECK (unit IN ('g', 'm', 'ml', 'm2', 'cm2', 'piece'));
ALTER TABLE pricing_rules DROP CONSTRAINT pricing_rules_material_unit_check;
ALTER TABLE pricing_rules ADD CONSTRAINT pricing_rules_material_unit_check
    CHECK (material_unit IS NULL OR material_unit IN ('g', 'm', 'ml', 'm2', 'cm2', 'piece'));
-- Snapshot rules additionally price measures; 'stitch' is the unit of the stitches measure.
ALTER TABLE machine_job_pricing_snapshot_rules DROP CONSTRAINT machine_job_pricing_snapshot_rules_unit_check;
ALTER TABLE machine_job_pricing_snapshot_rules ADD CONSTRAINT machine_job_pricing_snapshot_rules_unit_check
    CHECK (unit IN ('hour', 'g', 'm', 'ml', 'm2', 'cm2', 'piece', 'stitch'));

-- 3. Material types list the processes they can be used for.
CREATE TABLE material_type_processes (
    material_type_id uuid NOT NULL REFERENCES material_types(id) ON DELETE CASCADE,
    process text NOT NULL CHECK (process IN ('fdm_printing', 'embroidery', 'uv_printing', 'laser_cutting', 'vinyl_cutting', 'other')),
    PRIMARY KEY (material_type_id, process)
);

-- Existing types keep working where they were used: a type gets the process of
-- every machine type one of its materials was consumed on, plus FDM printing
-- when it is measured in grams and one of its materials has a filament
-- diameter. Types without any such sign get "other". Staff refine this in the
-- material type form.
INSERT INTO material_type_processes (material_type_id, process)
SELECT t.id, x.process FROM material_types t
JOIN LATERAL (
    SELECT mt.process
    FROM machine_run_usages u
    JOIN materials m ON m.id = u.material_id AND m.material_type_id = t.id
    JOIN machine_runs r ON r.id = u.run_id
    JOIN machines ma ON ma.id = r.machine_id
    JOIN machine_types mt ON mt.id = ma.machine_type_id
    UNION
    SELECT 'fdm_printing'
    WHERE t.unit = 'g' AND EXISTS (
        SELECT 1 FROM materials m JOIN material_filament_properties fp ON fp.material_id = m.id
        WHERE m.material_type_id = t.id
    )
) x ON true;

INSERT INTO material_type_processes (material_type_id, process)
SELECT t.id, 'other' FROM material_types t
WHERE NOT EXISTS (SELECT 1 FROM material_type_processes p WHERE p.material_type_id = t.id);

-- 4. Run measures: counted facts of a run that are not material, priced per block.
CREATE TABLE machine_run_measures (
    run_id uuid NOT NULL REFERENCES machine_runs(id) ON DELETE CASCADE,
    measure text NOT NULL CHECK (measure IN ('stitches')),
    value bigint NOT NULL CHECK (value >= 0),
    PRIMARY KEY (run_id, measure)
);

-- 5. Pricing rules for measures: the rate is per block (1000 stitches).
ALTER TABLE pricing_rules
    ADD COLUMN measure text CHECK (measure IS NULL OR measure IN ('stitches')),
    ADD COLUMN block_size integer CHECK (block_size IS NULL OR block_size > 0);
ALTER TABLE pricing_rules DROP CONSTRAINT pricing_rules_kind_check;
ALTER TABLE pricing_rules DROP CONSTRAINT pricing_rules_kind_selector_check;
ALTER TABLE pricing_rules
    ADD CONSTRAINT pricing_rules_kind_check CHECK (kind IN ('machine_runtime', 'material', 'machine_measure')),
    ADD CONSTRAINT pricing_rules_kind_selector_check CHECK (
        (kind = 'machine_runtime' AND machine_type_id IS NOT NULL AND material_type_id IS NULL AND material_unit IS NULL AND measure IS NULL AND block_size IS NULL)
        OR
        (kind = 'material' AND machine_type_id IS NULL AND material_type_id IS NOT NULL AND material_unit IS NOT NULL AND measure IS NULL AND block_size IS NULL)
        OR
        (kind = 'machine_measure' AND machine_type_id IS NOT NULL AND material_type_id IS NULL AND material_unit IS NULL AND measure IS NOT NULL AND block_size IS NOT NULL)
    );
CREATE UNIQUE INDEX pricing_rules_active_measure_idx
    ON pricing_rules (pricing_group_id, machine_type_id, measure)
    WHERE active AND kind = 'machine_measure';

ALTER TABLE machine_job_pricing_snapshot_rules
    ADD COLUMN measure text CHECK (measure IS NULL OR measure IN ('stitches')),
    ADD COLUMN block_size integer CHECK (block_size IS NULL OR block_size > 0);
ALTER TABLE machine_job_pricing_snapshot_rules DROP CONSTRAINT machine_job_pricing_snapshot_rules_kind_check;
ALTER TABLE machine_job_pricing_snapshot_rules
    ADD CONSTRAINT machine_job_pricing_snapshot_rules_kind_check CHECK (kind IN ('machine_runtime', 'material', 'machine_measure')),
    ADD CONSTRAINT machine_job_pricing_snapshot_rules_measure_shape_check CHECK ((kind = 'machine_measure') = (measure IS NOT NULL AND block_size IS NOT NULL));

-- +goose Down
-- Measures, their rules and snapshot entries and the processes of material types
-- are dropped. Machine types with the FDM process become printer types again.
ALTER TABLE machine_job_pricing_snapshot_rules
    DROP CONSTRAINT machine_job_pricing_snapshot_rules_measure_shape_check,
    DROP CONSTRAINT machine_job_pricing_snapshot_rules_kind_check;
DELETE FROM machine_job_pricing_snapshot_rules WHERE kind = 'machine_measure';
ALTER TABLE machine_job_pricing_snapshot_rules
    ADD CONSTRAINT machine_job_pricing_snapshot_rules_kind_check CHECK (kind IN ('machine_runtime', 'material')),
    DROP COLUMN measure,
    DROP COLUMN block_size;

DROP INDEX pricing_rules_active_measure_idx;
ALTER TABLE pricing_rules DROP CONSTRAINT pricing_rules_kind_selector_check, DROP CONSTRAINT pricing_rules_kind_check;
DELETE FROM pricing_rules WHERE kind = 'machine_measure';
ALTER TABLE pricing_rules
    DROP COLUMN measure,
    DROP COLUMN block_size,
    ADD CONSTRAINT pricing_rules_kind_check CHECK (kind IN ('machine_runtime', 'material')),
    ADD CONSTRAINT pricing_rules_kind_selector_check CHECK (
        (kind = 'machine_runtime' AND machine_type_id IS NOT NULL AND material_type_id IS NULL AND material_unit IS NULL)
        OR
        (kind = 'material' AND machine_type_id IS NULL AND material_type_id IS NOT NULL AND material_unit IS NOT NULL)
    );

DROP TABLE machine_run_measures;
DROP TABLE material_type_processes;

-- cm2 has no older equivalent, so the downgrade refuses while any cm2 data exists.
-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM materials WHERE unit = 'cm2')
       OR EXISTS (SELECT 1 FROM material_types WHERE unit = 'cm2')
       OR EXISTS (SELECT 1 FROM machine_job_pricing_snapshot_rules WHERE unit IN ('cm2', 'stitch')) THEN
        RAISE EXCEPTION 'cm2 materials, material types and snapshot rules cannot be downgraded; delete or convert them first';
    END IF;
END $$;
-- +goose StatementEnd
ALTER TABLE machine_job_pricing_snapshot_rules DROP CONSTRAINT machine_job_pricing_snapshot_rules_unit_check;
ALTER TABLE machine_job_pricing_snapshot_rules ADD CONSTRAINT machine_job_pricing_snapshot_rules_unit_check
    CHECK (unit IN ('hour', 'g', 'm', 'ml', 'm2', 'piece'));
ALTER TABLE pricing_rules DROP CONSTRAINT pricing_rules_material_unit_check;
ALTER TABLE pricing_rules ADD CONSTRAINT pricing_rules_material_unit_check
    CHECK (material_unit IS NULL OR material_unit IN ('g', 'm', 'ml', 'm2', 'piece'));
ALTER TABLE materials DROP CONSTRAINT materials_unit_check;
ALTER TABLE materials ADD CONSTRAINT materials_unit_check CHECK (unit IN ('g', 'm', 'ml', 'm2', 'piece'));
ALTER TABLE material_types DROP CONSTRAINT material_types_unit_check;
ALTER TABLE material_types ADD CONSTRAINT material_types_unit_check CHECK (unit IN ('g', 'm', 'ml', 'm2', 'piece'));

ALTER TABLE machine_types ADD COLUMN printer boolean NOT NULL DEFAULT false;
UPDATE machine_types SET printer = true WHERE process = 'fdm_printing';
ALTER TABLE machine_types DROP COLUMN process;
