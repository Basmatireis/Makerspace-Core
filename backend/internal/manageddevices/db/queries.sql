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
INSERT INTO managed_devices (id, name, device_type_id, token_digest, expires_at, session_policy_id,
  terminal_enabled, allowed_app_modes, check_in_methods, check_out_methods, allow_tap_checkout,
  offer_surveys_at_checkout, kiosk_reset_seconds)
VALUES (sqlc.arg(id), sqlc.arg(name), sqlc.arg(device_type_id), sqlc.arg(token_digest), sqlc.narg(expires_at),
  sqlc.narg(session_policy_id), sqlc.arg(terminal_enabled), sqlc.arg(allowed_app_modes), sqlc.arg(check_in_methods),
  sqlc.arg(check_out_methods), sqlc.arg(allow_tap_checkout), sqlc.arg(offer_surveys_at_checkout),
  sqlc.arg(kiosk_reset_seconds)) RETURNING *;

-- name: UpdateManagedDevice :one
UPDATE managed_devices SET name = sqlc.arg(name), device_type_id = sqlc.arg(device_type_id),
  expires_at = sqlc.narg(expires_at), session_policy_id = sqlc.narg(session_policy_id),
  terminal_enabled = sqlc.arg(terminal_enabled), allowed_app_modes = sqlc.arg(allowed_app_modes), check_in_methods = sqlc.arg(check_in_methods),
  check_out_methods = sqlc.arg(check_out_methods), allow_tap_checkout = sqlc.arg(allow_tap_checkout),
  offer_surveys_at_checkout = sqlc.arg(offer_surveys_at_checkout), kiosk_reset_seconds = sqlc.arg(kiosk_reset_seconds),
  version = version + 1, updated_at = now()
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
SELECT md.id, md.name, md.device_type_id, dt.name AS device_type_name, md.expires_at,
       md.session_policy_id, md.terminal_enabled, md.allowed_app_modes, md.check_in_methods, md.check_out_methods,
       md.allow_tap_checkout, md.offer_surveys_at_checkout, md.kiosk_reset_seconds
FROM managed_devices md JOIN device_types dt ON dt.id = md.device_type_id
WHERE md.token_digest = sqlc.arg(token_digest) AND md.revoked_at IS NULL
  AND (md.expires_at IS NULL OR md.expires_at > now());

-- name: TouchManagedDevice :exec
UPDATE managed_devices SET last_seen_at = now()
WHERE id = sqlc.arg(id) AND revoked_at IS NULL
  AND (last_seen_at IS NULL OR last_seen_at < now() - interval '5 minutes');

-- name: ListSessionPolicies :many
SELECT * FROM session_policies ORDER BY is_default DESC, lower(name), id;

-- name: GetSessionPolicy :one
SELECT * FROM session_policies WHERE id = sqlc.arg(id);

-- name: GetDefaultSessionPolicy :one
SELECT * FROM session_policies WHERE is_default LIMIT 1;

-- name: CreateSessionPolicy :one
INSERT INTO session_policies (id, name, idle_timeout_seconds, absolute_lifetime_seconds, post_session_destination, is_default)
VALUES (sqlc.arg(id), sqlc.arg(name), sqlc.arg(idle_timeout_seconds), sqlc.arg(absolute_lifetime_seconds),
  sqlc.arg(post_session_destination), sqlc.arg(is_default)) RETURNING *;

-- name: ClearDefaultSessionPolicy :exec
UPDATE session_policies SET is_default = false, version = version + 1, updated_at = now()
WHERE is_default AND id <> sqlc.arg(id);

-- name: UpdateSessionPolicy :one
UPDATE session_policies SET name = sqlc.arg(name), idle_timeout_seconds = sqlc.arg(idle_timeout_seconds),
  absolute_lifetime_seconds = sqlc.arg(absolute_lifetime_seconds),
  post_session_destination = sqlc.arg(post_session_destination), is_default = sqlc.arg(is_default),
  version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) RETURNING *;

-- name: RevokeSessionsForPolicy :exec
UPDATE sessions SET revoked_at = COALESCE(revoked_at, now()),
  revocation_reason = COALESCE(revocation_reason, 'session_policy_changed')
WHERE session_policy_id = sqlc.arg(session_policy_id) AND revoked_at IS NULL;

-- name: RevokeSessionsForManagedDevice :exec
UPDATE sessions SET revoked_at = COALESCE(revoked_at, now()),
  revocation_reason = COALESCE(revocation_reason, 'managed_device_policy_changed')
WHERE managed_device_id = sqlc.arg(managed_device_id) AND revoked_at IS NULL;

-- name: ListDeviceCapabilities :many
SELECT capability FROM managed_device_capabilities
WHERE managed_device_id = sqlc.arg(managed_device_id) AND enabled
ORDER BY capability;

-- name: ClearDeviceCapabilities :exec
DELETE FROM managed_device_capabilities WHERE managed_device_id = sqlc.arg(managed_device_id);

-- name: AddDeviceCapability :exec
INSERT INTO managed_device_capabilities (managed_device_id, capability)
VALUES (sqlc.arg(managed_device_id), sqlc.arg(capability));

-- name: GetManagedDeviceHardwareReport :one
SELECT platform, bridge_version, reported_at
FROM managed_device_hardware_reports
WHERE managed_device_id = sqlc.arg(managed_device_id);

-- name: ListReportedDeviceCapabilities :many
SELECT capability
FROM managed_device_reported_capabilities
WHERE managed_device_id = sqlc.arg(managed_device_id)
ORDER BY capability;

-- name: UpsertManagedDeviceHardwareReport :exec
INSERT INTO managed_device_hardware_reports (managed_device_id, platform, bridge_version, reported_at)
VALUES (sqlc.arg(managed_device_id), sqlc.arg(platform), sqlc.arg(bridge_version), now())
ON CONFLICT (managed_device_id) DO UPDATE
SET platform = EXCLUDED.platform, bridge_version = EXCLUDED.bridge_version, reported_at = now();

-- name: ClearReportedDeviceCapabilities :exec
DELETE FROM managed_device_reported_capabilities
WHERE managed_device_id = sqlc.arg(managed_device_id);

-- name: AddReportedDeviceCapability :exec
INSERT INTO managed_device_reported_capabilities (managed_device_id, capability)
VALUES (sqlc.arg(managed_device_id), sqlc.arg(capability));

-- name: EnsureManagedDeviceTypeByName :exec
INSERT INTO device_types (id, name, description)
VALUES (sqlc.arg(id), sqlc.arg(name), sqlc.narg(description))
ON CONFLICT DO NOTHING;

-- name: GetDeviceTypeByName :one
SELECT * FROM device_types WHERE lower(name) = lower(sqlc.arg(name)::text);

-- name: SetManagedDeviceTokenDigest :one
UPDATE managed_devices SET token_digest = sqlc.arg(token_digest), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND revoked_at IS NULL RETURNING id;

-- Pairing -----------------------------------------------------------------------------------------------------

-- name: DeleteExpiredManagedDevicePairingRequests :exec
DELETE FROM managed_device_pairing_requests WHERE expires_at <= sqlc.arg(now)::timestamptz;

-- name: CountOpenManagedDevicePairingRequests :one
SELECT count(*) FROM managed_device_pairing_requests WHERE expires_at > sqlc.arg(now)::timestamptz;

-- name: CreateManagedDevicePairingRequest :exec
INSERT INTO managed_device_pairing_requests (id, code_digest, poll_secret_digest, credential_delivery, created_at, expires_at)
VALUES (sqlc.arg(id), sqlc.arg(code_digest), sqlc.arg(poll_secret_digest), sqlc.arg(credential_delivery), sqlc.arg(created_at), sqlc.arg(expires_at));

-- name: DeleteOpenManagedDevicePairingRequestByPollDigest :exec
DELETE FROM managed_device_pairing_requests
WHERE poll_secret_digest = sqlc.arg(poll_secret_digest) AND claimed_device_id IS NULL;

-- name: GetManagedDevicePairingRequestForPoll :one
-- Locks the request so that two concurrent polls cannot both collect the credential.
SELECT id, credential_delivery, claimed_device_id FROM managed_device_pairing_requests
WHERE poll_secret_digest = sqlc.arg(poll_secret_digest) FOR UPDATE;

-- name: GetOpenManagedDevicePairingRequestByCode :one
-- Locks the open request so that two staff members cannot claim the same code.
SELECT id FROM managed_device_pairing_requests
WHERE code_digest = sqlc.arg(code_digest) AND claimed_at IS NULL AND expires_at > sqlc.arg(now)::timestamptz FOR UPDATE;

-- name: ClaimManagedDevicePairingRequest :exec
UPDATE managed_device_pairing_requests
SET claimed_device_id = sqlc.arg(device_id), claimed_at = sqlc.arg(now)::timestamptz, expires_at = sqlc.arg(delivery_deadline)
WHERE id = sqlc.arg(id);

-- name: DeleteManagedDevicePairingRequest :exec
DELETE FROM managed_device_pairing_requests WHERE id = sqlc.arg(id);

-- name: IssuePairedManagedDeviceToken :one
-- Replaces the unusable placeholder digest of a freshly paired device with the digest of the delivered token.
UPDATE managed_devices SET token_digest = sqlc.arg(token_digest), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
RETURNING expires_at;

-- name: GetManagedDeviceCameraSettings :one
SELECT * FROM managed_device_camera_settings WHERE managed_device_id = sqlc.arg(managed_device_id);

-- name: GetManagedDeviceCameraSettingsForUpdate :one
SELECT * FROM managed_device_camera_settings WHERE managed_device_id = sqlc.arg(managed_device_id) FOR UPDATE;

-- name: UpsertManagedDeviceCameraSettings :one
INSERT INTO managed_device_camera_settings (
    managed_device_id, crop_center_x, crop_center_y, crop_size, indicator_edge, indicator_offset,
    calibration_expires_at, updated_at)
VALUES (
    sqlc.arg(managed_device_id), sqlc.narg(crop_center_x), sqlc.narg(crop_center_y), sqlc.narg(crop_size),
    sqlc.narg(indicator_edge), sqlc.narg(indicator_offset), sqlc.narg(calibration_expires_at), sqlc.arg(updated_at))
ON CONFLICT (managed_device_id) DO UPDATE SET
    crop_center_x = EXCLUDED.crop_center_x,
    crop_center_y = EXCLUDED.crop_center_y,
    crop_size = EXCLUDED.crop_size,
    indicator_edge = EXCLUDED.indicator_edge,
    indicator_offset = EXCLUDED.indicator_offset,
    calibration_expires_at = EXCLUDED.calibration_expires_at,
    updated_at = EXCLUDED.updated_at
RETURNING *;
