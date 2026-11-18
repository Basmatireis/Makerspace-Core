-- +goose Up
-- The tablet's check-out feedback no longer has its own switch, and surveys reach people by e-mail or push
-- notification, not "in the app". Reword the Surveys & feedback consent description to match. The consent itself is
-- unchanged, so text_version is left as is and nobody is asked to consent again.
UPDATE notification_categories
SET description = 'Surveys we send you by e-mail or push notification, about your visit or an open day.',
    updated_at = now()
WHERE key = 'surveys';

-- +goose Down
UPDATE notification_categories
SET description = 'Surveys we send you by e-mail or in the app, about your visit or an open day. The tablet may still ask once at '
    || 'check-out; that has its own switch.',
    updated_at = now()
WHERE key = 'surveys';
