-- name: CreateConnector :one
INSERT INTO scim_connectors (id, name, oidc_provider_id, enabled)
VALUES (sqlc.arg(id), sqlc.arg(name), sqlc.narg(oidc_provider_id), sqlc.arg(enabled))
RETURNING *;

-- name: ListConnectors :many
SELECT c.*, COALESCE(token.expires_at, 'epoch'::timestamptz) AS token_expires_at, token.revoked_at AS token_revoked_at
FROM scim_connectors c
LEFT JOIN LATERAL (
    SELECT expires_at, revoked_at FROM scim_connector_tokens
    WHERE connector_id = c.id ORDER BY created_at DESC LIMIT 1
) token ON true
ORDER BY lower(c.name), c.id;

-- name: GetConnector :one
SELECT c.*, COALESCE(token.expires_at, 'epoch'::timestamptz) AS token_expires_at, token.revoked_at AS token_revoked_at
FROM scim_connectors c
LEFT JOIN LATERAL (
    SELECT expires_at, revoked_at FROM scim_connector_tokens
    WHERE connector_id = c.id ORDER BY created_at DESC LIMIT 1
) token ON true
WHERE c.id = sqlc.arg(id);

-- name: UpdateConnector :one
UPDATE scim_connectors
SET name=sqlc.arg(name), oidc_provider_id=sqlc.narg(oidc_provider_id), enabled=sqlc.arg(enabled),
    version=version+1, updated_at=now()
WHERE id=sqlc.arg(id) AND version=sqlc.arg(expected_version)
RETURNING *;

-- name: BumpConnectorVersion :one
UPDATE scim_connectors SET version=version+1, updated_at=now()
WHERE id=sqlc.arg(id) AND version=sqlc.arg(expected_version)
RETURNING *;

-- name: RevokeActiveConnectorTokens :exec
UPDATE scim_connector_tokens SET revoked_at=COALESCE(revoked_at, now())
WHERE connector_id=sqlc.arg(connector_id) AND revoked_at IS NULL;

-- name: CreateConnectorToken :one
INSERT INTO scim_connector_tokens (id, connector_id, token_digest, expires_at, created_by_account_id)
VALUES (sqlc.arg(id), sqlc.arg(connector_id), sqlc.arg(token_digest), sqlc.arg(expires_at), sqlc.narg(created_by_account_id))
RETURNING *;

-- name: AuthenticateConnector :one
SELECT c.id, c.name, c.oidc_provider_id, p.issuer
FROM scim_connector_tokens token
JOIN scim_connectors c ON c.id=token.connector_id
LEFT JOIN oidc_providers p ON p.id=c.oidc_provider_id
WHERE token.token_digest=sqlc.arg(token_digest) AND token.revoked_at IS NULL
  AND token.expires_at > now() AND c.enabled;

-- name: TouchConnectorToken :exec
UPDATE scim_connector_tokens SET last_used_at=now()
WHERE token_digest=sqlc.arg(token_digest) AND (last_used_at IS NULL OR last_used_at < now()-interval '5 minutes');

-- name: CreateProvisionedPerson :one
INSERT INTO people (id, first_name, last_name, email, phone)
VALUES (sqlc.arg(id), sqlc.arg(first_name), sqlc.arg(last_name), sqlc.narg(email), sqlc.narg(phone))
RETURNING *;

-- name: CreateProvisionedAccount :one
INSERT INTO accounts (id, person_id, status, provisioning_source)
VALUES (sqlc.arg(id), sqlc.arg(person_id), sqlc.arg(status), 'scim')
RETURNING *;

-- name: CreateBoundOIDCIdentity :one
INSERT INTO auth_identities (id, account_id, kind, provider_id, issuer, subject, verified_at)
VALUES (sqlc.arg(id), sqlc.arg(account_id), 'oidc', sqlc.arg(provider_id), sqlc.arg(issuer), sqlc.arg(subject), now())
RETURNING id;

-- name: CreateSCIMUser :one
INSERT INTO scim_users (id, connector_id, person_id, account_id, external_id, user_name, provisioning_data)
VALUES (sqlc.arg(id), sqlc.arg(connector_id), sqlc.arg(person_id), sqlc.arg(account_id), sqlc.narg(external_id), sqlc.arg(user_name), sqlc.arg(provisioning_data)::text::jsonb)
RETURNING *;

-- name: GetSCIMUser :one
SELECT su.*, p.first_name, p.last_name, p.email, p.phone, p.version AS person_version,
       a.status, a.provisioning_source, a.first_authenticated_at, a.administratively_disabled_at
FROM scim_users su
JOIN people p ON p.id=su.person_id
JOIN accounts a ON a.id=su.account_id
WHERE su.connector_id=sqlc.arg(connector_id) AND su.id=sqlc.arg(id);

-- name: LockProvisionedPerson :exec
SELECT id FROM people WHERE id=sqlc.arg(id) FOR UPDATE;

-- name: ListSCIMUsers :many
SELECT su.*, p.first_name, p.last_name, p.email, p.phone, p.version AS person_version,
       a.status, a.provisioning_source, a.first_authenticated_at, a.administratively_disabled_at
FROM scim_users su
JOIN people p ON p.id=su.person_id
JOIN accounts a ON a.id=su.account_id
WHERE su.connector_id=sqlc.arg(connector_id)
  AND (sqlc.arg(filter_attribute)::text='' OR
       (sqlc.arg(filter_attribute)::text='userName' AND lower(su.user_name)=lower(sqlc.arg(filter_value)::text)) OR
       (sqlc.arg(filter_attribute)::text='externalId' AND su.external_id=sqlc.arg(filter_value)::text))
ORDER BY su.id
LIMIT sqlc.arg(page_limit) OFFSET sqlc.arg(page_offset);

-- name: CountSCIMUsers :one
SELECT count(*) FROM scim_users su
WHERE su.connector_id=sqlc.arg(connector_id)
  AND (sqlc.arg(filter_attribute)::text='' OR
       (sqlc.arg(filter_attribute)::text='userName' AND lower(su.user_name)=lower(sqlc.arg(filter_value)::text)) OR
       (sqlc.arg(filter_attribute)::text='externalId' AND su.external_id=sqlc.arg(filter_value)::text));

-- name: UpdateSCIMMapping :one
UPDATE scim_users SET external_id=sqlc.narg(external_id), user_name=sqlc.arg(user_name),
    provisioning_data=sqlc.arg(provisioning_data)::text::jsonb, version=version+1, updated_at=now()
WHERE connector_id=sqlc.arg(connector_id) AND id=sqlc.arg(id)
RETURNING *;

-- name: UpdateProvisionedPerson :exec
UPDATE people SET first_name=sqlc.arg(first_name), last_name=sqlc.arg(last_name),
    email=sqlc.narg(email), phone=sqlc.narg(phone), version=version+1, updated_at=now()
WHERE id=sqlc.arg(id);

-- name: SetProvisionedAccountStatus :exec
UPDATE accounts SET status=sqlc.arg(status), version=version+1, updated_at=now()
WHERE id=sqlc.arg(id);

-- name: EnableSCIMAccountUnlessAdminDisabled :exec
UPDATE accounts SET status='enabled', version=version+1, updated_at=now()
WHERE id=sqlc.arg(id) AND administratively_disabled_at IS NULL AND status<>'enabled';

-- name: DisableConnectorOIDCIdentity :many
UPDATE auth_identities SET disabled_at=COALESCE(disabled_at, now()), updated_at=now()
WHERE account_id=sqlc.arg(account_id) AND kind='oidc' AND provider_id=sqlc.arg(provider_id) AND disabled_at IS NULL
RETURNING id;

-- name: ReenableConnectorOIDCIdentity :exec
UPDATE auth_identities SET disabled_at=NULL, updated_at=now()
WHERE account_id=sqlc.arg(account_id) AND kind='oidc' AND provider_id=sqlc.arg(provider_id);

-- name: RevokeSessionsForIdentity :exec
UPDATE sessions SET revoked_at=COALESCE(revoked_at, now()), revocation_reason=COALESCE(revocation_reason, 'scim_deprovisioned')
WHERE auth_identity_id=sqlc.arg(auth_identity_id) AND revoked_at IS NULL;

-- name: CountIndependentUsableIdentities :one
SELECT count(*) FROM auth_identities i
WHERE i.account_id=sqlc.arg(account_id) AND i.disabled_at IS NULL
  AND (sqlc.narg(excluded_provider_id)::uuid IS NULL OR i.provider_id IS DISTINCT FROM sqlc.narg(excluded_provider_id)::uuid)
  AND ((i.kind='password' AND EXISTS (SELECT 1 FROM password_credentials pc WHERE pc.auth_identity_id=i.id AND NOT pc.reset_required))
    OR (i.kind='pin' AND EXISTS (SELECT 1 FROM pin_credentials pc WHERE pc.auth_identity_id=i.id))
    OR (i.kind='oidc' AND EXISTS (SELECT 1 FROM oidc_providers op WHERE op.id=i.provider_id AND op.enabled)));

-- name: RevokeSessionsForAccount :exec
UPDATE sessions SET revoked_at=COALESCE(revoked_at, now()), revocation_reason=COALESCE(revocation_reason, sqlc.arg(reason))
WHERE account_id=sqlc.arg(account_id) AND revoked_at IS NULL;

-- name: DeleteSCIMUser :exec
DELETE FROM scim_users WHERE connector_id=sqlc.arg(connector_id) AND id=sqlc.arg(id);

-- name: CountConnectorUsers :one
SELECT count(*) FROM scim_users WHERE connector_id=sqlc.arg(connector_id);

-- name: GetReconciliationAccount :one
SELECT a.id AS account_id, a.person_id, a.provisioning_source, a.first_authenticated_at,
       p.profile_image_file_id
FROM accounts a JOIN people p ON p.id=a.person_id
WHERE a.id=sqlc.arg(account_id)
FOR UPDATE OF a, p;

-- name: LockReconciliationPeople :exec
SELECT p.id FROM people p JOIN accounts a ON a.person_id=p.id
WHERE a.id IN (sqlc.arg(source_account_id), sqlc.arg(target_account_id))
ORDER BY p.id FOR UPDATE OF p;

-- name: CountLocalIdentitiesForAccount :one
SELECT count(*) FROM auth_identities WHERE account_id=sqlc.arg(account_id) AND kind IN ('password','pin');

-- name: CountSCIMMappingsForAccount :one
SELECT count(*) FROM scim_users WHERE account_id=sqlc.arg(account_id);

-- name: ListSCIMMappingConnectorConflicts :many
SELECT source.connector_id
FROM scim_users source
JOIN scim_users target ON target.connector_id=source.connector_id
WHERE source.account_id=sqlc.arg(source_account_id) AND target.account_id=sqlc.arg(target_account_id);

-- name: ListOpenDayReconciliationConflicts :many
SELECT source.open_day_id
FROM open_day_assignments source
JOIN open_day_assignments target ON target.open_day_id=source.open_day_id
WHERE source.person_id=sqlc.arg(source_person_id) AND target.person_id=sqlc.arg(target_person_id)
  AND source.requirement_id<>target.requirement_id;

-- name: ListPendingLabRuleConflicts :many
SELECT source.id
FROM laborordnung_requests source
JOIN laborordnung_requests target ON target.person_id=sqlc.arg(target_person_id) AND target.status='pending'
WHERE source.person_id=sqlc.arg(source_person_id) AND source.status='pending'
  AND source.required_version_id<>target.required_version_id;

-- name: DeduplicateOpenDayAssignments :exec
DELETE FROM open_day_assignments source
USING open_day_assignments target
WHERE source.person_id=sqlc.arg(source_person_id) AND target.person_id=sqlc.arg(target_person_id)
  AND source.open_day_id=target.open_day_id AND source.requirement_id=target.requirement_id;

-- name: MoveOpenDayAssignments :exec
UPDATE open_day_assignments SET person_id=sqlc.arg(target_person_id) WHERE person_id=sqlc.arg(source_person_id);

-- name: DeduplicatePendingLabRuleRequests :exec
DELETE FROM laborordnung_requests source
USING laborordnung_requests target
WHERE source.person_id=sqlc.arg(source_person_id) AND target.person_id=sqlc.arg(target_person_id)
  AND source.status='pending' AND target.status='pending'
  AND source.required_version_id=target.required_version_id;

-- name: MoveLabRuleRequests :exec
UPDATE laborordnung_requests SET person_id=sqlc.arg(target_person_id) WHERE person_id=sqlc.arg(source_person_id);

-- name: TransferProfileImage :exec
UPDATE people target SET profile_image_file_id=source.profile_image_file_id,
    profile_image_source=source.profile_image_source, version=target.version+1, updated_at=now()
FROM people source
WHERE target.id=sqlc.arg(target_person_id) AND source.id=sqlc.arg(source_person_id)
  AND target.profile_image_file_id IS NULL AND source.profile_image_file_id IS NOT NULL;

-- name: TransferExternalIdentities :exec
UPDATE auth_identities SET account_id=sqlc.arg(target_account_id), updated_at=now()
WHERE account_id=sqlc.arg(source_account_id) AND kind='oidc';

-- name: TransferAccountRoles :exec
INSERT INTO account_roles (account_id, role_id, assigned_by_account_id, assigned_at)
SELECT sqlc.arg(target_account_id), source.role_id, sqlc.narg(assigned_by_account_id), now()
FROM account_roles source WHERE source.account_id=sqlc.arg(source_account_id)
ON CONFLICT (account_id, role_id) DO NOTHING;

-- name: TransferSCIMMappings :exec
UPDATE scim_users SET account_id=sqlc.arg(target_account_id), person_id=sqlc.arg(target_person_id),
    version=version+1, updated_at=now()
WHERE account_id=sqlc.arg(source_account_id);

-- name: RevokeProvisionalSessions :exec
UPDATE sessions SET revoked_at=COALESCE(revoked_at, now()), revocation_reason=COALESCE(revocation_reason, 'scim_reconciled')
WHERE account_id=sqlc.arg(source_account_id) AND revoked_at IS NULL;

-- name: DeleteReconciledAccount :exec
DELETE FROM accounts WHERE id=sqlc.arg(id);

-- name: DeleteReconciledPerson :exec
DELETE FROM people WHERE id=sqlc.arg(id);

-- name: BumpReconciledAccountVersion :exec
UPDATE accounts SET version=version+1, updated_at=now() WHERE id=sqlc.arg(id);
