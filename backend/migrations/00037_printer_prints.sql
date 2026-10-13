-- +goose Up
-- Observed runs reported by printer connectors become the "prints" that staff
-- see in the jobs list: they get a display ID, the printer-reported file name,
-- times, progress and the latest reported material usage. A machine job links
-- to at most one print; linking replaces the job's manual run.
CREATE SEQUENCE print_display_sequence;

ALTER TABLE printer_observed_runs
    ADD COLUMN display_id text UNIQUE CHECK (display_id ~ '^PR-[0-9]{4}-[0-9]{6,}$'),
    ADD COLUMN file_name text CHECK (file_name IS NULL OR (file_name = btrim(file_name) AND file_name <> '' AND length(file_name) <= 255)),
    ADD COLUMN started_at timestamptz,
    ADD COLUMN ended_at timestamptz,
    ADD COLUMN estimated_end_at timestamptz,
    ADD COLUMN progress_percent smallint CHECK (progress_percent IS NULL OR progress_percent BETWEEN 0 AND 100),
    ADD COLUMN reported_quantity_g numeric(20, 6) CHECK (reported_quantity_g IS NULL OR reported_quantity_g > 0),
    ADD COLUMN reported_quantity_basis text CHECK (reported_quantity_basis IS NULL OR reported_quantity_basis IN ('estimated', 'actual')),
    ADD COLUMN reported_spool_id uuid REFERENCES filament_spools(id) ON DELETE SET NULL,
    ADD COLUMN reported_event_id uuid REFERENCES printer_events(id) ON DELETE SET NULL,
    ADD CONSTRAINT printer_observed_runs_time_order CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at),
    ADD CONSTRAINT printer_observed_runs_reported_shape CHECK ((reported_quantity_g IS NULL) = (reported_quantity_basis IS NULL));

WITH ordered AS (
    SELECT id, first_observed_at, row_number() OVER (ORDER BY first_observed_at, id) AS n
    FROM printer_observed_runs
)
UPDATE printer_observed_runs r
SET display_id = 'PR-' || to_char(o.first_observed_at AT TIME ZONE 'UTC', 'YYYY') || '-' || lpad(o.n::text, 6, '0')
FROM ordered o
WHERE o.id = r.id;

SELECT setval('print_display_sequence', GREATEST((SELECT count(*) FROM printer_observed_runs), 1), (SELECT count(*) FROM printer_observed_runs) > 0);

UPDATE printer_observed_runs r
SET started_at = e.started_at,
    ended_at = CASE WHEN r.state IN ('completed', 'failed', 'cancelled') THEN GREATEST(e.ended_at, e.started_at) END
FROM (
    SELECT observed_run_id,
           min(occurred_at) FILTER (WHERE kind IN ('progress', 'operational_state')) AS started_at,
           max(occurred_at) FILTER (WHERE kind = 'terminal_outcome') AS ended_at
    FROM printer_events
    WHERE observed_run_id IS NOT NULL
    GROUP BY observed_run_id
) e
WHERE e.observed_run_id = r.id;

ALTER TABLE printer_observed_runs ALTER COLUMN display_id SET NOT NULL;

ALTER TABLE machine_jobs
    ADD COLUMN print_id uuid UNIQUE REFERENCES printer_observed_runs(id) ON DELETE SET NULL;

-- Jobs that were linked through a print submission attempt keep that link.
UPDATE machine_jobs j
SET print_id = r.id
FROM printer_observed_runs r
JOIN print_attempts a ON a.id = r.attempt_id
WHERE a.machine_job_id = j.id;

SET CONSTRAINTS anonymous_job_completed IMMEDIATE;

-- +goose Down
ALTER TABLE machine_jobs DROP COLUMN print_id;

ALTER TABLE printer_observed_runs
    DROP CONSTRAINT printer_observed_runs_reported_shape,
    DROP CONSTRAINT printer_observed_runs_time_order,
    DROP COLUMN reported_event_id,
    DROP COLUMN reported_spool_id,
    DROP COLUMN reported_quantity_basis,
    DROP COLUMN reported_quantity_g,
    DROP COLUMN progress_percent,
    DROP COLUMN estimated_end_at,
    DROP COLUMN ended_at,
    DROP COLUMN started_at,
    DROP COLUMN file_name,
    DROP COLUMN display_id;

DROP SEQUENCE print_display_sequence;
