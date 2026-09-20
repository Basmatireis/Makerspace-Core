-- +goose Up
CREATE TABLE oidc_providers (
    id uuid PRIMARY KEY,
    slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
    display_name text NOT NULL CHECK (display_name = btrim(display_name) AND display_name <> '' AND length(display_name) <= 100),
    issuer text NOT NULL CHECK (issuer = btrim(issuer) AND issuer <> '' AND length(issuer) <= 500),
    client_id text NOT NULL CHECK (client_id = btrim(client_id) AND client_id <> '' AND length(client_id) <= 255),
    encrypted_client_secret bytea NOT NULL,
    enabled boolean NOT NULL DEFAULT false,
    jit_enabled boolean NOT NULL DEFAULT false,
    acr_assurance_mappings jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(acr_assurance_mappings) = 'object'),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX oidc_providers_slug_idx ON oidc_providers (slug);
CREATE UNIQUE INDEX oidc_providers_issuer_idx ON oidc_providers (issuer);

ALTER TABLE auth_identities ADD CONSTRAINT auth_identities_provider_fk
    FOREIGN KEY (provider_id) REFERENCES oidc_providers(id) ON DELETE RESTRICT;

CREATE TABLE oidc_flows (
    id uuid PRIMARY KEY,
    provider_id uuid NOT NULL REFERENCES oidc_providers(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('login', 'link')),
    account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,
    state_digest bytea NOT NULL UNIQUE CHECK (octet_length(state_digest) = 32),
    browser_token_digest bytea NOT NULL UNIQUE CHECK (octet_length(browser_token_digest) = 32),
    encrypted_nonce bytea NOT NULL,
    encrypted_pkce_verifier bytea NOT NULL,
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((kind = 'login' AND account_id IS NULL) OR (kind = 'link' AND account_id IS NOT NULL)),
    CHECK (expires_at > created_at)
);
CREATE INDEX oidc_flows_expiry_idx ON oidc_flows (expires_at);

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM auth_identities WHERE kind = 'oidc') THEN
        RAISE EXCEPTION 'cannot downgrade while OIDC identities exist';
    END IF;
END $$;
-- +goose StatementEnd
DROP TABLE oidc_flows;
ALTER TABLE auth_identities DROP CONSTRAINT auth_identities_provider_fk;
DROP TABLE oidc_providers;
