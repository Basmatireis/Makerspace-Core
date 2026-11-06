-- +goose Up
-- When a granted consent was withdrawn. Only a granted answer that turned into a "no" has a value (a first "no" is a
-- decline, not a withdrawal); the withdrawal is kept as proof for three years and then deleted by the retention run.
ALTER TABLE notification_consents ADD COLUMN withdrawn_at timestamptz;
ALTER TABLE notification_consents ADD CONSTRAINT notification_consents_withdrawn_check CHECK (withdrawn_at IS NULL OR NOT granted);
CREATE INDEX notification_consents_withdrawn_idx ON notification_consents (withdrawn_at) WHERE withdrawn_at IS NOT NULL;

-- +goose Down
DROP INDEX notification_consents_withdrawn_idx;
ALTER TABLE notification_consents DROP COLUMN withdrawn_at;
