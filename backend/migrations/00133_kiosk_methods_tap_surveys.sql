-- +goose Up
-- A kiosk names the ways people may check in and out (password, PIN, emailed code) instead of an assurance level. The
-- sets accept exactly what the assurance levels accepted: `low` took all three, `normal` the password and the emailed
-- code. `strong` and above were never reachable at a kiosk; they become the password alone. Check-out may name no way
-- only while tapping a name in the presence list is allowed, so a kiosk always offers some way out.
ALTER TABLE managed_devices
    ADD COLUMN check_in_methods text[] NOT NULL DEFAULT ARRAY['email_code', 'pin', 'password']::text[],
    ADD COLUMN check_out_methods text[] NOT NULL DEFAULT ARRAY['email_code', 'pin', 'password']::text[];
UPDATE managed_devices SET
    check_in_methods = CASE check_in_assurance
        WHEN 'low' THEN ARRAY['email_code', 'pin', 'password']::text[]
        WHEN 'normal' THEN ARRAY['email_code', 'password']::text[]
        ELSE ARRAY['password']::text[] END,
    check_out_methods = CASE check_out_assurance
        WHEN 'low' THEN ARRAY['email_code', 'pin', 'password']::text[]
        WHEN 'normal' THEN ARRAY['email_code', 'password']::text[]
        ELSE ARRAY['password']::text[] END;
ALTER TABLE managed_devices
    ADD CONSTRAINT managed_devices_check_in_methods_check CHECK (
        check_in_methods <@ ARRAY['email_code', 'pin', 'password']::text[] AND cardinality(check_in_methods) >= 1),
    ADD CONSTRAINT managed_devices_check_out_methods_check CHECK (
        check_out_methods <@ ARRAY['email_code', 'pin', 'password']::text[]
        AND (cardinality(check_out_methods) >= 1 OR allow_tap_checkout));
-- Deliberate: the method sets above replace the device's attendance assurance levels; Down restores them.
-- squawk-ignore ban-drop-column
ALTER TABLE managed_devices DROP COLUMN check_in_assurance, DROP COLUMN check_out_assurance;

-- A tablet may also offer the check-out survey after a tap in the presence list. Anyone can tap anyone, so that offer
-- names nobody: it has neither a check-out reference nor a person, and its answers are stored without a person. An open
-- offer is either such a tap offer or a self check-out offer with both.
ALTER TABLE survey_offers DROP CONSTRAINT survey_offers_open_person_check;
ALTER TABLE survey_offers ADD CONSTRAINT survey_offers_open_person_check
    CHECK (consumed_at IS NOT NULL OR (visit_id IS NULL) = (person_id IS NULL));

-- +goose Down
DELETE FROM survey_offers WHERE consumed_at IS NULL AND person_id IS NULL;
ALTER TABLE survey_offers DROP CONSTRAINT survey_offers_open_person_check;
ALTER TABLE survey_offers ADD CONSTRAINT survey_offers_open_person_check
    CHECK (consumed_at IS NOT NULL OR (visit_id IS NOT NULL AND person_id IS NOT NULL));

ALTER TABLE managed_devices
    ADD COLUMN check_in_assurance text NOT NULL DEFAULT 'low'
        CHECK (check_in_assurance IN ('low', 'normal', 'strong', 'strong_mfa')),
    ADD COLUMN check_out_assurance text NOT NULL DEFAULT 'low'
        CHECK (check_out_assurance IN ('low', 'normal', 'strong', 'strong_mfa'));
UPDATE managed_devices SET
    check_in_assurance = CASE WHEN 'pin' = ANY (check_in_methods) THEN 'low' ELSE 'normal' END,
    check_out_assurance = CASE WHEN 'pin' = ANY (check_out_methods) OR cardinality(check_out_methods) = 0
        THEN 'low' ELSE 'normal' END;
ALTER TABLE managed_devices DROP COLUMN check_in_methods, DROP COLUMN check_out_methods;
