-- +goose Up
-- A recorded run's 3MF can be uploaded by staff when the connector cannot read
-- it from the printer (a print started from the printer's internal storage).
-- The flag tells a manually uploaded file from one the connector retrieved: only
-- the former may be replaced by another manual upload, and the connector's own
-- retrieval supersedes it.
ALTER TABLE machine_runs
    ADD COLUMN artifact_manual boolean NOT NULL DEFAULT false,
    ADD CONSTRAINT machine_runs_artifact_manual_requires_artifact CHECK (NOT artifact_manual OR artifact_id IS NOT NULL);

-- +goose Down
ALTER TABLE machine_runs
    DROP CONSTRAINT machine_runs_artifact_manual_requires_artifact,
    DROP COLUMN artifact_manual;
