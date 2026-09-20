-- +goose Up
ALTER TABLE accounts
    ADD COLUMN provisioning_source text NOT NULL DEFAULT 'local'
        CHECK (provisioning_source IN ('local', 'invitation', 'oidc_jit', 'scim', 'visitor')),
    ADD COLUMN first_authenticated_at timestamptz;

ALTER TABLE auth_identities DROP CONSTRAINT auth_identities_kind_check;
ALTER TABLE auth_identities DROP CONSTRAINT auth_identities_account_id_kind_key;
ALTER TABLE auth_identities DROP CONSTRAINT auth_identities_kind_identifier_normalized_key;
ALTER TABLE auth_identities ALTER COLUMN identifier_display DROP NOT NULL;
ALTER TABLE auth_identities ALTER COLUMN identifier_normalized DROP NOT NULL;
ALTER TABLE auth_identities DROP CONSTRAINT auth_identities_identifier_display_check;
ALTER TABLE auth_identities DROP CONSTRAINT auth_identities_identifier_normalized_check;

UPDATE auth_identities SET kind = 'password' WHERE kind = 'email_password';

ALTER TABLE auth_identities
    ADD COLUMN provider_id uuid,
    ADD COLUMN issuer text,
    ADD COLUMN subject text,
    ADD COLUMN verified_at timestamptz,
    ADD COLUMN disabled_at timestamptz,
    ADD COLUMN last_used_at timestamptz,
    ADD CONSTRAINT auth_identities_kind_check CHECK (kind IN ('password', 'pin', 'oidc')),
    ADD CONSTRAINT auth_identities_identifier_display_check CHECK (
        identifier_display IS NULL OR
        (identifier_display = btrim(identifier_display) AND identifier_display <> '' AND length(identifier_display) <= 254)
    ),
    ADD CONSTRAINT auth_identities_identifier_normalized_check CHECK (
        identifier_normalized IS NULL OR
        (identifier_normalized = btrim(identifier_normalized) AND identifier_normalized <> '' AND length(identifier_normalized) <= 254)
    ),
    ADD CONSTRAINT auth_identities_shape_check CHECK (
        (kind IN ('password', 'pin') AND identifier_display IS NOT NULL AND identifier_normalized IS NOT NULL
            AND provider_id IS NULL AND issuer IS NULL AND subject IS NULL)
        OR
        (kind = 'oidc' AND provider_id IS NOT NULL AND issuer IS NOT NULL AND subject IS NOT NULL)
    );

UPDATE auth_identities SET verified_at = created_at WHERE kind = 'password';

CREATE UNIQUE INDEX auth_identities_password_account_idx
    ON auth_identities (account_id) WHERE kind = 'password';
CREATE UNIQUE INDEX auth_identities_password_identifier_idx
    ON auth_identities (identifier_normalized) WHERE kind = 'password';
CREATE UNIQUE INDEX auth_identities_pin_identifier_idx
    ON auth_identities (identifier_normalized) WHERE kind = 'pin';
CREATE UNIQUE INDEX auth_identities_oidc_subject_idx
    ON auth_identities (issuer, subject) WHERE kind = 'oidc';
CREATE INDEX auth_identities_account_idx ON auth_identities (account_id, kind, id);

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM auth_identities WHERE kind <> 'password') THEN
        RAISE EXCEPTION 'cannot downgrade while non-password authentication identities exist';
    END IF;
END $$;
-- +goose StatementEnd

DROP INDEX auth_identities_account_idx;
DROP INDEX auth_identities_oidc_subject_idx;
DROP INDEX auth_identities_pin_identifier_idx;
DROP INDEX auth_identities_password_identifier_idx;
DROP INDEX auth_identities_password_account_idx;

ALTER TABLE auth_identities DROP CONSTRAINT auth_identities_shape_check;
ALTER TABLE auth_identities DROP CONSTRAINT auth_identities_identifier_normalized_check;
ALTER TABLE auth_identities DROP CONSTRAINT auth_identities_identifier_display_check;
ALTER TABLE auth_identities DROP CONSTRAINT auth_identities_kind_check;
ALTER TABLE auth_identities DROP COLUMN last_used_at;
ALTER TABLE auth_identities DROP COLUMN disabled_at;
ALTER TABLE auth_identities DROP COLUMN verified_at;
ALTER TABLE auth_identities DROP COLUMN subject;
ALTER TABLE auth_identities DROP COLUMN issuer;
ALTER TABLE auth_identities DROP COLUMN provider_id;

UPDATE auth_identities SET kind = 'email_password' WHERE kind = 'password';

ALTER TABLE auth_identities ALTER COLUMN identifier_display SET NOT NULL;
ALTER TABLE auth_identities ALTER COLUMN identifier_normalized SET NOT NULL;
ALTER TABLE auth_identities
    ADD CONSTRAINT auth_identities_kind_check CHECK (kind = 'email_password'),
    ADD CONSTRAINT auth_identities_identifier_display_check CHECK (
        identifier_display = btrim(identifier_display) AND identifier_display <> '' AND length(identifier_display) <= 254
    ),
    ADD CONSTRAINT auth_identities_identifier_normalized_check CHECK (
        identifier_normalized = btrim(identifier_normalized) AND identifier_normalized <> '' AND length(identifier_normalized) <= 254
    ),
    ADD CONSTRAINT auth_identities_account_id_kind_key UNIQUE (account_id, kind),
    ADD CONSTRAINT auth_identities_kind_identifier_normalized_key UNIQUE (kind, identifier_normalized);

ALTER TABLE accounts DROP COLUMN first_authenticated_at;
ALTER TABLE accounts DROP COLUMN provisioning_source;
