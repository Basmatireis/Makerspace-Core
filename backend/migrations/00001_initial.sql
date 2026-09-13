-- +goose Up
CREATE TABLE people (
    id uuid PRIMARY KEY,
    first_name text NOT NULL CHECK (first_name = btrim(first_name) AND first_name <> '' AND length(first_name) <= 100),
    last_name text NOT NULL CHECK (last_name = btrim(last_name) AND last_name <> '' AND length(last_name) <= 100),
    email text CHECK (email IS NULL OR (email = btrim(email) AND email <> '' AND length(email) <= 254)),
    phone text CHECK (phone IS NULL OR (phone = btrim(phone) AND phone <> '' AND length(phone) <= 64)),
    matriculation_number text CHECK (matriculation_number IS NULL OR (matriculation_number = btrim(matriculation_number) AND matriculation_number <> '' AND length(matriculation_number) <= 64)),
    photo_reference text CHECK (photo_reference IS NULL OR (photo_reference = btrim(photo_reference) AND photo_reference <> '' AND length(photo_reference) <= 500)),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

CREATE INDEX people_name_idx ON people (lower(last_name), lower(first_name), id);
CREATE UNIQUE INDEX people_matriculation_number_unique_idx
    ON people (matriculation_number)
    WHERE matriculation_number IS NOT NULL;

CREATE TABLE accounts (
    id uuid PRIMARY KEY,
    person_id uuid NOT NULL UNIQUE REFERENCES people(id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'disabled' CHECK (status IN ('enabled', 'disabled')),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_identities (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind = 'email_password'),
    identifier_display text NOT NULL CHECK (identifier_display = btrim(identifier_display) AND identifier_display <> '' AND length(identifier_display) <= 254),
    identifier_normalized text NOT NULL CHECK (identifier_normalized = btrim(identifier_normalized) AND identifier_normalized <> '' AND length(identifier_normalized) <= 254),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (account_id, kind),
    UNIQUE (kind, identifier_normalized)
);

CREATE TABLE password_credentials (
    auth_identity_id uuid PRIMARY KEY REFERENCES auth_identities(id) ON DELETE CASCADE,
    password_hash text NOT NULL CHECK (password_hash <> ''),
    reset_required boolean NOT NULL DEFAULT false,
    changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE roles (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (name = btrim(name) AND name <> '' AND length(name) <= 100),
    description text CHECK (description IS NULL OR length(description) <= 500),
    system_key text UNIQUE CHECK (system_key IS NULL OR system_key = 'master'),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (system_key IS NULL OR name = 'master')
);

CREATE UNIQUE INDEX roles_name_ci_idx ON roles (lower(name));

INSERT INTO roles (id, name, description, system_key)
VALUES ('01995ea6-6d00-7000-8000-000000000001', 'master', 'Built-in unrestricted system role', 'master');

-- +goose StatementBegin
CREATE FUNCTION prevent_system_role_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.system_key IS NOT NULL THEN
            RAISE EXCEPTION 'system roles cannot be created' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF OLD.system_key IS NOT NULL OR NEW.system_key IS NOT NULL THEN
            RAISE EXCEPTION 'system roles are immutable' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.system_key IS NOT NULL THEN
        RAISE EXCEPTION 'system roles cannot be deleted' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
END;
$$;
-- +goose StatementEnd

CREATE TRIGGER roles_protect_system_role
BEFORE INSERT OR UPDATE OR DELETE ON roles
FOR EACH ROW EXECUTE FUNCTION prevent_system_role_mutation();

CREATE TABLE role_permissions (
    role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id text NOT NULL CHECK (permission_id <> '' AND length(permission_id) <= 128),
    PRIMARY KEY (role_id, permission_id)
);

-- +goose StatementBegin
CREATE FUNCTION prevent_master_role_permission_write() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM roles WHERE id = NEW.role_id AND system_key = 'master') THEN
        RAISE EXCEPTION 'master permissions are derived from application code' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
-- +goose StatementEnd

CREATE TRIGGER role_permissions_reject_master
BEFORE INSERT OR UPDATE ON role_permissions
FOR EACH ROW EXECUTE FUNCTION prevent_master_role_permission_write();

CREATE TABLE account_roles (
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    assigned_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    assigned_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, role_id)
);

CREATE INDEX account_roles_role_idx ON account_roles (role_id, account_id);

CREATE TABLE sessions (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    auth_identity_id uuid NOT NULL REFERENCES auth_identities(id) ON DELETE CASCADE,
    token_digest bytea NOT NULL UNIQUE CHECK (octet_length(token_digest) = 32),
    csrf_digest bytea NOT NULL CHECK (octet_length(csrf_digest) = 32),
    auth_method text NOT NULL CHECK (auth_method = 'password'),
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    idle_expires_at timestamptz NOT NULL,
    absolute_expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    revocation_reason text CHECK (revocation_reason IS NULL OR length(revocation_reason) <= 64),
    CHECK (idle_expires_at <= absolute_expires_at)
);

CREATE INDEX sessions_account_idx ON sessions (account_id);
CREATE INDEX sessions_expiry_idx ON sessions (absolute_expires_at);
CREATE INDEX sessions_idle_expiry_idx ON sessions (idle_expires_at);
CREATE INDEX sessions_revoked_at_idx ON sessions (revoked_at) WHERE revoked_at IS NOT NULL;

CREATE TABLE password_reset_tokens (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
    token_digest bytea NOT NULL UNIQUE CHECK (octet_length(token_digest) = 32),
    created_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    CHECK (expires_at > created_at)
);

CREATE INDEX password_reset_tokens_expiry_idx ON password_reset_tokens (expires_at);

CREATE TABLE audit_events (
    id uuid PRIMARY KEY,
    actor_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    action text NOT NULL CHECK (action <> '' AND length(action) <= 128),
    resource_type text NOT NULL CHECK (resource_type <> '' AND length(resource_type) <= 64),
    resource_id uuid,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    request_id uuid,
    changed_fields text[] NOT NULL DEFAULT '{}',
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
    source text NOT NULL DEFAULT 'http' CHECK (source IN ('http', 'admin_cli', 'system'))
);

CREATE INDEX audit_events_cursor_idx ON audit_events (occurred_at DESC, id DESC);
CREATE INDEX audit_events_actor_idx ON audit_events (actor_account_id, occurred_at DESC);
CREATE INDEX audit_events_resource_idx ON audit_events (resource_type, resource_id, occurred_at DESC);

-- +goose Down
DROP TABLE audit_events;
DROP TABLE password_reset_tokens;
DROP TABLE sessions;
DROP TABLE account_roles;
DROP TABLE role_permissions;
DROP TABLE roles;
DROP FUNCTION prevent_master_role_permission_write();
DROP FUNCTION prevent_system_role_mutation();
DROP TABLE password_credentials;
DROP TABLE auth_identities;
DROP TABLE accounts;
DROP TABLE people;
