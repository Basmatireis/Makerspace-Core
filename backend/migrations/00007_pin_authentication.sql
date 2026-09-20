-- +goose Up
ALTER TABLE sessions DROP CONSTRAINT sessions_auth_method_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_auth_method_check CHECK (auth_method IN ('password', 'pin', 'oidc'));

CREATE UNIQUE INDEX auth_identities_pin_account_idx
    ON auth_identities (account_id) WHERE kind = 'pin';

CREATE TABLE pin_credentials (
    auth_identity_id uuid PRIMARY KEY REFERENCES auth_identities(id) ON DELETE CASCADE,
    pin_hash text NOT NULL CHECK (pin_hash <> ''),
    changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pin_login_throttles (
    dimension text NOT NULL CHECK (dimension IN ('login_name', 'source')),
    key_digest bytea NOT NULL CHECK (octet_length(key_digest) = 32),
    failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
    blocked_until timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (dimension, key_digest)
);

CREATE INDEX pin_login_throttles_cleanup_idx ON pin_login_throttles (updated_at);

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM auth_identities WHERE kind = 'pin') THEN
        RAISE EXCEPTION 'cannot downgrade while PIN identities exist';
    END IF;
END $$;
-- +goose StatementEnd

DROP TABLE pin_login_throttles;
DROP TABLE pin_credentials;
DROP INDEX auth_identities_pin_account_idx;
ALTER TABLE sessions DROP CONSTRAINT sessions_auth_method_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_auth_method_check CHECK (auth_method = 'password');
