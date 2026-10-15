-- +goose Up
-- Jobs and runs are deleted with a tombstone: the inventory ledger is
-- immutable and references run usages, and a connector would otherwise recreate
-- a deleted recorded run with its next event. Tombstoned rows keep their
-- display ID (display IDs are never reused) and are excluded from every
-- query that serves the user. A deleted run is detached from its job.
ALTER TABLE machine_jobs
    ADD COLUMN deleted_at timestamptz,
    ADD COLUMN deleted_by uuid REFERENCES accounts(id) ON DELETE SET NULL,
    ADD CONSTRAINT machine_jobs_deleted_check CHECK (deleted_at IS NOT NULL OR deleted_by IS NULL);

ALTER TABLE machine_runs
    ADD COLUMN deleted_at timestamptz,
    ADD COLUMN deleted_by uuid REFERENCES accounts(id) ON DELETE SET NULL,
    ADD CONSTRAINT machine_runs_deleted_check CHECK (deleted_at IS NOT NULL OR deleted_by IS NULL),
    DROP CONSTRAINT machine_runs_source_shape,
    ADD CONSTRAINT machine_runs_source_shape CHECK (
        (source = 'recorded' AND assignment_id IS NOT NULL AND first_observed_at IS NOT NULL AND last_observed_at IS NOT NULL)
        OR (source = 'manual' AND assignment_id IS NULL AND vendor_job_id IS NULL AND (job_id IS NOT NULL OR deleted_at IS NOT NULL)
            AND started_at IS NOT NULL AND ended_at IS NOT NULL AND ended_at > started_at
            AND reported_quantity_g IS NULL AND reported_event_id IS NULL)
    ),
    ADD CONSTRAINT machine_runs_deleted_detached CHECK (deleted_at IS NULL OR job_id IS NULL);

DROP INDEX machine_runs_unassigned_idx;
CREATE INDEX machine_runs_unassigned_idx ON machine_runs (machine_id, last_observed_at DESC, id DESC) WHERE job_id IS NULL AND deleted_at IS NULL;

-- The per-job aggregate ignores deleted jobs and runs.
CREATE OR REPLACE VIEW machine_job_run_summaries AS
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
    JOIN machine_jobs j ON j.id = r.job_id AND j.deleted_at IS NULL
    WHERE r.job_id IS NOT NULL AND r.deleted_at IS NULL AND r.state IS DISTINCT FROM 'replaced'
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

-- Clearing a connector's events hides the events received so far; the events
-- themselves are never deleted.
ALTER TABLE printer_connectors
    ADD COLUMN events_cleared_at timestamptz,
    ADD COLUMN events_cleared_by uuid REFERENCES accounts(id) ON DELETE SET NULL,
    ADD CONSTRAINT printer_connectors_events_cleared_check CHECK (events_cleared_at IS NOT NULL OR events_cleared_by IS NULL);

-- +goose Down
-- Deleted jobs and runs cannot be represented without the tombstone columns.
-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM machine_jobs WHERE deleted_at IS NOT NULL)
       OR EXISTS (SELECT 1 FROM machine_runs WHERE deleted_at IS NOT NULL) THEN
        RAISE EXCEPTION 'deleted jobs and runs cannot be downgraded';
    END IF;
END $$;
-- +goose StatementEnd

ALTER TABLE printer_connectors
    DROP CONSTRAINT printer_connectors_events_cleared_check,
    DROP COLUMN events_cleared_by,
    DROP COLUMN events_cleared_at;

CREATE OR REPLACE VIEW machine_job_run_summaries AS
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

DROP INDEX machine_runs_unassigned_idx;
CREATE INDEX machine_runs_unassigned_idx ON machine_runs (machine_id, last_observed_at DESC, id DESC) WHERE job_id IS NULL;

ALTER TABLE machine_runs
    DROP CONSTRAINT machine_runs_deleted_detached,
    DROP CONSTRAINT machine_runs_source_shape,
    ADD CONSTRAINT machine_runs_source_shape CHECK (
        (source = 'recorded' AND assignment_id IS NOT NULL AND first_observed_at IS NOT NULL AND last_observed_at IS NOT NULL)
        OR (source = 'manual' AND assignment_id IS NULL AND vendor_job_id IS NULL AND job_id IS NOT NULL
            AND started_at IS NOT NULL AND ended_at IS NOT NULL AND ended_at > started_at
            AND reported_quantity_g IS NULL AND reported_event_id IS NULL)
    ),
    DROP CONSTRAINT machine_runs_deleted_check,
    DROP COLUMN deleted_by,
    DROP COLUMN deleted_at;

ALTER TABLE machine_jobs
    DROP CONSTRAINT machine_jobs_deleted_check,
    DROP COLUMN deleted_by,
    DROP COLUMN deleted_at;
