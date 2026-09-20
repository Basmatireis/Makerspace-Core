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
SELECT a.id, a.person_id, a.status, a.provisioning_source, a.first_authenticated_at,
       a.version, a.created_at, a.updated_at,
       i.id AS auth_identity_id, i.identifier_display AS login_email,
       CASE WHEN prt.id IS NOT NULL OR pc.reset_required THEN 'reset_required'
            WHEN pc.auth_identity_id IS NULL THEN 'not_set' ELSE 'active' END AS password_status
FROM accounts a
LEFT JOIN auth_identities i ON i.account_id = a.id AND i.kind = 'password'
LEFT JOIN password_credentials pc ON pc.auth_identity_id = i.id
LEFT JOIN password_reset_tokens prt ON prt.account_id = a.id AND prt.expires_at > now()
WHERE a.id = sqlc.arg(id);

-- name: GetPersonVersionForAccountCreation :one
SELECT version FROM people WHERE id = sqlc.arg(person_id) FOR UPDATE;

-- name: UpdateAccountStatus :one
UPDATE accounts SET status = sqlc.arg(status),
    administratively_disabled_at = CASE WHEN sqlc.arg(status)::text = 'disabled' THEN now() ELSE NULL END,
    version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) RETURNING *;

-- name: BumpAccountVersion :one
UPDATE accounts SET version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) RETURNING *;

-- name: DeleteAccount :one
DELETE FROM accounts WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) RETURNING id;

-- name: CreateAuthIdentity :one
INSERT INTO auth_identities (id, account_id, kind, identifier_display, identifier_normalized)
VALUES (sqlc.arg(id), sqlc.arg(account_id), 'password', sqlc.arg(identifier_display)::text, sqlc.arg(identifier_normalized)::text)
RETURNING *;

-- name: UpdateLoginEmail :one
UPDATE auth_identities SET identifier_display = sqlc.arg(identifier_display)::text,
    identifier_normalized = sqlc.arg(identifier_normalized)::text,
    verified_at = CASE WHEN identifier_normalized = sqlc.arg(identifier_normalized)::text THEN verified_at ELSE NULL END,
    updated_at = now()
WHERE account_id = sqlc.arg(account_id) AND kind = 'password' RETURNING *;

-- name: GetIdentityByAccount :one
SELECT * FROM auth_identities WHERE account_id = sqlc.arg(account_id) AND kind = 'password';

-- name: ListAuthIdentitiesByAccount :many
SELECT i.*, COALESCE(i.identifier_display, p.display_name) AS display_identifier, p.slug AS provider_slug
FROM auth_identities i
LEFT JOIN oidc_providers p ON p.id = i.provider_id
WHERE i.account_id = sqlc.arg(account_id)
ORDER BY i.kind, i.created_at, i.id;

-- name: CountUsableAuthIdentities :one
SELECT count(*) FROM auth_identities i
WHERE i.account_id = sqlc.arg(account_id) AND i.disabled_at IS NULL
  AND (
    (i.kind = 'password' AND i.verified_at IS NOT NULL AND EXISTS (
      SELECT 1 FROM password_credentials pc WHERE pc.auth_identity_id = i.id AND NOT pc.reset_required
    ))
    OR (i.kind = 'pin' AND EXISTS (SELECT 1 FROM pin_credentials pc WHERE pc.auth_identity_id=i.id))
    OR (i.kind = 'oidc' AND EXISTS (SELECT 1 FROM oidc_providers op WHERE op.id=i.provider_id AND op.enabled))
  );

-- name: UpsertPasswordCredential :exec
INSERT INTO password_credentials (auth_identity_id, password_hash, reset_required, changed_at)
VALUES (sqlc.arg(auth_identity_id), sqlc.arg(password_hash), false, now())
ON CONFLICT (auth_identity_id) DO UPDATE
SET password_hash = EXCLUDED.password_hash, reset_required = false, changed_at = now();

-- name: VerifyPasswordIdentity :exec
UPDATE auth_identities
SET verified_at = COALESCE(verified_at, now()), disabled_at = NULL, updated_at = now()
WHERE id = sqlc.arg(id) AND kind = 'password';

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
SELECT g.id, g.permission_id, g.scope, g.minimum_assurance, gdt.device_type_id
FROM role_permission_grants g LEFT JOIN role_permission_grant_device_types gdt ON gdt.grant_id = g.id
WHERE g.role_id = sqlc.arg(role_id)
ORDER BY g.permission_id, g.id, gdt.device_type_id;

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
JOIN auth_identities i ON i.account_id = a.id AND i.kind = 'password'
WHERE i.identifier_normalized = sqlc.arg(identifier_normalized)::text;

-- name: FindAccountsByAdministrativeIdentifier :many
SELECT DISTINCT a.id
FROM accounts a
JOIN people p ON p.id = a.person_id
LEFT JOIN auth_identities i ON i.account_id = a.id AND i.kind IN ('password', 'pin')
WHERE lower(btrim(COALESCE(i.identifier_normalized, ''))) = lower(btrim(sqlc.arg(identifier)::text))
   OR lower(btrim(COALESCE(i.identifier_display, ''))) = lower(btrim(sqlc.arg(identifier)::text))
   OR lower(btrim(COALESCE(p.email, ''))) = lower(btrim(sqlc.arg(identifier)::text))
ORDER BY a.id;

-- name: GetPasswordIdentityForAccountForUpdate :one
SELECT * FROM auth_identities
WHERE account_id = sqlc.arg(account_id) AND kind = 'password'
FOR UPDATE;

-- name: GetPersonEmailForAccount :one
SELECT p.email FROM people p JOIN accounts a ON a.person_id = p.id
WHERE a.id = sqlc.arg(account_id);

-- name: CreateVerifiedPasswordIdentity :one
INSERT INTO auth_identities (id, account_id, kind, identifier_display, identifier_normalized, verified_at)
VALUES (sqlc.arg(id), sqlc.arg(account_id), 'password', sqlc.arg(identifier_display), sqlc.arg(identifier_normalized), now())
RETURNING *;

-- name: RestorePasswordIdentity :exec
UPDATE auth_identities
SET disabled_at = NULL, verified_at = COALESCE(verified_at, now()), updated_at = now()
WHERE id = sqlc.arg(id) AND kind = 'password';

-- name: DeletePasswordChallengesForAccount :exec
DELETE FROM auth_challenges
WHERE account_id = sqlc.arg(account_id)
  AND kind IN ('invitation', 'email_verification', 'password_reset');

-- name: BumpAccountVersionForAdministrativeReset :exec
UPDATE accounts SET version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id);

-- name: RecoverAccount :one
UPDATE accounts SET status = 'enabled', version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) RETURNING *;

-- name: IsAccountMaster :one
SELECT EXISTS (SELECT 1 FROM account_roles ar JOIN roles r ON r.id = ar.role_id
WHERE ar.account_id = sqlc.arg(account_id) AND r.system_key = 'master');

-- name: UpsertAuthChallenge :one
INSERT INTO auth_challenges (
    id, kind, account_id, auth_identity_id, code_digest, delivery_address,
    created_by_account_id, expires_at
) VALUES (
    sqlc.arg(id), sqlc.arg(kind), sqlc.arg(account_id), sqlc.narg(auth_identity_id),
    sqlc.arg(code_digest), sqlc.arg(delivery_address), sqlc.narg(created_by_account_id), sqlc.arg(expires_at)
)
ON CONFLICT (account_id, kind) DO UPDATE SET
    id = EXCLUDED.id, auth_identity_id = EXCLUDED.auth_identity_id,
    code_digest = EXCLUDED.code_digest, delivery_address = EXCLUDED.delivery_address,
    attempt_count = 0, created_by_account_id = EXCLUDED.created_by_account_id,
    expires_at = EXCLUDED.expires_at, used_at = NULL, cancelled_at = NULL,
    delivery_status = 'pending', delivery_attempted_at = NULL,
    delivery_failure_code = NULL, created_at = now()
RETURNING *;

-- name: SetAuthChallengeDelivery :exec
UPDATE auth_challenges
SET delivery_status = sqlc.arg(delivery_status), delivery_attempted_at = now(), delivery_failure_code = sqlc.narg(delivery_failure_code)
WHERE id = sqlc.arg(id) AND delivery_status = 'pending';

-- name: MarkInvitationProvisioning :exec
UPDATE accounts SET provisioning_source = 'invitation'
WHERE id = sqlc.arg(id) AND first_authenticated_at IS NULL AND provisioning_source = 'local';
