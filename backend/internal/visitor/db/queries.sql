-- name: GetConfiguration :one
SELECT * FROM visitor_enrollment_configuration WHERE singleton=true;

-- name: GetConfigurationForUpdate :one
SELECT * FROM visitor_enrollment_configuration WHERE singleton=true FOR UPDATE;

-- name: UpdateConfiguration :one
UPDATE visitor_enrollment_configuration
SET enabled=sqlc.arg(enabled), version=version+1,
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

-- name: GetVisitorRole :one
-- Every new person holds the Visitor membership role (assigned by a trigger on people).
SELECT * FROM roles WHERE system_key='visitor';

-- name: GetRolePermissionGrants :many
SELECT g.id, g.permission_id, g.scope, g.minimum_assurance, g.reauth_within_minutes, gdt.device_type_id
FROM role_permission_grants g
LEFT JOIN role_permission_grant_device_types gdt ON gdt.grant_id=g.id
WHERE g.role_id=sqlc.arg(role_id)
ORDER BY g.id, gdt.device_type_id;

-- name: IsDeviceTypeAllowed :one
SELECT c.enabled
       AND md.revoked_at IS NULL AND (md.expires_at IS NULL OR md.expires_at > now())
       AND EXISTS (SELECT 1 FROM visitor_enrollment_device_types t WHERE t.device_type_id=md.device_type_id)
FROM visitor_enrollment_configuration c
JOIN managed_devices md ON md.id=sqlc.arg(managed_device_id)
WHERE c.singleton=true;

-- name: CreateEnrollmentContext :one
INSERT INTO visitor_enrollment_contexts (id, managed_device_id, token_digest, csrf_digest, expires_at, lab_rules_version_id)
VALUES (sqlc.arg(id), sqlc.arg(managed_device_id), sqlc.arg(token_digest), sqlc.arg(csrf_digest), sqlc.arg(expires_at),
    (SELECT id FROM laborordnung_versions WHERE status='published' AND effective_at <= now() ORDER BY effective_at DESC, id DESC LIMIT 1))
RETURNING *;

-- name: GetEnrollmentContext :one
SELECT ec.* FROM visitor_enrollment_contexts ec
JOIN managed_devices md ON md.id=ec.managed_device_id
JOIN visitor_enrollment_configuration c ON c.singleton=true
WHERE ec.token_digest=sqlc.arg(token_digest) AND ec.used_at IS NULL AND ec.expires_at > now()
  AND c.enabled
  AND md.revoked_at IS NULL AND (md.expires_at IS NULL OR md.expires_at > now())
  AND EXISTS (SELECT 1 FROM visitor_enrollment_device_types t WHERE t.device_type_id=md.device_type_id);

-- name: GetEnrollmentContextForUpdate :one
SELECT ec.* FROM visitor_enrollment_contexts ec
JOIN managed_devices md ON md.id=ec.managed_device_id
JOIN visitor_enrollment_configuration c ON c.singleton=true
WHERE ec.id=sqlc.arg(id) AND ec.used_at IS NULL AND ec.expires_at > now()
  AND c.enabled
  AND md.revoked_at IS NULL AND (md.expires_at IS NULL OR md.expires_at > now())
  AND EXISTS (SELECT 1 FROM visitor_enrollment_device_types t WHERE t.device_type_id=md.device_type_id)
FOR UPDATE OF ec;

-- name: ConsumeEnrollmentContext :execrows
-- The verified address now lives on the account; the used context keeps no copy of it.
UPDATE visitor_enrollment_contexts
SET used_at=now(), email_display=NULL, email_normalized=NULL, email_code_digest=NULL, email_code_expires_at=NULL,
    email_verified_at=NULL
WHERE id=sqlc.arg(id) AND used_at IS NULL;

-- name: GetPinnedLabRulesVersion :one
SELECT v.* FROM laborordnung_versions v
JOIN visitor_enrollment_contexts ec ON ec.lab_rules_version_id=v.id
WHERE ec.id=sqlc.arg(context_id);

-- name: CreateVisitorPerson :one
INSERT INTO people (id, first_name, last_name, email, profile_image_file_id, profile_image_source, member_since)
VALUES (sqlc.arg(id), sqlc.arg(first_name), sqlc.arg(last_name), sqlc.narg(email), sqlc.narg(profile_image_file_id), CASE WHEN sqlc.narg(profile_image_file_id)::uuid IS NULL THEN NULL ELSE 'terminal_capture' END, sqlc.arg(member_since))
RETURNING *;

-- name: CreateVisitorAccount :one
INSERT INTO accounts (id, person_id, status, provisioning_source)
VALUES (sqlc.arg(id), sqlc.arg(person_id), sqlc.arg(status), 'visitor')
RETURNING *;

-- name: DeleteExpiredEnrollmentContexts :execrows
DELETE FROM visitor_enrollment_contexts WHERE expires_at < sqlc.arg(before_time);

-- name: LoginEmailTaken :one
SELECT EXISTS (
    SELECT 1 FROM auth_identities WHERE kind = 'password' AND identifier_normalized = sqlc.arg(identifier_normalized)::text
)::boolean AS taken;

-- name: SetEnrollmentEmailCode :exec
-- A new code replaces the previous one and its address, and clears an earlier verification.
UPDATE visitor_enrollment_contexts
SET email_display=sqlc.arg(email_display), email_normalized=sqlc.arg(email_normalized),
    email_code_digest=sqlc.arg(email_code_digest), email_code_expires_at=sqlc.arg(email_code_expires_at),
    email_code_attempts=0, email_codes_sent=email_codes_sent+1, email_verified_at=NULL
WHERE id=sqlc.arg(id);

-- name: ClearEnrollmentEmailCode :exec
-- Withdraws a code whose mail could not be delivered, unless a newer code replaced it meanwhile.
UPDATE visitor_enrollment_contexts SET email_code_digest=NULL, email_code_expires_at=NULL
WHERE id=sqlc.arg(id) AND email_code_digest=sqlc.arg(email_code_digest);

-- name: RecordEnrollmentEmailCodeFailure :exec
UPDATE visitor_enrollment_contexts SET email_code_attempts=LEAST(email_code_attempts+1, 5) WHERE id=sqlc.arg(id);

-- name: VerifyEnrollmentEmail :exec
UPDATE visitor_enrollment_contexts
SET email_verified_at=now(), email_code_digest=NULL, email_code_expires_at=NULL
WHERE id=sqlc.arg(id);

-- name: EnableVisitorEmailCode :execrows
UPDATE auth_identities SET email_code_enabled=true, updated_at=now()
WHERE account_id=sqlc.arg(account_id) AND kind='password';
