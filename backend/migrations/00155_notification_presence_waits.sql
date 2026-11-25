-- +goose Up
-- When an account last had the application open in a visible tab on a managed device: only the latest time per
-- device, no history. In-app rule actions limited to devices or device types read it.
CREATE TABLE account_device_presence (
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    managed_device_id uuid NOT NULL REFERENCES managed_devices(id) ON DELETE CASCADE,
    last_visible_at timestamptz NOT NULL,
    PRIMARY KEY (account_id, managed_device_id)
);
CREATE INDEX account_device_presence_device_idx ON account_device_presence (managed_device_id);

-- In-app notifications that wait for their recipient to open the application (on a chosen device, if the action
-- names devices). Each row is one person of one firing; it is delivered by the person's next poll while the firing is
-- unresolved and the row has not expired. The action and the event's field values (identifiers only) are kept to
-- check the rule's conditions again on delivery.
CREATE TABLE notification_presence_waits (
    id uuid PRIMARY KEY,
    firing_id uuid NOT NULL REFERENCES notification_firings(id) ON DELETE CASCADE,
    person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    step integer NOT NULL DEFAULT 0 CHECK (step BETWEEN 0 AND 5),
    action jsonb NOT NULL CHECK (jsonb_typeof(action) = 'object'),
    item jsonb CHECK (item IS NULL OR jsonb_typeof(item) = 'object'),
    -- The "waiting" line of the delivery log, replaced on delivery and marked as not online on expiry.
    log_id uuid REFERENCES notification_firing_recipients(id) ON DELETE SET NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL
);
CREATE INDEX notification_presence_waits_person_idx ON notification_presence_waits (person_id, expires_at);
CREATE INDEX notification_presence_waits_firing_idx ON notification_presence_waits (firing_id);
CREATE INDEX notification_presence_waits_expires_idx ON notification_presence_waits (expires_at);

ALTER TABLE notification_firing_recipients DROP CONSTRAINT notification_firing_recipients_status_check;
ALTER TABLE notification_firing_recipients
    ADD CONSTRAINT notification_firing_recipients_status_check CHECK (status IN (
        'sent', 'skipped_consent', 'skipped_muted', 'skipped_condition', 'throttled', 'fallback', 'skipped_offline',
        'waiting'
    ));

-- +goose Down
UPDATE notification_firing_recipients SET status = 'skipped_offline' WHERE status = 'waiting';
ALTER TABLE notification_firing_recipients DROP CONSTRAINT notification_firing_recipients_status_check;
ALTER TABLE notification_firing_recipients
    ADD CONSTRAINT notification_firing_recipients_status_check CHECK (status IN (
        'sent', 'skipped_consent', 'skipped_muted', 'skipped_condition', 'throttled', 'fallback', 'skipped_offline'
    ));
DROP TABLE notification_presence_waits;
DROP TABLE account_device_presence;
