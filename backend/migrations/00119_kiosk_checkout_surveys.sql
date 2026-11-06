-- +goose Up
-- Identified check-out (PIN or password) is always available on a kiosk. Tapping a name in the presence list becomes an
-- additional switch, and the tablet may offer the check-out survey and returns to its start screen after a while.
ALTER TABLE managed_devices
    ADD COLUMN allow_tap_checkout boolean NOT NULL DEFAULT false,
    ADD COLUMN offer_surveys_at_checkout boolean NOT NULL DEFAULT false,
    ADD COLUMN kiosk_reset_seconds integer NOT NULL DEFAULT 60 CHECK (kiosk_reset_seconds BETWEEN 15 AND 600);
UPDATE managed_devices SET allow_tap_checkout = true WHERE checkout_mode = 'public_tap';
ALTER TABLE managed_devices DROP COLUMN checkout_mode;

-- Whether the tablet asks the survey at check-out (the delay and cooldown stay for the e-mail invitation).
ALTER TABLE survey_triggers ADD COLUMN ask_at_tablet boolean NOT NULL DEFAULT false;

-- A survey the tablet offered after a self check-out. The token is opaque, single use and bound to the visit, the
-- tablet and the survey version; only its digest is stored. Consuming an offer clears the link to the visit.
CREATE TABLE survey_offers (
    id uuid PRIMARY KEY,
    token_digest bytea NOT NULL UNIQUE CHECK (octet_length(token_digest) = 32),
    visit_id uuid REFERENCES visits(id) ON DELETE CASCADE,
    device_id uuid NOT NULL REFERENCES managed_devices(id) ON DELETE CASCADE,
    survey_id uuid NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
    survey_version_id uuid NOT NULL REFERENCES survey_versions(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (consumed_at IS NOT NULL OR visit_id IS NOT NULL)
);
CREATE INDEX survey_offers_expiry_idx ON survey_offers (expires_at);
CREATE INDEX survey_offers_visit_idx ON survey_offers (visit_id) WHERE visit_id IS NOT NULL;

-- When the tablet last asked a person about a survey. It outlives the offer and starts the per-person cooldown, also
-- when the person declined or answered (answers themselves never link back to the person).
CREATE TABLE survey_ask_cooldowns (
    person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    survey_id uuid NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
    asked_at timestamptz NOT NULL,
    PRIMARY KEY (person_id, survey_id)
);
CREATE INDEX survey_ask_cooldowns_asked_idx ON survey_ask_cooldowns (asked_at);

-- +goose Down
DROP TABLE survey_ask_cooldowns;
DROP TABLE survey_offers;
ALTER TABLE survey_triggers DROP COLUMN ask_at_tablet;
ALTER TABLE managed_devices ADD COLUMN checkout_mode text NOT NULL DEFAULT 'verified'
    CHECK (checkout_mode IN ('verified', 'public_tap'));
UPDATE managed_devices SET checkout_mode = 'public_tap' WHERE allow_tap_checkout;
ALTER TABLE managed_devices
    DROP COLUMN kiosk_reset_seconds,
    DROP COLUMN offer_surveys_at_checkout,
    DROP COLUMN allow_tap_checkout;
