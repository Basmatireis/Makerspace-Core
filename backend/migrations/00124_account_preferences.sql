-- +goose Up
-- Small per-account interface choices that should follow the person to every device, such as whether the open-day
-- pages show the list or the calendar. The allowed keys and values are enforced in application code. A UI
-- preference: no audit, deleted with the account.
CREATE TABLE account_preferences (
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    key text NOT NULL CHECK (key ~ '^[a-zA-Z][a-zA-Z0-9.]{0,63}$'),
    value text NOT NULL CHECK (char_length(value) BETWEEN 1 AND 64),
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (account_id, key)
);

-- +goose Down
DROP TABLE account_preferences;
