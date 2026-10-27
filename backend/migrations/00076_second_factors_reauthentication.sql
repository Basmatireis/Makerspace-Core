-- +goose Up
-- Second factors (TOTP with recovery codes, WebAuthn passkeys), the pending password login that waits for a second
-- factor, step-up reauthentication requirements on permission grants, and the master role's fresh-sign-in policy.

-- A grant may additionally require that the session's last (re)authentication at the grant's minimum assurance is
-- at most this many minutes old. NULL means no fresh sign-in is required.
ALTER TABLE role_permission_grants
    ADD COLUMN reauth_within_minutes integer CHECK (reauth_within_minutes BETWEEN 1 AND 1440);

-- authenticated_assurance is the assurance proven at authenticated_at (login or the last reauthentication). It can be
-- lower than the session's base assurance, for example a password reauthentication of a strong OIDC session, so the
-- freshness of a high-assurance grant is never satisfied by a weaker proof. NULL (sessions created before this
-- migration) means current_assurance, which is what the earlier reauthentication stored.
ALTER TABLE sessions
    ADD COLUMN authenticated_assurance text
        CHECK (authenticated_assurance IN ('low', 'normal', 'strong', 'strong_mfa')),
    ADD COLUMN mfa_setup_required boolean NOT NULL DEFAULT false;

CREATE TABLE mfa_totp_credentials (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
    -- Encrypted with the application keyring; never stored or logged in plaintext.
    secret_ciphertext bytea NOT NULL CHECK (octet_length(secret_ciphertext) > 0),
    -- NULL while the enrollment waits for its first valid code.
    confirmed_at timestamptz,
    -- The RFC 6238 time step of the last accepted code; a code is never accepted twice.
    last_used_step bigint,
    last_used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mfa_recovery_codes (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    -- Keyed HMAC digest; the code itself is shown once.
    code_digest bytea NOT NULL CHECK (octet_length(code_digest) = 32),
    used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (account_id, code_digest)
);

CREATE TABLE webauthn_credentials (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    credential_id bytea NOT NULL UNIQUE CHECK (octet_length(credential_id) BETWEEN 1 AND 1023),
    -- The public credential record of the WebAuthn library (public key, sign count, flags); contains no secret.
    credential jsonb NOT NULL,
    name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
    created_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz
);

CREATE INDEX webauthn_credentials_account_idx ON webauthn_credentials (account_id, created_at);

-- A usernameless passkey login has no password, PIN, or OIDC identity: its session references the passkey instead,
-- and deleting the passkey deletes those sessions.
ALTER TABLE sessions
    ALTER COLUMN auth_identity_id DROP NOT NULL,
    ADD COLUMN webauthn_credential_id uuid REFERENCES webauthn_credentials(id) ON DELETE CASCADE;
ALTER TABLE sessions DROP CONSTRAINT sessions_auth_method_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_auth_method_check
    CHECK (auth_method IN ('password', 'pin', 'oidc', 'passkey'));
ALTER TABLE sessions ADD CONSTRAINT sessions_authenticator_check CHECK (
    (auth_method = 'passkey' AND auth_identity_id IS NULL AND webauthn_credential_id IS NOT NULL)
    OR (auth_method <> 'passkey' AND auth_identity_id IS NOT NULL AND webauthn_credential_id IS NULL)
);

-- A password login of an account with a second factor: no session yet, only a short-lived single-use token whose
-- digest is stored here and whose value lives in an HttpOnly cookie.
CREATE TABLE pending_logins (
    id uuid PRIMARY KEY,
    token_digest bytea NOT NULL UNIQUE CHECK (octet_length(token_digest) = 32),
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    auth_identity_id uuid NOT NULL REFERENCES auth_identities(id) ON DELETE CASCADE,
    managed_device_id uuid REFERENCES managed_devices(id) ON DELETE CASCADE,
    failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX pending_logins_account_idx ON pending_logins (account_id);
CREATE INDEX pending_logins_expiry_idx ON pending_logins (expires_at);

-- Server-side WebAuthn ceremony state. A challenge is looked up by the digest of the challenge the client signed,
-- bound to its purpose and, where applicable, to the session or pending login that requested it, and deleted when
-- it is used.
CREATE TABLE webauthn_challenges (
    id uuid PRIMARY KEY,
    challenge_digest bytea NOT NULL UNIQUE CHECK (octet_length(challenge_digest) = 32),
    purpose text NOT NULL CHECK (purpose IN ('registration', 'login', 'second_factor', 'reauthentication')),
    account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,
    session_id uuid REFERENCES sessions(id) ON DELETE CASCADE,
    pending_login_id uuid REFERENCES pending_logins(id) ON DELETE CASCADE,
    session_data jsonb NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (purpose = 'login' OR account_id IS NOT NULL),
    CHECK (purpose NOT IN ('registration', 'reauthentication') OR session_id IS NOT NULL),
    CHECK (purpose <> 'second_factor' OR pending_login_id IS NOT NULL)
);

CREATE INDEX webauthn_challenges_expiry_idx ON webauthn_challenges (expires_at);

-- Failed second-factor verifications per account, with the same back-off as the PIN throttle.
CREATE TABLE second_factor_throttles (
    account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
    blocked_until timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Permissions the master role may use only after a fresh sign-in within the window. Managed by masters only.
CREATE TABLE master_reauthentication_permissions (
    permission_id text PRIMARY KEY CHECK (permission_id <> '' AND length(permission_id) <= 128),
    within_minutes integer NOT NULL CHECK (within_minutes BETWEEN 1 AND 1440),
    updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO master_reauthentication_permissions (permission_id, within_minutes) VALUES
    ('accounts.mfa.reset', 10),
    ('accounts.password.set', 10),
    ('branding.manage', 10),
    ('mail.manage', 10),
    ('oidc.manage', 10),
    ('people.roles.assign', 10),
    ('roles.manage', 10);

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM role_permission_grants WHERE reauth_within_minutes IS NOT NULL) THEN
        RAISE EXCEPTION 'cannot downgrade while permission grants require a fresh sign-in';
    END IF;
END $$;
-- +goose StatementEnd

DROP TABLE master_reauthentication_permissions;
DROP TABLE second_factor_throttles;
DROP TABLE webauthn_challenges;
DROP TABLE pending_logins;
DELETE FROM sessions WHERE auth_method = 'passkey';
ALTER TABLE sessions DROP CONSTRAINT sessions_authenticator_check;
ALTER TABLE sessions DROP CONSTRAINT sessions_auth_method_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_auth_method_check CHECK (auth_method IN ('password', 'pin', 'oidc'));
ALTER TABLE sessions DROP COLUMN webauthn_credential_id, ALTER COLUMN auth_identity_id SET NOT NULL;
DROP TABLE webauthn_credentials;
DROP TABLE mfa_recovery_codes;
DROP TABLE mfa_totp_credentials;
ALTER TABLE sessions DROP COLUMN mfa_setup_required, DROP COLUMN authenticated_assurance;
ALTER TABLE role_permission_grants DROP COLUMN reauth_within_minutes;
