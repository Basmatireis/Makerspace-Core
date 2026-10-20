-- +goose Up
-- Camera access outside the building: tickets for a display that is visible from outside are only
-- issued when this is switched on explicitly.
ALTER TABLE signage_displays ADD COLUMN allow_camera_outside boolean NOT NULL DEFAULT false;

-- Session epoch: gateways restart go2rtc (dropping every running WebRTC/MSE session) when it changes.
CREATE TABLE streaming_session_epoch (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    epoch bigint NOT NULL DEFAULT 0 CHECK (epoch >= 0)
);
INSERT INTO streaming_session_epoch (singleton, epoch) VALUES (true, 0);

-- Displays revoked or deleted in the last 24 hours; gateways refuse their tickets. No personal data.
CREATE TABLE signage_revoked_displays (
    display_id uuid PRIMARY KEY,
    revoked_at timestamptz NOT NULL DEFAULT now()
);

-- Ticket key rotation: a new key is first published as pending and signs only after activates_at.
ALTER TABLE signage_ticket_keys ADD COLUMN state text NOT NULL DEFAULT 'active' CHECK (state IN ('pending', 'active', 'retired'));
ALTER TABLE signage_ticket_keys ADD COLUMN activates_at timestamptz;
UPDATE signage_ticket_keys SET state = 'retired' WHERE retired_at IS NOT NULL;
DROP INDEX signage_ticket_keys_active_idx;
CREATE UNIQUE INDEX signage_ticket_keys_active_idx ON signage_ticket_keys ((true)) WHERE state = 'active';
CREATE UNIQUE INDEX signage_ticket_keys_pending_idx ON signage_ticket_keys ((true)) WHERE state = 'pending';
ALTER TABLE signage_ticket_keys ADD CONSTRAINT signage_ticket_keys_lifecycle_check
    CHECK ((state = 'retired') = (retired_at IS NOT NULL) AND (state <> 'pending' OR activates_at IS NOT NULL));

-- +goose Down
ALTER TABLE signage_ticket_keys DROP CONSTRAINT signage_ticket_keys_lifecycle_check;
DROP INDEX signage_ticket_keys_pending_idx;
DROP INDEX signage_ticket_keys_active_idx;
DELETE FROM signage_ticket_keys WHERE state = 'pending';
CREATE UNIQUE INDEX signage_ticket_keys_active_idx ON signage_ticket_keys ((true)) WHERE retired_at IS NULL;
ALTER TABLE signage_ticket_keys DROP COLUMN activates_at;
ALTER TABLE signage_ticket_keys DROP COLUMN state;
DROP TABLE signage_revoked_displays;
DROP TABLE streaming_session_epoch;
ALTER TABLE signage_displays DROP COLUMN allow_camera_outside;
