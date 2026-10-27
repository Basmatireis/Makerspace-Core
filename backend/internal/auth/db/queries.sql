-- name: FindLoginAccountByEmail :one
SELECT account_id
FROM auth_identities
WHERE kind = 'password' AND disabled_at IS NULL AND identifier_normalized = sqlc.arg(identifier_normalized)::text;

-- name: GetAccountForAuthentication :one
SELECT id, status, version
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
-- A password session: normal assurance, or strong_mfa when the login also verified a second factor.
INSERT INTO sessions (id, account_id, auth_identity_id, token_digest, csrf_digest, auth_method,
  base_assurance, current_assurance, authenticated_assurance, mfa_setup_required, authenticated_at,
  idle_expires_at, absolute_expires_at, managed_device_id, session_policy_id, session_policy_version,
  idle_timeout_seconds, post_session_destination)
VALUES (sqlc.arg(id), sqlc.arg(account_id), sqlc.arg(auth_identity_id)::uuid, sqlc.arg(token_digest), sqlc.arg(csrf_digest), 'password',
  sqlc.arg(assurance), sqlc.arg(assurance), sqlc.arg(assurance), sqlc.arg(mfa_setup_required), now(),
  sqlc.arg(idle_expires_at), sqlc.arg(absolute_expires_at), sqlc.narg(managed_device_id), sqlc.narg(session_policy_id),
  sqlc.arg(session_policy_version), sqlc.arg(idle_timeout_seconds), sqlc.arg(post_session_destination))
RETURNING id;

-- name: CreatePasskeySession :one
INSERT INTO sessions (id, account_id, webauthn_credential_id, token_digest, csrf_digest, auth_method,
  base_assurance, current_assurance, authenticated_assurance, authenticated_at,
  idle_expires_at, absolute_expires_at, managed_device_id, session_policy_id, session_policy_version,
  idle_timeout_seconds, post_session_destination)
VALUES (sqlc.arg(id), sqlc.arg(account_id), sqlc.arg(webauthn_credential_id)::uuid, sqlc.arg(token_digest), sqlc.arg(csrf_digest), 'passkey',
  'strong_mfa', 'strong_mfa', 'strong_mfa', now(),
  sqlc.arg(idle_expires_at), sqlc.arg(absolute_expires_at), sqlc.narg(managed_device_id), sqlc.narg(session_policy_id),
  sqlc.arg(session_policy_version), sqlc.arg(idle_timeout_seconds), sqlc.arg(post_session_destination))
RETURNING id;

-- name: CreatePINSession :one
INSERT INTO sessions (
    id, account_id, auth_identity_id, token_digest, csrf_digest, auth_method,
    base_assurance, current_assurance, authenticated_assurance, authenticated_at, idle_expires_at, absolute_expires_at,
    managed_device_id, session_policy_id, session_policy_version, idle_timeout_seconds, post_session_destination
)
VALUES (
    sqlc.arg(id), sqlc.arg(account_id), sqlc.arg(auth_identity_id)::uuid, sqlc.arg(token_digest),
    sqlc.arg(csrf_digest), 'pin', 'low', 'low', 'low', now(), sqlc.arg(idle_expires_at), sqlc.arg(absolute_expires_at),
    sqlc.narg(managed_device_id), sqlc.narg(session_policy_id), sqlc.arg(session_policy_version),
    sqlc.arg(idle_timeout_seconds), sqlc.arg(post_session_destination)
)
RETURNING *;

-- name: CreateOIDCSession :one
INSERT INTO sessions (
    id, account_id, auth_identity_id, token_digest, csrf_digest, auth_method,
    base_assurance, current_assurance, authenticated_assurance, mfa_setup_required, authenticated_at,
    idle_expires_at, absolute_expires_at,
    managed_device_id, session_policy_id, session_policy_version, idle_timeout_seconds, post_session_destination
)
VALUES (
    sqlc.arg(id), sqlc.arg(account_id), sqlc.arg(auth_identity_id)::uuid, sqlc.arg(token_digest),
    sqlc.arg(csrf_digest), 'oidc', sqlc.arg(assurance), sqlc.arg(assurance), sqlc.arg(assurance),
    sqlc.arg(mfa_setup_required), sqlc.arg(authenticated_at),
    sqlc.arg(idle_expires_at), sqlc.arg(absolute_expires_at), sqlc.narg(managed_device_id), sqlc.narg(session_policy_id),
    sqlc.arg(session_policy_version), sqlc.arg(idle_timeout_seconds), sqlc.arg(post_session_destination)
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
-- mfa_setup_required lifts as soon as the account has a second factor, even when it was enrolled in another session.
SELECT s.id AS session_id, s.account_id, s.csrf_digest,
	       s.idle_expires_at, s.absolute_expires_at, s.last_seen_at, s.managed_device_id,
	       s.session_policy_id, s.session_policy_version, s.idle_timeout_seconds, s.post_session_destination,
	       s.auth_method, s.base_assurance, s.current_assurance, s.authenticated_at, s.assurance_expires_at,
	       COALESCE(s.authenticated_assurance, s.current_assurance)::text AS authenticated_assurance,
	       (s.mfa_setup_required AND NOT EXISTS (
	           SELECT 1 FROM mfa_totp_credentials t WHERE t.account_id = s.account_id AND t.confirmed_at IS NOT NULL
	       ) AND NOT EXISTS (
	           SELECT 1 FROM webauthn_credentials w WHERE w.account_id = s.account_id
	       ))::boolean AS mfa_setup_required,
	       a.person_id, p.first_name, p.last_name
FROM sessions s JOIN accounts a ON a.id = s.account_id JOIN people p ON p.id = a.person_id
LEFT JOIN auth_identities i ON i.id = s.auth_identity_id
WHERE s.token_digest = sqlc.arg(token_digest) AND s.revoked_at IS NULL
  AND s.idle_expires_at > now() AND s.absolute_expires_at > now() AND a.status = 'enabled'
  AND (s.webauthn_credential_id IS NOT NULL OR (i.id IS NOT NULL AND i.disabled_at IS NULL));

-- name: GetSessionPostDestinationByDigest :one
SELECT post_session_destination
FROM sessions
WHERE token_digest = sqlc.arg(token_digest);

-- name: TouchSession :one
UPDATE sessions SET last_seen_at = now(),
  idle_expires_at = LEAST(now() + make_interval(secs => idle_timeout_seconds), absolute_expires_at)
WHERE id = sqlc.arg(id) AND revoked_at IS NULL AND idle_expires_at > now() AND absolute_expires_at > now()
RETURNING idle_expires_at, absolute_expires_at, post_session_destination;

-- name: GetEffectiveSessionPolicy :one
SELECT p.*
FROM session_policies p
WHERE p.id = COALESCE(
  (SELECT md.session_policy_id FROM managed_devices md
   WHERE md.id = sqlc.narg(managed_device_id) AND md.revoked_at IS NULL
     AND (md.expires_at IS NULL OR md.expires_at > now())),
  (SELECT id FROM session_policies WHERE is_default LIMIT 1)
)
LIMIT 1;

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
SELECT a.id AS account_id, a.person_id, a.status, i.id AS auth_identity_id, i.identifier_display AS login_name,
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
-- A key that stayed quiet for 15 minutes starts over, so a shared source (a NAT, a
-- terminal) is not stuck at the maximum back-off after a few old failures.
INSERT INTO pin_login_throttles (dimension, key_digest, failure_count, blocked_until)
VALUES (sqlc.arg(dimension), sqlc.arg(key_digest), 1, now() + interval '1 second')
ON CONFLICT (dimension, key_digest) DO UPDATE SET
    failure_count = CASE
        WHEN pin_login_throttles.updated_at < now() - interval '15 minutes' THEN 1
        ELSE LEAST(pin_login_throttles.failure_count + 1, 20)
    END,
    blocked_until = now() + CASE
        WHEN pin_login_throttles.updated_at < now() - interval '15 minutes' THEN interval '1 second'
        ELSE make_interval(secs => LEAST(300, power(2, LEAST(pin_login_throttles.failure_count, 8))::integer))
    END,
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
    identifier_normalized = sqlc.arg(identifier_normalized), verified_at = COALESCE(verified_at, now()),
    disabled_at = NULL, updated_at = now()
WHERE account_id = sqlc.arg(account_id) AND kind = 'pin'
RETURNING *;

-- name: GetPINIdentityForAccount :one
SELECT * FROM auth_identities WHERE account_id = sqlc.arg(account_id) AND kind = 'pin' FOR UPDATE;

-- name: UpsertPINCredential :exec
INSERT INTO pin_credentials (auth_identity_id, pin_hash, changed_at)
VALUES (sqlc.arg(auth_identity_id), sqlc.arg(pin_hash), now())
ON CONFLICT (auth_identity_id) DO UPDATE SET pin_hash = EXCLUDED.pin_hash, changed_at = now();

-- name: DeletePINEnrollmentChallengeForAccount :exec
DELETE FROM auth_challenges
WHERE account_id = sqlc.arg(account_id) AND kind = 'pin_enrollment';

-- name: DeletePINIdentity :exec
DELETE FROM auth_identities WHERE id = sqlc.arg(id) AND kind = 'pin';

-- name: DeletePasswordIdentity :exec
DELETE FROM auth_identities WHERE id = sqlc.arg(id) AND kind = 'password';

-- name: GetSessionForReauthentication :one
-- Locks the session row (FOR UPDATE OF s).
SELECT s.id, s.base_assurance, s.current_assurance, s.authenticated_at, s.assurance_expires_at,
       COALESCE(s.authenticated_assurance, s.current_assurance)::text AS authenticated_assurance,
       s.auth_method, s.mfa_setup_required
FROM sessions s LEFT JOIN auth_identities i ON i.id=s.auth_identity_id
WHERE s.id=sqlc.arg(session_id) AND s.account_id=sqlc.arg(account_id)
  AND s.revoked_at IS NULL AND s.idle_expires_at>now() AND s.absolute_expires_at>now()
  AND (s.webauthn_credential_id IS NOT NULL OR (i.id IS NOT NULL AND i.disabled_at IS NULL))
FOR UPDATE OF s;

-- name: GrantRecentAuthentication :exec
-- A proof weaker than the session's base never lowers the session's assurance; it only records what was proven
-- and when. The temporary raise expires back to the base assurance.
UPDATE sessions SET current_assurance=sqlc.arg(current_assurance), authenticated_at=sqlc.arg(authenticated_at),
    authenticated_assurance=sqlc.arg(proof_assurance), assurance_expires_at=sqlc.narg(expires_at)
WHERE id=sqlc.arg(id);

-- name: RaiseSessionToStrongMFA :exec
-- The session proved a second factor (enrollment, second-factor reauthentication): it is now equivalent to a
-- multi-factor login.
UPDATE sessions SET base_assurance='strong_mfa', current_assurance='strong_mfa', authenticated_assurance='strong_mfa',
    authenticated_at=sqlc.arg(authenticated_at), assurance_expires_at=NULL, mfa_setup_required=false
WHERE id=sqlc.arg(id);

-- name: GetAccountSecondFactorState :one
-- required: the account holds the master role or a role with a grant that needs strong_mfa.
SELECT
    EXISTS (
        SELECT 1 FROM accounts a
        JOIN person_roles pr ON pr.person_id = a.person_id
        JOIN roles r ON r.id = pr.role_id
        LEFT JOIN role_permission_grants g ON g.role_id = r.id
        WHERE a.id = sqlc.arg(account_id)::uuid AND (r.system_key = 'master' OR g.minimum_assurance = 'strong_mfa')
    )::boolean AS required,
    EXISTS (
        SELECT 1 FROM mfa_totp_credentials t WHERE t.account_id = sqlc.arg(account_id)::uuid AND t.confirmed_at IS NOT NULL
    )::boolean AS totp_enrolled,
    (SELECT count(*) FROM webauthn_credentials w WHERE w.account_id = sqlc.arg(account_id)::uuid)::bigint AS passkey_count,
    (SELECT count(*) FROM mfa_recovery_codes c WHERE c.account_id = sqlc.arg(account_id)::uuid AND c.used_at IS NULL)::bigint
        AS recovery_codes_remaining;

-- name: GetTOTPCredential :one
SELECT * FROM mfa_totp_credentials WHERE account_id = sqlc.arg(account_id);

-- name: GetTOTPCredentialForUpdate :one
SELECT * FROM mfa_totp_credentials WHERE account_id = sqlc.arg(account_id) FOR UPDATE;

-- name: ReplacePendingTOTPCredential :exec
-- Only an unconfirmed enrollment is replaced; a confirmed authenticator app stays until it is removed.
INSERT INTO mfa_totp_credentials (id, account_id, secret_ciphertext, created_at)
VALUES (sqlc.arg(id), sqlc.arg(account_id), sqlc.arg(secret_ciphertext), now())
ON CONFLICT (account_id) DO UPDATE SET id = EXCLUDED.id, secret_ciphertext = EXCLUDED.secret_ciphertext,
    created_at = now(), last_used_step = NULL, last_used_at = NULL
WHERE mfa_totp_credentials.confirmed_at IS NULL;

-- name: ConfirmTOTPCredential :exec
UPDATE mfa_totp_credentials SET confirmed_at = now(), last_used_step = sqlc.arg(step), last_used_at = now()
WHERE id = sqlc.arg(id) AND confirmed_at IS NULL;

-- name: RecordTOTPUse :exec
UPDATE mfa_totp_credentials SET last_used_step = sqlc.arg(step), last_used_at = now()
WHERE id = sqlc.arg(id) AND (last_used_step IS NULL OR last_used_step < sqlc.arg(step));

-- name: DeleteTOTPCredential :execrows
DELETE FROM mfa_totp_credentials WHERE account_id = sqlc.arg(account_id);

-- name: DeleteRecoveryCodes :exec
DELETE FROM mfa_recovery_codes WHERE account_id = sqlc.arg(account_id);

-- name: InsertRecoveryCode :exec
INSERT INTO mfa_recovery_codes (id, account_id, code_digest) VALUES (sqlc.arg(id), sqlc.arg(account_id), sqlc.arg(code_digest));

-- name: UseRecoveryCode :execrows
UPDATE mfa_recovery_codes SET used_at = now()
WHERE account_id = sqlc.arg(account_id) AND code_digest = sqlc.arg(code_digest) AND used_at IS NULL;

-- name: ListWebAuthnCredentials :many
SELECT * FROM webauthn_credentials WHERE account_id = sqlc.arg(account_id) ORDER BY created_at, id;

-- name: GetWebAuthnCredentialByCredentialID :one
SELECT * FROM webauthn_credentials WHERE credential_id = sqlc.arg(credential_id);

-- name: InsertWebAuthnCredential :one
INSERT INTO webauthn_credentials (id, account_id, credential_id, credential, name)
VALUES (sqlc.arg(id), sqlc.arg(account_id), sqlc.arg(credential_id), sqlc.arg(credential)::text::jsonb, sqlc.arg(name))
RETURNING *;

-- name: UpdateWebAuthnCredentialUse :exec
UPDATE webauthn_credentials SET credential = sqlc.arg(credential)::text::jsonb, last_used_at = now() WHERE id = sqlc.arg(id);

-- name: RenameWebAuthnCredential :one
UPDATE webauthn_credentials SET name = sqlc.arg(name)
WHERE id = sqlc.arg(id) AND account_id = sqlc.arg(account_id)
RETURNING *;

-- name: DeleteWebAuthnCredential :execrows
DELETE FROM webauthn_credentials WHERE id = sqlc.arg(id) AND account_id = sqlc.arg(account_id);

-- name: CountSecondFactors :one
SELECT ((SELECT count(*) FROM mfa_totp_credentials t WHERE t.account_id = sqlc.arg(account_id)::uuid AND t.confirmed_at IS NOT NULL)
      + (SELECT count(*) FROM webauthn_credentials w WHERE w.account_id = sqlc.arg(account_id)::uuid))::bigint AS total;

-- name: CreatePendingLogin :exec
INSERT INTO pending_logins (id, token_digest, account_id, auth_identity_id, managed_device_id, expires_at)
VALUES (sqlc.arg(id), sqlc.arg(token_digest), sqlc.arg(account_id), sqlc.arg(auth_identity_id), sqlc.narg(managed_device_id), sqlc.arg(expires_at));

-- name: GetPendingLoginForUpdate :one
SELECT * FROM pending_logins WHERE token_digest = sqlc.arg(token_digest) AND expires_at > now() FOR UPDATE;

-- name: GetPendingLogin :one
SELECT * FROM pending_logins WHERE token_digest = sqlc.arg(token_digest) AND expires_at > now();

-- name: RecordPendingLoginFailure :one
UPDATE pending_logins SET failed_attempts = failed_attempts + 1 WHERE id = sqlc.arg(id) RETURNING failed_attempts;

-- name: DeletePendingLogin :exec
DELETE FROM pending_logins WHERE id = sqlc.arg(id);

-- name: DeletePendingLoginsForAccount :exec
DELETE FROM pending_logins WHERE account_id = sqlc.arg(account_id);

-- name: DeleteExpiredPendingLogins :execrows
DELETE FROM pending_logins WHERE expires_at < sqlc.arg(before_time);

-- name: SecondFactorThrottleBlocked :one
SELECT EXISTS (
    SELECT 1 FROM second_factor_throttles WHERE account_id = sqlc.arg(account_id) AND blocked_until > now()
);

-- name: RecordSecondFactorFailure :exec
-- Same back-off as the PIN throttle: one second, then doubling up to five minutes; a quiet quarter hour resets it.
INSERT INTO second_factor_throttles (account_id, failure_count, blocked_until)
VALUES (sqlc.arg(account_id), 1, now() + interval '1 second')
ON CONFLICT (account_id) DO UPDATE SET
    failure_count = CASE
        WHEN second_factor_throttles.updated_at < now() - interval '15 minutes' THEN 1
        ELSE LEAST(second_factor_throttles.failure_count + 1, 20)
    END,
    blocked_until = now() + CASE
        WHEN second_factor_throttles.updated_at < now() - interval '15 minutes' THEN interval '1 second'
        ELSE make_interval(secs => LEAST(300, power(2, LEAST(second_factor_throttles.failure_count, 8))::integer))
    END,
    updated_at = now();

-- name: ClearSecondFactorThrottle :exec
DELETE FROM second_factor_throttles WHERE account_id = sqlc.arg(account_id);

-- name: InsertWebAuthnChallenge :exec
INSERT INTO webauthn_challenges (id, challenge_digest, purpose, account_id, session_id, pending_login_id, session_data, expires_at)
VALUES (sqlc.arg(id), sqlc.arg(challenge_digest), sqlc.arg(purpose), sqlc.narg(account_id), sqlc.narg(session_id),
        sqlc.narg(pending_login_id), sqlc.arg(session_data)::text::jsonb, sqlc.arg(expires_at));

-- name: DeleteWebAuthnChallengesForSession :exec
DELETE FROM webauthn_challenges WHERE session_id = sqlc.arg(session_id) AND purpose = sqlc.arg(purpose);

-- name: DeleteWebAuthnChallengesForPendingLogin :exec
DELETE FROM webauthn_challenges WHERE pending_login_id = sqlc.arg(pending_login_id);

-- name: ConsumeWebAuthnChallenge :one
-- Single use: the row is deleted whether or not the assertion then verifies.
DELETE FROM webauthn_challenges
WHERE challenge_digest = sqlc.arg(challenge_digest) AND purpose = sqlc.arg(purpose)
RETURNING *;

-- name: DeleteExpiredWebAuthnChallenges :execrows
DELETE FROM webauthn_challenges WHERE expires_at < sqlc.arg(before_time);

-- name: GetAccountWebAuthnUser :one
SELECT a.id, a.status, COALESCE(i.identifier_display, '')::text AS login_email, p.first_name, p.last_name
FROM accounts a JOIN people p ON p.id = a.person_id
LEFT JOIN auth_identities i ON i.account_id = a.id AND i.kind = 'password'
WHERE a.id = sqlc.arg(account_id);

