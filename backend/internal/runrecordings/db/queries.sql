-- name: GetRecordingSettings :one
SELECT * FROM run_recording_settings WHERE singleton;

-- name: UpdateRecordingSettings :one
UPDATE run_recording_settings
SET timelapse_enabled = sqlc.arg(timelapse_enabled), timelapse_retention_days = sqlc.arg(timelapse_retention_days),
    version = version + 1, updated_at = now()
WHERE singleton AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: GetRunCommandTargetForUpdate :one
-- Locks the run so concurrent requests for it are counted exactly.
SELECT r.id, r.source, r.state, r.artifact_id, r.assignment_id,
       a.connector_id, (a.id IS NOT NULL AND a.ended_at IS NULL) AS assignment_active,
       c.lifecycle AS connector_lifecycle, c.commands_polled_at, COALESCE(a.adapter_kind, '')::text AS adapter_kind
FROM machine_runs r
LEFT JOIN printer_connector_assignments a ON a.id = r.assignment_id
LEFT JOIN printer_connectors c ON c.id = a.connector_id
WHERE r.id = sqlc.arg(run_id) AND r.deleted_at IS NULL
FOR UPDATE OF r;

-- name: GetOpenRunCommand :one
SELECT * FROM machine_run_commands
WHERE run_id = sqlc.arg(run_id) AND kind = sqlc.arg(kind) AND state IN ('requested', 'running');

-- name: CountRunCommandsSince :one
SELECT count(*)::bigint AS recent, COALESCE(min(requested_at), now())::timestamptz AS oldest
FROM machine_run_commands
WHERE run_id = sqlc.arg(run_id) AND requested_at > sqlc.arg(since);

-- name: InsertRunCommand :one
INSERT INTO machine_run_commands (id, run_id, connector_id, assignment_id, kind)
VALUES (sqlc.arg(id), sqlc.arg(run_id), sqlc.arg(connector_id), sqlc.arg(assignment_id), sqlc.arg(kind))
RETURNING *;

-- name: ListLatestRunCommands :many
SELECT DISTINCT ON (run_id, kind) * FROM machine_run_commands
WHERE run_id = ANY(sqlc.arg(run_ids)::uuid[])
ORDER BY run_id, kind, requested_at DESC, id DESC;

-- name: MarkConnectorCommandsPolled :exec
UPDATE printer_connectors SET commands_polled_at = now() WHERE id = sqlc.arg(id);

-- name: ListOpenConnectorCommands :many
SELECT * FROM machine_run_commands
WHERE connector_id = sqlc.arg(connector_id) AND state IN ('requested', 'running') AND assignment_id IS NOT NULL
ORDER BY requested_at, id
LIMIT 50;

-- name: GetConnectorCommandForUpdate :one
SELECT * FROM machine_run_commands WHERE id = sqlc.arg(id) AND connector_id = sqlc.arg(connector_id) FOR UPDATE;

-- name: SetRunCommandState :one
UPDATE machine_run_commands
SET state = sqlc.arg(state), reason_code = sqlc.narg(reason_code),
    started_at = COALESCE(started_at, now()),
    finished_at = CASE WHEN sqlc.arg(state)::text IN ('succeeded', 'failed') THEN now() END,
    updated_at = now()
WHERE id = sqlc.arg(id)
RETURNING *;

-- name: ExpireStaleRunCommands :many
UPDATE machine_run_commands
SET state = 'failed',
    reason_code = CASE WHEN state = 'requested' THEN 'command_expired' ELSE 'command_timed_out' END,
    finished_at = now(), updated_at = now()
WHERE (state = 'requested' AND requested_at < sqlc.arg(requested_before))
   OR (state = 'running' AND started_at < sqlc.arg(running_before)::timestamptz)
RETURNING id, run_id, connector_id;

-- name: GetConnectorRunTarget :one
-- A run of one of the connector's assignments, also after the assignment ended.
SELECT r.id, r.artifact_id, (a.ended_at IS NULL)::boolean AS assignment_active
FROM machine_runs r
JOIN printer_connector_assignments a ON a.id = r.assignment_id AND a.machine_id = r.machine_id
WHERE r.id = sqlc.arg(run_id) AND a.id = sqlc.arg(assignment_id) AND a.connector_id = sqlc.arg(connector_id)
  AND r.deleted_at IS NULL AND r.source = 'recorded';

-- name: GetConnectorRunTargetForUpdate :one
SELECT r.id, r.machine_id, (a.ended_at IS NULL)::boolean AS assignment_active
FROM machine_runs r
JOIN printer_connector_assignments a ON a.id = r.assignment_id AND a.machine_id = r.machine_id
WHERE r.id = sqlc.arg(run_id) AND a.id = sqlc.arg(assignment_id) AND a.connector_id = sqlc.arg(connector_id)
  AND r.deleted_at IS NULL AND r.source = 'recorded'
FOR UPDATE OF r;

-- name: UpsertRunConsumptionReport :exec
INSERT INTO machine_run_connector_reports (run_id, consumption_state, consumption_reason, consumption_detail, consumption_observed_at)
VALUES (sqlc.arg(run_id), sqlc.arg(state), sqlc.narg(reason), sqlc.narg(detail), sqlc.arg(observed_at))
ON CONFLICT (run_id) DO UPDATE SET
    consumption_state = excluded.consumption_state, consumption_reason = excluded.consumption_reason,
    consumption_detail = excluded.consumption_detail, consumption_observed_at = excluded.consumption_observed_at,
    updated_at = now()
WHERE machine_run_connector_reports.consumption_observed_at IS NULL
   OR machine_run_connector_reports.consumption_observed_at <= excluded.consumption_observed_at;

-- name: UpsertRunTimelapseReport :exec
INSERT INTO machine_run_connector_reports (run_id, timelapse_state, timelapse_reason, timelapse_detail, timelapse_observed_at)
VALUES (sqlc.arg(run_id), sqlc.arg(state), sqlc.narg(reason), sqlc.narg(detail), sqlc.arg(observed_at))
ON CONFLICT (run_id) DO UPDATE SET
    timelapse_state = excluded.timelapse_state, timelapse_reason = excluded.timelapse_reason,
    timelapse_detail = excluded.timelapse_detail, timelapse_observed_at = excluded.timelapse_observed_at,
    updated_at = now()
WHERE machine_run_connector_reports.timelapse_observed_at IS NULL
   OR machine_run_connector_reports.timelapse_observed_at <= excluded.timelapse_observed_at;

-- name: GetRunTimelapse :one
SELECT * FROM machine_run_timelapses WHERE run_id = sqlc.arg(run_id);

-- name: InsertRunTimelapse :one
INSERT INTO machine_run_timelapses (run_id, file_id, size_bytes, sha256)
VALUES (sqlc.arg(run_id), sqlc.arg(file_id), sqlc.arg(size_bytes), sqlc.arg(sha256))
RETURNING *;

-- name: ListRunArtifactFiles :many
SELECT r.id AS run_id, pa.id AS artifact_id, f.original_filename, f.size_bytes,
       encode(pa.sha256, 'hex')::text AS sha256, pa.parser_status, r.artifact_manual
FROM machine_runs r
JOIN print_artifacts pa ON pa.id = r.artifact_id
JOIN files f ON f.id = pa.original_file_id
WHERE r.id = ANY(sqlc.arg(run_ids)::uuid[]);

-- name: ListRunPreviews :many
SELECT r.id AS run_id, p.id, p.role, p.plate_number, p.width, p.height, p.mime_type,
       COALESCE(pa.primary_preview_id = p.id, false)::boolean AS is_primary
FROM machine_runs r
JOIN print_artifacts pa ON pa.id = r.artifact_id
JOIN print_artifact_previews p ON p.artifact_id = pa.id
WHERE r.id = ANY(sqlc.arg(run_ids)::uuid[])
ORDER BY r.id, (p.role <> 'plate'), p.plate_number NULLS LAST, p.archive_path, p.id;

-- name: ListRunTimelapses :many
SELECT run_id, size_bytes, created_at FROM machine_run_timelapses WHERE run_id = ANY(sqlc.arg(run_ids)::uuid[]);

-- name: ListRunTimelapseReports :many
SELECT run_id, timelapse_state, timelapse_reason, timelapse_detail
FROM machine_run_connector_reports
WHERE run_id = ANY(sqlc.arg(run_ids)::uuid[]) AND timelapse_state IS NOT NULL;

-- name: GetRunArtifactFile :one
SELECT pa.original_file_id, f.original_filename, f.size_bytes, encode(pa.sha256, 'hex')::text AS sha256
FROM machine_runs r
JOIN print_artifacts pa ON pa.id = r.artifact_id
JOIN files f ON f.id = pa.original_file_id
WHERE r.id = sqlc.arg(run_id) AND r.deleted_at IS NULL;

-- name: GetRunPreviewFile :one
SELECT p.file_id, p.mime_type, p.size_bytes, p.archive_path
FROM machine_runs r
JOIN print_artifact_previews p ON p.artifact_id = r.artifact_id
WHERE r.id = sqlc.arg(run_id) AND p.id = sqlc.arg(preview_id) AND r.deleted_at IS NULL;

-- name: GetRunTimelapseFile :one
SELECT t.file_id, t.size_bytes, r.display_id
FROM machine_runs r
JOIN machine_run_timelapses t ON t.run_id = r.id
WHERE r.id = sqlc.arg(run_id) AND r.deleted_at IS NULL;

-- name: ListExpiredTimelapsesForUpdate :many
SELECT run_id, file_id FROM machine_run_timelapses
WHERE created_at < sqlc.arg(cutoff)
ORDER BY created_at, run_id
LIMIT sqlc.arg(row_limit)
FOR UPDATE SKIP LOCKED;

-- name: DeleteRunTimelapses :exec
DELETE FROM machine_run_timelapses WHERE run_id = ANY(sqlc.arg(run_ids)::uuid[]);

-- name: DeleteFilesQueueBlobs :exec
WITH deleted AS (
    DELETE FROM files WHERE id = ANY(sqlc.arg(file_ids)::uuid[]) RETURNING storage_key
)
INSERT INTO file_blob_deletions (storage_key) SELECT storage_key FROM deleted
ON CONFLICT (storage_key) DO NOTHING;
