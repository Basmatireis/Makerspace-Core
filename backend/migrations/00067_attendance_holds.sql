-- +goose Up
-- A check-in held until a supervisor confirms the person's signed Lab Rules. At most one per person; it lapses at
-- expires_at (local midnight after the attempt) and becomes a visit when the Lab Rules are confirmed before that.
CREATE TABLE attendance_holds (
    id uuid PRIMARY KEY,
    person_id uuid NOT NULL UNIQUE REFERENCES people(id) ON DELETE CASCADE,
    requested_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    check_in_device_id uuid REFERENCES managed_devices(id) ON DELETE SET NULL,
    check_in_method text NOT NULL CHECK (check_in_method IN ('password', 'pin', 'oidc', 'nfc', 'supervisor')),
    check_in_assurance text NOT NULL CHECK (check_in_assurance IN ('low', 'normal', 'strong', 'strong_mfa')),
    checked_in_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    CHECK (expires_at > requested_at)
);
CREATE INDEX attendance_holds_expiry_idx ON attendance_holds (expires_at);

-- +goose Down
DROP TABLE attendance_holds;
