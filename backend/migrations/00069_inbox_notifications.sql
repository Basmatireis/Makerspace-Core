-- +goose Up
-- In-app notifications: a notification is written once and fanned out to one recipient row per account at the moment
-- it is created (recipients are a snapshot). Manual messages remember which roles they were sent to for the sent list.
CREATE TABLE inbox_notifications (
    id uuid PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN (
        'message',
        'lab_rules_confirmation_requested',
        'open_day_period_open',
        'open_day_place_freed',
        'run_finished'
    )),
    title text NOT NULL CHECK (title = btrim(title) AND title <> '' AND char_length(title) <= 120),
    body text NOT NULL CHECK (body = btrim(body) AND body <> '' AND char_length(body) <= 2000),
    link text CHECK (link IS NULL OR (link LIKE '/%' AND link NOT LIKE '//%' AND char_length(link) <= 500)),
    created_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    CHECK (expires_at > created_at)
);

CREATE INDEX inbox_notifications_expires_idx ON inbox_notifications (expires_at);
CREATE INDEX inbox_notifications_messages_idx ON inbox_notifications (created_at DESC, id DESC) WHERE kind = 'message';

CREATE TABLE inbox_notification_roles (
    notification_id uuid NOT NULL REFERENCES inbox_notifications(id) ON DELETE CASCADE,
    role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (notification_id, role_id)
);

CREATE INDEX inbox_notification_roles_role_idx ON inbox_notification_roles (role_id);

CREATE TABLE inbox_recipients (
    notification_id uuid NOT NULL REFERENCES inbox_notifications(id) ON DELETE CASCADE,
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    read_at timestamptz,
    PRIMARY KEY (notification_id, account_id)
);

CREATE INDEX inbox_recipients_account_idx ON inbox_recipients (account_id, read_at);

-- +goose Down
DROP TABLE inbox_recipients;
DROP TABLE inbox_notification_roles;
DROP TABLE inbox_notifications;
