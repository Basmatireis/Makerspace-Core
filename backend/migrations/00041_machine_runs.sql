-- +goose Up
-- A job consists of runs. A run is one period of work on the job's machine:
-- recorded by a connector (formerly a "print") or entered manually by staff.
-- Jobs keep the billing facts; start, end, runtime, material and the derived
-- outcome come from their runs. Recorded runs may exist without a job until
-- staff attach them.

-- Runs: the connector's observed runs become recorded runs.
ALTER TABLE printer_observed_runs RENAME TO machine_runs;
ALTER SEQUENCE print_display_sequence RENAME TO machine_run_display_sequence;
ALTER TABLE printer_events RENAME COLUMN observed_run_id TO run_id;

ALTER TABLE machine_runs
    DROP CONSTRAINT printer_observed_runs_machine_id_fkey,
    DROP CONSTRAINT printer_observed_runs_display_id_check,
    DROP CONSTRAINT printer_observed_runs_state_check,
    ALTER COLUMN state DROP DEFAULT,
    ALTER COLUMN state DROP NOT NULL,
    ALTER COLUMN assignment_id DROP NOT NULL,
    ALTER COLUMN first_observed_at DROP NOT NULL,
    ALTER COLUMN last_observed_at DROP NOT NULL,
    ADD COLUMN source text NOT NULL DEFAULT 'recorded',
    ADD COLUMN job_id uuid,
    ADD COLUMN outcome text CHECK (outcome IS NULL OR outcome IN ('successful', 'partial_failure', 'failed', 'cancelled')),
    ADD CONSTRAINT machine_runs_machine_fk FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE RESTRICT;
ALTER TABLE machine_runs ALTER COLUMN source DROP DEFAULT;

UPDATE machine_runs SET
    display_id = 'R-' || substring(display_id FROM 4),
    state = CASE state
        WHEN 'observed' THEN 'running'
        WHEN 'printing' THEN 'running'
        WHEN 'completed' THEN 'finished'
        WHEN 'uncertain' THEN 'unknown'
        ELSE state
    END;

ALTER TABLE machine_runs
    ADD CONSTRAINT machine_runs_display_id_check CHECK (display_id ~ '^R-[0-9]{4}-[0-9]{6,}$'),
    -- Manual runs derive "running" from their planned end; only cancellation
    -- and replacement by a recorded run are stored.
    ADD CONSTRAINT machine_runs_state_check CHECK (
        (source = 'recorded' AND state IN ('running', 'finished', 'failed', 'cancelled', 'unknown'))
        OR (source = 'manual' AND (state IS NULL OR state IN ('cancelled', 'replaced')))
    ),
    ADD CONSTRAINT machine_runs_source_shape CHECK (
        (source = 'recorded' AND assignment_id IS NOT NULL AND first_observed_at IS NOT NULL AND last_observed_at IS NOT NULL)
        OR (source = 'manual' AND assignment_id IS NULL AND vendor_job_id IS NULL AND job_id IS NOT NULL
            AND started_at IS NOT NULL AND ended_at IS NOT NULL AND ended_at > started_at
            AND reported_quantity_g IS NULL AND reported_event_id IS NULL)
    );

ALTER TABLE machine_jobs ADD CONSTRAINT machine_jobs_id_machine_key UNIQUE (id, machine_id);
-- A run belongs to a job on the same machine. Detaching keeps the run.
ALTER TABLE machine_runs
    ADD CONSTRAINT machine_runs_job_fk FOREIGN KEY (job_id, machine_id) REFERENCES machine_jobs(id, machine_id) ON DELETE SET NULL (job_id);
CREATE INDEX machine_runs_job_idx ON machine_runs (job_id, started_at) WHERE job_id IS NOT NULL;
CREATE INDEX machine_runs_unassigned_idx ON machine_runs (machine_id, last_observed_at DESC, id DESC) WHERE job_id IS NULL;

-- Linked prints become the job's recorded run.
UPDATE machine_runs r
SET job_id = j.id, outcome = NULLIF(j.outcome, 'unknown')
FROM machine_jobs j
WHERE j.print_id = r.id;

UPDATE machine_runs
SET outcome = CASE state WHEN 'finished' THEN 'successful' WHEN 'failed' THEN 'failed' WHEN 'cancelled' THEN 'cancelled' END
WHERE job_id IS NULL;

-- Every other job gets one manual run with its former times and outcome.
INSERT INTO machine_runs (id, display_id, machine_id, source, job_id, state, started_at, ended_at, outcome, history_complete, version, created_at, updated_at)
SELECT uuidv7(),
       'R-' || to_char(j.starts_at AT TIME ZONE 'UTC', 'YYYY') || '-' || lpad(nextval('machine_run_display_sequence')::text, 6, '0'),
       j.machine_id, 'manual', j.id,
       CASE WHEN j.outcome = 'cancelled' THEN 'cancelled' END,
       j.starts_at, j.ends_at, NULLIF(j.outcome, 'unknown'), true, 1, j.created_at, j.updated_at
FROM machine_jobs j
WHERE j.print_id IS NULL
ORDER BY j.starts_at, j.id;

-- Material usage belongs to a run.
ALTER TABLE machine_job_material_usages RENAME TO machine_run_usages;
ALTER TABLE machine_run_usages ADD COLUMN run_id uuid REFERENCES machine_runs(id) ON DELETE CASCADE;
UPDATE machine_run_usages u SET run_id = r.id FROM machine_runs r WHERE r.job_id = u.machine_job_id;
ALTER TABLE machine_run_usages ALTER COLUMN run_id SET NOT NULL;
ALTER TABLE machine_run_usages DROP COLUMN machine_job_id;
CREATE INDEX machine_run_usages_material_idx ON machine_run_usages (material_id, run_id);
CREATE INDEX machine_run_usages_spool_idx ON machine_run_usages (spool_id, run_id) WHERE spool_id IS NOT NULL;
CREATE UNIQUE INDEX machine_run_usages_active_spool_idx ON machine_run_usages (run_id, spool_id)
    WHERE active AND ownership = 'makerspace' AND spool_id IS NOT NULL;
CREATE UNIQUE INDEX machine_run_usages_active_unassigned_idx ON machine_run_usages (run_id, material_id)
    WHERE active AND ownership = 'makerspace' AND spool_id IS NULL AND spool_display_id IS NULL;

-- Ledger: consumption is attributed to run usages.
ALTER TABLE inventory_transactions DISABLE TRIGGER inventory_transactions_immutable;
ALTER TABLE inventory_transactions RENAME COLUMN machine_job_usage_id TO run_usage_id;
ALTER TABLE inventory_transactions
    DROP CONSTRAINT inventory_transactions_kind_check,
    DROP CONSTRAINT inventory_transactions_check1,
    DROP CONSTRAINT inventory_transactions_check2;
UPDATE inventory_transactions SET kind = 'machine_run_consumption' WHERE kind = 'machine_job_consumption';
ALTER TABLE inventory_transactions
    ADD CONSTRAINT inventory_transactions_kind_check CHECK (kind IN ('purchase', 'machine_run_consumption', 'manual_consumption', 'adjustment', 'disposal', 'spool_transfer')),
    ADD CONSTRAINT inventory_transactions_consumption_sign CHECK ((kind IN ('machine_run_consumption', 'manual_consumption', 'disposal') AND quantity_delta < 0) OR kind NOT IN ('machine_run_consumption', 'manual_consumption', 'disposal')),
    ADD CONSTRAINT inventory_transactions_run_usage_required CHECK ((kind = 'machine_run_consumption' AND run_usage_id IS NOT NULL) OR kind <> 'machine_run_consumption');
ALTER INDEX inventory_transactions_job_usage_idx RENAME TO inventory_transactions_run_usage_idx;

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION guard_inventory_transaction_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'inventory transaction history is immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.material_id IS DISTINCT FROM OLD.material_id
       OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.quantity_delta IS DISTINCT FROM OLD.quantity_delta
       OR NEW.unit_acquisition_cost IS DISTINCT FROM OLD.unit_acquisition_cost
       OR NEW.inventory_value_delta IS DISTINCT FROM OLD.inventory_value_delta
       OR NEW.total_purchase_price IS DISTINCT FROM OLD.total_purchase_price
       OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
       OR NEW.supplier IS DISTINCT FROM OLD.supplier
       OR NEW.note IS DISTINCT FROM OLD.note
       OR NEW.adjustment_reason IS DISTINCT FROM OLD.adjustment_reason
       OR NEW.run_usage_id IS DISTINCT FROM OLD.run_usage_id
       OR (NEW.actor_account_id IS DISTINCT FROM OLD.actor_account_id AND NOT (OLD.actor_account_id IS NOT NULL AND NEW.actor_account_id IS NULL))
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR (NEW.spool_id IS DISTINCT FROM OLD.spool_id AND NEW.spool_id IS NOT NULL)
       OR (NEW.from_spool_id IS DISTINCT FROM OLD.from_spool_id AND NEW.from_spool_id IS NOT NULL)
       OR (NEW.to_spool_id IS DISTINCT FROM OLD.to_spool_id AND NEW.to_spool_id IS NOT NULL)
       OR (NEW.fill_id IS DISTINCT FROM OLD.fill_id AND NEW.fill_id IS NOT NULL)
       OR (NEW.from_fill_id IS DISTINCT FROM OLD.from_fill_id AND NEW.from_fill_id IS NOT NULL)
       OR (NEW.to_fill_id IS DISTINCT FROM OLD.to_fill_id AND NEW.to_fill_id IS NOT NULL)
       OR NEW.transfer_quantity IS DISTINCT FROM OLD.transfer_quantity
       OR NEW.spool_display_id IS DISTINCT FROM OLD.spool_display_id
       OR NEW.fill_number IS DISTINCT FROM OLD.fill_number
       OR NEW.from_spool_display_id IS DISTINCT FROM OLD.from_spool_display_id
       OR NEW.from_fill_number IS DISTINCT FROM OLD.from_fill_number
       OR NEW.to_spool_display_id IS DISTINCT FROM OLD.to_spool_display_id
       OR NEW.to_fill_number IS DISTINCT FROM OLD.to_fill_number THEN
        RAISE EXCEPTION 'inventory transaction history is immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END $$;
-- +goose StatementEnd
ALTER TABLE inventory_transactions ENABLE TRIGGER inventory_transactions_immutable;

-- Jobs: times, material and the outcome now come from runs; staff may override the outcome.
ALTER TABLE machine_jobs
    ADD COLUMN outcome_override text CHECK (outcome_override IS NULL OR outcome_override IN ('successful', 'partial_failure', 'failed', 'cancelled'));
SET CONSTRAINTS anonymous_job_completed IMMEDIATE;
ALTER TABLE machine_jobs
    DROP COLUMN print_id,
    DROP COLUMN outcome,
    DROP COLUMN starts_at,
    DROP COLUMN ends_at;
CREATE INDEX machine_jobs_machine_idx ON machine_jobs (machine_id, created_at DESC, id);
CREATE INDEX machine_jobs_customer_person_idx ON machine_jobs (customer_person_id, created_at DESC) WHERE customer_person_id IS NOT NULL;
CREATE INDEX machine_jobs_customer_organization_idx ON machine_jobs (customer_organization_id, created_at DESC) WHERE customer_organization_id IS NOT NULL;
CREATE INDEX machine_jobs_operator_idx ON machine_jobs (operator_person_id, created_at DESC) WHERE operator_person_id IS NOT NULL;

-- Per-job aggregate of its runs. A manual run is running while its planned
-- end lies in the future; a running recorded run counts until its estimated
-- end, or until now when the printer gives none.
CREATE VIEW machine_job_run_summaries AS
WITH runs AS (
    SELECT r.job_id,
           COALESCE(r.started_at, r.first_observed_at) AS started_at,
           CASE
               WHEN r.source = 'manual' THEN r.state IS NULL AND r.ended_at > now()
               ELSE r.state = 'running'
           END AS running,
           CASE
               WHEN r.source = 'manual' THEN r.ended_at
               ELSE COALESCE(r.ended_at, GREATEST(r.estimated_end_at, now()), now())
           END AS effective_end,
           r.outcome
    FROM machine_runs r
    WHERE r.job_id IS NOT NULL AND r.state IS DISTINCT FROM 'replaced'
)
SELECT job_id,
       count(*) AS run_count,
       min(started_at) AS started_at,
       CASE WHEN bool_or(running) THEN NULL ELSE max(effective_end) END AS ended_at,
       max(effective_end) AS expected_end_at,
       bool_or(running) AS running,
       COALESCE(sum(GREATEST(0, extract(epoch FROM (effective_end - started_at)))), 0)::bigint AS runtime_seconds,
       CASE
           WHEN bool_or(running) THEN NULL
           WHEN bool_or(outcome IS NULL) THEN 'unknown'
           WHEN bool_and(outcome = 'successful') THEN 'successful'
           WHEN bool_and(outcome = 'cancelled') THEN 'cancelled'
           WHEN bool_and(outcome = 'failed') THEN 'failed'
           ELSE 'partial_failure'
       END AS derived_outcome
FROM runs
GROUP BY job_id;

-- +goose Down
-- Restores one run per job. Jobs with several runs and usages of runs
-- without a job cannot be represented in the previous model.
-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM machine_runs WHERE job_id IS NOT NULL AND state IS DISTINCT FROM 'replaced' GROUP BY job_id HAVING count(*) > 1)
       OR EXISTS (SELECT 1 FROM machine_run_usages u JOIN machine_runs r ON r.id = u.run_id WHERE r.job_id IS NULL)
       OR EXISTS (SELECT 1 FROM machine_runs WHERE source = 'manual' AND state = 'replaced') THEN
        RAISE EXCEPTION 'jobs with several runs, replaced runs or usages of unassigned runs cannot be downgraded';
    END IF;
END $$;
-- +goose StatementEnd

DROP VIEW machine_job_run_summaries;

ALTER TABLE machine_jobs
    ADD COLUMN starts_at timestamptz,
    ADD COLUMN ends_at timestamptz,
    ADD COLUMN outcome text,
    ADD COLUMN print_id uuid;
UPDATE machine_jobs j
SET starts_at = COALESCE(r.started_at, r.first_observed_at),
    ends_at = GREATEST(COALESCE(r.ended_at, r.last_observed_at, r.started_at), COALESCE(r.started_at, r.first_observed_at) + interval '1 second'),
    outcome = COALESCE(j.outcome_override, r.outcome, 'unknown'),
    print_id = CASE WHEN r.source = 'recorded' THEN r.id END
FROM machine_runs r
WHERE r.job_id = j.id;
SET CONSTRAINTS anonymous_job_completed IMMEDIATE;
ALTER TABLE machine_jobs
    ALTER COLUMN starts_at SET NOT NULL,
    ALTER COLUMN ends_at SET NOT NULL,
    ALTER COLUMN outcome SET NOT NULL,
    ADD CONSTRAINT machine_jobs_check CHECK (starts_at < ends_at),
    ADD CONSTRAINT machine_jobs_outcome_check CHECK (outcome IN ('successful', 'partial_failure', 'failed', 'cancelled', 'unknown')),
    DROP COLUMN outcome_override;
DROP INDEX machine_jobs_machine_idx;
DROP INDEX machine_jobs_customer_person_idx;
DROP INDEX machine_jobs_customer_organization_idx;
DROP INDEX machine_jobs_operator_idx;
CREATE INDEX machine_jobs_time_idx ON machine_jobs (starts_at DESC, id DESC);
CREATE INDEX machine_jobs_machine_idx ON machine_jobs (machine_id, starts_at DESC, id);
CREATE INDEX machine_jobs_customer_person_idx ON machine_jobs (customer_person_id, starts_at DESC) WHERE customer_person_id IS NOT NULL;
CREATE INDEX machine_jobs_customer_organization_idx ON machine_jobs (customer_organization_id, starts_at DESC) WHERE customer_organization_id IS NOT NULL;
CREATE INDEX machine_jobs_operator_idx ON machine_jobs (operator_person_id, starts_at DESC) WHERE operator_person_id IS NOT NULL;

ALTER TABLE inventory_transactions DISABLE TRIGGER inventory_transactions_immutable;
ALTER INDEX inventory_transactions_run_usage_idx RENAME TO inventory_transactions_job_usage_idx;
ALTER TABLE inventory_transactions
    DROP CONSTRAINT inventory_transactions_run_usage_required,
    DROP CONSTRAINT inventory_transactions_consumption_sign,
    DROP CONSTRAINT inventory_transactions_kind_check;
UPDATE inventory_transactions SET kind = 'machine_job_consumption' WHERE kind = 'machine_run_consumption';
ALTER TABLE inventory_transactions RENAME COLUMN run_usage_id TO machine_job_usage_id;
ALTER TABLE inventory_transactions
    ADD CONSTRAINT inventory_transactions_kind_check CHECK (kind IN ('purchase', 'machine_job_consumption', 'manual_consumption', 'adjustment', 'disposal', 'spool_transfer')),
    ADD CONSTRAINT inventory_transactions_check1 CHECK ((kind IN ('machine_job_consumption', 'manual_consumption', 'disposal') AND quantity_delta < 0) OR kind NOT IN ('machine_job_consumption', 'manual_consumption', 'disposal')),
    ADD CONSTRAINT inventory_transactions_check2 CHECK ((kind = 'machine_job_consumption' AND machine_job_usage_id IS NOT NULL) OR kind <> 'machine_job_consumption');
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION guard_inventory_transaction_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'inventory transaction history is immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.material_id IS DISTINCT FROM OLD.material_id
       OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.quantity_delta IS DISTINCT FROM OLD.quantity_delta
       OR NEW.unit_acquisition_cost IS DISTINCT FROM OLD.unit_acquisition_cost
       OR NEW.inventory_value_delta IS DISTINCT FROM OLD.inventory_value_delta
       OR NEW.total_purchase_price IS DISTINCT FROM OLD.total_purchase_price
       OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
       OR NEW.supplier IS DISTINCT FROM OLD.supplier
       OR NEW.note IS DISTINCT FROM OLD.note
       OR NEW.adjustment_reason IS DISTINCT FROM OLD.adjustment_reason
       OR (NEW.machine_job_usage_id IS DISTINCT FROM OLD.machine_job_usage_id AND NOT (OLD.machine_job_usage_id IS NOT NULL AND NEW.machine_job_usage_id IS NULL))
       OR (NEW.actor_account_id IS DISTINCT FROM OLD.actor_account_id AND NOT (OLD.actor_account_id IS NOT NULL AND NEW.actor_account_id IS NULL))
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR (NEW.spool_id IS DISTINCT FROM OLD.spool_id AND NEW.spool_id IS NOT NULL)
       OR (NEW.from_spool_id IS DISTINCT FROM OLD.from_spool_id AND NEW.from_spool_id IS NOT NULL)
       OR (NEW.to_spool_id IS DISTINCT FROM OLD.to_spool_id AND NEW.to_spool_id IS NOT NULL)
       OR (NEW.fill_id IS DISTINCT FROM OLD.fill_id AND NEW.fill_id IS NOT NULL)
       OR (NEW.from_fill_id IS DISTINCT FROM OLD.from_fill_id AND NEW.from_fill_id IS NOT NULL)
       OR (NEW.to_fill_id IS DISTINCT FROM OLD.to_fill_id AND NEW.to_fill_id IS NOT NULL)
       OR NEW.transfer_quantity IS DISTINCT FROM OLD.transfer_quantity
       OR NEW.spool_display_id IS DISTINCT FROM OLD.spool_display_id
       OR NEW.fill_number IS DISTINCT FROM OLD.fill_number
       OR NEW.from_spool_display_id IS DISTINCT FROM OLD.from_spool_display_id
       OR NEW.from_fill_number IS DISTINCT FROM OLD.from_fill_number
       OR NEW.to_spool_display_id IS DISTINCT FROM OLD.to_spool_display_id
       OR NEW.to_fill_number IS DISTINCT FROM OLD.to_fill_number THEN
        RAISE EXCEPTION 'inventory transaction history is immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END $$;
-- +goose StatementEnd
ALTER TABLE inventory_transactions ENABLE TRIGGER inventory_transactions_immutable;

DROP INDEX machine_run_usages_active_unassigned_idx;
DROP INDEX machine_run_usages_active_spool_idx;
DROP INDEX machine_run_usages_spool_idx;
DROP INDEX machine_run_usages_material_idx;
ALTER TABLE machine_run_usages ADD COLUMN machine_job_id uuid REFERENCES machine_jobs(id) ON DELETE CASCADE;
UPDATE machine_run_usages u SET machine_job_id = r.job_id FROM machine_runs r WHERE r.id = u.run_id;
ALTER TABLE machine_run_usages ALTER COLUMN machine_job_id SET NOT NULL, DROP COLUMN run_id;
ALTER TABLE machine_run_usages RENAME TO machine_job_material_usages;
ALTER TABLE machine_job_material_usages ADD CONSTRAINT machine_job_material_usages_id_machine_job_id_key UNIQUE (id, machine_job_id);
CREATE INDEX machine_job_material_usages_material_idx ON machine_job_material_usages (material_id, machine_job_id);
CREATE INDEX machine_job_usages_spool_idx ON machine_job_material_usages (spool_id, machine_job_id) WHERE spool_id IS NOT NULL;
CREATE UNIQUE INDEX machine_job_usages_active_spool_idx ON machine_job_material_usages (machine_job_id, spool_id)
    WHERE active AND ownership = 'makerspace' AND spool_id IS NOT NULL;
CREATE UNIQUE INDEX machine_job_usages_active_unassigned_idx ON machine_job_material_usages (machine_job_id, material_id)
    WHERE active AND ownership = 'makerspace' AND spool_id IS NULL AND spool_display_id IS NULL;

DELETE FROM machine_runs WHERE source = 'manual';
DROP INDEX machine_runs_unassigned_idx;
DROP INDEX machine_runs_job_idx;
ALTER TABLE machine_runs
    DROP CONSTRAINT machine_runs_job_fk,
    DROP CONSTRAINT machine_runs_source_shape,
    DROP CONSTRAINT machine_runs_state_check,
    DROP CONSTRAINT machine_runs_display_id_check;
ALTER TABLE machine_jobs DROP CONSTRAINT machine_jobs_id_machine_key;
UPDATE machine_runs SET
    display_id = 'PR-' || substring(display_id FROM 3),
    state = CASE state WHEN 'running' THEN 'printing' WHEN 'finished' THEN 'completed' WHEN 'unknown' THEN 'uncertain' ELSE state END;
ALTER TABLE machine_runs
    DROP CONSTRAINT machine_runs_machine_fk,
    DROP COLUMN outcome,
    DROP COLUMN job_id,
    DROP COLUMN source,
    ALTER COLUMN last_observed_at SET NOT NULL,
    ALTER COLUMN first_observed_at SET NOT NULL,
    ALTER COLUMN assignment_id SET NOT NULL,
    ALTER COLUMN state SET NOT NULL,
    ALTER COLUMN state SET DEFAULT 'observed',
    ADD CONSTRAINT printer_observed_runs_state_check CHECK (state IN ('observed', 'printing', 'completed', 'failed', 'cancelled', 'uncertain')),
    ADD CONSTRAINT printer_observed_runs_display_id_check CHECK (display_id ~ '^PR-[0-9]{4}-[0-9]{6,}$'),
    ADD CONSTRAINT printer_observed_runs_machine_id_fkey FOREIGN KEY (machine_id) REFERENCES printer_profiles(machine_id) ON DELETE RESTRICT;
ALTER TABLE machine_jobs ADD CONSTRAINT machine_jobs_print_id_key UNIQUE (print_id),
    ADD CONSTRAINT machine_jobs_print_id_fkey FOREIGN KEY (print_id) REFERENCES machine_runs(id) ON DELETE SET NULL;
ALTER TABLE printer_events RENAME COLUMN run_id TO observed_run_id;
ALTER SEQUENCE machine_run_display_sequence RENAME TO print_display_sequence;
ALTER TABLE machine_runs RENAME TO printer_observed_runs;
