-- +goose Up
ALTER TABLE accounts ADD COLUMN administratively_disabled_at timestamptz;

CREATE TABLE auth_challenges (
    id uuid PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('invitation', 'email_verification', 'password_reset', 'pin_enrollment')),
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    auth_identity_id uuid REFERENCES auth_identities(id) ON DELETE CASCADE,
    code_digest bytea NOT NULL UNIQUE CHECK (octet_length(code_digest) = 32),
    delivery_address text NOT NULL CHECK (delivery_address = btrim(delivery_address) AND delivery_address <> '' AND length(delivery_address) <= 254),
    attempt_count smallint NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
    created_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    cancelled_at timestamptz,
    delivery_status text NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending', 'sent', 'failed')),
    delivery_attempted_at timestamptz,
    delivery_failure_code text CHECK (delivery_failure_code IS NULL OR (delivery_failure_code <> '' AND length(delivery_failure_code) <= 64)),
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (expires_at > created_at),
    CHECK (NOT (used_at IS NOT NULL AND cancelled_at IS NOT NULL)),
    UNIQUE (account_id, kind)
);

CREATE INDEX auth_challenges_expiry_idx ON auth_challenges (expires_at);
CREATE INDEX auth_challenges_identity_idx ON auth_challenges (auth_identity_id, kind) WHERE auth_identity_id IS NOT NULL;

CREATE TABLE auth_rate_limits (
    action text NOT NULL CHECK (action <> '' AND length(action) <= 64),
    key_digest bytea NOT NULL CHECK (octet_length(key_digest) = 32),
    window_started_at timestamptz NOT NULL,
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    blocked_until timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (action, key_digest)
);

CREATE INDEX auth_rate_limits_cleanup_idx ON auth_rate_limits (updated_at);

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM auth_challenges) THEN
        RAISE EXCEPTION 'cannot downgrade while reusable authentication challenges exist';
    END IF;
END $$;
-- +goose StatementEnd

DROP TABLE auth_rate_limits;
DROP TABLE auth_challenges;
ALTER TABLE accounts DROP COLUMN administratively_disabled_at;
