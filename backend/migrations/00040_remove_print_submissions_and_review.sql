-- +goose Up
-- Print submissions, print attempts and the review queue for automatically
-- ingested jobs are replaced by prints reported by printer connectors and by
-- jobs that staff create or link. Nothing has been deployed yet, so the
-- legacy structures are removed instead of kept read-only.
-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM machine_jobs WHERE review_state = 'needs_review') THEN
        RAISE EXCEPTION 'machine jobs awaiting review must be confirmed before this migration';
    END IF;
END $$;
-- +goose StatementEnd

-- The anonymous-job guard still names review_state; without the review queue a
-- job without a customer can only be inserted by an atomic counter sale.
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION check_anonymous_job_completion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.customer_person_id IS NULL AND NEW.customer_organization_id IS NULL AND TG_OP='INSERT' AND NOT EXISTS(
 SELECT 1 FROM order_job_claims c JOIN order_items i ON i.id=c.order_item_id JOIN orders o ON o.id=i.order_id
 WHERE c.machine_job_id=NEW.id AND o.status='finalized' AND o.customer_kind='anonymous'
 AND o.fulfillment_mode='immediate' AND o.total_amount=(SELECT COALESCE(sum(amount),0) FROM payment_allocations WHERE order_id=o.id)) THEN
 RAISE EXCEPTION 'anonymous job requires atomic counter sale' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
-- +goose StatementEnd

ALTER TABLE printer_observed_runs DROP COLUMN attempt_id;
ALTER TABLE printer_events
    DROP CONSTRAINT printer_events_check,
    DROP COLUMN attempt_id,
    DROP COLUMN reconciliation_state,
    DROP COLUMN reconciled_by_account_id,
    DROP COLUMN reconciled_at;

DROP TABLE print_filament_declarations;
DROP TABLE printing_operations;
DROP TABLE print_attempts;
DROP TABLE print_submissions;
DROP SEQUENCE print_submission_display_sequence;

ALTER TABLE machine_jobs
    DROP CONSTRAINT machine_jobs_check2,
    DROP CONSTRAINT machine_jobs_check3,
    DROP COLUMN review_state,
    DROP COLUMN source,
    DROP COLUMN external_id,
    DROP COLUMN external_metadata;

DELETE FROM role_permission_grants WHERE permission_id IN ('print_submissions.read', 'print_submissions.manage', 'machine_jobs.review');

-- +goose Down
-- Restores the empty legacy structures; their former contents are not recoverable.
ALTER TABLE machine_jobs
    ADD COLUMN source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'automatic')),
    ADD COLUMN external_id text CHECK (external_id IS NULL OR (external_id = btrim(external_id) AND external_id <> '' AND length(external_id) <= 200)),
    ADD COLUMN external_metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(external_metadata) = 'object' AND octet_length(external_metadata::text) <= 16384),
    ADD COLUMN review_state text NOT NULL DEFAULT 'confirmed' CHECK (review_state IN ('needs_review', 'confirmed')),
    ADD CONSTRAINT machine_jobs_check2 CHECK ((source = 'automatic' AND external_id IS NOT NULL) OR source = 'manual'),
    ADD CONSTRAINT machine_jobs_check3 CHECK ((review_state = 'needs_review' AND source = 'automatic') OR review_state = 'confirmed');
ALTER TABLE machine_jobs ALTER COLUMN source DROP DEFAULT, ALTER COLUMN review_state DROP DEFAULT;
CREATE UNIQUE INDEX machine_jobs_automatic_external_idx ON machine_jobs (machine_id, external_id) WHERE source = 'automatic';
CREATE INDEX machine_jobs_review_idx ON machine_jobs (review_state, starts_at, id);

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION check_anonymous_job_completion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.review_state='confirmed' AND NEW.customer_person_id IS NULL AND NEW.customer_organization_id IS NULL AND
 (TG_OP='INSERT' OR OLD.review_state='needs_review') AND NOT EXISTS(
 SELECT 1 FROM order_job_claims c JOIN order_items i ON i.id=c.order_item_id JOIN orders o ON o.id=i.order_id
 WHERE c.machine_job_id=NEW.id AND o.status='finalized' AND o.customer_kind='anonymous'
 AND o.fulfillment_mode='immediate' AND o.total_amount=(SELECT COALESCE(sum(amount),0) FROM payment_allocations WHERE order_id=o.id)) THEN
 RAISE EXCEPTION 'anonymous job confirmation requires atomic counter sale' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
-- +goose StatementEnd

CREATE SEQUENCE print_submission_display_sequence;
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
    CONSTRAINT print_filament_declarations_spool_fk FOREIGN KEY (spool_id) REFERENCES filament_spools(id) ON DELETE SET NULL
);
CREATE INDEX print_filament_declarations_submission_idx ON print_filament_declarations (submission_id, id) WHERE submission_id IS NOT NULL;
CREATE INDEX print_filament_declarations_attempt_idx ON print_filament_declarations (attempt_id, id) WHERE attempt_id IS NOT NULL;
CREATE TABLE printing_operations (
    operation_key uuid PRIMARY KEY,
    actor_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('attempt_create', 'attempt_retry', 'reconciliation_accept')),
    fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
    result_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE printer_events
    ADD COLUMN attempt_id uuid REFERENCES print_attempts(id) ON DELETE SET NULL,
    ADD COLUMN reconciliation_state text NOT NULL DEFAULT 'not_applicable' CHECK (reconciliation_state IN ('not_applicable', 'pending', 'accepted', 'rejected')),
    ADD COLUMN reconciled_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    ADD COLUMN reconciled_at timestamptz;
UPDATE printer_events SET reconciliation_state = 'pending' WHERE kind = 'consumption_report';
ALTER TABLE printer_events ADD CONSTRAINT printer_events_check CHECK ((kind = 'consumption_report' AND reconciliation_state IN ('pending', 'accepted', 'rejected')) OR (kind <> 'consumption_report' AND reconciliation_state = 'not_applicable'));
CREATE INDEX printer_events_pending_reconciliation_idx ON printer_events (received_at, id) WHERE reconciliation_state = 'pending';
CREATE INDEX printer_events_attempt_time_idx ON printer_events (attempt_id, occurred_at, id) WHERE attempt_id IS NOT NULL;

ALTER TABLE printer_observed_runs ADD COLUMN attempt_id uuid UNIQUE REFERENCES print_attempts(id) ON DELETE SET NULL;
CREATE INDEX printer_observed_runs_unmatched_idx ON printer_observed_runs (last_observed_at DESC, id DESC) WHERE attempt_id IS NULL;
