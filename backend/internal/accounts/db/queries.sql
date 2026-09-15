-- name: CreateAccount :one
INSERT INTO accounts (id, person_id, status)
VALUES (sqlc.arg(id), sqlc.arg(person_id), sqlc.arg(status)) RETURNING *;

-- name: GetAccountForMutation :one
SELECT * FROM accounts WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: GetAccountByPerson :one
SELECT * FROM accounts WHERE person_id = sqlc.arg(person_id);

-- name: GetAccountByPersonForMutation :one
SELECT * FROM accounts WHERE person_id = sqlc.arg(person_id) FOR UPDATE;

-- name: GetAccountView :one
SELECT a.id, a.person_id, a.status, a.version, a.created_at, a.updated_at,
       i.id AS auth_identity_id, i.identifier_display AS login_email,
       CASE WHEN prt.id IS NOT NULL OR pc.reset_required THEN 'reset_required'
            WHEN pc.auth_identity_id IS NULL THEN 'not_set' ELSE 'active' END AS password_status
FROM accounts a
JOIN auth_identities i ON i.account_id = a.id AND i.kind = 'email_password'
LEFT JOIN password_credentials pc ON pc.auth_identity_id = i.id
LEFT JOIN password_reset_tokens prt ON prt.account_id = a.id AND prt.expires_at > now()
WHERE a.id = sqlc.arg(id);

-- name: GetPersonVersionForAccountCreation :one
SELECT version FROM people WHERE id = sqlc.arg(person_id) FOR UPDATE;

-- name: UpdateAccountStatus :one
UPDATE accounts SET status = sqlc.arg(status), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) RETURNING *;

-- name: BumpAccountVersion :one
UPDATE accounts SET version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) RETURNING *;

-- name: DeleteAccount :one
DELETE FROM accounts WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) RETURNING id;

-- name: CreateAuthIdentity :one
INSERT INTO auth_identities (id, account_id, kind, identifier_display, identifier_normalized)
VALUES (sqlc.arg(id), sqlc.arg(account_id), 'email_password', sqlc.arg(identifier_display), sqlc.arg(identifier_normalized))
RETURNING *;

-- name: UpdateLoginEmail :one
UPDATE auth_identities SET identifier_display = sqlc.arg(identifier_display),
    identifier_normalized = sqlc.arg(identifier_normalized), updated_at = now()
WHERE account_id = sqlc.arg(account_id) AND kind = 'email_password' RETURNING *;

-- name: GetIdentityByAccount :one
SELECT * FROM auth_identities WHERE account_id = sqlc.arg(account_id) AND kind = 'email_password';

-- name: UpsertPasswordCredential :exec
INSERT INTO password_credentials (auth_identity_id, password_hash, reset_required, changed_at)
VALUES (sqlc.arg(auth_identity_id), sqlc.arg(password_hash), false, now())
ON CONFLICT (auth_identity_id) DO UPDATE
SET password_hash = EXCLUDED.password_hash, reset_required = false, changed_at = now();

-- name: MarkPasswordResetRequired :exec
UPDATE password_credentials SET reset_required = true, changed_at = now()
WHERE auth_identity_id = sqlc.arg(auth_identity_id);

-- name: AssignAccountRole :execrows
INSERT INTO account_roles (account_id, role_id, assigned_by_account_id)
VALUES (sqlc.arg(account_id), sqlc.arg(role_id), sqlc.narg(assigned_by_account_id))
ON CONFLICT (account_id, role_id) DO NOTHING;

-- name: RemoveAccountRole :execrows
DELETE FROM account_roles WHERE account_id = sqlc.arg(account_id) AND role_id = sqlc.arg(role_id);

-- name: ListAccountRoles :many
SELECT r.* FROM roles r JOIN account_roles ar ON ar.role_id = r.id
WHERE ar.account_id = sqlc.arg(account_id)
ORDER BY r.system_key DESC NULLS LAST, lower(r.name), r.id;

-- name: GetRoleForAssignment :one
SELECT * FROM roles WHERE id = sqlc.arg(id) FOR SHARE;

-- name: GetRolePermissionGrantsForAssignment :many
SELECT rp.permission_id, rp.scope, rpdt.device_type_id
FROM role_permissions rp LEFT JOIN role_permission_device_types rpdt
  ON rpdt.role_id = rp.role_id AND rpdt.permission_id = rp.permission_id
WHERE rp.role_id = sqlc.arg(role_id)
ORDER BY rp.permission_id, rpdt.device_type_id;

-- name: IsAccountRoleAssigned :one
SELECT EXISTS (SELECT 1 FROM account_roles WHERE account_id = sqlc.arg(account_id) AND role_id = sqlc.arg(role_id));

-- name: RevokeSessionsForAccount :exec
UPDATE sessions
SET revoked_at = COALESCE(revoked_at, now()), revocation_reason = COALESCE(revocation_reason, sqlc.arg(reason))
WHERE account_id = sqlc.arg(account_id) AND revoked_at IS NULL;

-- name: DeletePasswordResetForAccount :exec
DELETE FROM password_reset_tokens WHERE account_id = sqlc.arg(account_id);

-- name: CreatePasswordResetToken :one
INSERT INTO password_reset_tokens (id, account_id, token_digest, created_by_account_id, expires_at)
VALUES (sqlc.arg(id), sqlc.arg(account_id), sqlc.arg(token_digest), sqlc.arg(created_by_account_id), sqlc.arg(expires_at))
ON CONFLICT (account_id) DO UPDATE SET id = EXCLUDED.id, token_digest = EXCLUDED.token_digest,
    created_by_account_id = EXCLUDED.created_by_account_id, created_at = now(), expires_at = EXCLUDED.expires_at
RETURNING *;

-- name: LockMasterRole :one
SELECT id FROM roles WHERE system_key = 'master' FOR UPDATE;

-- name: AcquireMasterInvariantLock :exec
SELECT pg_advisory_xact_lock(5577006791947779410);

-- name: CountEnabledMasters :one
SELECT count(*) FROM accounts a
JOIN account_roles ar ON ar.account_id = a.id JOIN roles r ON r.id = ar.role_id
WHERE a.status = 'enabled' AND r.system_key = 'master';

-- name: CountMasterAssignments :one
SELECT count(*) FROM account_roles ar JOIN roles r ON r.id = ar.role_id WHERE r.system_key = 'master';

-- name: GetMasterRole :one
SELECT * FROM roles WHERE system_key = 'master';

-- name: GetAccountIdentityByLoginEmail :one
SELECT a.*, i.id AS auth_identity_id FROM accounts a
JOIN auth_identities i ON i.account_id = a.id AND i.kind = 'email_password'
WHERE i.identifier_normalized = sqlc.arg(identifier_normalized);

-- name: RecoverAccount :one
UPDATE accounts SET status = 'enabled', version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) RETURNING *;

-- name: IsAccountMaster :one
SELECT EXISTS (SELECT 1 FROM account_roles ar JOIN roles r ON r.id = ar.role_id
WHERE ar.account_id = sqlc.arg(account_id) AND r.system_key = 'master');
