-- name: CreateConnector :one
INSERT INTO printer_connectors (id, name, location_label)
VALUES (sqlc.arg(id), sqlc.arg(name), sqlc.narg(location_label)) RETURNING *;

-- name: ListConnectors :many
SELECT * FROM printer_connectors ORDER BY lower(name), id;

-- name: GetConnector :one
SELECT * FROM printer_connectors WHERE id=sqlc.arg(id);

-- name: GetConnectorForUpdate :one
SELECT * FROM printer_connectors WHERE id=sqlc.arg(id) FOR UPDATE;

-- name: UpdateConnector :one
UPDATE printer_connectors SET name=sqlc.arg(name), location_label=sqlc.narg(location_label),
    configuration_revision=configuration_revision + CASE WHEN lifecycle <> sqlc.arg(lifecycle) THEN 1 ELSE 0 END,
    lifecycle=sqlc.arg(lifecycle), disabled_at=sqlc.narg(disabled_at), version=version+1, updated_at=now()
WHERE id=sqlc.arg(id) AND version=sqlc.arg(expected_version) RETURNING *;

-- name: RevokeOpenEnrollments :exec
UPDATE printer_connector_enrollments SET revoked_at=COALESCE(revoked_at, now())
WHERE connector_id=sqlc.arg(connector_id) AND consumed_at IS NULL AND revoked_at IS NULL;

-- name: CreateEnrollment :one
INSERT INTO printer_connector_enrollments (id, connector_id, token_digest, expires_at, created_by_account_id)
VALUES (sqlc.arg(id), sqlc.arg(connector_id), sqlc.arg(token_digest), sqlc.arg(expires_at), sqlc.narg(created_by_account_id)) RETURNING *;

-- name: GetEnrollmentByDigestForUpdate :one
SELECT * FROM printer_connector_enrollments WHERE token_digest=sqlc.arg(token_digest) FOR UPDATE;

-- name: CreateCredential :one
INSERT INTO printer_connector_credentials (id, connector_id, token_digest, expires_at)
VALUES (sqlc.arg(id), sqlc.arg(connector_id), sqlc.arg(token_digest), sqlc.arg(expires_at)) RETURNING *;

-- name: BeginCredentialRotation :exec
UPDATE printer_connector_credentials SET state='retiring', retire_after=now()+interval '24 hours'
WHERE connector_id=sqlc.arg(connector_id) AND state='current';

-- name: RevokeRetiringCredentials :exec
UPDATE printer_connector_credentials SET state='revoked', revoked_at=COALESCE(revoked_at, now())
WHERE connector_id=sqlc.arg(connector_id) AND state='retiring';

-- name: GetConnectorCredential :one
SELECT * FROM printer_connector_credentials WHERE id=sqlc.arg(id) AND connector_id=sqlc.arg(connector_id);

-- name: CreateRotatedCredential :one
INSERT INTO printer_connector_credentials (id, connector_id, token_digest, expires_at, state)
VALUES (sqlc.arg(id), sqlc.arg(connector_id), sqlc.arg(token_digest), sqlc.arg(expires_at), 'current') RETURNING *;

-- name: CompleteEnrollment :one
UPDATE printer_connector_enrollments
SET consumed_at=COALESCE(consumed_at, now()), credential_fingerprint=COALESCE(credential_fingerprint, sqlc.arg(credential_fingerprint)),
    accepted_credential_id=COALESCE(accepted_credential_id, sqlc.arg(credential_id))
WHERE id=sqlc.arg(id) RETURNING *;

-- name: ActivateConnector :one
UPDATE printer_connectors SET lifecycle='active', enrolled_at=COALESCE(enrolled_at, now()), version=version+1, updated_at=now()
WHERE id=sqlc.arg(id) AND lifecycle='pending' RETURNING *;

-- name: AuthenticateConnector :one
SELECT c.*, cr.id AS credential_id
FROM printer_connector_credentials cr JOIN printer_connectors c ON c.id=cr.connector_id
WHERE cr.token_digest=sqlc.arg(token_digest) AND cr.state IN ('current','retiring')
  AND cr.expires_at > now() AND (cr.retire_after IS NULL OR cr.retire_after > now())
  AND c.lifecycle IN ('active','disabled');

-- name: TouchCredential :exec
UPDATE printer_connector_credentials SET last_used_at=now()
WHERE id=sqlc.arg(id) AND (last_used_at IS NULL OR last_used_at < now()-interval '5 minutes');

-- name: RevokeConnectorCredentials :exec
UPDATE printer_connector_credentials SET state='revoked', revoked_at=COALESCE(revoked_at, now())
WHERE connector_id=sqlc.arg(connector_id) AND state <> 'revoked';

-- name: RevokeConnector :one
UPDATE printer_connectors SET lifecycle='revoked', revoked_at=now(), disabled_at=NULL,
    configuration_revision=configuration_revision+1, version=version+1, updated_at=now()
WHERE id=sqlc.arg(id) AND version=sqlc.arg(expected_version) AND lifecycle <> 'revoked' RETURNING *;

-- name: EndConnectorAssignments :exec
UPDATE printer_connector_assignments SET ended_at=COALESCE(ended_at, now()), enabled=false, version=version+1, updated_at=now()
WHERE connector_id=sqlc.arg(connector_id) AND ended_at IS NULL;

-- name: CreateAssignment :one
INSERT INTO printer_connector_assignments (id, connector_id, machine_id, adapter_kind, adapter_schema_version, settings, encrypted_secrets, enabled)
VALUES (sqlc.arg(id), sqlc.arg(connector_id), sqlc.arg(machine_id), sqlc.arg(adapter_kind), sqlc.arg(adapter_schema_version), sqlc.arg(settings), sqlc.narg(encrypted_secrets), sqlc.arg(enabled)) RETURNING *;

-- name: GetAssignmentForUpdate :one
SELECT * FROM printer_connector_assignments
WHERE id=sqlc.arg(id) AND connector_id=sqlc.arg(connector_id) FOR UPDATE;

-- name: UpdateAssignment :one
UPDATE printer_connector_assignments SET adapter_kind=sqlc.arg(adapter_kind),
    adapter_schema_version=sqlc.arg(adapter_schema_version), settings=sqlc.arg(settings),
    encrypted_secrets=sqlc.narg(encrypted_secrets),
    enabled=CASE WHEN sqlc.arg(end_assignment)::boolean THEN false ELSE sqlc.arg(enabled) END,
    ended_at=CASE WHEN sqlc.arg(end_assignment)::boolean THEN now() ELSE ended_at END,
    configuration_version=configuration_version+1, version=version+1, updated_at=now()
WHERE id=sqlc.arg(id) AND connector_id=sqlc.arg(connector_id)
  AND version=sqlc.arg(expected_version) AND ended_at IS NULL
RETURNING *;

-- name: GetAssignment :one
SELECT a.*, m.name AS machine_name
FROM printer_connector_assignments a JOIN machines m ON m.id=a.machine_id
WHERE a.id=sqlc.arg(id) AND a.connector_id=sqlc.arg(connector_id);

-- name: ListActiveAssignments :many
SELECT a.*, p.enabled AS printer_enabled, m.name AS machine_name
FROM printer_connector_assignments a
JOIN printer_profiles p ON p.machine_id=a.machine_id
JOIN machines m ON m.id=a.machine_id
WHERE a.connector_id=sqlc.arg(connector_id) AND a.ended_at IS NULL
ORDER BY lower(m.name), a.id;

-- name: ListConnectorAssignments :many
SELECT a.*, m.name AS machine_name
FROM printer_connector_assignments a JOIN machines m ON m.id=a.machine_id
WHERE a.connector_id=sqlc.arg(connector_id)
ORDER BY a.ended_at NULLS FIRST, lower(m.name), a.id;

-- name: GetAssignmentForIngress :one
SELECT a.*, c.lifecycle AS connector_lifecycle
FROM printer_connector_assignments a JOIN printer_connectors c ON c.id=a.connector_id
WHERE a.id=sqlc.arg(id) AND a.connector_id=sqlc.arg(connector_id) FOR UPDATE OF a, c;

-- name: BumpConnectorConfiguration :one
UPDATE printer_connectors SET configuration_revision=configuration_revision+1, version=version+1, updated_at=now()
WHERE id=sqlc.arg(id) RETURNING *;

-- name: RecordHeartbeat :one
UPDATE printer_connectors SET last_heartbeat_at=now(), software_version=sqlc.arg(software_version),
    protocol_version=sqlc.arg(protocol_version), applied_configuration_revision=sqlc.arg(applied_configuration_revision),
    health_state=sqlc.arg(health_state), health_summary=sqlc.narg(health_summary),
    pending_event_count=sqlc.arg(pending_event_count), quarantined_event_count=sqlc.arg(quarantined_event_count), updated_at=now()
WHERE id=sqlc.arg(id) AND lifecycle='active' RETURNING *;

-- name: UpdateAssignmentRuntime :exec
UPDATE printer_connector_assignments SET applied_configuration_version=sqlc.arg(applied_configuration_version),
    runtime_state=sqlc.arg(runtime_state), runtime_error_code=sqlc.narg(runtime_error_code), updated_at=now()
WHERE id=sqlc.arg(id) AND connector_id=sqlc.arg(connector_id) AND ended_at IS NULL;

-- name: NextPrintSequence :one
SELECT nextval('machine_run_display_sequence')::bigint;

-- name: InsertObservedRun :one
INSERT INTO machine_runs (id, display_id, source, assignment_id, machine_id, vendor_job_id, state, history_complete, first_observed_at, last_observed_at)
VALUES (sqlc.arg(id), sqlc.arg(display_id), 'recorded', sqlc.arg(assignment_id), sqlc.arg(machine_id), sqlc.narg(vendor_job_id), sqlc.arg(state), sqlc.arg(history_complete), sqlc.arg(observed_at), sqlc.arg(observed_at))
ON CONFLICT (id) DO NOTHING
RETURNING *;

-- name: UpdateObservedRun :one
UPDATE machine_runs SET
    vendor_job_id=COALESCE(vendor_job_id, sqlc.narg(vendor_job_id)::text),
    state=CASE
        WHEN state IN ('finished','failed','cancelled') THEN state
        WHEN sqlc.arg(observed_at)::timestamptz >= last_observed_at THEN sqlc.arg(state)::text
        ELSE state
    END,
    history_complete=history_complete AND sqlc.arg(history_complete)::boolean,
    last_observed_at=GREATEST(last_observed_at, sqlc.arg(observed_at)::timestamptz),
    version=version + CASE
        WHEN sqlc.arg(observed_at)::timestamptz > last_observed_at THEN 1
        ELSE 0
    END,
    updated_at=CASE
        WHEN sqlc.arg(observed_at)::timestamptz > last_observed_at THEN now()
        ELSE updated_at
    END
WHERE id=sqlc.arg(id) AND assignment_id=sqlc.arg(assignment_id) AND machine_id=sqlc.arg(machine_id)
RETURNING *;

-- name: UpdateObservedRunFacts :exec
UPDATE machine_runs SET
    started_at=sqlc.narg(started_at)::timestamptz,
    ended_at=sqlc.narg(ended_at)::timestamptz,
    file_name=COALESCE(sqlc.narg(file_name)::text, file_name),
    progress_percent=COALESCE(sqlc.narg(progress_percent)::smallint, progress_percent),
    estimated_end_at=COALESCE(sqlc.narg(estimated_end_at)::timestamptz, estimated_end_at)
WHERE id=sqlc.arg(id);

-- name: SetObservedRunReport :execrows
UPDATE machine_runs r SET reported_quantity_g=sqlc.arg(quantity_g), reported_quantity_basis=sqlc.arg(quantity_basis),
    reported_spool_id=sqlc.narg(spool_id), reported_event_id=sqlc.arg(event_id)
WHERE r.id=sqlc.arg(id) AND (r.reported_event_id IS NULL OR sqlc.arg(report_revision)::bigint >= COALESCE((SELECT e.report_revision FROM printer_events e WHERE e.id=r.reported_event_id), 0));

-- name: InsertReportedUsageItem :exec
INSERT INTO machine_run_reported_usage_items (
    id, run_id, source_printer_event_id, report_revision, line_number,
    slicer_filament_id, extruder, input_unit_external_id, slot_external_id,
    planned_quantity_g, planned_length_mm, estimated_quantity_g, material_id, spool_id,
    method, calculation_version, quality
) VALUES (
    sqlc.arg(id), sqlc.arg(run_id), sqlc.arg(source_printer_event_id), sqlc.arg(report_revision), sqlc.arg(line_number),
    sqlc.narg(slicer_filament_id), sqlc.narg(extruder), sqlc.narg(input_unit_external_id), sqlc.narg(slot_external_id),
    sqlc.narg(planned_quantity_g), sqlc.narg(planned_length_mm), sqlc.narg(estimated_quantity_g), sqlc.narg(material_id), sqlc.narg(spool_id),
    sqlc.arg(method), sqlc.arg(calculation_version), sqlc.arg(quality)
) ON CONFLICT (run_id, report_revision, line_number) DO NOTHING;

-- name: UpsertPrinterErrorOccurrence :exec
INSERT INTO printer_error_occurrences (
    id, machine_id, assignment_id, run_id, source_family, original_code,
    first_observed_at, last_observed_at, context
) VALUES (
    sqlc.arg(id), sqlc.arg(machine_id), sqlc.arg(assignment_id), sqlc.narg(run_id),
    sqlc.arg(source_family), sqlc.arg(original_code), sqlc.arg(observed_at), sqlc.arg(observed_at), sqlc.arg(context)
)
ON CONFLICT (assignment_id, source_family, original_code) WHERE resolved_at IS NULL
DO UPDATE SET last_observed_at=GREATEST(printer_error_occurrences.last_observed_at, EXCLUDED.last_observed_at),
              run_id=COALESCE(printer_error_occurrences.run_id, EXCLUDED.run_id),
              context=EXCLUDED.context, updated_at=now();

-- name: ResolvePrinterErrorOccurrence :exec
UPDATE printer_error_occurrences
SET last_observed_at=GREATEST(last_observed_at, sqlc.arg(observed_at)::timestamptz),
    resolved_at=GREATEST(first_observed_at, sqlc.arg(observed_at)::timestamptz), updated_at=now()
WHERE assignment_id=sqlc.arg(assignment_id) AND source_family=sqlc.arg(source_family)
  AND original_code=sqlc.arg(original_code) AND resolved_at IS NULL;

-- name: ListSlotSpoolsAt :many
SELECT a.spool_id
FROM printer_spool_assignments a
JOIN printer_slots s ON s.id=a.slot_id
JOIN printer_input_units u ON u.id=s.input_unit_id
WHERE u.machine_id=sqlc.arg(machine_id) AND s.external_identifier=sqlc.arg(slot_external_id)
  AND (sqlc.narg(input_unit_external_id)::text IS NULL OR u.external_identifier=sqlc.narg(input_unit_external_id))
  AND a.mounted_at <= sqlc.arg(at)::timestamptz AND (a.unmounted_at IS NULL OR a.unmounted_at > sqlc.arg(at)::timestamptz);

-- name: ListNFCSpoolsAt :many
SELECT i.spool_id
FROM filament_spool_identifiers i
WHERE i.kind='nfc' AND lower(i.value)=lower(sqlc.arg(tag_uid))
  AND i.created_at <= sqlc.arg(at)::timestamptz
  AND (i.retired_at IS NULL OR i.retired_at > sqlc.arg(at)::timestamptz);

-- name: ListObservedRuns :many
SELECT r.*, m.name AS machine_name
FROM machine_runs r JOIN machines m ON m.id=r.machine_id
WHERE r.deleted_at IS NULL AND r.assignment_id IN (SELECT id FROM printer_connector_assignments WHERE connector_id=sqlc.arg(connector_id))
ORDER BY r.last_observed_at DESC, r.id DESC LIMIT 100;

-- name: ListConnectorEvents :many
SELECT id, machine_id, connector_assignment_id, kind, occurred_at, received_at,
    application_state, application_reason, payload
FROM printer_events
WHERE connector_id=sqlc.arg(connector_id)
  AND (sqlc.arg(include_cleared)::boolean OR received_at > COALESCE((SELECT c.events_cleared_at FROM printer_connectors c WHERE c.id=sqlc.arg(connector_id)), '-infinity'::timestamptz))
ORDER BY received_at DESC, id DESC LIMIT 100;

-- name: ClearConnectorEvents :one
UPDATE printer_connectors SET events_cleared_at=sqlc.arg(cleared_at), events_cleared_by=sqlc.narg(cleared_by)
WHERE id=sqlc.arg(id) RETURNING *;

-- name: GetObservedRunForUpdate :one
SELECT * FROM machine_runs WHERE id=sqlc.arg(id) AND source='recorded' FOR UPDATE;

-- name: GetConnectorEventByKey :one
SELECT * FROM printer_events WHERE source_id=sqlc.arg(source_id) AND event_key=sqlc.arg(event_key);

-- name: GetConnectorEventBySequence :one
SELECT * FROM printer_events WHERE connector_assignment_id=sqlc.arg(assignment_id) AND source_sequence=sqlc.arg(source_sequence);

-- name: InsertConnectorEvent :one
INSERT INTO printer_events (id, source_id, event_key, fingerprint, protocol_version, machine_id, kind, occurred_at,
    source_sequence, external_print_id, payload, connector_id, connector_assignment_id,
    run_id, configuration_version, application_state, application_reason, report_revision)
VALUES (sqlc.arg(id), sqlc.arg(source_id), sqlc.arg(event_key), sqlc.arg(fingerprint), sqlc.arg(protocol_version), sqlc.arg(machine_id),
    sqlc.arg(kind), sqlc.arg(occurred_at), sqlc.arg(source_sequence), sqlc.narg(external_print_id), sqlc.arg(payload),
    sqlc.arg(connector_id), sqlc.arg(assignment_id), sqlc.narg(run_id),
    sqlc.arg(configuration_version), sqlc.arg(application_state), sqlc.narg(application_reason), sqlc.narg(report_revision)) RETURNING *;

-- name: BumpConnectorsOfMachine :exec
UPDATE printer_connectors SET configuration_revision=configuration_revision+1, version=version+1, updated_at=now()
WHERE id IN (SELECT connector_id FROM printer_connector_assignments WHERE machine_id=sqlc.arg(machine_id) AND ended_at IS NULL);

-- name: GetAssignmentForLiveStatus :one
SELECT a.id, a.machine_id, a.configuration_version, a.enabled, a.ended_at, c.lifecycle AS connector_lifecycle
FROM printer_connector_assignments a JOIN printer_connectors c ON c.id=a.connector_id
WHERE a.id=sqlc.arg(id) AND a.connector_id=sqlc.arg(connector_id);

-- name: UpsertPrinterLiveStatus :exec
INSERT INTO printer_live_statuses (assignment_id, machine_id, observed_at, received_at, configuration_version, snapshot)
VALUES (sqlc.arg(assignment_id), sqlc.arg(machine_id), sqlc.arg(observed_at), sqlc.arg(received_at), sqlc.arg(configuration_version), sqlc.arg(snapshot))
ON CONFLICT (assignment_id) DO UPDATE SET machine_id=EXCLUDED.machine_id, observed_at=EXCLUDED.observed_at,
    received_at=EXCLUDED.received_at, configuration_version=EXCLUDED.configuration_version, snapshot=EXCLUDED.snapshot
WHERE printer_live_statuses.observed_at <= EXCLUDED.observed_at;

-- name: GetActivePrinterLiveStatus :one
SELECT s.* FROM printer_live_statuses s JOIN printer_connector_assignments a ON a.id=s.assignment_id
WHERE s.machine_id=sqlc.arg(machine_id) AND a.ended_at IS NULL;

-- name: GetAccountDisplayName :one
SELECT btrim(p.first_name || ' ' || p.last_name)::text AS display_name
FROM accounts a JOIN people p ON p.id=a.person_id WHERE a.id=sqlc.arg(id);
