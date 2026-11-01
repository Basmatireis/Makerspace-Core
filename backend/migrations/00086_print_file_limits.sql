-- +goose Up
-- The same limits for print files (3MF) as for timelapse videos: the largest accepted file, how long files are kept
-- (0 keeps them until their run is deleted), how many are kept and how much storage they may take (0 = no limit).
ALTER TABLE run_recording_settings
    ADD COLUMN artifact_max_bytes bigint NOT NULL DEFAULT 536870912
        CHECK (artifact_max_bytes BETWEEN 1048576 AND 536870912),
    ADD COLUMN artifact_retention_days integer NOT NULL DEFAULT 0 CHECK (artifact_retention_days BETWEEN 0 AND 3650),
    ADD COLUMN artifact_max_count integer NOT NULL DEFAULT 0 CHECK (artifact_max_count >= 0),
    ADD COLUMN artifact_max_total_bytes bigint NOT NULL DEFAULT 0 CHECK (artifact_max_total_bytes >= 0);

-- +goose Down
ALTER TABLE run_recording_settings
    DROP COLUMN artifact_max_total_bytes, DROP COLUMN artifact_max_count,
    DROP COLUMN artifact_retention_days, DROP COLUMN artifact_max_bytes;
