-- +goose Up
CREATE TABLE device_types (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (name = btrim(name) AND name <> '' AND length(name) <= 100),
    description text CHECK (description IS NULL OR length(description) <= 500),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX device_types_name_ci_idx ON device_types (lower(name));

CREATE TABLE managed_devices (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (name = btrim(name) AND name <> '' AND length(name) <= 100),
    device_type_id uuid NOT NULL REFERENCES device_types(id) ON DELETE RESTRICT,
    token_digest bytea NOT NULL UNIQUE CHECK (octet_length(token_digest) = 32),
    expires_at timestamptz,
    revoked_at timestamptz,
    last_seen_at timestamptz,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX managed_devices_name_ci_idx ON managed_devices (lower(name));
CREATE INDEX managed_devices_type_idx ON managed_devices (device_type_id, id);
CREATE INDEX managed_devices_validity_idx ON managed_devices (expires_at) WHERE revoked_at IS NULL;

ALTER TABLE role_permissions
    ADD COLUMN scope text NOT NULL DEFAULT 'global'
    CHECK (scope IN ('global', 'managed_device', 'device_type'));

CREATE TABLE role_permission_device_types (
    role_id uuid NOT NULL,
    permission_id text NOT NULL,
    device_type_id uuid NOT NULL REFERENCES device_types(id) ON DELETE RESTRICT,
    PRIMARY KEY (role_id, permission_id, device_type_id),
    FOREIGN KEY (role_id, permission_id)
        REFERENCES role_permissions(role_id, permission_id) ON DELETE CASCADE
);

CREATE INDEX role_permission_device_types_type_idx
    ON role_permission_device_types (device_type_id, role_id, permission_id);

-- +goose Down
DROP TABLE role_permission_device_types;
ALTER TABLE role_permissions DROP COLUMN scope;
DROP TABLE managed_devices;
DROP TABLE device_types;
