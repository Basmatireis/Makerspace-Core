-- +goose Up
-- Local streaming gateways (digital signage camera streams). The identity, enrollment and credential
-- tables mirror the printer connector lifecycle: a pending gateway is enrolled with a one-time secret
-- (only its digest is stored) and then authenticates with a rotating runtime credential (digest only).
CREATE TABLE streaming_gateways (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (name = btrim(name) AND name <> '' AND length(name) <= 120),
    public_host text NOT NULL CHECK (public_host = lower(public_host) AND length(public_host) BETWEEN 1 AND 260 AND public_host ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$'),
    lifecycle text NOT NULL DEFAULT 'pending' CHECK (lifecycle IN ('pending', 'active', 'disabled', 'revoked')),
    configuration_revision bigint NOT NULL DEFAULT 1 CHECK (configuration_revision > 0),
    applied_configuration_revision bigint NOT NULL DEFAULT 0 CHECK (applied_configuration_revision >= 0),
    software_version text CHECK (software_version IS NULL OR length(software_version) <= 80),
    protocol_version integer CHECK (protocol_version IS NULL OR protocol_version > 0),
    health_state text CHECK (health_state IS NULL OR health_state IN ('connected', 'degraded')),
    health_summary text CHECK (health_summary IS NULL OR length(health_summary) <= 500),
    last_heartbeat_at timestamptz,
    enrolled_at timestamptz,
    disabled_at timestamptz,
    revoked_at timestamptz,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX streaming_gateways_name_ci_idx ON streaming_gateways (lower(name));

CREATE TABLE streaming_gateway_enrollments (
    id uuid PRIMARY KEY,
    gateway_id uuid NOT NULL REFERENCES streaming_gateways(id) ON DELETE CASCADE,
    token_digest bytea NOT NULL UNIQUE CHECK (octet_length(token_digest) = 32),
    credential_fingerprint text CHECK (credential_fingerprint IS NULL OR credential_fingerprint ~ '^[0-9a-f]{64}$'),
    accepted_credential_id uuid,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    revoked_at timestamptz,
    created_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX streaming_gateway_open_enrollment_idx
    ON streaming_gateway_enrollments (gateway_id)
    WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE TABLE streaming_gateway_credentials (
    id uuid PRIMARY KEY,
    gateway_id uuid NOT NULL REFERENCES streaming_gateways(id) ON DELETE CASCADE,
    token_digest bytea NOT NULL UNIQUE CHECK (octet_length(token_digest) = 32),
    state text NOT NULL DEFAULT 'current' CHECK (state IN ('current', 'retiring', 'revoked')),
    expires_at timestamptz NOT NULL,
    last_used_at timestamptz,
    retire_after timestamptz,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE streaming_gateway_enrollments
    ADD CONSTRAINT streaming_gateway_enrollment_credential_fk
    FOREIGN KEY (accepted_credential_id) REFERENCES streaming_gateway_credentials(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX streaming_gateway_current_credential_idx
    ON streaming_gateway_credentials (gateway_id) WHERE state = 'current';
CREATE UNIQUE INDEX streaming_gateway_retiring_credential_idx
    ON streaming_gateway_credentials (gateway_id) WHERE state = 'retiring';

-- A camera is a machine whose Bambu printer camera is restreamed by one gateway. The RTSPS host and
-- access code are not stored here: they come from the machine's active printer-connector assignment
-- at configuration time.
CREATE TABLE streaming_cameras (
    id uuid PRIMARY KEY,
    gateway_id uuid NOT NULL REFERENCES streaming_gateways(id) ON DELETE CASCADE,
    machine_id uuid NOT NULL UNIQUE REFERENCES machines(id) ON DELETE CASCADE,
    enabled boolean NOT NULL DEFAULT true,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX streaming_cameras_gateway_idx ON streaming_cameras (gateway_id);

-- Ephemeral per-camera health reported by the gateway heartbeat (not audited).
CREATE TABLE streaming_camera_states (
    camera_id uuid PRIMARY KEY REFERENCES streaming_cameras(id) ON DELETE CASCADE,
    health text NOT NULL CHECK (health IN ('live', 'idle', 'unavailable')),
    viewers integer NOT NULL DEFAULT 0 CHECK (viewers >= 0 AND viewers <= 100000),
    codec text CHECK (codec IS NULL OR length(codec) <= 40),
    width integer CHECK (width IS NULL OR (width > 0 AND width <= 16384)),
    height integer CHECK (height IS NULL OR (height > 0 AND height <= 16384)),
    fps double precision CHECK (fps IS NULL OR (fps >= 0 AND fps <= 1000)),
    reported_at timestamptz NOT NULL DEFAULT now()
);

-- Ed25519 keys that sign short-lived stream tickets. The private key is encrypted with the
-- application keyring. Exactly one key is active; a retired key's public half stays valid for
-- gateways for ten minutes after retirement.
CREATE TABLE signage_ticket_keys (
    id uuid PRIMARY KEY,
    kid text NOT NULL UNIQUE CHECK (kid ~ '^[A-Za-z0-9_-]{8,32}$'),
    public_key bytea NOT NULL CHECK (octet_length(public_key) = 32),
    encrypted_private_key bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    retired_at timestamptz
);

CREATE UNIQUE INDEX signage_ticket_keys_active_idx ON signage_ticket_keys ((true)) WHERE retired_at IS NULL;

-- +goose Down
DROP TABLE signage_ticket_keys;
DROP TABLE streaming_camera_states;
DROP TABLE streaming_cameras;
ALTER TABLE streaming_gateway_enrollments DROP CONSTRAINT streaming_gateway_enrollment_credential_fk;
DROP TABLE streaming_gateway_credentials;
DROP TABLE streaming_gateway_enrollments;
DROP TABLE streaming_gateways;
