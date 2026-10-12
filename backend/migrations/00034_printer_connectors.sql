-- +goose Up
CREATE TABLE printer_connectors (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (name = btrim(name) AND name <> '' AND length(name) <= 120),
    location_label text CHECK (location_label IS NULL OR (location_label = btrim(location_label) AND location_label <> '' AND length(location_label) <= 200)),
    lifecycle text NOT NULL DEFAULT 'pending' CHECK (lifecycle IN ('pending', 'active', 'disabled', 'revoked')),
    configuration_revision bigint NOT NULL DEFAULT 1 CHECK (configuration_revision > 0),
    applied_configuration_revision bigint NOT NULL DEFAULT 0 CHECK (applied_configuration_revision >= 0),
    software_version text CHECK (software_version IS NULL OR length(software_version) <= 80),
    protocol_version integer CHECK (protocol_version IS NULL OR protocol_version > 0),
    health_state text CHECK (health_state IS NULL OR health_state IN ('connected', 'degraded')),
    health_summary text CHECK (health_summary IS NULL OR length(health_summary) <= 500),
    pending_event_count bigint NOT NULL DEFAULT 0 CHECK (pending_event_count >= 0),
    quarantined_event_count bigint NOT NULL DEFAULT 0 CHECK (quarantined_event_count >= 0),
    last_heartbeat_at timestamptz,
    enrolled_at timestamptz,
    disabled_at timestamptz,
    revoked_at timestamptz,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX printer_connectors_name_ci_idx ON printer_connectors (lower(name));
CREATE INDEX printer_connectors_lifecycle_heartbeat_idx ON printer_connectors (lifecycle, last_heartbeat_at DESC NULLS LAST, id);

CREATE TABLE printer_connector_enrollments (
    id uuid PRIMARY KEY,
    connector_id uuid NOT NULL REFERENCES printer_connectors(id) ON DELETE CASCADE,
    token_digest bytea NOT NULL UNIQUE CHECK (octet_length(token_digest) = 32),
    credential_fingerprint text CHECK (credential_fingerprint IS NULL OR credential_fingerprint ~ '^[0-9a-f]{64}$'),
    accepted_credential_id uuid,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    revoked_at timestamptz,
    created_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX printer_connector_open_enrollment_idx
    ON printer_connector_enrollments (connector_id)
    WHERE consumed_at IS NULL AND revoked_at IS NULL;
CREATE INDEX printer_connector_enrollment_expiry_idx
    ON printer_connector_enrollments (expires_at)
    WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE TABLE printer_connector_credentials (
    id uuid PRIMARY KEY,
    connector_id uuid NOT NULL REFERENCES printer_connectors(id) ON DELETE CASCADE,
    token_digest bytea NOT NULL UNIQUE CHECK (octet_length(token_digest) = 32),
    state text NOT NULL DEFAULT 'current' CHECK (state IN ('current', 'retiring', 'revoked')),
    expires_at timestamptz NOT NULL,
    last_used_at timestamptz,
    retire_after timestamptz,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE printer_connector_enrollments
    ADD CONSTRAINT printer_connector_enrollment_credential_fk
    FOREIGN KEY (accepted_credential_id) REFERENCES printer_connector_credentials(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX printer_connector_current_credential_idx
    ON printer_connector_credentials (connector_id) WHERE state = 'current';
CREATE UNIQUE INDEX printer_connector_retiring_credential_idx
    ON printer_connector_credentials (connector_id) WHERE state = 'retiring';
CREATE INDEX printer_connector_credential_expiry_idx
    ON printer_connector_credentials (expires_at) WHERE state <> 'revoked';

CREATE TABLE printer_connector_assignments (
    id uuid PRIMARY KEY,
    connector_id uuid NOT NULL REFERENCES printer_connectors(id) ON DELETE RESTRICT,
    machine_id uuid NOT NULL REFERENCES printer_profiles(machine_id) ON DELETE RESTRICT,
    adapter_kind text NOT NULL CHECK (adapter_kind = btrim(adapter_kind) AND adapter_kind <> '' AND length(adapter_kind) <= 80),
    adapter_schema_version integer NOT NULL DEFAULT 1 CHECK (adapter_schema_version > 0),
    settings jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object' AND octet_length(settings::text) <= 32768),
    encrypted_secrets bytea,
    configuration_version bigint NOT NULL DEFAULT 1 CHECK (configuration_version > 0),
    enabled boolean NOT NULL DEFAULT true,
    applied_configuration_version bigint NOT NULL DEFAULT 0 CHECK (applied_configuration_version >= 0),
    runtime_state text CHECK (runtime_state IS NULL OR runtime_state IN ('connecting', 'connected', 'disconnected', 'degraded', 'disabled')),
    runtime_error_code text CHECK (runtime_error_code IS NULL OR (runtime_error_code = btrim(runtime_error_code) AND length(runtime_error_code) <= 80)),
    activated_at timestamptz NOT NULL DEFAULT now(),
    ended_at timestamptz,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (ended_at IS NULL OR ended_at >= activated_at)
);

CREATE UNIQUE INDEX printer_connector_active_machine_idx
    ON printer_connector_assignments (machine_id) WHERE ended_at IS NULL;
CREATE INDEX printer_connector_assignment_connector_idx
    ON printer_connector_assignments (connector_id, ended_at, machine_id);

CREATE TABLE printer_observed_runs (
    id uuid PRIMARY KEY,
    assignment_id uuid NOT NULL REFERENCES printer_connector_assignments(id) ON DELETE RESTRICT,
    machine_id uuid NOT NULL REFERENCES printer_profiles(machine_id) ON DELETE RESTRICT,
    vendor_job_id text CHECK (vendor_job_id IS NULL OR (vendor_job_id = btrim(vendor_job_id) AND vendor_job_id <> '' AND length(vendor_job_id) <= 200)),
    attempt_id uuid UNIQUE REFERENCES print_attempts(id) ON DELETE SET NULL,
    state text NOT NULL DEFAULT 'observed' CHECK (state IN ('observed', 'printing', 'completed', 'failed', 'cancelled', 'uncertain')),
    history_complete boolean NOT NULL DEFAULT true,
    first_observed_at timestamptz NOT NULL,
    last_observed_at timestamptz NOT NULL,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (last_observed_at >= first_observed_at)
);

CREATE INDEX printer_observed_runs_machine_time_idx ON printer_observed_runs (machine_id, last_observed_at DESC, id DESC);
CREATE INDEX printer_observed_runs_unmatched_idx ON printer_observed_runs (last_observed_at DESC, id DESC) WHERE attempt_id IS NULL;

CREATE TABLE printer_discovery_requests (
    id uuid PRIMARY KEY,
    connector_id uuid NOT NULL REFERENCES printer_connectors(id) ON DELETE CASCADE,
    adapter_kind text NOT NULL CHECK (adapter_kind = btrim(adapter_kind) AND adapter_kind <> '' AND length(adapter_kind) <= 80),
    state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'completed', 'failed', 'expired')),
    requested_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    expires_at timestamptz NOT NULL,
    error_code text CHECK (error_code IS NULL OR length(error_code) <= 80),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX printer_discovery_open_idx ON printer_discovery_requests (connector_id, adapter_kind)
    WHERE state IN ('pending', 'running');

CREATE TABLE printer_discovery_candidates (
    id uuid PRIMARY KEY,
    request_id uuid NOT NULL REFERENCES printer_discovery_requests(id) ON DELETE CASCADE,
    candidate_key text NOT NULL CHECK (candidate_key = btrim(candidate_key) AND candidate_key <> '' AND length(candidate_key) <= 200),
    observation jsonb NOT NULL CHECK (jsonb_typeof(observation) = 'object' AND octet_length(observation::text) <= 16384),
    decision text NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending', 'approved', 'rejected')),
    assignment_id uuid REFERENCES printer_connector_assignments(id) ON DELETE SET NULL,
    first_seen_at timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    UNIQUE (request_id, candidate_key),
    CHECK (last_seen_at >= first_seen_at)
);

ALTER TABLE printer_profiles
    ADD COLUMN identity_namespace text,
    ADD COLUMN identity_value text,
    ADD CONSTRAINT printer_profiles_identity_pair_check CHECK ((identity_namespace IS NULL) = (identity_value IS NULL)),
    ADD CONSTRAINT printer_profiles_identity_namespace_check CHECK (identity_namespace IS NULL OR (identity_namespace = btrim(identity_namespace) AND identity_namespace <> '' AND length(identity_namespace) <= 80)),
    ADD CONSTRAINT printer_profiles_identity_value_check CHECK (identity_value IS NULL OR (identity_value = btrim(identity_value) AND identity_value <> '' AND length(identity_value) <= 200));

CREATE UNIQUE INDEX printer_profiles_verified_identity_idx
    ON printer_profiles (identity_namespace, identity_value) WHERE identity_namespace IS NOT NULL;

ALTER TABLE printer_events
    ADD COLUMN connector_id uuid REFERENCES printer_connectors(id) ON DELETE SET NULL,
    ADD COLUMN connector_assignment_id uuid REFERENCES printer_connector_assignments(id) ON DELETE SET NULL,
    ADD COLUMN observed_run_id uuid REFERENCES printer_observed_runs(id) ON DELETE SET NULL,
    ADD COLUMN configuration_version bigint CHECK (configuration_version IS NULL OR configuration_version > 0),
    ADD COLUMN application_state text NOT NULL DEFAULT 'recorded' CHECK (application_state IN ('recorded', 'applied', 'review_required')),
    ADD COLUMN application_reason text CHECK (application_reason IS NULL OR length(application_reason) <= 200),
    ADD COLUMN report_revision bigint CHECK (report_revision IS NULL OR report_revision > 0),
    ADD CONSTRAINT printer_events_connector_metadata_check CHECK (
        (connector_id IS NULL AND connector_assignment_id IS NULL AND configuration_version IS NULL)
        OR (connector_id IS NOT NULL AND connector_assignment_id IS NOT NULL AND configuration_version IS NOT NULL AND source_sequence IS NOT NULL AND source_sequence > 0)
    );

CREATE UNIQUE INDEX printer_events_assignment_sequence_idx
    ON printer_events (connector_assignment_id, source_sequence) WHERE connector_assignment_id IS NOT NULL;
CREATE UNIQUE INDEX printer_events_run_report_revision_idx
    ON printer_events (observed_run_id, report_revision) WHERE observed_run_id IS NOT NULL AND report_revision IS NOT NULL;
CREATE INDEX printer_events_connector_time_idx ON printer_events (connector_id, received_at DESC, id DESC) WHERE connector_id IS NOT NULL;
CREATE INDEX printer_events_pending_reconciliation_idx ON printer_events (received_at, id) WHERE reconciliation_state = 'pending';

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM printer_connectors)
       OR EXISTS (SELECT 1 FROM printer_observed_runs)
       OR EXISTS (SELECT 1 FROM printer_discovery_requests)
       OR EXISTS (SELECT 1 FROM printer_events WHERE connector_id IS NOT NULL) THEN
        RAISE EXCEPTION 'cannot downgrade while printer connector history exists';
    END IF;
END $$;
-- +goose StatementEnd

DROP INDEX printer_events_pending_reconciliation_idx;
DROP INDEX printer_events_connector_time_idx;
DROP INDEX printer_events_run_report_revision_idx;
DROP INDEX printer_events_assignment_sequence_idx;
ALTER TABLE printer_events
    DROP CONSTRAINT printer_events_connector_metadata_check,
    DROP COLUMN report_revision,
    DROP COLUMN application_reason,
    DROP COLUMN application_state,
    DROP COLUMN configuration_version,
    DROP COLUMN observed_run_id,
    DROP COLUMN connector_assignment_id,
    DROP COLUMN connector_id;
DROP INDEX printer_profiles_verified_identity_idx;
ALTER TABLE printer_profiles
    DROP CONSTRAINT printer_profiles_identity_value_check,
    DROP CONSTRAINT printer_profiles_identity_namespace_check,
    DROP CONSTRAINT printer_profiles_identity_pair_check,
    DROP COLUMN identity_value,
    DROP COLUMN identity_namespace;
DROP TABLE printer_discovery_candidates;
DROP TABLE printer_discovery_requests;
DROP TABLE printer_observed_runs;
DROP TABLE printer_connector_assignments;
ALTER TABLE printer_connector_enrollments DROP CONSTRAINT printer_connector_enrollment_credential_fk;
DROP TABLE printer_connector_credentials;
DROP TABLE printer_connector_enrollments;
DROP TABLE printer_connectors;
