-- +goose Up
-- Machine types become the process catalog: a process is what a machine does, carries the pricing, the trainings
-- and the materials that fit, and is edited by the makerspace. The former fixed process enum becomes a chosen
-- integration (none, or an FDM printer with a printer setup) plus a catalog of counted measures per process.
ALTER TABLE machine_types RENAME TO processes;
ALTER INDEX machine_types_name_ci_idx RENAME TO processes_name_ci_idx;
ALTER TABLE processes ADD COLUMN integration text NOT NULL DEFAULT 'none' CHECK (integration IN ('none', 'fdm_printer'));
UPDATE processes SET integration = 'fdm_printer' WHERE process = 'fdm_printing';
ALTER TABLE processes ALTER COLUMN integration DROP DEFAULT;

CREATE TABLE process_measures (
    process_id uuid NOT NULL REFERENCES processes(id) ON DELETE CASCADE,
    key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,39}$'),
    label text NOT NULL CHECK (label = btrim(label) AND label <> '' AND length(label) <= 60),
    unit text NOT NULL CHECK (unit = btrim(unit) AND unit <> '' AND length(unit) <= 20),
    block_size integer NOT NULL CHECK (block_size >= 1),
    position integer NOT NULL DEFAULT 0 CHECK (position >= 0),
    PRIMARY KEY (process_id, key)
);
INSERT INTO process_measures (process_id, key, label, unit, block_size)
SELECT id, 'stitches', 'Stitches', 'stitch', 1000 FROM processes WHERE process = 'embroidery';

-- Material eligibility links a material type to processes by id instead of by the enum.
CREATE TABLE material_type_process_links (
    material_type_id uuid NOT NULL REFERENCES material_types(id) ON DELETE CASCADE,
    process_id uuid NOT NULL REFERENCES processes(id) ON DELETE CASCADE,
    PRIMARY KEY (material_type_id, process_id)
);
INSERT INTO material_type_process_links (material_type_id, process_id)
SELECT DISTINCT l.material_type_id, p.id FROM material_type_processes l JOIN processes p ON p.process = l.process;
DROP TABLE material_type_processes;
ALTER TABLE material_type_process_links RENAME TO material_type_processes;
ALTER INDEX material_type_process_links_pkey RENAME TO material_type_processes_pkey;
CREATE INDEX material_type_processes_process_idx ON material_type_processes (process_id, material_type_id);

ALTER TABLE processes DROP COLUMN process;

ALTER TABLE machines RENAME COLUMN machine_type_id TO process_id;
ALTER TABLE machines RENAME CONSTRAINT machines_machine_type_id_fkey TO machines_process_id_fkey;
ALTER INDEX machines_type_status_idx RENAME TO machines_process_status_idx;

ALTER TABLE pricing_rules RENAME COLUMN machine_type_id TO process_id;
ALTER TABLE pricing_rules RENAME CONSTRAINT pricing_rules_machine_type_id_fkey TO pricing_rules_process_id_fkey;
ALTER TABLE pricing_rules DROP CONSTRAINT pricing_rules_measure_check;
ALTER TABLE pricing_rules ADD CONSTRAINT pricing_rules_measure_check CHECK (measure IS NULL OR measure ~ '^[a-z][a-z0-9_]{1,39}$');
ALTER TABLE machine_job_pricing_snapshot_rules DROP CONSTRAINT machine_job_pricing_snapshot_rules_measure_check;
ALTER TABLE machine_job_pricing_snapshot_rules
    ADD CONSTRAINT machine_job_pricing_snapshot_rules_measure_check CHECK (measure IS NULL OR measure ~ '^[a-z][a-z0-9_]{1,39}$');
ALTER TABLE machine_run_measures DROP CONSTRAINT machine_run_measures_measure_check;
ALTER TABLE machine_run_measures ADD CONSTRAINT machine_run_measures_measure_check CHECK (measure ~ '^[a-z][a-z0-9_]{1,39}$');
-- A snapshot entry carries the unit of its measure, which is free text on the process now.
ALTER TABLE machine_job_pricing_snapshot_rules DROP CONSTRAINT machine_job_pricing_snapshot_rules_unit_check;
ALTER TABLE machine_job_pricing_snapshot_rules
    ADD CONSTRAINT machine_job_pricing_snapshot_rules_unit_check CHECK (unit = btrim(unit) AND unit <> '' AND length(unit) <= 20);

ALTER TABLE training_machine_types RENAME TO training_processes;
ALTER TABLE training_processes RENAME COLUMN machine_type_id TO process_id;
ALTER TABLE training_processes RENAME CONSTRAINT training_machine_types_machine_type_id_fkey TO training_processes_process_id_fkey;
ALTER INDEX training_machine_types_pkey RENAME TO training_processes_pkey;
ALTER INDEX training_machine_types_machine_type_idx RENAME TO training_processes_process_idx;

-- +goose Down
-- Refuses while a measure other than stitches exists (the former enum cannot hold it).
ALTER INDEX training_processes_process_idx RENAME TO training_machine_types_machine_type_idx;
ALTER INDEX training_processes_pkey RENAME TO training_machine_types_pkey;
ALTER TABLE training_processes RENAME CONSTRAINT training_processes_process_id_fkey TO training_machine_types_machine_type_id_fkey;
ALTER TABLE training_processes RENAME COLUMN process_id TO machine_type_id;
ALTER TABLE training_processes RENAME TO training_machine_types;

ALTER TABLE machine_job_pricing_snapshot_rules DROP CONSTRAINT machine_job_pricing_snapshot_rules_unit_check;
ALTER TABLE machine_job_pricing_snapshot_rules
    ADD CONSTRAINT machine_job_pricing_snapshot_rules_unit_check CHECK (unit IN ('hour', 'g', 'm', 'ml', 'm2', 'cm2', 'piece', 'stitch'));
ALTER TABLE machine_run_measures DROP CONSTRAINT machine_run_measures_measure_check;
ALTER TABLE machine_run_measures ADD CONSTRAINT machine_run_measures_measure_check CHECK (measure IN ('stitches'));
ALTER TABLE machine_job_pricing_snapshot_rules DROP CONSTRAINT machine_job_pricing_snapshot_rules_measure_check;
ALTER TABLE machine_job_pricing_snapshot_rules
    ADD CONSTRAINT machine_job_pricing_snapshot_rules_measure_check CHECK (measure IS NULL OR measure IN ('stitches'));
ALTER TABLE pricing_rules DROP CONSTRAINT pricing_rules_measure_check;
ALTER TABLE pricing_rules ADD CONSTRAINT pricing_rules_measure_check CHECK (measure IS NULL OR measure IN ('stitches'));
ALTER TABLE pricing_rules RENAME CONSTRAINT pricing_rules_process_id_fkey TO pricing_rules_machine_type_id_fkey;
ALTER TABLE pricing_rules RENAME COLUMN process_id TO machine_type_id;

ALTER INDEX machines_process_status_idx RENAME TO machines_type_status_idx;
ALTER TABLE machines RENAME CONSTRAINT machines_process_id_fkey TO machines_machine_type_id_fkey;
ALTER TABLE machines RENAME COLUMN process_id TO machine_type_id;

ALTER TABLE processes ADD COLUMN process text NOT NULL DEFAULT 'other'
    CHECK (process IN ('fdm_printing', 'embroidery', 'uv_printing', 'laser_cutting', 'vinyl_cutting', 'other'));
UPDATE processes SET process = 'fdm_printing' WHERE integration = 'fdm_printer';
UPDATE processes p SET process = 'embroidery'
    WHERE p.integration = 'none' AND EXISTS (SELECT 1 FROM process_measures m WHERE m.process_id = p.id AND m.key = 'stitches');
ALTER TABLE processes ALTER COLUMN process DROP DEFAULT;

CREATE TABLE material_type_process_enum (
    material_type_id uuid NOT NULL REFERENCES material_types(id) ON DELETE CASCADE,
    process text NOT NULL CHECK (process IN ('fdm_printing', 'embroidery', 'uv_printing', 'laser_cutting', 'vinyl_cutting', 'other')),
    PRIMARY KEY (material_type_id, process)
);
INSERT INTO material_type_process_enum (material_type_id, process)
SELECT DISTINCT l.material_type_id, p.process FROM material_type_processes l JOIN processes p ON p.id = l.process_id;
DROP TABLE material_type_processes;
ALTER TABLE material_type_process_enum RENAME TO material_type_processes;
ALTER INDEX material_type_process_enum_pkey RENAME TO material_type_processes_pkey;

DROP TABLE process_measures;
ALTER TABLE processes DROP COLUMN integration;
ALTER INDEX processes_name_ci_idx RENAME TO machine_types_name_ci_idx;
ALTER TABLE processes RENAME TO machine_types;
