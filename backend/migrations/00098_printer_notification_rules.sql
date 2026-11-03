-- +goose Up
-- Who is told about which printer event: the run's operator, the job's recipient, the people holding a role, and
-- whether by e-mail as well. min_severity filters printer errors only.
CREATE TABLE printer_notification_rules (
    event text PRIMARY KEY CHECK (event IN ('printer_error', 'run_finished', 'filament_change')),
    notify_operator boolean NOT NULL DEFAULT true,
    notify_recipient boolean NOT NULL DEFAULT false,
    role_id uuid REFERENCES roles(id) ON DELETE SET NULL,
    email boolean NOT NULL DEFAULT false,
    min_severity text CHECK (min_severity IS NULL OR min_severity IN ('fatal', 'serious', 'common', 'info')),
    CHECK (event = 'printer_error' OR min_severity IS NULL)
);
INSERT INTO printer_notification_rules (event, notify_operator, role_id, min_severity)
SELECT 'printer_error', true, error_role_id, error_min_severity FROM printer_notification_settings WHERE singleton;
INSERT INTO printer_notification_rules (event, notify_operator, role_id, min_severity)
SELECT 'printer_error', true, NULL, 'serious' WHERE NOT EXISTS (SELECT 1 FROM printer_notification_rules);
INSERT INTO printer_notification_rules (event, notify_operator) VALUES ('run_finished', true), ('filament_change', true);
ALTER TABLE printer_notification_settings DROP COLUMN error_role_id, DROP COLUMN error_min_severity;

-- E-mails of printer notifications wait here until the delivery job sent them; a row is deleted once sent or given
-- up. It names the person or organization, never an address: the address is read when the mail is sent, and a
-- recipient deleted in the meantime gets nothing. The ids carry no foreign key because a row lives for minutes.
CREATE TABLE notification_mail_outbox (
    id uuid PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('printer_error', 'run_finished', 'filament_change')),
    person_id uuid,
    organization_id uuid,
    subject text NOT NULL CHECK (subject <> '' AND length(subject) <= 200),
    body text NOT NULL CHECK (length(body) <= 2000),
    link text CHECK (link IS NULL OR (link LIKE '/%' AND length(link) <= 500)),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((person_id IS NULL) <> (organization_id IS NULL))
);
CREATE INDEX notification_mail_outbox_due_idx ON notification_mail_outbox (next_attempt_at, id);

-- +goose Down
DROP TABLE notification_mail_outbox;
ALTER TABLE printer_notification_settings
    ADD COLUMN error_role_id uuid REFERENCES roles(id) ON DELETE SET NULL,
    ADD COLUMN error_min_severity text NOT NULL DEFAULT 'serious'
        CHECK (error_min_severity IN ('fatal', 'serious', 'common', 'info'));
UPDATE printer_notification_settings s
SET error_role_id = r.role_id, error_min_severity = COALESCE(r.min_severity, 'serious')
FROM printer_notification_rules r WHERE r.event = 'printer_error';
DROP TABLE printer_notification_rules;
