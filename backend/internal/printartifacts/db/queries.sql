-- name: GetArtifactByID :one
SELECT a.*, f.original_filename, f.content_type, f.size_bytes
FROM print_artifacts a
JOIN files f ON f.id = a.original_file_id
WHERE a.id = sqlc.arg(id);

-- name: GetArtifactBySHA256 :one
SELECT a.*, f.original_filename, f.content_type, f.size_bytes
FROM print_artifacts a
JOIN files f ON f.id = a.original_file_id
WHERE a.sha256 = sqlc.arg(sha256);

-- name: InsertArtifact :one
INSERT INTO print_artifacts (id, original_file_id, sha256, parser_status, parser_version, metadata)
VALUES (sqlc.arg(id), sqlc.arg(original_file_id), sqlc.arg(sha256), sqlc.arg(parser_status), sqlc.arg(parser_version), sqlc.arg(metadata))
ON CONFLICT (sha256) DO NOTHING
RETURNING *;

-- name: InsertArtifactPreview :one
INSERT INTO print_artifact_previews (
    id, artifact_id, file_id, archive_path, role, plate_number, width, height, mime_type, size_bytes, sha256
) VALUES (
    sqlc.arg(id), sqlc.arg(artifact_id), sqlc.arg(file_id), sqlc.arg(archive_path), sqlc.narg(role),
    sqlc.narg(plate_number), sqlc.arg(width), sqlc.arg(height), sqlc.arg(mime_type), sqlc.arg(size_bytes), sqlc.arg(sha256)
)
ON CONFLICT (artifact_id, sha256) DO NOTHING
RETURNING *;

-- name: SetArtifactPrimaryPreview :exec
UPDATE print_artifacts SET primary_preview_id = sqlc.narg(primary_preview_id), updated_at = now()
WHERE id = sqlc.arg(id);

-- name: InsertArtifactFilament :exec
INSERT INTO print_artifact_filaments (
    artifact_id, filament_key, filament_type, color, extruder, planned_weight_g, planned_length_mm, density_g_cm3, diameter_mm
) VALUES (
    sqlc.arg(artifact_id), sqlc.arg(filament_key), sqlc.narg(filament_type), sqlc.narg(color), sqlc.narg(extruder),
    sqlc.narg(planned_weight_g), sqlc.narg(planned_length_mm), sqlc.narg(density_g_cm3), sqlc.narg(diameter_mm)
)
ON CONFLICT (artifact_id, filament_key) DO NOTHING;

-- name: ListArtifactFilaments :many
SELECT * FROM print_artifact_filaments WHERE artifact_id = sqlc.arg(artifact_id) ORDER BY filament_key;

-- name: ListArtifactPreviews :many
SELECT p.* FROM print_artifact_previews p WHERE p.artifact_id = sqlc.arg(artifact_id)
ORDER BY (p.id = (SELECT primary_preview_id FROM print_artifacts WHERE id = p.artifact_id)) DESC,
         p.plate_number NULLS LAST, p.archive_path, p.id;

-- name: GetArtifactPreview :one
SELECT p.*, f.original_filename, f.content_type
FROM print_artifact_previews p JOIN files f ON f.id = p.file_id
WHERE p.id = sqlc.arg(id);

-- name: GetConnectorArtifactUploadTarget :one
SELECT a.id AS assignment_id, a.machine_id, a.configuration_version, r.id AS run_id, r.job_id, r.artifact_id
FROM printer_connector_assignments a
JOIN machine_runs r ON r.assignment_id = a.id AND r.machine_id = a.machine_id
WHERE a.id = sqlc.arg(assignment_id) AND a.connector_id = sqlc.arg(connector_id)
  AND r.id = sqlc.arg(run_id) AND r.deleted_at IS NULL AND a.ended_at IS NULL
FOR UPDATE OF a, r;

-- name: CheckConnectorArtifactUploadTarget :one
SELECT a.machine_id, a.configuration_version, r.artifact_id
FROM printer_connector_assignments a
JOIN machine_runs r ON r.assignment_id = a.id AND r.machine_id = a.machine_id
WHERE a.id = sqlc.arg(assignment_id) AND a.connector_id = sqlc.arg(connector_id)
  AND r.id = sqlc.arg(run_id) AND r.deleted_at IS NULL AND a.ended_at IS NULL;

-- name: AttachArtifactToRun :one
UPDATE machine_runs SET artifact_id = sqlc.arg(artifact_id), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(run_id) AND (artifact_id IS NULL OR artifact_id = sqlc.arg(artifact_id))
RETURNING *;

-- name: FindPlannedJobsForArtifact :many
SELECT j.id
FROM machine_jobs j
WHERE j.machine_id = sqlc.arg(machine_id) AND j.artifact_id = sqlc.arg(artifact_id) AND j.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM machine_runs r WHERE r.job_id = j.id AND r.state IS DISTINCT FROM 'replaced')
ORDER BY j.created_at, j.id
FOR UPDATE OF j;

-- name: AttachRunToPlannedJob :execrows
UPDATE machine_runs SET job_id = sqlc.arg(job_id), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(run_id) AND job_id IS NULL;

-- name: NextMachineJobSequence :one
SELECT nextval('machine_job_display_sequence')::bigint;

-- name: GetMachineForArtifactJob :one
SELECT m.*, p.machine_id AS profile_machine_id, p.enabled AS profile_enabled
FROM machines m JOIN printer_profiles p ON p.machine_id = m.id
WHERE m.id = sqlc.arg(id) FOR UPDATE OF m, p;

-- name: BillingPersonExists :one
SELECT EXISTS(SELECT 1 FROM people WHERE id = sqlc.arg(id) AND deleted_at IS NULL);

-- name: ActiveOrganizationExists :one
SELECT EXISTS(SELECT 1 FROM organizations WHERE id = sqlc.arg(id) AND active);

-- name: OperatorExists :one
SELECT EXISTS(SELECT 1 FROM accounts WHERE person_id = sqlc.arg(person_id) AND status = 'enabled');

-- name: CreatePlannedMachineJob :one
INSERT INTO machine_jobs (
    id, display_id, machine_id, customer_person_id, customer_organization_id, operator_person_id, title, notes, artifact_id
) VALUES (
    sqlc.arg(id), sqlc.arg(display_id), sqlc.arg(machine_id), sqlc.narg(customer_person_id), sqlc.narg(customer_organization_id),
    sqlc.arg(operator_person_id), sqlc.narg(title), sqlc.narg(notes), sqlc.arg(artifact_id)
) RETURNING *;

-- name: NextPricingSnapshotRevision :one
SELECT (COALESCE(max(revision), 0) + 1)::integer FROM machine_job_pricing_snapshots WHERE machine_job_id = sqlc.arg(machine_job_id);

-- name: CreatePricingSnapshot :one
INSERT INTO machine_job_pricing_snapshots (
    id, machine_job_id, revision, pricing_group_id, pricing_group_name, reason, complete, calculated_amount, captured_by_account_id
) VALUES (
    sqlc.arg(id), sqlc.arg(machine_job_id), sqlc.arg(revision), sqlc.arg(pricing_group_id), sqlc.arg(pricing_group_name),
    'initial', false, NULL, sqlc.arg(captured_by_account_id)
) RETURNING *;

-- name: ActivatePricingSnapshot :one
UPDATE machine_jobs SET active_pricing_snapshot_id = sqlc.arg(snapshot_id), pricing_status = 'incomplete',
    calculated_price = NULL, version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) RETURNING *;

-- name: InsertPricingSnapshotRules :exec
INSERT INTO machine_job_pricing_snapshot_rules (id, snapshot_id, source_rule_id, kind, label, selector, material_type_id, unit, rate, missing)
SELECT uuidv7(), sqlc.arg(snapshot_id), r.id, r.kind,
       CASE WHEN r.kind = 'machine_runtime' THEN 'Machine runtime' ELSE COALESCE(mat.name, 'Material') END,
       CASE WHEN r.kind = 'machine_runtime' THEN COALESCE(mt.name, '*') ELSE r.material_type_id::text END,
       r.material_type_id,
       CASE WHEN r.kind = 'machine_runtime' THEN 'hour' ELSE COALESCE(r.material_unit, 'g') END,
       r.rate, false
FROM pricing_rules r
LEFT JOIN machine_types mt ON mt.id = r.machine_type_id
LEFT JOIN material_types mat ON mat.id = r.material_type_id
WHERE r.pricing_group_id = sqlc.arg(pricing_group_id) AND r.active;

-- name: InsertReportedUsageItem :one
INSERT INTO machine_run_reported_usage_items (
    id, run_id, source_printer_event_id, report_revision, line_number, slicer_filament_id, extruder,
    input_unit_external_id, slot_external_id, planned_quantity_g, planned_length_mm, estimated_quantity_g,
    material_id, spool_id, method, calculation_version, quality
) VALUES (
    sqlc.arg(id), sqlc.arg(run_id), sqlc.arg(source_printer_event_id), sqlc.arg(report_revision), sqlc.arg(line_number),
    sqlc.narg(slicer_filament_id), sqlc.narg(extruder), sqlc.narg(input_unit_external_id), sqlc.narg(slot_external_id),
    sqlc.narg(planned_quantity_g), sqlc.narg(planned_length_mm), sqlc.narg(estimated_quantity_g),
    sqlc.narg(material_id), sqlc.narg(spool_id), sqlc.arg(method), sqlc.arg(calculation_version), sqlc.arg(quality)
) ON CONFLICT (run_id, report_revision, line_number) DO NOTHING RETURNING *;

-- name: ListLatestReportedUsageItems :many
SELECT i.* FROM machine_run_reported_usage_items i
WHERE i.run_id = sqlc.arg(run_id)
  AND i.report_revision = (SELECT max(report_revision) FROM machine_run_reported_usage_items WHERE run_id = sqlc.arg(run_id))
ORDER BY i.line_number;

-- name: UpsertPrinterErrorOccurrence :one
INSERT INTO printer_error_occurrences (
    id, machine_id, assignment_id, run_id, source_family, original_code, first_observed_at, last_observed_at, context, verified_description
) VALUES (
    sqlc.arg(id), sqlc.arg(machine_id), sqlc.arg(assignment_id), sqlc.narg(run_id), sqlc.arg(source_family), sqlc.arg(original_code),
    sqlc.arg(observed_at), sqlc.arg(observed_at), sqlc.arg(context), sqlc.narg(verified_description)
)
ON CONFLICT (assignment_id, source_family, original_code) WHERE resolved_at IS NULL
DO UPDATE SET last_observed_at = GREATEST(printer_error_occurrences.last_observed_at, EXCLUDED.last_observed_at),
              run_id = COALESCE(EXCLUDED.run_id, printer_error_occurrences.run_id),
              context = EXCLUDED.context, updated_at = now()
RETURNING *;

-- name: ResolvePrinterErrorOccurrence :execrows
UPDATE printer_error_occurrences SET resolved_at = sqlc.arg(observed_at), last_observed_at = GREATEST(last_observed_at, sqlc.arg(observed_at)), updated_at = now()
WHERE assignment_id = sqlc.arg(assignment_id) AND source_family = sqlc.arg(source_family)
  AND original_code = sqlc.arg(original_code) AND resolved_at IS NULL;
