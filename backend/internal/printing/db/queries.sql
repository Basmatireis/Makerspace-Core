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
