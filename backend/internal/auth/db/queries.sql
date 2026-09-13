-- name: FindLoginAccountByEmail :one
SELECT account_id
FROM auth_identities
WHERE kind = 'email_password' AND identifier_normalized = sqlc.arg(identifier_normalized);

-- name: GetAccountForAuthentication :one
SELECT id, status
FROM accounts
WHERE id = sqlc.arg(id)
FOR UPDATE;

-- name: GetLoginByEmail :one
SELECT a.id AS account_id, a.person_id, a.status, a.version AS account_version,
       i.id AS auth_identity_id, i.identifier_display AS login_email,
       pc.password_hash, pc.reset_required, p.first_name, p.last_name
FROM auth_identities i JOIN accounts a ON a.id = i.account_id
JOIN people p ON p.id = a.person_id JOIN password_credentials pc ON pc.auth_identity_id = i.id
WHERE i.kind = 'email_password' AND i.identifier_normalized = sqlc.arg(identifier_normalized);

-- name: CreateSession :one
INSERT INTO sessions (id, account_id, auth_identity_id, token_digest, csrf_digest, auth_method, idle_expires_at, absolute_expires_at)
VALUES (sqlc.arg(id), sqlc.arg(account_id), sqlc.arg(auth_identity_id), sqlc.arg(token_digest), sqlc.arg(csrf_digest), 'password', sqlc.arg(idle_expires_at), sqlc.arg(absolute_expires_at))
RETURNING *;

-- name: GetSessionPrincipal :one
SELECT s.id AS session_id, s.account_id, s.auth_identity_id, s.csrf_digest,
       s.idle_expires_at, s.absolute_expires_at, s.last_seen_at,
       a.person_id, p.first_name, p.last_name, i.identifier_display AS login_email
FROM sessions s JOIN accounts a ON a.id = s.account_id JOIN people p ON p.id = a.person_id
JOIN auth_identities i ON i.id = s.auth_identity_id
WHERE s.token_digest = sqlc.arg(token_digest) AND s.revoked_at IS NULL
  AND s.idle_expires_at > now() AND s.absolute_expires_at > now() AND a.status = 'enabled';

-- name: TouchSession :exec
UPDATE sessions SET last_seen_at = now(), idle_expires_at = LEAST(sqlc.arg(idle_expires_at), absolute_expires_at)
WHERE id = sqlc.arg(id) AND last_seen_at < now() - interval '5 minutes' AND revoked_at IS NULL;

-- name: RevokeSession :exec
UPDATE sessions SET revoked_at = COALESCE(revoked_at, now()), revocation_reason = COALESCE(revocation_reason, sqlc.arg(reason))
WHERE id = sqlc.arg(id);

-- name: RevokeSessionsForAccount :exec
UPDATE sessions SET revoked_at = COALESCE(revoked_at, now()), revocation_reason = COALESCE(revocation_reason, sqlc.arg(reason))
WHERE account_id = sqlc.arg(account_id) AND revoked_at IS NULL;

-- name: DeleteExpiredSessions :execrows
DELETE FROM sessions WHERE absolute_expires_at < sqlc.arg(before_time)
   OR idle_expires_at < sqlc.arg(before_time)
   OR (revoked_at IS NOT NULL AND revoked_at < sqlc.arg(before_time));

-- name: GetPasswordCredentialForAccount :one
SELECT pc.* FROM password_credentials pc JOIN auth_identities i ON i.id = pc.auth_identity_id
WHERE i.account_id = sqlc.arg(account_id) AND i.kind = 'email_password';

-- name: UpsertPasswordCredential :exec
INSERT INTO password_credentials (auth_identity_id, password_hash, reset_required, changed_at)
VALUES (sqlc.arg(auth_identity_id), sqlc.arg(password_hash), false, now())
ON CONFLICT (auth_identity_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, reset_required = false, changed_at = now();

-- name: CreatePasswordResetToken :one
INSERT INTO password_reset_tokens (id, account_id, token_digest, created_by_account_id, expires_at)
VALUES (sqlc.arg(id), sqlc.arg(account_id), sqlc.arg(token_digest), sqlc.narg(created_by_account_id), sqlc.arg(expires_at))
ON CONFLICT (account_id) DO UPDATE SET id = EXCLUDED.id, token_digest = EXCLUDED.token_digest,
    created_by_account_id = EXCLUDED.created_by_account_id, created_at = now(), expires_at = EXCLUDED.expires_at
RETURNING *;

-- name: GetPasswordResetByDigest :one
SELECT prt.*, i.id AS auth_identity_id
FROM password_reset_tokens prt JOIN auth_identities i ON i.account_id = prt.account_id AND i.kind = 'email_password'
WHERE prt.token_digest = sqlc.arg(token_digest) AND prt.expires_at > now()
FOR UPDATE OF prt;

-- name: FindPasswordResetAccountByDigest :one
SELECT account_id
FROM password_reset_tokens
WHERE token_digest = sqlc.arg(token_digest) AND expires_at > now();

-- name: DeletePasswordResetToken :exec
DELETE FROM password_reset_tokens WHERE id = sqlc.arg(id);

-- name: BumpAccountVersionAfterCredentialChange :exec
UPDATE accounts
SET version = version + 1, updated_at = now()
WHERE id = sqlc.arg(account_id);

-- name: DeleteExpiredPasswordResetTokens :execrows
DELETE FROM password_reset_tokens WHERE expires_at < sqlc.arg(before_time);
