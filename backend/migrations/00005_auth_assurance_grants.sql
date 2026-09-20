-- +goose Up
ALTER TABLE sessions
    ADD COLUMN base_assurance text NOT NULL DEFAULT 'normal'
        CHECK (base_assurance IN ('low', 'normal', 'strong', 'strong_mfa')),
    ADD COLUMN current_assurance text NOT NULL DEFAULT 'normal'
        CHECK (current_assurance IN ('low', 'normal', 'strong', 'strong_mfa')),
    ADD COLUMN authenticated_at timestamptz,
    ADD COLUMN assurance_expires_at timestamptz;

UPDATE sessions SET authenticated_at = created_at WHERE authenticated_at IS NULL;
ALTER TABLE sessions ALTER COLUMN authenticated_at SET NOT NULL;

CREATE TABLE role_permission_grants_new (
    id uuid PRIMARY KEY,
    role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id text NOT NULL CHECK (permission_id <> '' AND length(permission_id) <= 128),
    scope text NOT NULL DEFAULT 'global' CHECK (scope IN ('global', 'managed_device', 'device_type')),
    minimum_assurance text NOT NULL DEFAULT 'low'
        CHECK (minimum_assurance IN ('low', 'normal', 'strong', 'strong_mfa')),
    UNIQUE (id, role_id)
);

INSERT INTO role_permission_grants_new (id, role_id, permission_id, scope, minimum_assurance)
SELECT uuidv7(), role_id, permission_id, scope, 'low' FROM role_permissions;

CREATE TABLE role_permission_grant_device_types_new (
    grant_id uuid NOT NULL REFERENCES role_permission_grants_new(id) ON DELETE CASCADE,
    device_type_id uuid NOT NULL REFERENCES device_types(id) ON DELETE RESTRICT,
    PRIMARY KEY (grant_id, device_type_id)
);

INSERT INTO role_permission_grant_device_types_new (grant_id, device_type_id)
SELECT g.id, old.device_type_id
FROM role_permission_device_types old
JOIN role_permission_grants_new g
  ON g.role_id = old.role_id AND g.permission_id = old.permission_id;

DROP TABLE role_permission_device_types;
DROP TABLE role_permissions;
ALTER TABLE role_permission_grants_new RENAME TO role_permission_grants;
ALTER TABLE role_permission_grant_device_types_new RENAME TO role_permission_grant_device_types;

CREATE INDEX role_permission_grants_role_idx
    ON role_permission_grants (role_id, permission_id, id);
CREATE INDEX role_permission_grant_device_types_type_idx
    ON role_permission_grant_device_types (device_type_id, grant_id);

CREATE TRIGGER role_permission_grants_reject_master
BEFORE INSERT OR UPDATE ON role_permission_grants
FOR EACH ROW EXECUTE FUNCTION prevent_master_role_permission_write();

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM role_permission_grants
        GROUP BY role_id, permission_id HAVING count(*) > 1
    ) OR EXISTS (
        SELECT 1 FROM role_permission_grants WHERE minimum_assurance <> 'low'
    ) THEN
        RAISE EXCEPTION 'cannot downgrade grants that use multiple alternatives or authentication assurance';
    END IF;
END $$;
-- +goose StatementEnd

DROP TRIGGER role_permission_grants_reject_master ON role_permission_grants;

CREATE TABLE role_permissions (
    role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id text NOT NULL CHECK (permission_id <> '' AND length(permission_id) <= 128),
    scope text NOT NULL DEFAULT 'global' CHECK (scope IN ('global', 'managed_device', 'device_type')),
    PRIMARY KEY (role_id, permission_id)
);

INSERT INTO role_permissions (role_id, permission_id, scope)
SELECT role_id, permission_id, scope FROM role_permission_grants;

CREATE TABLE role_permission_device_types (
    role_id uuid NOT NULL,
    permission_id text NOT NULL,
    device_type_id uuid NOT NULL REFERENCES device_types(id) ON DELETE RESTRICT,
    PRIMARY KEY (role_id, permission_id, device_type_id),
    FOREIGN KEY (role_id, permission_id)
        REFERENCES role_permissions(role_id, permission_id) ON DELETE CASCADE
);

INSERT INTO role_permission_device_types (role_id, permission_id, device_type_id)
SELECT g.role_id, g.permission_id, dt.device_type_id
FROM role_permission_grant_device_types dt
JOIN role_permission_grants g ON g.id = dt.grant_id;

DROP TABLE role_permission_grant_device_types;
DROP TABLE role_permission_grants;

CREATE INDEX role_permission_device_types_type_idx
    ON role_permission_device_types (device_type_id, role_id, permission_id);

CREATE TRIGGER role_permissions_reject_master
BEFORE INSERT OR UPDATE ON role_permissions
FOR EACH ROW EXECUTE FUNCTION prevent_master_role_permission_write();

ALTER TABLE sessions DROP COLUMN assurance_expires_at;
ALTER TABLE sessions DROP COLUMN authenticated_at;
ALTER TABLE sessions DROP COLUMN current_assurance;
ALTER TABLE sessions DROP COLUMN base_assurance;
