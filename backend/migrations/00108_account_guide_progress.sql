-- +goose Up
-- Which in-app guided tours an account has completed or dismissed. A UI preference: no audit, deleted with the account.
CREATE TABLE account_guide_progress (
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    guide_id text NOT NULL CHECK (guide_id ~ '^[a-z][a-z0-9-]{0,63}$'),
    status text NOT NULL CHECK (status IN ('completed', 'dismissed')),
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (account_id, guide_id)
);

-- +goose Down
DROP TABLE account_guide_progress;
