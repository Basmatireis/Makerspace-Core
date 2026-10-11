-- +goose Up
CREATE SEQUENCE print_submission_display_sequence;

CREATE TABLE printer_profiles (
    machine_id uuid PRIMARY KEY REFERENCES machines(id) ON DELETE CASCADE,
    enabled boolean NOT NULL DEFAULT true,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE printer_input_units (
    id uuid PRIMARY KEY,
    machine_id uuid NOT NULL REFERENCES printer_profiles(machine_id) ON DELETE CASCADE,
    name text NOT NULL CHECK (name = btrim(name) AND name <> '' AND length(name) <= 120),
    position integer NOT NULL CHECK (position >= 0),
    external_identifier text CHECK (external_identifier IS NULL OR (external_identifier = btrim(external_identifier) AND external_identifier <> '' AND length(external_identifier) <= 200)),
    enabled boolean NOT NULL DEFAULT true,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (machine_id, position),
    UNIQUE (id, machine_id)
);

CREATE UNIQUE INDEX printer_input_units_external_idx ON printer_input_units (machine_id, external_identifier) WHERE external_identifier IS NOT NULL;

CREATE TABLE printer_slots (
    id uuid PRIMARY KEY,
    input_unit_id uuid NOT NULL REFERENCES printer_input_units(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (name = btrim(name) AND name <> '' AND length(name) <= 120),
    position integer NOT NULL CHECK (position >= 0),
    external_identifier text CHECK (external_identifier IS NULL OR (external_identifier = btrim(external_identifier) AND external_identifier <> '' AND length(external_identifier) <= 200)),
    status text NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'unavailable', 'retired')),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (input_unit_id, position)
);

CREATE UNIQUE INDEX printer_slots_external_idx ON printer_slots (input_unit_id, external_identifier) WHERE external_identifier IS NOT NULL;

CREATE TABLE print_submissions (
    id uuid PRIMARY KEY,
    display_id text NOT NULL UNIQUE CHECK (display_id ~ '^PS-[0-9]{4}-[0-9]{6,}$'),
    machine_id uuid NOT NULL REFERENCES printer_profiles(machine_id) ON DELETE RESTRICT,
    customer_person_id uuid REFERENCES people(id) ON DELETE SET NULL,
    customer_organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
    title text NOT NULL CHECK (title = btrim(title) AND title <> '' AND length(title) <= 200),
    notes text CHECK (notes IS NULL OR length(notes) <= 2000),
    state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'in_progress', 'completed', 'failed', 'cancelled')),
    reprints_submission_id uuid REFERENCES print_submissions(id) ON DELETE SET NULL,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (customer_person_id IS NULL OR customer_organization_id IS NULL),
    CHECK (reprints_submission_id IS NULL OR reprints_submission_id <> id)
);

CREATE INDEX print_submissions_state_time_idx ON print_submissions (state, created_at DESC, id DESC);
CREATE INDEX print_submissions_machine_time_idx ON print_submissions (machine_id, created_at DESC, id DESC);

CREATE TABLE print_attempts (
    id uuid PRIMARY KEY,
    submission_id uuid NOT NULL REFERENCES print_submissions(id) ON DELETE CASCADE,
    attempt_number integer NOT NULL CHECK (attempt_number > 0),
    machine_id uuid NOT NULL REFERENCES printer_profiles(machine_id) ON DELETE RESTRICT,
    state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'accepted', 'printing', 'completed', 'failed', 'cancelled')),
    external_print_id text CHECK (external_print_id IS NULL OR (external_print_id = btrim(external_print_id) AND external_print_id <> '' AND length(external_print_id) <= 200)),
    accepted_at timestamptz,
    started_at timestamptz,
    ended_at timestamptz,
    machine_job_id uuid UNIQUE REFERENCES machine_jobs(id) ON DELETE SET NULL,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (submission_id, attempt_number)
);

CREATE UNIQUE INDEX print_attempts_active_submission_idx ON print_attempts (submission_id) WHERE state IN ('queued', 'accepted', 'printing');
CREATE UNIQUE INDEX print_attempts_external_idx ON print_attempts (machine_id, external_print_id) WHERE external_print_id IS NOT NULL;

CREATE TABLE print_filament_declarations (
    id uuid PRIMARY KEY,
    submission_id uuid REFERENCES print_submissions(id) ON DELETE CASCADE,
    attempt_id uuid REFERENCES print_attempts(id) ON DELETE CASCADE,
    ownership text NOT NULL CHECK (ownership IN ('makerspace', 'external')),
    material_id uuid REFERENCES materials(id) ON DELETE RESTRICT,
    spool_id uuid,
    external_material_name text,
    estimated_quantity_g numeric(20, 6) CHECK (estimated_quantity_g IS NULL OR estimated_quantity_g > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((submission_id IS NOT NULL)::integer + (attempt_id IS NOT NULL)::integer = 1),
    CHECK (
        (ownership = 'makerspace' AND material_id IS NOT NULL AND external_material_name IS NULL)
        OR
        (ownership = 'external' AND spool_id IS NULL AND external_material_name IS NOT NULL
            AND external_material_name = btrim(external_material_name) AND external_material_name <> '' AND length(external_material_name) <= 200)
    ),
    FOREIGN KEY (spool_id, material_id) REFERENCES filament_spools(id, material_id) ON DELETE RESTRICT
);

CREATE INDEX print_filament_declarations_submission_idx ON print_filament_declarations (submission_id, id) WHERE submission_id IS NOT NULL;
CREATE INDEX print_filament_declarations_attempt_idx ON print_filament_declarations (attempt_id, id) WHERE attempt_id IS NOT NULL;

CREATE TABLE printer_events (
    id uuid PRIMARY KEY,
    source_id text NOT NULL CHECK (source_id = btrim(source_id) AND source_id <> '' AND length(source_id) <= 120),
    event_key text NOT NULL CHECK (event_key = btrim(event_key) AND event_key <> '' AND length(event_key) <= 200),
    fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
    protocol_version integer NOT NULL CHECK (protocol_version > 0),
    machine_id uuid REFERENCES printer_profiles(machine_id) ON DELETE RESTRICT,
    attempt_id uuid REFERENCES print_attempts(id) ON DELETE SET NULL,
    kind text NOT NULL CHECK (kind IN ('identity', 'connectivity', 'operational_state', 'progress', 'slot_observation', 'consumption_report', 'terminal_outcome')),
    occurred_at timestamptz NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    source_sequence bigint,
    external_print_id text CHECK (external_print_id IS NULL OR length(external_print_id) <= 200),
    payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 32768),
    reconciliation_state text NOT NULL DEFAULT 'not_applicable' CHECK (reconciliation_state IN ('not_applicable', 'pending', 'accepted', 'rejected')),
    reconciled_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    reconciled_at timestamptz,
    UNIQUE (source_id, event_key),
    CHECK ((kind = 'consumption_report' AND reconciliation_state IN ('pending', 'accepted', 'rejected')) OR (kind <> 'consumption_report' AND reconciliation_state = 'not_applicable'))
);

CREATE INDEX printer_events_attempt_time_idx ON printer_events (attempt_id, occurred_at, id) WHERE attempt_id IS NOT NULL;
CREATE INDEX printer_events_machine_time_idx ON printer_events (machine_id, occurred_at DESC, id DESC) WHERE machine_id IS NOT NULL;

CREATE TABLE printer_spool_assignments (
    id uuid PRIMARY KEY,
    slot_id uuid NOT NULL REFERENCES printer_slots(id) ON DELETE RESTRICT,
    spool_id uuid NOT NULL REFERENCES filament_spools(id) ON DELETE RESTRICT,
    mounted_at timestamptz NOT NULL,
    unmounted_at timestamptz,
    mounted_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    unmounted_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    source text NOT NULL CHECK (source IN ('manual', 'connector_reconciled')),
    source_event_id uuid REFERENCES printer_events(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (unmounted_at IS NULL OR unmounted_at > mounted_at)
);

CREATE UNIQUE INDEX printer_spool_assignments_open_slot_idx ON printer_spool_assignments (slot_id) WHERE unmounted_at IS NULL;
CREATE UNIQUE INDEX printer_spool_assignments_open_spool_idx ON printer_spool_assignments (spool_id) WHERE unmounted_at IS NULL;
CREATE INDEX printer_spool_assignments_slot_history_idx ON printer_spool_assignments (slot_id, mounted_at DESC, id DESC);

ALTER TABLE machine_job_material_usages ADD COLUMN source_printer_event_id uuid REFERENCES printer_events(id) ON DELETE SET NULL;

CREATE TABLE printing_operations (
    operation_key uuid PRIMARY KEY,
    actor_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    kind text NOT NULL CHECK (kind IN ('attempt_create', 'attempt_retry', 'reconciliation_accept')),
    fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
    result_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM print_submissions)
       OR EXISTS (SELECT 1 FROM printer_spool_assignments)
       OR EXISTS (SELECT 1 FROM printer_events) THEN
        RAISE EXCEPTION 'cannot downgrade while printing history exists';
    END IF;
END $$;
-- +goose StatementEnd

DROP TABLE printing_operations;
ALTER TABLE machine_job_material_usages DROP COLUMN source_printer_event_id;
DROP TABLE printer_spool_assignments;
DROP TABLE printer_events;
DROP TABLE print_filament_declarations;
DROP TABLE print_attempts;
DROP TABLE print_submissions;
DROP TABLE printer_slots;
DROP TABLE printer_input_units;
DROP TABLE printer_profiles;
DROP SEQUENCE print_submission_display_sequence;
