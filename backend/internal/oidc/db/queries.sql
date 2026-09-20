-- name: CreateProvider :one
INSERT INTO oidc_providers (id, slug, display_name, issuer, client_id, encrypted_client_secret, enabled, jit_enabled, acr_assurance_mappings)
VALUES (sqlc.arg(id), sqlc.arg(slug), sqlc.arg(display_name), sqlc.arg(issuer), sqlc.arg(client_id), sqlc.arg(encrypted_client_secret), sqlc.arg(enabled), sqlc.arg(jit_enabled), sqlc.arg(acr_assurance_mappings)::text::jsonb)
RETURNING *;

-- name: ListProviders :many
SELECT * FROM oidc_providers ORDER BY lower(display_name), id;

-- name: ListEnabledLoginProviders :many
SELECT slug, display_name FROM oidc_providers WHERE enabled ORDER BY lower(display_name), id;

-- name: GetProvider :one
SELECT * FROM oidc_providers WHERE id = sqlc.arg(id);

-- name: GetEnabledProviderBySlug :one
SELECT * FROM oidc_providers WHERE slug = sqlc.arg(slug) AND enabled;

-- name: UpdateProvider :one
UPDATE oidc_providers SET display_name = sqlc.arg(display_name), issuer = sqlc.arg(issuer), client_id = sqlc.arg(client_id),
    encrypted_client_secret = sqlc.arg(encrypted_client_secret), enabled = sqlc.arg(enabled), jit_enabled = sqlc.arg(jit_enabled),
    acr_assurance_mappings = sqlc.arg(acr_assurance_mappings)::text::jsonb, version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: RotateProviderSecret :execrows
UPDATE oidc_providers
SET encrypted_client_secret = sqlc.arg(encrypted_client_secret), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id);

-- name: CreateFlow :one
INSERT INTO oidc_flows (id, provider_id, kind, account_id, session_id, state_digest, browser_token_digest, encrypted_nonce, encrypted_pkce_verifier, expires_at)
VALUES (sqlc.arg(id), sqlc.arg(provider_id), sqlc.arg(kind), sqlc.narg(account_id), sqlc.narg(session_id), sqlc.arg(state_digest), sqlc.arg(browser_token_digest), sqlc.arg(encrypted_nonce), sqlc.arg(encrypted_pkce_verifier), sqlc.arg(expires_at))
RETURNING *;

-- name: GetFlowForCallback :one
SELECT * FROM oidc_flows
WHERE state_digest = sqlc.arg(state_digest) AND browser_token_digest = sqlc.arg(browser_token_digest)
  AND expires_at > now() AND used_at IS NULL
FOR UPDATE;

-- name: MarkFlowUsed :execrows
UPDATE oidc_flows SET used_at = now() WHERE id = sqlc.arg(id) AND used_at IS NULL;

-- name: DeleteExpiredFlows :execrows
DELETE FROM oidc_flows WHERE expires_at < sqlc.arg(before_time) OR used_at < sqlc.arg(before_time);

-- name: FindOIDCIdentity :one
SELECT i.id AS identity_id, i.account_id, a.status
FROM auth_identities i JOIN accounts a ON a.id = i.account_id
WHERE i.kind = 'oidc' AND i.issuer = sqlc.arg(issuer) AND i.subject = sqlc.arg(subject) AND i.disabled_at IS NULL;

-- name: CreateOIDCIdentity :one
INSERT INTO auth_identities (id, account_id, kind, provider_id, issuer, subject, verified_at)
VALUES (sqlc.arg(id), sqlc.arg(account_id), 'oidc', sqlc.arg(provider_id), sqlc.arg(issuer), sqlc.arg(subject), now())
RETURNING *;

-- name: CreateJITPerson :one
INSERT INTO people (id, first_name, last_name, email, phone)
VALUES (sqlc.arg(id), sqlc.arg(first_name), sqlc.arg(last_name), sqlc.narg(email), sqlc.narg(phone))
RETURNING *;

-- name: CreateJITAccount :one
INSERT INTO accounts (id, person_id, status, provisioning_source)
VALUES (sqlc.arg(id), sqlc.arg(person_id), 'enabled', 'oidc_jit')
RETURNING *;

-- name: GetOIDCIdentityForUnlink :one
SELECT * FROM auth_identities WHERE id = sqlc.arg(id) AND kind = 'oidc' FOR UPDATE;

-- name: GetAccountStatusForUpdate :one
SELECT status FROM accounts WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: CountUsableIdentities :one
SELECT count(*) FROM auth_identities i
WHERE i.account_id = sqlc.arg(account_id) AND i.id <> sqlc.arg(excluded_identity_id) AND i.disabled_at IS NULL
  AND ((i.kind = 'password' AND EXISTS (SELECT 1 FROM password_credentials pc WHERE pc.auth_identity_id = i.id AND NOT pc.reset_required))
    OR (i.kind = 'pin' AND EXISTS (SELECT 1 FROM pin_credentials pc WHERE pc.auth_identity_id = i.id))
    OR (i.kind = 'oidc' AND EXISTS (SELECT 1 FROM oidc_providers op WHERE op.id=i.provider_id AND op.enabled)));

-- name: DeleteOIDCIdentity :exec
DELETE FROM auth_identities WHERE id = sqlc.arg(id) AND kind = 'oidc';

-- name: RevokeSessionsForIdentity :exec
UPDATE sessions SET revoked_at = COALESCE(revoked_at, now()), revocation_reason = COALESCE(revocation_reason, 'identity_unlinked')
WHERE auth_identity_id = sqlc.arg(auth_identity_id) AND revoked_at IS NULL;

-- name: BumpAccountVersion :exec
UPDATE accounts SET version = version + 1, updated_at = now() WHERE id = sqlc.arg(id);

-- name: HasLinkedProvider :one
SELECT EXISTS (SELECT 1 FROM auth_identities
WHERE account_id=sqlc.arg(account_id) AND provider_id=sqlc.arg(provider_id) AND kind='oidc' AND disabled_at IS NULL);

-- name: GetFlowContext :one
SELECT * FROM oidc_flows
WHERE state_digest=sqlc.arg(state_digest) AND browser_token_digest=sqlc.arg(browser_token_digest)
  AND expires_at>now() AND used_at IS NULL;

-- name: GetProviderForFlow :one
SELECT * FROM oidc_providers WHERE id=sqlc.arg(id) FOR SHARE;
