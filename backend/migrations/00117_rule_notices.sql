-- +goose Up
-- Notices a notification rule puts on signage displays and on entrance tablets. They are separate from the announcement
-- templates: a rule notice is plain text for a few minutes (or until its firing is resolved), shown above whatever the
-- display plays, and it never carries media.
CREATE TABLE signage_rule_notices (
    id uuid PRIMARY KEY,
    firing_id uuid REFERENCES notification_firings(id) ON DELETE SET NULL,
    display_id uuid NOT NULL REFERENCES signage_displays(id) ON DELETE CASCADE,
    title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
    body text NOT NULL CHECK (char_length(body) <= 2000),
    tone text NOT NULL CHECK (tone IN ('info', 'warning', 'critical')),
    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL,
    CHECK (ends_at > starts_at)
);
CREATE INDEX signage_rule_notices_display_idx ON signage_rule_notices (display_id, ends_at);
CREATE INDEX signage_rule_notices_firing_idx ON signage_rule_notices (firing_id) WHERE firing_id IS NOT NULL;
CREATE INDEX signage_rule_notices_ends_idx ON signage_rule_notices (ends_at);

-- Notices for entrance tablets. 'banner' shows on the start screen, 'everyone_today' on the result screen of every
-- check-in until the end of the day, 'person_checkin' on the result screen of one person's check-in right now and
-- 'next_checkin' on the result screen of one person's next check-in at any of the chosen tablets. One delivery of an
-- action creates one row per tablet that share a group_id, so a next-check-in notice is shown once.
CREATE TABLE kiosk_rule_notices (
    id uuid PRIMARY KEY,
    group_id uuid NOT NULL,
    firing_id uuid REFERENCES notification_firings(id) ON DELETE SET NULL,
    device_id uuid NOT NULL REFERENCES managed_devices(id) ON DELETE CASCADE,
    mode text NOT NULL CHECK (mode IN ('banner', 'person_checkin', 'next_checkin', 'everyone_today')),
    person_id uuid REFERENCES people(id) ON DELETE CASCADE,
    title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
    body text NOT NULL CHECK (char_length(body) <= 2000),
    level text NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'success', 'warning', 'error')),
    must_tap boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    shown_at timestamptz,
    CHECK (expires_at > created_at),
    CHECK ((mode IN ('person_checkin', 'next_checkin')) = (person_id IS NOT NULL))
);
CREATE INDEX kiosk_rule_notices_device_idx ON kiosk_rule_notices (device_id, expires_at);
CREATE INDEX kiosk_rule_notices_person_idx ON kiosk_rule_notices (person_id, device_id) WHERE person_id IS NOT NULL AND shown_at IS NULL;
CREATE INDEX kiosk_rule_notices_group_idx ON kiosk_rule_notices (group_id);
CREATE INDEX kiosk_rule_notices_firing_idx ON kiosk_rule_notices (firing_id) WHERE firing_id IS NOT NULL;
CREATE INDEX kiosk_rule_notices_expires_idx ON kiosk_rule_notices (expires_at);

-- +goose Down
DROP TABLE kiosk_rule_notices;
DROP TABLE signage_rule_notices;
