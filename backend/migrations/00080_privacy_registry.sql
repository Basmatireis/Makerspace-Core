-- +goose Up
-- Privacy registry: the installation-wide settings of the privacy module and
-- a persisted view of the data categories that modules (and later plugins)
-- declared. Definitions live in application code; the snapshot keeps a
-- category visible after its module was disabled or its plugin removed, so
-- retention and data-subject requests still cover it.
CREATE TABLE privacy_settings (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    controller_name text NOT NULL DEFAULT '' CHECK (length(controller_name) <= 200),
    controller_address text NOT NULL DEFAULT '' CHECK (length(controller_address) <= 1000),
    data_protection_contact text NOT NULL DEFAULT '' CHECK (length(data_protection_contact) <= 500),
    -- Automatic retention runs stay off until the operator turns them on deliberately;
    -- `admin cleanup` remains the scheduled production path until then.
    automatic_runs_enabled boolean NOT NULL DEFAULT false,
    run_interval_minutes integer NOT NULL DEFAULT 60 CHECK (run_interval_minutes BETWEEN 5 AND 1440),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    updated_at timestamptz,
    updated_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL
);
INSERT INTO privacy_settings (singleton) VALUES (true);

CREATE TABLE privacy_category_snapshots (
    category_id text PRIMARY KEY CHECK (category_id ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$'),
    owner_module_id text NOT NULL CHECK (owner_module_id ~ '^[a-z][a-z0-9_]{1,39}$'),
    definition jsonb NOT NULL,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    -- orphaned: the category is no longer declared by any module or plugin but data may remain.
    orphaned boolean NOT NULL DEFAULT false
);

INSERT INTO master_reauthentication_permissions (permission_id, within_minutes) VALUES ('privacy.settings.manage', 10)
ON CONFLICT (permission_id) DO NOTHING;

-- +goose Down
DELETE FROM master_reauthentication_permissions WHERE permission_id = 'privacy.settings.manage';
DELETE FROM role_permission_grants WHERE permission_id IN ('privacy.read', 'privacy.settings.manage');
DROP TABLE privacy_category_snapshots;
DROP TABLE privacy_settings;
