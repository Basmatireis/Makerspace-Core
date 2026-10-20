-- +goose Up
-- Deleting a printer connector removes its assignments. Recorded runs and printer error history
-- are business records of the machine and survive: they only lose the informational pointer
-- to the assignment that observed them.
ALTER TABLE machine_runs
    DROP CONSTRAINT printer_observed_runs_assignment_id_fkey,
    ADD CONSTRAINT machine_runs_assignment_id_fkey FOREIGN KEY (assignment_id) REFERENCES printer_connector_assignments(id) ON DELETE SET NULL,
    DROP CONSTRAINT machine_runs_source_shape,
    ADD CONSTRAINT machine_runs_source_shape CHECK (
        (source = 'recorded' AND first_observed_at IS NOT NULL AND last_observed_at IS NOT NULL)
        OR (source = 'manual' AND assignment_id IS NULL AND vendor_job_id IS NULL AND (job_id IS NOT NULL OR deleted_at IS NOT NULL)
            AND started_at IS NOT NULL AND ended_at IS NOT NULL AND ended_at > started_at
            AND reported_quantity_g IS NULL AND reported_event_id IS NULL)
    );

ALTER TABLE printer_error_occurrences
    ALTER COLUMN assignment_id DROP NOT NULL,
    DROP CONSTRAINT printer_error_occurrences_assignment_id_fkey,
    ADD CONSTRAINT printer_error_occurrences_assignment_id_fkey FOREIGN KEY (assignment_id) REFERENCES printer_connector_assignments(id) ON DELETE SET NULL;

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM machine_runs WHERE source = 'recorded' AND assignment_id IS NULL)
       OR EXISTS (SELECT 1 FROM printer_error_occurrences WHERE assignment_id IS NULL) THEN
        RAISE EXCEPTION 'cannot downgrade while runs or printer errors of deleted connectors exist';
    END IF;
END $$;
-- +goose StatementEnd

ALTER TABLE printer_error_occurrences
    DROP CONSTRAINT printer_error_occurrences_assignment_id_fkey,
    ADD CONSTRAINT printer_error_occurrences_assignment_id_fkey FOREIGN KEY (assignment_id) REFERENCES printer_connector_assignments(id) ON DELETE RESTRICT,
    ALTER COLUMN assignment_id SET NOT NULL;

ALTER TABLE machine_runs
    DROP CONSTRAINT machine_runs_source_shape,
    ADD CONSTRAINT machine_runs_source_shape CHECK (
        (source = 'recorded' AND assignment_id IS NOT NULL AND first_observed_at IS NOT NULL AND last_observed_at IS NOT NULL)
        OR (source = 'manual' AND assignment_id IS NULL AND vendor_job_id IS NULL AND (job_id IS NOT NULL OR deleted_at IS NOT NULL)
            AND started_at IS NOT NULL AND ended_at IS NOT NULL AND ended_at > started_at
            AND reported_quantity_g IS NULL AND reported_event_id IS NULL)
    ),
    DROP CONSTRAINT machine_runs_assignment_id_fkey,
    ADD CONSTRAINT printer_observed_runs_assignment_id_fkey FOREIGN KEY (assignment_id) REFERENCES printer_connector_assignments(id) ON DELETE RESTRICT;
