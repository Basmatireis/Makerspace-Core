-- Gateways -----------------------------------------------------------------------------------------------------

-- name: CreateGateway :one
INSERT INTO streaming_gateways (id, name, public_host)
VALUES (sqlc.arg(id), sqlc.arg(name), sqlc.arg(public_host)) RETURNING *;

-- name: ListGateways :many
SELECT * FROM streaming_gateways ORDER BY lower(name), id;

-- name: GetGateway :one
SELECT * FROM streaming_gateways WHERE id = sqlc.arg(id);

-- name: GetGatewayForUpdate :one
SELECT * FROM streaming_gateways WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: UpdateGateway :one
UPDATE streaming_gateways SET name = sqlc.arg(name), public_host = sqlc.arg(public_host), lifecycle = sqlc.arg(lifecycle),
    disabled_at = sqlc.narg(disabled_at), configuration_revision = configuration_revision + 1,
    version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) AND lifecycle <> 'revoked' RETURNING *;

-- name: DeleteGateway :execrows
DELETE FROM streaming_gateways WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version);

-- name: RevokeGateway :one
UPDATE streaming_gateways SET lifecycle = 'revoked', revoked_at = now(), disabled_at = NULL,
    configuration_revision = configuration_revision + 1, version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) AND lifecycle <> 'revoked' RETURNING *;

-- name: BumpGatewayConfiguration :exec
UPDATE streaming_gateways SET configuration_revision = configuration_revision + 1, updated_at = now() WHERE id = sqlc.arg(id);

-- name: BumpAllGatewayConfigurations :exec
UPDATE streaming_gateways SET configuration_revision = configuration_revision + 1, updated_at = now() WHERE lifecycle IN ('pending', 'active', 'disabled');

-- name: RecordGatewayHeartbeat :one
UPDATE streaming_gateways SET software_version = sqlc.arg(software_version), protocol_version = sqlc.arg(protocol_version),
    applied_configuration_revision = sqlc.arg(applied_configuration_revision), health_state = sqlc.arg(health_state),
    health_summary = sqlc.narg(health_summary), last_heartbeat_at = now()
WHERE id = sqlc.arg(id) AND lifecycle = 'active' RETURNING *;

-- Enrollment and credentials -----------------------------------------------------------------------------------

-- name: RevokeOpenGatewayEnrollments :exec
UPDATE streaming_gateway_enrollments SET revoked_at = COALESCE(revoked_at, now())
WHERE gateway_id = sqlc.arg(gateway_id) AND consumed_at IS NULL AND revoked_at IS NULL;

-- name: CreateGatewayEnrollment :one
INSERT INTO streaming_gateway_enrollments (id, gateway_id, token_digest, expires_at, created_by_account_id)
VALUES (sqlc.arg(id), sqlc.arg(gateway_id), sqlc.arg(token_digest), sqlc.arg(expires_at), sqlc.narg(created_by_account_id)) RETURNING *;

-- name: GetGatewayEnrollmentByDigestForUpdate :one
SELECT * FROM streaming_gateway_enrollments WHERE token_digest = sqlc.arg(token_digest) FOR UPDATE;

-- name: CompleteGatewayEnrollment :one
UPDATE streaming_gateway_enrollments
SET consumed_at = COALESCE(consumed_at, now()), credential_fingerprint = COALESCE(credential_fingerprint, sqlc.arg(credential_fingerprint)),
    accepted_credential_id = COALESCE(accepted_credential_id, sqlc.arg(credential_id))
WHERE id = sqlc.arg(id) RETURNING *;

-- name: CreateGatewayCredential :one
INSERT INTO streaming_gateway_credentials (id, gateway_id, token_digest, expires_at)
VALUES (sqlc.arg(id), sqlc.arg(gateway_id), sqlc.arg(token_digest), sqlc.arg(expires_at)) RETURNING *;

-- name: GetGatewayCredential :one
SELECT * FROM streaming_gateway_credentials WHERE id = sqlc.arg(id) AND gateway_id = sqlc.arg(gateway_id);

-- name: BeginGatewayCredentialRotation :exec
UPDATE streaming_gateway_credentials SET state = 'retiring', retire_after = now() + interval '24 hours'
WHERE gateway_id = sqlc.arg(gateway_id) AND state = 'current';

-- name: RevokeRetiringGatewayCredentials :exec
UPDATE streaming_gateway_credentials SET state = 'revoked', revoked_at = COALESCE(revoked_at, now())
WHERE gateway_id = sqlc.arg(gateway_id) AND state = 'retiring';

-- name: CreateRotatedGatewayCredential :one
INSERT INTO streaming_gateway_credentials (id, gateway_id, token_digest, expires_at, state)
VALUES (sqlc.arg(id), sqlc.arg(gateway_id), sqlc.arg(token_digest), sqlc.arg(expires_at), 'current') RETURNING *;

-- name: RevokeGatewayCredentials :exec
UPDATE streaming_gateway_credentials SET state = 'revoked', revoked_at = COALESCE(revoked_at, now())
WHERE gateway_id = sqlc.arg(gateway_id) AND state <> 'revoked';

-- name: ActivateGateway :one
UPDATE streaming_gateways SET lifecycle = 'active', enrolled_at = COALESCE(enrolled_at, now()),
    configuration_revision = configuration_revision + 1, version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND lifecycle = 'pending' RETURNING *;

-- name: ReenrollGateway :one
UPDATE streaming_gateways SET configuration_revision = configuration_revision + 1, version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND lifecycle IN ('active', 'disabled') RETURNING *;

-- name: AuthenticateGateway :one
SELECT g.*, cr.id AS credential_id
FROM streaming_gateway_credentials cr JOIN streaming_gateways g ON g.id = cr.gateway_id
WHERE cr.token_digest = sqlc.arg(token_digest) AND cr.state IN ('current', 'retiring')
  AND cr.expires_at > now() AND (cr.retire_after IS NULL OR cr.retire_after > now())
  AND g.lifecycle IN ('active', 'disabled');

-- name: GetGatewayCredentialExpiry :one
SELECT expires_at FROM streaming_gateway_credentials WHERE gateway_id = sqlc.arg(gateway_id) AND state = 'current';

-- name: ListGatewayCredentialExpiries :many
SELECT gateway_id, expires_at FROM streaming_gateway_credentials WHERE state = 'current';

-- name: TouchGatewayCredential :exec
UPDATE streaming_gateway_credentials SET last_used_at = now()
WHERE id = sqlc.arg(id) AND (last_used_at IS NULL OR last_used_at < now() - interval '5 minutes');

-- Cameras ------------------------------------------------------------------------------------------------------

-- name: ActiveBambuAssignmentForMachine :one
SELECT id, adapter_kind FROM printer_connector_assignments
WHERE machine_id = sqlc.arg(machine_id) AND ended_at IS NULL AND adapter_kind IN ('bambu_h2d', 'bambu_x1c');

-- name: ListCameraCandidates :many
SELECT m.id, m.name, mt.name AS kind
FROM machines m JOIN machine_types mt ON mt.id = m.machine_type_id
WHERE EXISTS (SELECT 1 FROM printer_connector_assignments a WHERE a.machine_id = m.id AND a.ended_at IS NULL AND a.adapter_kind IN ('bambu_h2d', 'bambu_x1c'))
  AND NOT EXISTS (SELECT 1 FROM streaming_cameras c WHERE c.machine_id = m.id)
ORDER BY lower(m.name), m.id;

-- name: MachineExists :one
SELECT EXISTS (SELECT 1 FROM machines WHERE id = sqlc.arg(id));

-- name: CreateCamera :one
INSERT INTO streaming_cameras (id, gateway_id, machine_id, enabled)
VALUES (sqlc.arg(id), sqlc.arg(gateway_id), sqlc.arg(machine_id), sqlc.arg(enabled)) RETURNING *;

-- name: GetCameraForUpdate :one
SELECT * FROM streaming_cameras WHERE id = sqlc.arg(id) AND gateway_id = sqlc.arg(gateway_id) FOR UPDATE;

-- name: UpdateCameraEnabled :one
UPDATE streaming_cameras SET enabled = sqlc.arg(enabled), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND gateway_id = sqlc.arg(gateway_id) AND version = sqlc.arg(expected_version) RETURNING *;

-- name: DeleteCamera :execrows
DELETE FROM streaming_cameras WHERE id = sqlc.arg(id) AND gateway_id = sqlc.arg(gateway_id);

-- name: GetCameraView :one
SELECT c.id, c.gateway_id, c.machine_id, m.name AS machine_name, c.enabled, c.version, c.created_at, c.updated_at,
       g.name AS gateway_name, g.lifecycle AS gateway_lifecycle,
       s.health, s.viewers, s.codec, s.width, s.height, s.fps, s.reported_at
FROM streaming_cameras c
JOIN streaming_gateways g ON g.id = c.gateway_id
JOIN machines m ON m.id = c.machine_id
LEFT JOIN streaming_camera_states s ON s.camera_id = c.id
WHERE c.id = sqlc.arg(id);

-- name: ListCameraViews :many
SELECT c.id, c.gateway_id, c.machine_id, m.name AS machine_name, c.enabled, c.version, c.created_at, c.updated_at,
       g.name AS gateway_name, g.lifecycle AS gateway_lifecycle,
       s.health, s.viewers, s.codec, s.width, s.height, s.fps, s.reported_at
FROM streaming_cameras c
JOIN streaming_gateways g ON g.id = c.gateway_id
JOIN machines m ON m.id = c.machine_id
LEFT JOIN streaming_camera_states s ON s.camera_id = c.id
WHERE sqlc.narg(gateway_id)::uuid IS NULL OR c.gateway_id = sqlc.narg(gateway_id)::uuid
ORDER BY lower(m.name), c.id;

-- name: ListGatewayConfigCameras :many
SELECT c.machine_id, m.name AS machine_name, a.id AS assignment_id, a.adapter_kind, a.settings, a.encrypted_secrets
FROM streaming_cameras c
JOIN machines m ON m.id = c.machine_id
JOIN printer_connector_assignments a ON a.machine_id = c.machine_id AND a.ended_at IS NULL AND a.adapter_kind IN ('bambu_h2d', 'bambu_x1c')
WHERE c.gateway_id = sqlc.arg(gateway_id) AND c.enabled
ORDER BY lower(m.name), c.machine_id;

-- name: ListGatewayCameraMachines :many
SELECT id, machine_id FROM streaming_cameras WHERE gateway_id = sqlc.arg(gateway_id);

-- name: UpsertCameraState :exec
INSERT INTO streaming_camera_states (camera_id, health, viewers, codec, width, height, fps, reported_at)
VALUES (sqlc.arg(camera_id), sqlc.arg(health), sqlc.arg(viewers), sqlc.narg(codec), sqlc.narg(width), sqlc.narg(height), sqlc.narg(fps), now())
ON CONFLICT (camera_id) DO UPDATE SET health = EXCLUDED.health, viewers = EXCLUDED.viewers, codec = EXCLUDED.codec,
    width = EXCLUDED.width, height = EXCLUDED.height, fps = EXCLUDED.fps, reported_at = EXCLUDED.reported_at;

-- name: DeleteCameraStatesOfGateway :exec
DELETE FROM streaming_camera_states WHERE camera_id IN (SELECT id FROM streaming_cameras WHERE gateway_id = sqlc.arg(gateway_id));

-- name: ListStreamCamerasForMachines :many
SELECT c.machine_id, m.name AS machine_name, g.public_host
FROM streaming_cameras c
JOIN streaming_gateways g ON g.id = c.gateway_id
JOIN machines m ON m.id = c.machine_id
WHERE c.machine_id = ANY(sqlc.arg(machine_ids)::text[]::uuid[]) AND c.enabled AND g.lifecycle = 'active'
ORDER BY lower(m.name), c.machine_id;

-- name: ListEnabledActiveCameraMachineIDs :many
SELECT c.machine_id FROM streaming_cameras c JOIN streaming_gateways g ON g.id = c.gateway_id
WHERE c.enabled AND g.lifecycle = 'active';

-- Ticket keys --------------------------------------------------------------------------------------------------

-- name: GetActiveTicketKey :one
SELECT * FROM signage_ticket_keys WHERE state = 'active';

-- name: GetPendingTicketKey :one
SELECT * FROM signage_ticket_keys WHERE state = 'pending';

-- name: LockTicketKeys :many
SELECT id FROM signage_ticket_keys WHERE state IN ('active', 'pending') ORDER BY id FOR UPDATE;

-- name: InsertTicketKey :execrows
INSERT INTO signage_ticket_keys (id, kid, public_key, encrypted_private_key, state, activates_at)
VALUES (sqlc.arg(id), sqlc.arg(kid), sqlc.arg(public_key), sqlc.arg(encrypted_private_key), sqlc.arg(state), sqlc.narg(activates_at))
ON CONFLICT DO NOTHING;

-- name: RetireActiveTicketKey :exec
UPDATE signage_ticket_keys SET state = 'retired', retired_at = sqlc.arg(retired_at) WHERE state = 'active';

-- name: ActivatePendingTicketKey :exec
UPDATE signage_ticket_keys SET state = 'active' WHERE state = 'pending';

-- name: ListValidTicketKeys :many
SELECT kid, public_key, state, retired_at FROM signage_ticket_keys
WHERE state IN ('pending', 'active') OR retired_at > sqlc.arg(retired_after)
ORDER BY created_at DESC, id DESC;

-- name: GetSessionEpoch :one
SELECT epoch FROM streaming_session_epoch WHERE singleton;

-- name: ListRevokedDisplayIDs :many
SELECT display_id FROM signage_revoked_displays WHERE revoked_at > sqlc.arg(revoked_after) ORDER BY display_id;

-- name: DeleteExpiredTicketKeys :exec
DELETE FROM signage_ticket_keys WHERE retired_at IS NOT NULL AND retired_at < sqlc.arg(older_than);
