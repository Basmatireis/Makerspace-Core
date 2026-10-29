-- +goose Up
-- Unified local service: the printer connector relays Bambu printer cameras itself, so the streaming gateway
-- entity, its stream tickets and everything around them disappear. A camera is now a flag on an active Bambu
-- printer-connector assignment.

-- The camera switch and the ephemeral relay status reported by the connector's heartbeat (not audited, like
-- runtime_state). camera_health is NULL until the connector reported a camera for the assignment.
ALTER TABLE printer_connector_assignments
    ADD COLUMN camera_streaming boolean NOT NULL DEFAULT false,
    ADD COLUMN camera_health text CHECK (camera_health IS NULL OR camera_health IN ('live', 'idle', 'unavailable')),
    ADD COLUMN camera_viewers integer NOT NULL DEFAULT 0 CHECK (camera_viewers BETWEEN 0 AND 100000),
    ADD COLUMN camera_reported_at timestamptz,
    ADD CONSTRAINT printer_connector_assignments_camera_adapter_check
        CHECK (camera_streaming = false OR adapter_kind IN ('bambu_h2d', 'bambu_x1c'));

-- Carry over: every enabled gateway camera of a machine whose printer is still connected through a Bambu adapter.
UPDATE printer_connector_assignments a
SET camera_streaming = true
FROM streaming_cameras c
WHERE c.machine_id = a.machine_id
  AND c.enabled
  AND a.ended_at IS NULL
  AND a.adapter_kind IN ('bambu_h2d', 'bambu_x1c');

-- Gateways, cameras, ticket keys, the session epoch and the revoked-display list are gone. The columns that
-- migration 00062 added to streaming_gateways go with the table. signage_displays.allow_camera_outside stays.
DROP TABLE signage_ticket_keys;
DROP TABLE streaming_camera_states;
DROP TABLE streaming_cameras;
ALTER TABLE streaming_gateway_enrollments DROP CONSTRAINT streaming_gateway_enrollment_credential_fk;
DROP TABLE streaming_gateway_credentials;
DROP TABLE streaming_gateway_enrollments;
DROP TABLE streaming_gateways;
DROP TABLE signage_revoked_displays;
DROP TABLE streaming_session_epoch;

-- local_services.manage existed only for gateways. Role permissions are stored as role_permission_grants (its device
-- type restrictions cascade); the master role derives its permissions from application code.
DELETE FROM role_permission_grants WHERE permission_id = 'local_services.manage';

-- +goose Down
-- The schema comes back in the shape it had before this migration (00053, 00054 and the gateway part of 00062).
-- Data is not restored: gateways, cameras and ticket keys are lost, and the local_services.manage grants stay
-- removed. Cameras are not converted back; camera_streaming values are dropped with the columns.
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
    updated_at timestamptz NOT NULL DEFAULT now(),
    updater_available boolean NOT NULL DEFAULT false,
    update_request_id uuid,
    update_target_version text CHECK (update_target_version IS NULL OR update_target_version ~ '^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$'),
    update_requested_at timestamptz,
    update_status text CHECK (update_status IS NULL OR update_status IN ('requested', 'in_progress', 'succeeded', 'failed')),
    update_status_reason text CHECK (update_status_reason IS NULL OR update_status_reason ~ '^[a-z0-9_]{1,64}$'),
    update_status_at timestamptz,
    CONSTRAINT streaming_gateways_update_request_check CHECK (
        (update_request_id IS NULL AND update_target_version IS NULL AND update_requested_at IS NULL
            AND update_status IS NULL AND update_status_reason IS NULL AND update_status_at IS NULL)
        OR (update_request_id IS NOT NULL AND update_target_version IS NOT NULL AND update_requested_at IS NOT NULL
            AND update_status IS NOT NULL AND update_status_at IS NOT NULL)
    )
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

CREATE TABLE signage_ticket_keys (
    id uuid PRIMARY KEY,
    kid text NOT NULL UNIQUE CHECK (kid ~ '^[A-Za-z0-9_-]{8,32}$'),
    public_key bytea NOT NULL CHECK (octet_length(public_key) = 32),
    encrypted_private_key bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    retired_at timestamptz,
    state text NOT NULL DEFAULT 'active' CHECK (state IN ('pending', 'active', 'retired')),
    activates_at timestamptz,
    CONSTRAINT signage_ticket_keys_lifecycle_check
        CHECK ((state = 'retired') = (retired_at IS NOT NULL) AND (state <> 'pending' OR activates_at IS NOT NULL))
);

CREATE UNIQUE INDEX signage_ticket_keys_active_idx ON signage_ticket_keys ((true)) WHERE state = 'active';
CREATE UNIQUE INDEX signage_ticket_keys_pending_idx ON signage_ticket_keys ((true)) WHERE state = 'pending';

CREATE TABLE streaming_session_epoch (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    epoch bigint NOT NULL DEFAULT 0 CHECK (epoch >= 0)
);
INSERT INTO streaming_session_epoch (singleton, epoch) VALUES (true, 0);

CREATE TABLE signage_revoked_displays (
    display_id uuid PRIMARY KEY,
    revoked_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE printer_connector_assignments
    DROP CONSTRAINT printer_connector_assignments_camera_adapter_check,
    DROP COLUMN camera_reported_at,
    DROP COLUMN camera_viewers,
    DROP COLUMN camera_health,
    DROP COLUMN camera_streaming;
