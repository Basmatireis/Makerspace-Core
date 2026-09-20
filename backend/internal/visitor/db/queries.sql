-- name: GetConfiguration :one
SELECT * FROM visitor_enrollment_configuration WHERE singleton=true;

-- name: GetConfigurationForUpdate :one
SELECT * FROM visitor_enrollment_configuration WHERE singleton=true FOR UPDATE;

-- name: UpdateConfiguration :one
UPDATE visitor_enrollment_configuration
SET enabled=sqlc.arg(enabled), initial_role_id=sqlc.narg(initial_role_id),
    allowed_methods=sqlc.arg(allowed_methods), version=version+1,
    updated_by_account_id=sqlc.arg(updated_by_account_id), updated_at=now()
WHERE singleton=true AND version=sqlc.arg(expected_version)
RETURNING *;

-- name: ListAllowedDeviceTypes :many
SELECT device_type_id FROM visitor_enrollment_device_types ORDER BY device_type_id;

-- name: ClearAllowedDeviceTypes :exec
DELETE FROM visitor_enrollment_device_types;

-- name: AddAllowedDeviceType :exec
INSERT INTO visitor_enrollment_device_types (device_type_id) VALUES (sqlc.arg(device_type_id));

-- name: DeviceTypeExists :one
SELECT EXISTS (SELECT 1 FROM device_types WHERE id=sqlc.arg(id));

-- name: GetAssignableRole :one
SELECT * FROM roles WHERE id=sqlc.arg(id);

-- name: GetRolePermissionGrants :many
SELECT g.id, g.permission_id, g.scope, g.minimum_assurance, gdt.device_type_id
FROM role_permission_grants g
LEFT JOIN role_permission_grant_device_types gdt ON gdt.grant_id=g.id
WHERE g.role_id=sqlc.arg(role_id)
ORDER BY g.id, gdt.device_type_id;

-- name: IsDeviceTypeAllowed :one
SELECT c.enabled AND c.initial_role_id IS NOT NULL
       AND md.revoked_at IS NULL AND (md.expires_at IS NULL OR md.expires_at > now())
       AND EXISTS (SELECT 1 FROM visitor_enrollment_device_types t WHERE t.device_type_id=md.device_type_id)
FROM visitor_enrollment_configuration c
JOIN managed_devices md ON md.id=sqlc.arg(managed_device_id)
WHERE c.singleton=true;

-- name: CreateEnrollmentContext :one
INSERT INTO visitor_enrollment_contexts (id, managed_device_id, token_digest, csrf_digest, expires_at)
VALUES (sqlc.arg(id), sqlc.arg(managed_device_id), sqlc.arg(token_digest), sqlc.arg(csrf_digest), sqlc.arg(expires_at))
RETURNING *;

-- name: GetEnrollmentContext :one
SELECT ec.* FROM visitor_enrollment_contexts ec
JOIN managed_devices md ON md.id=ec.managed_device_id
JOIN visitor_enrollment_configuration c ON c.singleton=true
WHERE ec.token_digest=sqlc.arg(token_digest) AND ec.used_at IS NULL AND ec.expires_at > now()
  AND c.enabled AND c.initial_role_id IS NOT NULL
  AND md.revoked_at IS NULL AND (md.expires_at IS NULL OR md.expires_at > now())
  AND EXISTS (SELECT 1 FROM visitor_enrollment_device_types t WHERE t.device_type_id=md.device_type_id);

-- name: GetEnrollmentContextForUpdate :one
SELECT ec.* FROM visitor_enrollment_contexts ec
JOIN managed_devices md ON md.id=ec.managed_device_id
JOIN visitor_enrollment_configuration c ON c.singleton=true
WHERE ec.id=sqlc.arg(id) AND ec.used_at IS NULL AND ec.expires_at > now()
  AND c.enabled AND c.initial_role_id IS NOT NULL
  AND md.revoked_at IS NULL AND (md.expires_at IS NULL OR md.expires_at > now())
  AND EXISTS (SELECT 1 FROM visitor_enrollment_device_types t WHERE t.device_type_id=md.device_type_id)
FOR UPDATE OF ec;

-- name: ConsumeEnrollmentContext :execrows
UPDATE visitor_enrollment_contexts SET used_at=now() WHERE id=sqlc.arg(id) AND used_at IS NULL;

-- name: GetCurrentLabRulesVersion :one
SELECT * FROM laborordnung_versions
WHERE status='published' AND effective_at <= now()
ORDER BY effective_at DESC, id DESC LIMIT 1;

-- name: CreateVisitorPerson :one
INSERT INTO people (id, first_name, last_name, email, phone, profile_image_file_id, profile_image_source)
VALUES (sqlc.arg(id), sqlc.arg(first_name), sqlc.arg(last_name), sqlc.narg(email), sqlc.narg(phone), sqlc.arg(profile_image_file_id), 'terminal_capture')
RETURNING *;

-- name: CreateVisitorAccount :one
INSERT INTO accounts (id, person_id, status, provisioning_source)
VALUES (sqlc.arg(id), sqlc.arg(person_id), sqlc.arg(status), 'visitor')
RETURNING *;

-- name: CreateVisitorPasswordIdentity :one
INSERT INTO auth_identities (id, account_id, kind, identifier_display, identifier_normalized)
VALUES (sqlc.arg(id), sqlc.arg(account_id), 'password', sqlc.arg(identifier_display), sqlc.arg(identifier_normalized))
RETURNING *;

-- name: CreateVisitorPINIdentity :one
INSERT INTO auth_identities (id, account_id, kind, identifier_display, identifier_normalized, verified_at)
VALUES (sqlc.arg(id), sqlc.arg(account_id), 'pin', sqlc.arg(identifier_display), sqlc.arg(identifier_normalized), now())
RETURNING *;

-- name: CreateVisitorPINCredential :exec
INSERT INTO pin_credentials (auth_identity_id, pin_hash) VALUES (sqlc.arg(auth_identity_id), sqlc.arg(pin_hash));

-- name: AssignVisitorRole :exec
INSERT INTO account_roles (account_id, role_id) VALUES (sqlc.arg(account_id), sqlc.arg(role_id));

-- name: CreateVisitorInvitation :one
INSERT INTO auth_challenges (id, kind, account_id, auth_identity_id, code_digest, delivery_address, expires_at)
VALUES (sqlc.arg(id), 'invitation', sqlc.arg(account_id), sqlc.arg(auth_identity_id), sqlc.arg(code_digest), sqlc.arg(delivery_address), sqlc.arg(expires_at))
RETURNING *;

-- name: SetChallengeDelivery :exec
UPDATE auth_challenges SET delivery_status=sqlc.arg(delivery_status), delivery_attempted_at=now(), delivery_failure_code=sqlc.narg(delivery_failure_code)
WHERE id=sqlc.arg(id);

-- name: CreateLabRulesRequest :one
INSERT INTO laborordnung_requests (id, person_id, required_version_id)
VALUES (sqlc.arg(id), sqlc.arg(person_id), sqlc.arg(required_version_id))
RETURNING *;
