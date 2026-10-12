-- name: GetPrinterProfile :one
SELECT p.*, m.name AS machine_name, m.status AS machine_status
FROM printer_profiles p JOIN machines m ON m.id=p.machine_id
WHERE p.machine_id=sqlc.arg(machine_id);

-- name: UpsertPrinterProfile :one
INSERT INTO printer_profiles (machine_id, enabled) VALUES (sqlc.arg(machine_id), sqlc.arg(enabled))
ON CONFLICT (machine_id) DO UPDATE SET enabled=EXCLUDED.enabled, version=printer_profiles.version+1, updated_at=now()
WHERE printer_profiles.version=sqlc.arg(expected_version) OR sqlc.arg(expected_version)=0
RETURNING *;

-- name: ListPrinterProfileIDs :many
SELECT machine_id FROM printer_profiles WHERE enabled ORDER BY machine_id;

-- name: CreatePrinterInputUnit :one
INSERT INTO printer_input_units (id, machine_id, name, position, external_identifier)
VALUES (sqlc.arg(id), sqlc.arg(machine_id), sqlc.arg(name), sqlc.arg(position), sqlc.narg(external_identifier)) RETURNING *;

-- name: ListPrinterInputUnits :many
SELECT * FROM printer_input_units WHERE machine_id=sqlc.arg(machine_id) ORDER BY position, id;

-- name: GetPrinterInputUnitForUpdate :one
SELECT * FROM printer_input_units WHERE id=sqlc.arg(id) FOR UPDATE;

-- name: UpdatePrinterInputUnit :one
UPDATE printer_input_units SET name=sqlc.arg(name), position=sqlc.arg(position), external_identifier=sqlc.narg(external_identifier),
    enabled=sqlc.arg(enabled), version=version+1, updated_at=now()
WHERE id=sqlc.arg(id) AND version=sqlc.arg(expected_version) RETURNING *;

-- name: CreatePrinterSlot :one
INSERT INTO printer_slots (id, input_unit_id, name, position, external_identifier, status)
VALUES (sqlc.arg(id), sqlc.arg(input_unit_id), sqlc.arg(name), sqlc.arg(position), sqlc.narg(external_identifier), sqlc.arg(status)) RETURNING *;

-- name: GetPrinterSlot :one
SELECT sl.*, u.machine_id, u.name AS input_unit_name,
       a.id AS assignment_id, a.spool_id, a.mounted_at, s.display_id AS spool_display_id
FROM printer_slots sl
JOIN printer_input_units u ON u.id=sl.input_unit_id
LEFT JOIN printer_spool_assignments a ON a.slot_id=sl.id AND a.unmounted_at IS NULL
LEFT JOIN filament_spools s ON s.id=a.spool_id
WHERE sl.id=sqlc.arg(id);

-- name: GetPrinterSlotForUpdate :one
SELECT sl.*, u.machine_id FROM printer_slots sl JOIN printer_input_units u ON u.id=sl.input_unit_id
WHERE sl.id=sqlc.arg(id) FOR UPDATE OF sl;

-- name: ListPrinterSlots :many
SELECT sl.*, u.machine_id, u.name AS input_unit_name,
       a.id AS assignment_id, a.spool_id, a.mounted_at, s.display_id AS spool_display_id
FROM printer_slots sl
JOIN printer_input_units u ON u.id=sl.input_unit_id
LEFT JOIN printer_spool_assignments a ON a.slot_id=sl.id AND a.unmounted_at IS NULL
LEFT JOIN filament_spools s ON s.id=a.spool_id
WHERE u.machine_id=sqlc.arg(machine_id)
ORDER BY u.position, sl.position, sl.id;

-- name: UpdatePrinterSlot :one
UPDATE printer_slots SET name=sqlc.arg(name), position=sqlc.arg(position), external_identifier=sqlc.narg(external_identifier),
    status=sqlc.arg(status), version=version+1, updated_at=now()
WHERE id=sqlc.arg(id) AND version=sqlc.arg(expected_version) RETURNING *;

-- name: GetOpenAssignmentForSlot :one
SELECT * FROM printer_spool_assignments WHERE slot_id=sqlc.arg(slot_id) AND unmounted_at IS NULL FOR UPDATE;

-- name: GetOpenAssignmentForSpool :one
SELECT * FROM printer_spool_assignments WHERE spool_id=sqlc.arg(spool_id) AND unmounted_at IS NULL FOR UPDATE;

-- name: CreatePrinterSpoolAssignment :one
INSERT INTO printer_spool_assignments (id, slot_id, spool_id, mounted_at, mounted_by_account_id, source, source_event_id)
VALUES (sqlc.arg(id), sqlc.arg(slot_id), sqlc.arg(spool_id), sqlc.arg(mounted_at), sqlc.narg(mounted_by_account_id), sqlc.arg(source), sqlc.narg(source_event_id)) RETURNING *;

-- name: ClosePrinterSpoolAssignment :one
UPDATE printer_spool_assignments SET unmounted_at=sqlc.arg(unmounted_at), unmounted_by_account_id=sqlc.narg(unmounted_by_account_id)
WHERE id=sqlc.arg(id) AND unmounted_at IS NULL RETURNING *;

-- name: ListPrinterSpoolAssignmentHistory :many
SELECT a.*, s.display_id AS spool_display_id
FROM printer_spool_assignments a JOIN filament_spools s ON s.id=a.spool_id
WHERE a.slot_id=sqlc.arg(slot_id) ORDER BY a.mounted_at DESC, a.id DESC
LIMIT sqlc.arg(page_limit) OFFSET sqlc.arg(page_offset);

-- name: NextPrintSubmissionSequence :one
SELECT nextval('print_submission_display_sequence')::bigint;

-- name: CreatePrintSubmission :one
INSERT INTO print_submissions (id, display_id, machine_id, customer_person_id, customer_organization_id, title, notes, reprints_submission_id, created_by_account_id)
VALUES (sqlc.arg(id), sqlc.arg(display_id), sqlc.arg(machine_id), sqlc.narg(customer_person_id), sqlc.narg(customer_organization_id),
    sqlc.arg(title), sqlc.narg(notes), sqlc.narg(reprints_submission_id), sqlc.narg(created_by_account_id)) RETURNING *;

-- name: GetPrintSubmission :one
SELECT s.*, m.name AS machine_name, cp.first_name AS customer_first_name, cp.last_name AS customer_last_name, co.name AS customer_organization_name
FROM print_submissions s JOIN machines m ON m.id=s.machine_id
LEFT JOIN people cp ON cp.id=s.customer_person_id
LEFT JOIN organizations co ON co.id=s.customer_organization_id
WHERE s.id=sqlc.arg(id);

-- name: GetPrintSubmissionForUpdate :one
SELECT * FROM print_submissions WHERE id=sqlc.arg(id) FOR UPDATE;

-- name: ListPrintSubmissions :many
SELECT s.*, m.name AS machine_name FROM print_submissions s JOIN machines m ON m.id=s.machine_id
WHERE (sqlc.arg(search)::text='' OR lower(s.display_id) LIKE '%'||lower(sqlc.arg(search)::text)||'%' OR lower(s.title) LIKE '%'||lower(sqlc.arg(search)::text)||'%')
  AND (sqlc.arg(state)::text='' OR s.state=sqlc.arg(state)::text)
  AND (sqlc.narg(machine_id)::uuid IS NULL OR s.machine_id=sqlc.narg(machine_id))
ORDER BY s.created_at DESC, s.id DESC LIMIT sqlc.arg(page_limit) OFFSET sqlc.arg(page_offset);

-- name: CountPrintSubmissions :one
SELECT count(*) FROM print_submissions s
WHERE (sqlc.arg(search)::text='' OR lower(s.display_id) LIKE '%'||lower(sqlc.arg(search)::text)||'%' OR lower(s.title) LIKE '%'||lower(sqlc.arg(search)::text)||'%')
  AND (sqlc.arg(state)::text='' OR s.state=sqlc.arg(state)::text)
  AND (sqlc.narg(machine_id)::uuid IS NULL OR s.machine_id=sqlc.narg(machine_id));

-- name: UpdatePrintSubmission :one
UPDATE print_submissions SET title=sqlc.arg(title), notes=sqlc.narg(notes), state=sqlc.arg(state),
    version=version+1, updated_at=now()
WHERE id=sqlc.arg(id) AND version=sqlc.arg(expected_version) RETURNING *;

-- name: CreatePrintFilamentDeclaration :one
INSERT INTO print_filament_declarations (id, submission_id, attempt_id, ownership, material_id, spool_id, external_material_name, estimated_quantity_g)
VALUES (sqlc.arg(id), sqlc.narg(submission_id), sqlc.narg(attempt_id), sqlc.arg(ownership), sqlc.narg(material_id),
    sqlc.narg(spool_id), sqlc.narg(external_material_name), sqlc.narg(estimated_quantity_g)) RETURNING *;

-- name: DeleteSubmissionFilamentDeclarations :exec
DELETE FROM print_filament_declarations WHERE submission_id=sqlc.arg(submission_id);

-- name: ListPrintFilamentDeclarations :many
SELECT d.*, COALESCE(m.name, d.external_material_name) AS material_name, s.display_id AS spool_display_id
FROM print_filament_declarations d
LEFT JOIN materials m ON m.id=d.material_id LEFT JOIN filament_spools s ON s.id=d.spool_id
WHERE d.submission_id=sqlc.narg(submission_id) OR d.attempt_id=sqlc.narg(attempt_id)
ORDER BY d.id;

-- name: NextPrintAttemptNumber :one
SELECT COALESCE(max(attempt_number),0)::integer+1 FROM print_attempts WHERE submission_id=sqlc.arg(submission_id);

-- name: CreatePrintAttempt :one
INSERT INTO print_attempts (id, submission_id, attempt_number, machine_id)
VALUES (sqlc.arg(id), sqlc.arg(submission_id), sqlc.arg(attempt_number), sqlc.arg(machine_id)) RETURNING *;

-- name: GetPrintAttempt :one
SELECT a.*, m.name AS machine_name FROM print_attempts a JOIN machines m ON m.id=a.machine_id WHERE a.id=sqlc.arg(id);

-- name: GetPrintAttemptForUpdate :one
SELECT * FROM print_attempts WHERE id=sqlc.arg(id) FOR UPDATE;

-- name: ListPrintAttempts :many
SELECT a.*, m.name AS machine_name FROM print_attempts a JOIN machines m ON m.id=a.machine_id
WHERE a.submission_id=sqlc.arg(submission_id) ORDER BY a.attempt_number, a.id;

-- name: UpdatePrintAttemptState :one
UPDATE print_attempts SET state=sqlc.arg(state), accepted_at=sqlc.narg(accepted_at), started_at=sqlc.narg(started_at),
    ended_at=sqlc.narg(ended_at), version=version+1, updated_at=now()
WHERE id=sqlc.arg(id) AND version=sqlc.arg(expected_version) RETURNING *;

-- name: LinkPrintAttemptJob :one
UPDATE print_attempts SET machine_job_id=sqlc.arg(machine_job_id), version=version+1, updated_at=now()
WHERE id=sqlc.arg(id) AND version=sqlc.arg(expected_version) AND machine_job_id IS NULL RETURNING *;

-- name: GetPrintingOperation :one
SELECT * FROM printing_operations WHERE operation_key=sqlc.arg(operation_key) FOR UPDATE;

-- name: InsertPrintingOperation :one
INSERT INTO printing_operations (operation_key, actor_account_id, kind, fingerprint, result_id)
VALUES (sqlc.arg(operation_key), sqlc.arg(actor_account_id), sqlc.arg(kind), sqlc.arg(fingerprint), sqlc.arg(result_id)) RETURNING *;

-- name: InsertPrinterEvent :one
INSERT INTO printer_events (id, source_id, event_key, fingerprint, protocol_version, machine_id, attempt_id, kind,
    occurred_at, source_sequence, external_print_id, payload, reconciliation_state)
VALUES (sqlc.arg(id), sqlc.arg(source_id), sqlc.arg(event_key), sqlc.arg(fingerprint), sqlc.arg(protocol_version),
    sqlc.narg(machine_id), sqlc.narg(attempt_id), sqlc.arg(kind), sqlc.arg(occurred_at), sqlc.narg(source_sequence),
    sqlc.narg(external_print_id), sqlc.arg(payload), sqlc.arg(reconciliation_state)) RETURNING *;

-- name: GetPrinterEventByKey :one
SELECT * FROM printer_events WHERE source_id=sqlc.arg(source_id) AND event_key=sqlc.arg(event_key) FOR UPDATE;

-- name: GetPrinterEventForUpdate :one
SELECT * FROM printer_events WHERE id=sqlc.arg(id) FOR UPDATE;

-- name: ListPrinterEventsForAttempt :many
SELECT * FROM printer_events WHERE attempt_id=sqlc.arg(attempt_id) ORDER BY occurred_at, id;

-- name: ReconcilePrinterEvent :one
UPDATE printer_events SET reconciliation_state=sqlc.arg(reconciliation_state), reconciled_by_account_id=sqlc.narg(reconciled_by_account_id), reconciled_at=now()
WHERE id=sqlc.arg(id) AND reconciliation_state='pending' RETURNING *;
