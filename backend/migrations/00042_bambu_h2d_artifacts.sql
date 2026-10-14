-- +goose Up
-- Archived printer jobs are immutable private files.  Their digest is the
-- identity used for connector deduplication and for conservative planned-job
-- matching; filenames are never identity.
CREATE TABLE print_artifacts (
    id uuid PRIMARY KEY,
    original_file_id uuid NOT NULL UNIQUE REFERENCES files(id) ON DELETE RESTRICT,
    sha256 bytea NOT NULL UNIQUE CHECK (octet_length(sha256) = 32),
    parser_status text NOT NULL CHECK (parser_status IN ('complete', 'partial', 'failed')),
    parser_version text NOT NULL CHECK (parser_version = btrim(parser_version) AND parser_version <> '' AND length(parser_version) <= 80),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 65536),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE print_artifact_previews (
    id uuid PRIMARY KEY,
    artifact_id uuid NOT NULL REFERENCES print_artifacts(id) ON DELETE RESTRICT,
    file_id uuid NOT NULL UNIQUE REFERENCES files(id) ON DELETE RESTRICT,
    archive_path text NOT NULL CHECK (archive_path = btrim(archive_path) AND archive_path <> '' AND length(archive_path) <= 1024),
    role text NOT NULL CHECK (role IN ('plate', 'model', 'other')),
    plate_number integer CHECK (plate_number IS NULL OR plate_number >= 0),
    width integer NOT NULL CHECK (width > 0),
    height integer NOT NULL CHECK (height > 0),
    mime_type text NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg')),
    size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 33554432),
    sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (artifact_id, sha256)
);
CREATE INDEX print_artifact_previews_artifact_idx ON print_artifact_previews (artifact_id, plate_number NULLS LAST, archive_path, id);

ALTER TABLE print_artifacts ADD COLUMN primary_preview_id uuid;
ALTER TABLE print_artifacts ADD CONSTRAINT print_artifacts_primary_preview_fk
    FOREIGN KEY (primary_preview_id) REFERENCES print_artifact_previews(id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE print_artifact_filaments (
    artifact_id uuid NOT NULL REFERENCES print_artifacts(id) ON DELETE RESTRICT,
    filament_key text NOT NULL CHECK (filament_key = btrim(filament_key) AND filament_key <> '' AND length(filament_key) <= 120),
    filament_type text CHECK (filament_type IS NULL OR length(filament_type) <= 120),
    color text CHECK (color IS NULL OR length(color) <= 80),
    extruder integer CHECK (extruder IS NULL OR extruder >= 0),
    planned_weight_g numeric(20, 6) CHECK (planned_weight_g IS NULL OR planned_weight_g >= 0),
    planned_length_mm numeric(20, 6) CHECK (planned_length_mm IS NULL OR planned_length_mm >= 0),
    density_g_cm3 numeric(12, 6) CHECK (density_g_cm3 IS NULL OR density_g_cm3 > 0),
    diameter_mm numeric(12, 6) CHECK (diameter_mm IS NULL OR diameter_mm > 0),
    PRIMARY KEY (artifact_id, filament_key)
);

ALTER TABLE machine_runs ADD COLUMN artifact_id uuid REFERENCES print_artifacts(id) ON DELETE RESTRICT;
ALTER TABLE machine_jobs ADD COLUMN artifact_id uuid REFERENCES print_artifacts(id) ON DELETE RESTRICT;
CREATE INDEX machine_runs_artifact_idx ON machine_runs (artifact_id) WHERE artifact_id IS NOT NULL;
CREATE INDEX machine_jobs_planned_artifact_idx ON machine_jobs (machine_id, artifact_id, created_at, id) WHERE artifact_id IS NOT NULL;

-- Connector reports are itemized while the legacy aggregate columns on
-- machine_runs remain available to one-line consumers during the transition.
CREATE TABLE machine_run_reported_usage_items (
    id uuid PRIMARY KEY,
    run_id uuid NOT NULL REFERENCES machine_runs(id) ON DELETE CASCADE,
    source_printer_event_id uuid NOT NULL REFERENCES printer_events(id) ON DELETE RESTRICT,
    report_revision bigint NOT NULL CHECK (report_revision > 0),
    line_number integer NOT NULL CHECK (line_number >= 0),
    slicer_filament_id text CHECK (slicer_filament_id IS NULL OR length(slicer_filament_id) <= 120),
    extruder integer CHECK (extruder IS NULL OR extruder >= 0),
    input_unit_external_id text CHECK (input_unit_external_id IS NULL OR length(input_unit_external_id) <= 200),
    slot_external_id text CHECK (slot_external_id IS NULL OR length(slot_external_id) <= 200),
    planned_quantity_g numeric(20, 6) CHECK (planned_quantity_g IS NULL OR planned_quantity_g >= 0),
    planned_length_mm numeric(20, 6) CHECK (planned_length_mm IS NULL OR planned_length_mm >= 0),
    estimated_quantity_g numeric(20, 6) CHECK (estimated_quantity_g IS NULL OR estimated_quantity_g >= 0),
    material_id uuid REFERENCES materials(id) ON DELETE RESTRICT,
    spool_id uuid REFERENCES filament_spools(id) ON DELETE SET NULL,
    method text NOT NULL CHECK (method = btrim(method) AND method <> '' AND length(method) <= 80),
    calculation_version text NOT NULL CHECK (calculation_version = btrim(calculation_version) AND calculation_version <> '' AND length(calculation_version) <= 80),
    quality text NOT NULL CHECK (quality IN ('high', 'medium', 'low', 'unresolved')),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (run_id, report_revision, line_number)
);
CREATE INDEX machine_run_reported_usage_items_run_idx ON machine_run_reported_usage_items (run_id, report_revision, line_number);

INSERT INTO machine_run_reported_usage_items (
    id, run_id, source_printer_event_id, report_revision, line_number,
    estimated_quantity_g, spool_id, method, calculation_version, quality, created_at
)
SELECT uuidv7(), r.id, r.reported_event_id, e.report_revision, 0,
       r.reported_quantity_g, r.reported_spool_id, 'legacy_report', 'legacy-v1', 'low', r.updated_at
FROM machine_runs r
JOIN printer_events e ON e.id = r.reported_event_id
WHERE r.reported_event_id IS NOT NULL AND e.report_revision IS NOT NULL AND r.reported_quantity_g IS NOT NULL;

ALTER TABLE machine_run_usages
    ADD COLUMN estimation_method text CHECK (estimation_method IS NULL OR (estimation_method = btrim(estimation_method) AND estimation_method <> '' AND length(estimation_method) <= 80)),
    ADD COLUMN calculation_version text CHECK (calculation_version IS NULL OR (calculation_version = btrim(calculation_version) AND calculation_version <> '' AND length(calculation_version) <= 80)),
    ADD COLUMN estimate_quality text CHECK (estimate_quality IS NULL OR estimate_quality IN ('high', 'medium', 'low')),
    ADD COLUMN report_revision bigint CHECK (report_revision IS NULL OR report_revision > 0),
    ADD COLUMN staff_corrected boolean NOT NULL DEFAULT false;

CREATE TABLE printer_error_occurrences (
    id uuid PRIMARY KEY,
    machine_id uuid NOT NULL REFERENCES machines(id) ON DELETE RESTRICT,
    assignment_id uuid NOT NULL REFERENCES printer_connector_assignments(id) ON DELETE RESTRICT,
    run_id uuid REFERENCES machine_runs(id) ON DELETE SET NULL,
    source_family text NOT NULL CHECK (source_family = btrim(source_family) AND source_family <> '' AND length(source_family) <= 80),
    original_code text NOT NULL CHECK (original_code = btrim(original_code) AND original_code <> '' AND length(original_code) <= 120),
    first_observed_at timestamptz NOT NULL,
    last_observed_at timestamptz NOT NULL,
    resolved_at timestamptz,
    context jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(context) = 'object' AND octet_length(context::text) <= 16384),
    verified_description text CHECK (verified_description IS NULL OR length(verified_description) <= 500),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (last_observed_at >= first_observed_at),
    CHECK (resolved_at IS NULL OR resolved_at >= first_observed_at)
);
CREATE UNIQUE INDEX printer_error_occurrences_open_idx
    ON printer_error_occurrences (assignment_id, source_family, original_code) WHERE resolved_at IS NULL;
CREATE INDEX printer_error_occurrences_machine_time_idx
    ON printer_error_occurrences (machine_id, first_observed_at DESC, id DESC);

ALTER TABLE printer_events DROP CONSTRAINT printer_events_kind_check;
ALTER TABLE printer_events ADD CONSTRAINT printer_events_kind_check CHECK (
    kind IN ('identity', 'connectivity', 'operational_state', 'progress', 'slot_observation',
             'consumption_report', 'terminal_outcome', 'printer_error', 'filament_change')
);

ALTER TABLE order_items
    DROP CONSTRAINT order_items_snapshot_schema_version_check,
    ALTER COLUMN snapshot_schema_version SET DEFAULT 3,
    ADD CONSTRAINT order_items_snapshot_schema_version_check CHECK (snapshot_schema_version IN (1, 2, 3));

-- +goose Down
-- Artifacts and error occurrences cannot be represented by the preceding
-- schema, so a populated installation must retain this migration.
-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM print_artifacts)
       OR EXISTS (SELECT 1 FROM order_items WHERE snapshot_schema_version = 3)
       OR EXISTS (SELECT 1 FROM printer_error_occurrences)
       OR EXISTS (SELECT 1 FROM machine_run_reported_usage_items WHERE method <> 'legacy_report' OR calculation_version <> 'legacy-v1' OR line_number <> 0)
       OR EXISTS (SELECT 1 FROM machine_run_usages WHERE estimation_method IS NOT NULL OR calculation_version IS NOT NULL OR estimate_quality IS NOT NULL OR report_revision IS NOT NULL OR staff_corrected) THEN
        RAISE EXCEPTION 'cannot downgrade while H2D artifacts, itemized usage, provenance, order snapshots, or printer error history exists';
    END IF;
END $$;
-- +goose StatementEnd

ALTER TABLE order_items
    DROP CONSTRAINT order_items_snapshot_schema_version_check,
    ALTER COLUMN snapshot_schema_version SET DEFAULT 2,
    ADD CONSTRAINT order_items_snapshot_schema_version_check CHECK (snapshot_schema_version IN (1, 2));
ALTER TABLE printer_events DROP CONSTRAINT printer_events_kind_check;
ALTER TABLE printer_events ADD CONSTRAINT printer_events_kind_check CHECK (
    kind IN ('identity', 'connectivity', 'operational_state', 'progress', 'slot_observation', 'consumption_report', 'terminal_outcome')
);
DROP TABLE printer_error_occurrences;
ALTER TABLE machine_run_usages
    DROP COLUMN staff_corrected,
    DROP COLUMN report_revision,
    DROP COLUMN estimate_quality,
    DROP COLUMN calculation_version,
    DROP COLUMN estimation_method;
DROP TABLE machine_run_reported_usage_items;
DROP INDEX machine_jobs_planned_artifact_idx;
DROP INDEX machine_runs_artifact_idx;
ALTER TABLE machine_jobs DROP COLUMN artifact_id;
ALTER TABLE machine_runs DROP COLUMN artifact_id;
DROP TABLE print_artifact_filaments;
ALTER TABLE print_artifacts DROP CONSTRAINT print_artifacts_primary_preview_fk;
ALTER TABLE print_artifacts DROP COLUMN primary_preview_id;
DROP TABLE print_artifact_previews;
DROP TABLE print_artifacts;
