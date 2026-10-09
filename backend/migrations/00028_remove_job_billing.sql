-- +goose Up
-- Existing billed/waived flags and references are disposable development data.
DROP INDEX machine_jobs_billing_idx;
ALTER TABLE machine_jobs DROP COLUMN billing_status, DROP COLUMN billing_reference;
-- +goose Down
ALTER TABLE machine_jobs ADD COLUMN billing_status text NOT NULL DEFAULT 'unbilled' CHECK(billing_status IN ('unbilled','billed','waived')),
ADD COLUMN billing_reference text;
CREATE INDEX machine_jobs_billing_idx ON machine_jobs(billing_status,starts_at DESC,id);
