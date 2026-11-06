-- +goose Up
-- How an in-app notification shows up (the rule action's in-app options) and how far it got on each recipient's
-- screen. Rows from before this migration keep today's behaviour: they appear as toasts, and they count as delivered so
-- that nobody gets a burst of old pop-ups when the poll starts reporting them.
ALTER TABLE inbox_notifications
    ADD COLUMN appearance text NOT NULL DEFAULT 'toast' CHECK (appearance IN ('bell', 'toast', 'banner', 'dialog')),
    ADD COLUMN level text NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'success', 'warning', 'error')),
    -- Seconds a toast stays; 0 keeps it until it is closed, NULL means the default.
    ADD COLUMN toast_seconds integer CHECK (toast_seconds IS NULL OR toast_seconds BETWEEN 0 AND 3600),
    ADD COLUMN button_kind text NOT NULL DEFAULT 'none' CHECK (button_kind IN ('none', 'ok', 'acknowledge', 'link')),
    ADD COLUMN button_label text CHECK (button_label IS NULL OR char_length(button_label) <= 40),
    ADD COLUMN button_link text CHECK (button_link IS NULL OR char_length(button_link) <= 500),
    ADD COLUMN only_button_closes boolean NOT NULL DEFAULT false,
    ADD COLUMN allow_later boolean NOT NULL DEFAULT false,
    ADD CONSTRAINT inbox_notifications_button_link_required_check CHECK ((button_kind = 'link') = (button_link IS NOT NULL));

ALTER TABLE inbox_recipients
    ADD COLUMN delivered_at timestamptz,
    ADD COLUMN seen_at timestamptz,
    ADD COLUMN acknowledged_at timestamptz,
    ADD COLUMN snoozed_until timestamptz;
UPDATE inbox_recipients SET delivered_at = now();
-- Notifications that were not delivered yet, found by the poll.
CREATE INDEX inbox_recipients_undelivered_idx ON inbox_recipients (account_id) WHERE delivered_at IS NULL;

-- When an account last had the application open in a visible tab: only the latest time, no history.
CREATE TABLE account_presence (
    account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    last_visible_at timestamptz NOT NULL
);

ALTER TABLE notification_firing_recipients DROP CONSTRAINT notification_firing_recipients_status_check;
ALTER TABLE notification_firing_recipients
    ADD CONSTRAINT notification_firing_recipients_status_check CHECK (status IN (
        'sent', 'skipped_consent', 'skipped_muted', 'skipped_condition', 'throttled', 'fallback', 'skipped_offline'
    ));

-- +goose Down
DELETE FROM notification_firing_recipients WHERE status = 'skipped_offline';
ALTER TABLE notification_firing_recipients DROP CONSTRAINT notification_firing_recipients_status_check;
ALTER TABLE notification_firing_recipients
    ADD CONSTRAINT notification_firing_recipients_status_check CHECK (status IN (
        'sent', 'skipped_consent', 'skipped_muted', 'skipped_condition', 'throttled', 'fallback'
    ));
DROP TABLE account_presence;
DROP INDEX inbox_recipients_undelivered_idx;
ALTER TABLE inbox_recipients
    DROP COLUMN snoozed_until,
    DROP COLUMN acknowledged_at,
    DROP COLUMN seen_at,
    DROP COLUMN delivered_at;
ALTER TABLE inbox_notifications
    DROP CONSTRAINT inbox_notifications_button_link_required_check,
    DROP COLUMN allow_later,
    DROP COLUMN only_button_closes,
    DROP COLUMN button_link,
    DROP COLUMN button_label,
    DROP COLUMN button_kind,
    DROP COLUMN toast_seconds,
    DROP COLUMN level,
    DROP COLUMN appearance;
