-- +goose Up
CREATE TABLE scim_connectors (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (name = btrim(name) AND name <> '' AND length(name) <= 100),
    oidc_provider_id uuid REFERENCES oidc_providers(id) ON DELETE RESTRICT,
    enabled boolean NOT NULL DEFAULT true,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX scim_connectors_name_ci_idx ON scim_connectors (lower(name));

CREATE TABLE scim_connector_tokens (
    id uuid PRIMARY KEY,
    connector_id uuid NOT NULL REFERENCES scim_connectors(id) ON DELETE CASCADE,
    token_digest bytea NOT NULL UNIQUE CHECK (octet_length(token_digest) = 32),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    last_used_at timestamptz,
    created_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX scim_connector_one_active_token_idx
    ON scim_connector_tokens (connector_id) WHERE revoked_at IS NULL;
CREATE INDEX scim_connector_tokens_expiry_idx ON scim_connector_tokens (expires_at);

CREATE TABLE scim_users (
    id uuid PRIMARY KEY,
    connector_id uuid NOT NULL REFERENCES scim_connectors(id) ON DELETE CASCADE,
    person_id uuid NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    external_id text CHECK (external_id IS NULL OR (external_id = btrim(external_id) AND external_id <> '' AND length(external_id) <= 255)),
    user_name text NOT NULL CHECK (user_name = btrim(user_name) AND user_name <> '' AND length(user_name) <= 255),
    provisioning_data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(provisioning_data) = 'object'),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (connector_id, person_id),
    UNIQUE (connector_id, account_id)
);
CREATE UNIQUE INDEX scim_users_external_id_idx ON scim_users (connector_id, external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX scim_users_user_name_ci_idx ON scim_users (connector_id, lower(user_name));
CREATE INDEX scim_users_connector_cursor_idx ON scim_users (connector_id, id);

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM scim_users) THEN
        RAISE EXCEPTION 'cannot downgrade while SCIM mappings exist';
    END IF;
END $$;
-- +goose StatementEnd
DROP TABLE scim_users;
DROP TABLE scim_connector_tokens;
DROP TABLE scim_connectors;
