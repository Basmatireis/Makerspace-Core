-- +goose Up
CREATE TABLE visitor_enrollment_configuration (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    enabled boolean NOT NULL DEFAULT false,
    initial_role_id uuid REFERENCES roles(id) ON DELETE RESTRICT,
    allowed_methods text[] NOT NULL DEFAULT '{}' CHECK (allowed_methods <@ ARRAY['password', 'pin']::text[]),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    updated_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (NOT enabled OR (initial_role_id IS NOT NULL AND cardinality(allowed_methods) > 0))
);

INSERT INTO visitor_enrollment_configuration (singleton) VALUES (true);

CREATE TABLE visitor_enrollment_device_types (
    device_type_id uuid PRIMARY KEY REFERENCES device_types(id) ON DELETE RESTRICT
);

CREATE TABLE visitor_enrollment_contexts (
    id uuid PRIMARY KEY,
    managed_device_id uuid NOT NULL REFERENCES managed_devices(id) ON DELETE CASCADE,
    token_digest bytea NOT NULL UNIQUE CHECK (octet_length(token_digest) = 32),
    csrf_digest bytea NOT NULL CHECK (octet_length(csrf_digest) = 32),
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (expires_at > created_at)
);

CREATE INDEX visitor_enrollment_contexts_expiry_idx ON visitor_enrollment_contexts (expires_at);

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM accounts WHERE provisioning_source = 'visitor') THEN
        RAISE EXCEPTION 'cannot downgrade while visitor-provisioned accounts exist';
    END IF;
END $$;
-- +goose StatementEnd
DROP TABLE visitor_enrollment_contexts;
DROP TABLE visitor_enrollment_device_types;
DROP TABLE visitor_enrollment_configuration;
