-- +goose Up
-- Sign-in with a one-time code mailed to the login email. The switch lives on the login email identity (the
-- auth_identities row of kind 'password', whose identifier is the login email). It stays on when the address changes:
-- codes then go to the new address, whose owner proves control by entering them. It goes away only with the identity.
ALTER TABLE auth_identities
    ADD COLUMN email_code_enabled boolean NOT NULL DEFAULT false,
    ADD CONSTRAINT auth_identities_email_code_kind_check CHECK (NOT email_code_enabled OR kind = 'password');

-- Sign-in codes are account-bound challenges: digest only, ten minutes, five wrong entries, single use. A code for the
-- web login (email_login) and one for kiosk check-in/out (email_check_in) are separate and never stand in for each other.
ALTER TABLE auth_challenges DROP CONSTRAINT auth_challenges_kind_check;
ALTER TABLE auth_challenges ADD CONSTRAINT auth_challenges_kind_check
    CHECK (kind IN ('invitation', 'email_verification', 'password_reset', 'pin_enrollment', 'email_login', 'email_check_in'));

-- Wrong emailed codes of an account across all its codes. A new code resets the per-code attempts, so this rolling
-- budget bounds guessing over time; rows older than a day no longer count and are pruned with the sign-in state.
CREATE TABLE email_code_failures (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    failed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_code_failures_account_idx ON email_code_failures (account_id, failed_at);

ALTER TABLE sessions DROP CONSTRAINT sessions_auth_method_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_auth_method_check
    CHECK (auth_method IN ('password', 'pin', 'oidc', 'passkey', 'email_code'));

-- A sign-in that waits for its second factor remembers whether the password or an emailed code was the first step.
ALTER TABLE pending_logins
    ADD COLUMN auth_method text NOT NULL DEFAULT 'password'
        CONSTRAINT pending_logins_auth_method_check CHECK (auth_method IN ('password', 'email_code'));

ALTER TABLE visits DROP CONSTRAINT visits_check_in_method_check;
ALTER TABLE visits ADD CONSTRAINT visits_check_in_method_check
    CHECK (check_in_method IN ('password', 'pin', 'email_code', 'oidc', 'nfc', 'supervisor', 'enrollment'));
ALTER TABLE visits DROP CONSTRAINT visits_check_out_method_check;
ALTER TABLE visits ADD CONSTRAINT visits_check_out_method_check
    CHECK (check_out_method IS NULL OR check_out_method IN ('password', 'pin', 'email_code', 'oidc', 'nfc', 'public_tap', 'supervisor'));

-- Kiosk enrollment verifies the visitor's address with a mailed code bound to the enrollment context. Only the code's
-- HMAC digest is stored; the address is cleared when the context is consumed and deleted with the expired context.
ALTER TABLE visitor_enrollment_contexts
    ADD COLUMN email_display text CHECK (email_display IS NULL OR (email_display <> '' AND length(email_display) <= 254)),
    ADD COLUMN email_normalized text CHECK (email_normalized IS NULL OR (email_normalized <> '' AND length(email_normalized) <= 254)),
    ADD COLUMN email_code_digest bytea CHECK (email_code_digest IS NULL OR octet_length(email_code_digest) = 32),
    ADD COLUMN email_code_expires_at timestamptz,
    ADD COLUMN email_code_attempts smallint NOT NULL DEFAULT 0 CHECK (email_code_attempts BETWEEN 0 AND 5),
    ADD COLUMN email_codes_sent smallint NOT NULL DEFAULT 0 CHECK (email_codes_sent >= 0),
    ADD COLUMN email_verified_at timestamptz,
    ADD CONSTRAINT visitor_enrollment_contexts_email_pair_check CHECK ((email_display IS NULL) = (email_normalized IS NULL)),
    ADD CONSTRAINT visitor_enrollment_contexts_email_code_check
        CHECK ((email_code_digest IS NULL) = (email_code_expires_at IS NULL)
            AND (email_code_digest IS NULL OR email_normalized IS NOT NULL)),
    ADD CONSTRAINT visitor_enrollment_contexts_email_verified_check
        CHECK (email_verified_at IS NULL OR email_normalized IS NOT NULL);

-- Visitors enroll with an emailed code only, so the per-installation choice of methods goes away.
ALTER TABLE visitor_enrollment_configuration DROP CONSTRAINT visitor_enrollment_configuration_check;
-- Deliberate: visitor enrollment no longer offers a choice of sign-in methods; Down restores the column.
-- squawk-ignore ban-drop-column
ALTER TABLE visitor_enrollment_configuration DROP COLUMN allowed_methods;

-- Whoever may set up their own or another account's PIN may also switch the emailed code; grants are copied with
-- scope, assurance, fresh-sign-in window and device types. The master role derives its permissions from code.
-- +goose StatementBegin
DO $$
DECLARE
    source record;
    new_grant uuid;
BEGIN
    FOR source IN
        SELECT id, role_id, permission_id, scope, minimum_assurance, reauth_within_minutes
        FROM role_permission_grants
        WHERE permission_id IN ('accounts.pin.enroll.self', 'accounts.pin.enroll.all')
        ORDER BY id
    LOOP
        new_grant := uuidv7();
        INSERT INTO role_permission_grants (id, role_id, permission_id, scope, minimum_assurance, reauth_within_minutes)
        VALUES (
            new_grant, source.role_id,
            CASE source.permission_id WHEN 'accounts.pin.enroll.self' THEN 'accounts.email_code.manage.self'
                ELSE 'accounts.email_code.manage.all' END,
            source.scope, source.minimum_assurance, source.reauth_within_minutes
        );
        INSERT INTO role_permission_grant_device_types (grant_id, device_type_id)
        SELECT new_grant, device_type_id FROM role_permission_grant_device_types WHERE grant_id = source.id;
    END LOOP;
END $$;
-- +goose StatementEnd

-- Existing visitors (people holding the Visitor membership role, identified by system_key) switch to the emailed
-- code: every visitor login email gets it, and visitor passwords are removed together with their pending invitations,
-- reset codes and password sessions. PIN logins stay. Accounts that also hold the master role are left alone so the
-- migration can never lock out an administrator.
UPDATE auth_identities i
SET email_code_enabled = true, updated_at = now()
FROM accounts a
WHERE i.account_id = a.id AND i.kind = 'password' AND i.disabled_at IS NULL
  AND EXISTS (
      SELECT 1 FROM person_roles pr JOIN roles r ON r.id = pr.role_id
      WHERE pr.person_id = a.person_id AND r.system_key = 'visitor'
  )
  AND NOT EXISTS (
      SELECT 1 FROM person_roles pr JOIN roles r ON r.id = pr.role_id
      WHERE pr.person_id = a.person_id AND r.system_key = 'master'
  );

UPDATE sessions s
SET revoked_at = now(), revocation_reason = 'password_removed'
FROM auth_identities i
JOIN password_credentials pc ON pc.auth_identity_id = i.id
WHERE s.auth_identity_id = i.id AND s.auth_method = 'password' AND s.revoked_at IS NULL AND i.email_code_enabled;

DELETE FROM pending_logins p
USING auth_identities i
JOIN password_credentials pc ON pc.auth_identity_id = i.id
WHERE p.auth_identity_id = i.id AND i.email_code_enabled;

DELETE FROM auth_challenges c
USING auth_identities i
WHERE c.account_id = i.account_id AND i.kind = 'password' AND i.email_code_enabled
  AND c.kind IN ('invitation', 'password_reset');

DELETE FROM password_reset_tokens t
USING auth_identities i
WHERE t.account_id = i.account_id AND i.kind = 'password' AND i.email_code_enabled;

UPDATE accounts a
SET version = a.version + 1, updated_at = now()
FROM auth_identities i
JOIN password_credentials pc ON pc.auth_identity_id = i.id
WHERE i.account_id = a.id AND i.email_code_enabled;

DELETE FROM password_credentials pc
USING auth_identities i
WHERE pc.auth_identity_id = i.id AND i.email_code_enabled;

-- +goose Down
-- Passwords removed by the Up section cannot be restored: those visitors keep their PIN (if any) and need a password
-- reset or invitation to sign in on the web again. Emailed-code sessions, codes and pending logins are deleted, and
-- email-code check-ins become password check-ins (the closest remaining method) so the narrower constraints hold.
DELETE FROM sessions WHERE auth_method = 'email_code';
DELETE FROM auth_challenges WHERE kind IN ('email_login', 'email_check_in');
DROP TABLE email_code_failures;
DELETE FROM pending_logins WHERE auth_method = 'email_code';
UPDATE visits SET check_in_method = 'password' WHERE check_in_method = 'email_code';
UPDATE visits SET check_out_method = 'password' WHERE check_out_method = 'email_code';

DELETE FROM role_permission_grants
WHERE permission_id IN ('accounts.email_code.manage.self', 'accounts.email_code.manage.all');
DELETE FROM master_reauthentication_permissions
WHERE permission_id IN ('accounts.email_code.manage.self', 'accounts.email_code.manage.all');

-- Enrollment offered password and PIN before; both come back so an enabled configuration stays valid.
ALTER TABLE visitor_enrollment_configuration
    ADD COLUMN allowed_methods text[] NOT NULL DEFAULT '{}' CHECK (allowed_methods <@ ARRAY['password', 'pin']::text[]);
UPDATE visitor_enrollment_configuration SET allowed_methods = ARRAY['password', 'pin']::text[];
ALTER TABLE visitor_enrollment_configuration ADD CONSTRAINT visitor_enrollment_configuration_check
    CHECK (NOT enabled OR cardinality(allowed_methods) > 0);

ALTER TABLE visitor_enrollment_contexts
    DROP CONSTRAINT visitor_enrollment_contexts_email_verified_check,
    DROP CONSTRAINT visitor_enrollment_contexts_email_code_check,
    DROP CONSTRAINT visitor_enrollment_contexts_email_pair_check,
    DROP COLUMN email_verified_at,
    DROP COLUMN email_codes_sent,
    DROP COLUMN email_code_attempts,
    DROP COLUMN email_code_expires_at,
    DROP COLUMN email_code_digest,
    DROP COLUMN email_normalized,
    DROP COLUMN email_display;

ALTER TABLE visits DROP CONSTRAINT visits_check_out_method_check;
ALTER TABLE visits ADD CONSTRAINT visits_check_out_method_check
    CHECK (check_out_method IS NULL OR check_out_method IN ('password', 'pin', 'oidc', 'nfc', 'public_tap', 'supervisor'));
ALTER TABLE visits DROP CONSTRAINT visits_check_in_method_check;
ALTER TABLE visits ADD CONSTRAINT visits_check_in_method_check
    CHECK (check_in_method IN ('password', 'pin', 'oidc', 'nfc', 'supervisor', 'enrollment'));

ALTER TABLE pending_logins DROP COLUMN auth_method;

ALTER TABLE sessions DROP CONSTRAINT sessions_auth_method_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_auth_method_check
    CHECK (auth_method IN ('password', 'pin', 'oidc', 'passkey'));

ALTER TABLE auth_challenges DROP CONSTRAINT auth_challenges_kind_check;
ALTER TABLE auth_challenges ADD CONSTRAINT auth_challenges_kind_check
    CHECK (kind IN ('invitation', 'email_verification', 'password_reset', 'pin_enrollment'));

ALTER TABLE auth_identities
    DROP CONSTRAINT auth_identities_email_code_kind_check,
    DROP COLUMN email_code_enabled;
