-- +goose Up
-- An unregistered kiosk (browser or desktop app) shows a short code; staff claim it in Core, which creates the managed
-- device. Like signage pairing, only digests of the code and of the poll secret are stored, and the device's real
-- credential is issued on the kiosk's first poll after the claim, so no plaintext token ever rests here.
CREATE TABLE managed_device_pairing_requests (
    id uuid PRIMARY KEY,
    code_digest bytea NOT NULL CHECK (octet_length(code_digest) = 32),
    poll_secret_digest bytea NOT NULL CHECK (octet_length(poll_secret_digest) = 32),
    credential_delivery text NOT NULL CHECK (credential_delivery IN ('browser_cookie', 'native_token')),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    claimed_device_id uuid REFERENCES managed_devices(id) ON DELETE CASCADE,
    claimed_at timestamptz,
    CHECK (expires_at > created_at),
    CHECK ((claimed_device_id IS NULL) = (claimed_at IS NULL))
);
CREATE UNIQUE INDEX managed_device_pairing_requests_open_code_idx
    ON managed_device_pairing_requests (code_digest) WHERE claimed_at IS NULL;
CREATE UNIQUE INDEX managed_device_pairing_requests_poll_idx ON managed_device_pairing_requests (poll_secret_digest);
CREATE INDEX managed_device_pairing_requests_expires_idx ON managed_device_pairing_requests (expires_at);
CREATE INDEX managed_device_pairing_requests_device_idx
    ON managed_device_pairing_requests (claimed_device_id) WHERE claimed_device_id IS NOT NULL;

-- +goose Down
DROP TABLE managed_device_pairing_requests;
