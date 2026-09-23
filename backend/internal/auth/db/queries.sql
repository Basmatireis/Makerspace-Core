-- name: FindLoginAccountByEmail :one
SELECT account_id
FROM auth_identities
WHERE kind = 'password' AND disabled_at IS NULL AND identifier_normalized = sqlc.arg(identifier_normalized)::text;

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
WHERE i.kind = 'password' AND i.disabled_at IS NULL AND i.identifier_normalized = sqlc.arg(identifier_normalized)::text;

-- name: OIDCIdentityUsable :one
SELECT EXISTS (
    SELECT 1 FROM auth_identities
    WHERE id = sqlc.arg(id) AND account_id = sqlc.arg(account_id)
      AND kind = 'oidc' AND disabled_at IS NULL
);

-- name: CreateSession :one
INSERT INTO sessions (id, account_id, auth_identity_id, token_digest, csrf_digest, auth_method, authenticated_at, idle_expires_at, absolute_expires_at)
VALUES (sqlc.arg(id), sqlc.arg(account_id), sqlc.arg(auth_identity_id), sqlc.arg(token_digest), sqlc.arg(csrf_digest), 'password', now(), sqlc.arg(idle_expires_at), sqlc.arg(absolute_expires_at))
RETURNING *;

-- name: CreatePINSession :one
INSERT INTO sessions (
    id, account_id, auth_identity_id, token_digest, csrf_digest, auth_method,
    base_assurance, current_assurance, authenticated_at, idle_expires_at, absolute_expires_at
)
VALUES (
    sqlc.arg(id), sqlc.arg(account_id), sqlc.arg(auth_identity_id), sqlc.arg(token_digest),
    sqlc.arg(csrf_digest), 'pin', 'low', 'low', now(), sqlc.arg(idle_expires_at), sqlc.arg(absolute_expires_at)
)
RETURNING *;

-- name: CreateOIDCSession :one
INSERT INTO sessions (
    id, account_id, auth_identity_id, token_digest, csrf_digest, auth_method,
    base_assurance, current_assurance, authenticated_at, idle_expires_at, absolute_expires_at
)
VALUES (
    sqlc.arg(id), sqlc.arg(account_id), sqlc.arg(auth_identity_id), sqlc.arg(token_digest),
    sqlc.arg(csrf_digest), 'oidc', sqlc.arg(assurance), sqlc.arg(assurance), sqlc.arg(authenticated_at),
    sqlc.arg(idle_expires_at), sqlc.arg(absolute_expires_at)
)
RETURNING *;

-- name: MarkAuthenticationSucceeded :exec
WITH touched_identity AS (
    UPDATE auth_identities
    SET last_used_at = now()
    WHERE auth_identities.id = sqlc.arg(auth_identity_id)
)
UPDATE accounts
SET first_authenticated_at = COALESCE(first_authenticated_at, now()), updated_at = updated_at
WHERE accounts.id = sqlc.arg(account_id);

-- name: GetSessionPrincipal :one
SELECT s.id AS session_id, s.account_id, s.auth_identity_id, s.csrf_digest,
       s.idle_expires_at, s.absolute_expires_at, s.last_seen_at,
       s.auth_method, s.base_assurance, s.current_assurance, s.authenticated_at, s.assurance_expires_at,
       a.person_id, p.first_name, p.last_name, COALESCE(i.identifier_display, '')::text AS login_email
FROM sessions s JOIN accounts a ON a.id = s.account_id JOIN people p ON p.id = a.person_id
JOIN auth_identities i ON i.id = s.auth_identity_id
WHERE s.token_digest = sqlc.arg(token_digest) AND s.revoked_at IS NULL
  AND s.idle_expires_at > now() AND s.absolute_expires_at > now() AND a.status = 'enabled'
  AND i.disabled_at IS NULL;

-- name: TouchSession :exec
UPDATE sessions SET last_seen_at = now(), idle_expires_at = LEAST(sqlc.arg(idle_expires_at), absolute_expires_at)
WHERE id = sqlc.arg(id) AND last_seen_at < now() - interval '5 minutes' AND revoked_at IS NULL;

-- name: RevokeSession :exec
UPDATE sessions SET revoked_at = COALESCE(revoked_at, now()), revocation_reason = COALESCE(revocation_reason, sqlc.arg(reason))
WHERE id = sqlc.arg(id);

-- name: RevokeSessionsForAccount :exec
UPDATE sessions SET revoked_at = COALESCE(revoked_at, now()), revocation_reason = COALESCE(revocation_reason, sqlc.arg(reason))
WHERE account_id = sqlc.arg(account_id) AND revoked_at IS NULL;

-- name: RevokeOtherSessionsForAccount :exec
UPDATE sessions SET revoked_at = COALESCE(revoked_at, now()), revocation_reason = COALESCE(revocation_reason, sqlc.arg(reason))
WHERE account_id = sqlc.arg(account_id) AND id <> sqlc.arg(current_session_id) AND revoked_at IS NULL;

-- name: DeleteExpiredSessions :execrows
DELETE FROM sessions WHERE absolute_expires_at < sqlc.arg(before_time)
   OR idle_expires_at < sqlc.arg(before_time)
   OR (revoked_at IS NOT NULL AND revoked_at < sqlc.arg(before_time));

-- name: GetPasswordCredentialForAccount :one
SELECT pc.* FROM password_credentials pc JOIN auth_identities i ON i.id = pc.auth_identity_id
WHERE i.account_id = sqlc.arg(account_id) AND i.kind = 'password' AND i.disabled_at IS NULL;

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
FROM password_reset_tokens prt JOIN auth_identities i ON i.account_id = prt.account_id AND i.kind = 'password'
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

-- name: ConsumeAuthRateLimit :one
INSERT INTO auth_rate_limits (action, key_digest, window_started_at, attempt_count)
VALUES (sqlc.arg(action), sqlc.arg(key_digest), now(), 1)
ON CONFLICT (action, key_digest) DO UPDATE SET
    window_started_at = CASE WHEN auth_rate_limits.window_started_at < now() - interval '15 minutes' THEN now() ELSE auth_rate_limits.window_started_at END,
    attempt_count = CASE WHEN auth_rate_limits.window_started_at < now() - interval '15 minutes' THEN 1 ELSE auth_rate_limits.attempt_count + 1 END,
    blocked_until = CASE
        WHEN auth_rate_limits.blocked_until > now() THEN auth_rate_limits.blocked_until
        WHEN (CASE WHEN auth_rate_limits.window_started_at < now() - interval '15 minutes' THEN 1 ELSE auth_rate_limits.attempt_count + 1 END) > sqlc.arg(max_attempts)::integer
            THEN now() + interval '15 minutes'
        ELSE NULL
    END,
    updated_at = now()
RETURNING blocked_until IS NULL OR blocked_until <= now() AS allowed;

-- name: FindPasswordChallengeTarget :one
SELECT a.id AS account_id, a.status, i.id AS auth_identity_id, i.identifier_display AS delivery_address
FROM auth_identities i
JOIN accounts a ON a.id = i.account_id
JOIN password_credentials pc ON pc.auth_identity_id = i.id
WHERE i.kind = 'password' AND i.identifier_normalized = sqlc.arg(identifier_normalized)::text
  AND i.disabled_at IS NULL;

-- name: FindPasswordIdentityTarget :one
SELECT a.id AS account_id, a.status, i.id AS auth_identity_id, i.identifier_display AS delivery_address
FROM auth_identities i
JOIN accounts a ON a.id = i.account_id
WHERE i.kind = 'password' AND i.identifier_normalized = sqlc.arg(identifier_normalized)::text
  AND i.disabled_at IS NULL;

-- name: GetPasswordIdentityTargetForAccount :one
SELECT a.id AS account_id, a.status, i.id AS auth_identity_id,
       i.identifier_display AS delivery_address, i.verified_at
FROM auth_identities i
JOIN accounts a ON a.id = i.account_id
WHERE i.account_id = sqlc.arg(account_id) AND i.kind = 'password'
  AND i.disabled_at IS NULL;

-- name: UpsertAuthChallenge :one
INSERT INTO auth_challenges (
    id, kind, account_id, auth_identity_id, code_digest, delivery_address,
    created_by_account_id, expires_at
) VALUES (
    sqlc.arg(id), sqlc.arg(kind), sqlc.arg(account_id), sqlc.narg(auth_identity_id),
    sqlc.arg(code_digest), sqlc.arg(delivery_address), sqlc.narg(created_by_account_id), sqlc.arg(expires_at)
)
ON CONFLICT (account_id, kind) DO UPDATE SET
    id = EXCLUDED.id,
    auth_identity_id = EXCLUDED.auth_identity_id,
    code_digest = EXCLUDED.code_digest,
    delivery_address = EXCLUDED.delivery_address,
    attempt_count = 0,
    created_by_account_id = EXCLUDED.created_by_account_id,
    expires_at = EXCLUDED.expires_at,
    used_at = NULL,
    cancelled_at = NULL,
    delivery_status = 'pending',
    delivery_attempted_at = NULL,
    delivery_failure_code = NULL,
    created_at = now()
RETURNING *;

-- name: SetAuthChallengeDelivery :exec
UPDATE auth_challenges
SET delivery_status = sqlc.arg(delivery_status), delivery_attempted_at = now(), delivery_failure_code = sqlc.narg(delivery_failure_code)
WHERE id = sqlc.arg(id) AND delivery_status = 'pending';

-- name: GetActiveAuthChallengeForUpdate :one
SELECT * FROM auth_challenges
WHERE account_id = sqlc.arg(account_id) AND kind = sqlc.arg(kind)
FOR UPDATE;

-- name: IncrementAuthChallengeFailure :exec
UPDATE auth_challenges SET attempt_count = LEAST(attempt_count + 1, 5)
WHERE id = sqlc.arg(id);

-- name: UseAuthChallenge :exec
UPDATE auth_challenges SET used_at = now()
WHERE id = sqlc.arg(id) AND used_at IS NULL AND cancelled_at IS NULL;

-- name: EnableInvitedAccount :exec
UPDATE accounts SET status = 'enabled', updated_at = now()
WHERE id = sqlc.arg(account_id) AND status = 'disabled' AND administratively_disabled_at IS NULL;

-- name: VerifyPasswordIdentity :exec
UPDATE auth_identities SET verified_at = COALESCE(verified_at, now()), updated_at = now()
WHERE id = sqlc.arg(id) AND kind = 'password';

-- name: DeleteExpiredAuthSecurityState :execrows
WITH deleted_challenges AS (
    DELETE FROM auth_challenges WHERE expires_at < sqlc.arg(before_time) RETURNING 1
), deleted_limits AS (
    DELETE FROM auth_rate_limits WHERE updated_at < sqlc.arg(before_time) - interval '1 day' RETURNING 1
)
SELECT count(*) FROM deleted_challenges;

-- name: FindPINLogin :one
SELECT a.id AS account_id, a.status, i.id AS auth_identity_id, i.identifier_display AS login_name,
       pc.pin_hash, p.first_name, p.last_name
FROM auth_identities i
JOIN accounts a ON a.id = i.account_id
JOIN people p ON p.id = a.person_id
JOIN pin_credentials pc ON pc.auth_identity_id = i.id
WHERE i.kind = 'pin' AND i.identifier_normalized = sqlc.arg(identifier_normalized)::text
  AND i.disabled_at IS NULL;

-- name: PINThrottleBlocked :one
SELECT EXISTS (
    SELECT 1 FROM pin_login_throttles
    WHERE dimension = sqlc.arg(dimension) AND key_digest = sqlc.arg(key_digest)
      AND blocked_until > now()
);

-- name: RecordPINFailure :exec
INSERT INTO pin_login_throttles (dimension, key_digest, failure_count, blocked_until)
VALUES (sqlc.arg(dimension), sqlc.arg(key_digest), 1, now() + interval '1 second')
ON CONFLICT (dimension, key_digest) DO UPDATE SET
    failure_count = LEAST(pin_login_throttles.failure_count + 1, 20),
    blocked_until = now() + make_interval(secs => LEAST(300, power(2, LEAST(pin_login_throttles.failure_count, 8))::integer)),
    updated_at = now();

-- name: ClearPINThrottle :exec
DELETE FROM pin_login_throttles
WHERE dimension = sqlc.arg(dimension) AND key_digest = sqlc.arg(key_digest);

-- name: CreatePINIdentity :one
INSERT INTO auth_identities (id, account_id, kind, identifier_display, identifier_normalized, verified_at)
VALUES (sqlc.arg(id), sqlc.arg(account_id), 'pin', sqlc.arg(identifier_display), sqlc.arg(identifier_normalized), now())
RETURNING *;

-- name: UpdatePINIdentity :one
UPDATE auth_identities SET identifier_display = sqlc.arg(identifier_display),
    identifier_normalized = sqlc.arg(identifier_normalized), disabled_at = NULL, updated_at = now()
WHERE account_id = sqlc.arg(account_id) AND kind = 'pin'
RETURNING *;

-- name: GetPINIdentityForAccount :one
SELECT * FROM auth_identities WHERE account_id = sqlc.arg(account_id) AND kind = 'pin' FOR UPDATE;

-- name: UpsertPINCredential :exec
INSERT INTO pin_credentials (auth_identity_id, pin_hash, changed_at)
VALUES (sqlc.arg(auth_identity_id), sqlc.arg(pin_hash), now())
ON CONFLICT (auth_identity_id) DO UPDATE SET pin_hash = EXCLUDED.pin_hash, changed_at = now();

-- name: DeletePINIdentity :exec
DELETE FROM auth_identities WHERE id = sqlc.arg(id) AND kind = 'pin';

-- name: CountUsableIdentitiesForAccount :one
SELECT count(*) FROM auth_identities i
WHERE i.account_id = sqlc.arg(account_id) AND i.disabled_at IS NULL
  AND ((i.kind = 'password' AND EXISTS (SELECT 1 FROM password_credentials pc WHERE pc.auth_identity_id = i.id AND NOT pc.reset_required))
    OR (i.kind = 'pin' AND EXISTS (SELECT 1 FROM pin_credentials pc WHERE pc.auth_identity_id = i.id))
    OR (i.kind = 'oidc' AND EXISTS (SELECT 1 FROM oidc_providers op WHERE op.id=i.provider_id AND op.enabled)));

-- name: DeletePasswordIdentity :exec
DELETE FROM auth_identities WHERE id = sqlc.arg(id) AND kind = 'password';

-- name: GetSessionForReauthentication :one
SELECT s.* FROM sessions s JOIN auth_identities i ON i.id=s.auth_identity_id
WHERE s.id=sqlc.arg(session_id) AND s.account_id=sqlc.arg(account_id)
  AND s.revoked_at IS NULL AND s.idle_expires_at>now() AND s.absolute_expires_at>now()
  AND i.disabled_at IS NULL
FOR UPDATE OF s;

-- name: GrantRecentAuthentication :exec
UPDATE sessions SET current_assurance=sqlc.arg(assurance), authenticated_at=sqlc.arg(authenticated_at),
    assurance_expires_at=sqlc.arg(expires_at)
WHERE id=sqlc.arg(id);
