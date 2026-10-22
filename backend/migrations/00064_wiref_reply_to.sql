-- +goose Up
-- Optional Reply-To address for the wiRef mail. Empty means none, so replies go to the mail sender address.
ALTER TABLE wiref_delivery_settings
    ADD COLUMN reply_to_email text NOT NULL DEFAULT '' CHECK (length(reply_to_email) <= 254);

-- +goose Down
ALTER TABLE wiref_delivery_settings DROP COLUMN reply_to_email;
