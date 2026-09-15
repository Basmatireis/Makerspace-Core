-- name: ListDeviceTypes :many
SELECT * FROM device_types ORDER BY lower(name), id;

-- name: GetDeviceType :one
SELECT * FROM device_types WHERE id = sqlc.arg(id);

-- name: GetDeviceTypeForMutation :one
SELECT * FROM device_types WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: CreateDeviceType :one
INSERT INTO device_types (id, name, description)
VALUES (sqlc.arg(id), sqlc.arg(name), sqlc.narg(description)) RETURNING *;

-- name: UpdateDeviceType :one
UPDATE device_types SET name = sqlc.arg(name), description = sqlc.narg(description),
  version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) RETURNING *;

-- name: DeleteDeviceType :one
DELETE FROM device_types WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) RETURNING id;

-- name: ListManagedDevices :many
SELECT md.*, dt.name AS device_type_name
FROM managed_devices md JOIN device_types dt ON dt.id = md.device_type_id
ORDER BY lower(md.name), md.id;

-- name: GetManagedDevice :one
SELECT md.*, dt.name AS device_type_name
FROM managed_devices md JOIN device_types dt ON dt.id = md.device_type_id
WHERE md.id = sqlc.arg(id);

-- name: GetManagedDeviceForMutation :one
SELECT * FROM managed_devices WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: CreateManagedDevice :one
INSERT INTO managed_devices (id, name, device_type_id, token_digest, expires_at)
VALUES (sqlc.arg(id), sqlc.arg(name), sqlc.arg(device_type_id), sqlc.arg(token_digest), sqlc.narg(expires_at)) RETURNING *;

-- name: UpdateManagedDevice :one
UPDATE managed_devices SET name = sqlc.arg(name), device_type_id = sqlc.arg(device_type_id),
  expires_at = sqlc.narg(expires_at), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) RETURNING *;

-- name: RevokeManagedDevice :one
UPDATE managed_devices SET revoked_at = now(), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) AND revoked_at IS NULL RETURNING *;

-- name: RotateManagedDeviceToken :one
UPDATE managed_devices SET token_digest = sqlc.arg(token_digest), expires_at = sqlc.narg(expires_at),
  version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) AND revoked_at IS NULL RETURNING *;

-- name: DeleteManagedDevice :one
DELETE FROM managed_devices WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
  AND revoked_at IS NOT NULL RETURNING id;

-- name: GetValidManagedDeviceByDigest :one
SELECT md.id, md.name, md.device_type_id, dt.name AS device_type_name, md.expires_at
FROM managed_devices md JOIN device_types dt ON dt.id = md.device_type_id
WHERE md.token_digest = sqlc.arg(token_digest) AND md.revoked_at IS NULL
  AND (md.expires_at IS NULL OR md.expires_at > now());

-- name: TouchManagedDevice :exec
UPDATE managed_devices SET last_seen_at = now()
WHERE id = sqlc.arg(id) AND revoked_at IS NULL
  AND (last_seen_at IS NULL OR last_seen_at < now() - interval '5 minutes');
