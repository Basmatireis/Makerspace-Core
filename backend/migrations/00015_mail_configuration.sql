-- +goose Up
CREATE TABLE mail_configuration (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    enabled boolean NOT NULL DEFAULT false,
    provider text NOT NULL DEFAULT 'smtp' CHECK (provider = 'smtp'),
    smtp_host text NOT NULL DEFAULT '',
    smtp_port integer NOT NULL DEFAULT 587 CHECK (smtp_port BETWEEN 1 AND 65535),
    smtp_tls_mode text NOT NULL DEFAULT 'starttls' CHECK (smtp_tls_mode IN ('starttls', 'tls', 'none')),
    smtp_username text NOT NULL DEFAULT '',
    encrypted_smtp_password bytea,
    from_address text NOT NULL DEFAULT '',
    from_name text NOT NULL DEFAULT '',
    base_url text NOT NULL DEFAULT '',
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    updated_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO mail_configuration (singleton) VALUES (true);

ALTER TABLE auth_challenges DROP CONSTRAINT auth_challenges_delivery_status_check;
ALTER TABLE auth_challenges ADD CONSTRAINT auth_challenges_delivery_status_check
    CHECK (delivery_status IN ('pending', 'sent', 'failed', 'manual'));

-- Mail configuration intentionally starts disabled. Previous environment
-- secrets are never copied into the database by a migration.

-- +goose Down
ALTER TABLE auth_challenges DROP CONSTRAINT auth_challenges_delivery_status_check;
ALTER TABLE auth_challenges ADD CONSTRAINT auth_challenges_delivery_status_check
    CHECK (delivery_status IN ('pending', 'sent', 'failed'));
DROP TABLE mail_configuration;
