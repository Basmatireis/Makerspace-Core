-- +goose Up
-- A deleted or detached run remembers the job it belonged to, so restoring the job or the run can put it back.
ALTER TABLE machine_runs
    ADD COLUMN former_job_id uuid REFERENCES machine_jobs(id) ON DELETE SET NULL;
CREATE INDEX machine_runs_former_job_idx ON machine_runs (former_job_id) WHERE former_job_id IS NOT NULL;
CREATE INDEX machine_runs_deleted_idx ON machine_runs (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX machine_jobs_deleted_idx ON machine_jobs (deleted_at DESC) WHERE deleted_at IS NOT NULL;

-- +goose Down
DROP INDEX machine_jobs_deleted_idx;
DROP INDEX machine_runs_deleted_idx;
DROP INDEX machine_runs_former_job_idx;
ALTER TABLE machine_runs DROP COLUMN former_job_id;
