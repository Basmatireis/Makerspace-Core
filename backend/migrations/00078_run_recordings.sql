-- +goose Up
-- Recorded-run files and connector follow-up: why a run has no (or only part
-- of its) filament consumption, manual connector commands (re-fetch the 3MF,
-- recompute consumption), printer timelapse videos with their retention, and a
-- durable queue for storage blobs whose file rows were deleted in a
-- transaction.

-- Installation settings for printer recordings (one row).
CREATE TABLE run_recording_settings (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    timelapse_enabled boolean NOT NULL DEFAULT true,
    -- 0 keeps timelapse videos until their run is deleted.
    timelapse_retention_days integer NOT NULL DEFAULT 90 CHECK (timelapse_retention_days BETWEEN 0 AND 3650),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO run_recording_settings (singleton) VALUES (true);

-- The latest per-run facts a connector reported about consumption and the
-- timelapse. Telemetry: one row per run, never audited, newest observation wins.
CREATE TABLE machine_run_connector_reports (
    run_id uuid PRIMARY KEY REFERENCES machine_runs(id) ON DELETE CASCADE,
    consumption_state text CHECK (consumption_state IS NULL OR consumption_state IN ('pending', 'reported', 'unavailable')),
    consumption_reason text CHECK (consumption_reason IS NULL OR consumption_reason ~ '^[a-z][a-z0-9_]{0,79}$'),
    consumption_detail text CHECK (consumption_detail IS NULL OR consumption_detail ~ '^[a-z][a-z0-9_]{0,79}$'),
    consumption_observed_at timestamptz,
    timelapse_state text CHECK (timelapse_state IS NULL OR timelapse_state IN ('pending', 'uploaded', 'not_found', 'failed', 'skipped')),
    timelapse_reason text CHECK (timelapse_reason IS NULL OR timelapse_reason ~ '^[a-z][a-z0-9_]{0,79}$'),
    timelapse_detail text CHECK (timelapse_detail IS NULL OR timelapse_detail ~ '^[a-z][a-z0-9_]{0,79}$'),
    timelapse_observed_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((consumption_state IS NULL) = (consumption_observed_at IS NULL)),
    CHECK ((timelapse_state IS NULL) = (timelapse_observed_at IS NULL))
);

-- Commands staff request for a recorded run; the connector that recorded the
-- run polls, executes and reports them. The requesting account is in the audit
-- log only.
CREATE TABLE machine_run_commands (
    id uuid PRIMARY KEY,
    run_id uuid NOT NULL REFERENCES machine_runs(id) ON DELETE CASCADE,
    connector_id uuid REFERENCES printer_connectors(id) ON DELETE SET NULL,
    assignment_id uuid REFERENCES printer_connector_assignments(id) ON DELETE SET NULL,
    kind text NOT NULL CHECK (kind IN ('refetch_artifact', 'recompute_consumption')),
    state text NOT NULL DEFAULT 'requested' CHECK (state IN ('requested', 'running', 'succeeded', 'failed')),
    reason_code text CHECK (reason_code IS NULL OR reason_code ~ '^[a-z][a-z0-9_]{0,79}$'),
    requested_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    finished_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((state IN ('succeeded', 'failed')) = (finished_at IS NOT NULL)),
    CHECK (state <> 'running' OR started_at IS NOT NULL)
);
-- At most one open command per run and kind: a repeated request returns it.
CREATE UNIQUE INDEX machine_run_commands_open_idx ON machine_run_commands (run_id, kind) WHERE state IN ('requested', 'running');
CREATE INDEX machine_run_commands_connector_open_idx ON machine_run_commands (connector_id, requested_at) WHERE state IN ('requested', 'running');
CREATE INDEX machine_run_commands_run_idx ON machine_run_commands (run_id, requested_at DESC);

-- Set whenever the connector polls its commands; Core refuses new commands for
-- a connector that does not poll (an older connector version).
ALTER TABLE printer_connectors ADD COLUMN commands_polled_at timestamptz;

-- One timelapse video per recorded run, in private file storage.
CREATE TABLE machine_run_timelapses (
    run_id uuid PRIMARY KEY REFERENCES machine_runs(id) ON DELETE CASCADE,
    file_id uuid NOT NULL UNIQUE REFERENCES files(id) ON DELETE RESTRICT,
    size_bytes bigint NOT NULL CHECK (size_bytes > 0),
    sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX machine_run_timelapses_created_idx ON machine_run_timelapses (created_at);

-- Storage blobs whose file rows were deleted inside another transaction (for
-- example together with a run). The API's maintenance loop deletes them.
CREATE TABLE file_blob_deletions (
    storage_key text PRIMARY KEY CHECK (storage_key = btrim(storage_key) AND storage_key <> '' AND length(storage_key) <= 255),
    requested_at timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM machine_run_timelapses) OR EXISTS (SELECT 1 FROM file_blob_deletions) THEN
        RAISE EXCEPTION 'cannot downgrade while run timelapses or pending blob deletions exist';
    END IF;
END $$;
-- +goose StatementEnd
DROP TABLE file_blob_deletions;
DROP TABLE machine_run_timelapses;
ALTER TABLE printer_connectors DROP COLUMN commands_polled_at;
DROP TABLE machine_run_commands;
DROP TABLE machine_run_connector_reports;
DROP TABLE run_recording_settings;
