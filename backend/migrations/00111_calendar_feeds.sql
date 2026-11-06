-- +goose Up
-- A person's private calendar subscription: one secret link per person that serves their open-day timeslots and event
-- shifts as iCalendar. Only the digest of the link's token is stored; creating a new link replaces the old one.
CREATE TABLE calendar_feeds (
    person_id uuid PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
    token_digest bytea NOT NULL UNIQUE CHECK (octet_length(token_digest) = 32),
    created_at timestamptz NOT NULL,
    -- Coarse on purpose: updated at most once an hour.
    last_used_at timestamptz
);

-- Changes to a person's open days become notifications, in the app and by e-mail.
ALTER TABLE inbox_notifications DROP CONSTRAINT inbox_notifications_kind_check;
ALTER TABLE inbox_notifications
    ADD CONSTRAINT inbox_notifications_kind_check CHECK (kind IN (
        'message',
        'lab_rules_published',
        'open_day_period_open',
        'open_day_place_freed',
        'open_day_timeslot_changed',
        'open_day_timeslot_removed',
        'open_day_cancelled',
        'open_day_assigned_by_other',
        'open_day_unassigned_by_other',
        'run_finished',
        'printer_error',
        'filament_change'
    ));
ALTER TABLE notification_mail_outbox DROP CONSTRAINT notification_mail_outbox_kind_check;
ALTER TABLE notification_mail_outbox
    ADD CONSTRAINT notification_mail_outbox_kind_check CHECK (kind IN (
        'printer_error',
        'run_finished',
        'filament_change',
        'lab_rules_published',
        'open_day_timeslot_changed',
        'open_day_timeslot_removed',
        'open_day_cancelled',
        'open_day_assigned_by_other',
        'open_day_unassigned_by_other'
    ));

-- +goose Down
DELETE FROM notification_mail_outbox WHERE kind LIKE 'open_day_%';
ALTER TABLE notification_mail_outbox DROP CONSTRAINT notification_mail_outbox_kind_check;
ALTER TABLE notification_mail_outbox
    ADD CONSTRAINT notification_mail_outbox_kind_check
        CHECK (kind IN ('printer_error', 'run_finished', 'filament_change', 'lab_rules_published'));
DELETE FROM inbox_notifications
WHERE kind IN (
    'open_day_timeslot_changed',
    'open_day_timeslot_removed',
    'open_day_cancelled',
    'open_day_assigned_by_other',
    'open_day_unassigned_by_other'
);
ALTER TABLE inbox_notifications DROP CONSTRAINT inbox_notifications_kind_check;
ALTER TABLE inbox_notifications
    ADD CONSTRAINT inbox_notifications_kind_check CHECK (kind IN (
        'message',
        'lab_rules_published',
        'open_day_period_open',
        'open_day_place_freed',
        'run_finished',
        'printer_error',
        'filament_change'
    ));
DROP TABLE calendar_feeds;
