-- +goose Up
-- The application ships no notification rules: the rules migration 00115 seeded (system_key set) are removed, so
-- only rules staff create are sent. Their preferences, firings and throttles go with them; notifications already
-- written keep their text and lose only the link to the rule.
DELETE FROM notification_rules WHERE system_key IS NOT NULL;

-- +goose Down
-- The removed rules are not restored.
SELECT 1;
