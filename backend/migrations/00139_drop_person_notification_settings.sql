-- +goose Up
-- The per-person "feedback at check-out" opt-out is gone: the tablet always offers a minute of feedback at check-out
-- (subject to the survey cooldown). Its only real column lived in this table, so the whole table goes.
-- squawk-ignore ban-drop-table
DROP TABLE person_notification_settings;

-- +goose Down
CREATE TABLE person_notification_settings (
    person_id uuid PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
    -- Whether the tablet may offer the visit survey at check-out.
    ask_feedback_at_checkout boolean NOT NULL DEFAULT true,
    updated_at timestamptz NOT NULL DEFAULT now()
);
