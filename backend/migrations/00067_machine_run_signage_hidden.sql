-- +goose Up
-- A person can opt a run out of digital signage: while the run is not ended, its machine (status and camera) is
-- hidden from every display. The flag belongs to the run, so the next run starts visible again.
ALTER TABLE machine_runs ADD COLUMN hidden_from_signage boolean NOT NULL DEFAULT false;

-- +goose Down
ALTER TABLE machine_runs DROP COLUMN hidden_from_signage;
